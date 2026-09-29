import { CORE, MODEL, buildGraph, deriveSnapshot, nodeKey, tarjan, type Registry, type VersionGraph } from "./graph";
import { fmtDate, moduleName, namespaceOf, tierOf } from "./names";
import type { ClosurePolicy, Finding, MdrsRow, ModuleInfo, Package, SourceFile, Tier, ViewMode } from "./types";

export interface ClosureReport {
  node: string;
  moduleId: string;
  et: string;
  direct: string[]; // target node keys
  implicitModules: { moduleId: string; versions: string[] }[]; // reachable only transitively
  redundantModules: string[]; // direct AND reachable through another direct target
  conflicts: { moduleId: string; versions: string[] }[]; // >1 version of same module in closure
  unresolved: string[]; // target versions with no MDRS rows in this view (closure cannot be followed inside the file)
  unresolvedWorkspace: string[]; // ... nor anywhere in the loaded workspace
}

/** Transitive closure using the view's edges, falling back to workspace edges for versions the view does not describe. */
function closureWith(g: VersionGraph, ext: VersionGraph | undefined, start: string): Set<string> {
  const seen = new Set<string>();
  const q = [start];
  while (q.length) {
    const v = q.pop()!;
    let outs = (g.out.get(v) ?? []).filter((e) => e.status === "active");
    if (!outs.length && ext) outs = (ext.out.get(v) ?? []).filter((e) => e.status === "active");
    for (const e of outs) {
      if (e.from === e.to || e.to === start || seen.has(e.to)) continue;
      seen.add(e.to);
      q.push(e.to);
    }
  }
  return seen;
}

export interface IdStrategy {
  moduleId: string;
  ids: number;
  rows: number;
  versions: number;
  strategy: "reuse-id" | "new-id-per-version" | "mixed" | "single";
}

export interface ViewAnalysis {
  rows: MdrsRow[];
  graph: VersionGraph;
  modules: Map<string, ModuleInfo>;
  moduleEdges: { from: string; to: string; versions: number; latestSource: string; latestTarget: string; retracted: number; flags: string[] }[];
  moduleCycles: string[][];
  closures: ClosureReport[];
  idStrategies: IdStrategy[];
  findings: Finding[];
  stats: {
    rows: number;
    active: number;
    inactive: number;
    ids: number;
    versionEdges: number;
    sourceModules: number;
    dateMin: string;
    dateMax: string;
  };
  ownTier: Tier;
  leafModules: string[];
  ownModules: string[];
}

export function analyseRows(
  rows: MdrsRow[],
  registry: Registry,
  opts: { policy: ClosurePolicy; view: ViewMode; names?: Record<string, string>; workspace?: VersionGraph },
): ViewAnalysis {
  const g = buildGraph(rows, registry);
  const findings: Finding[] = [];
  const nm = (id: string) => `${moduleName(id, opts.names)} (${id})`;

  // ---- modules & module-level edges
  const moduleIds = new Set<string>();
  for (const n of g.nodes.values()) moduleIds.add(n.moduleId);
  const mEdgeMap = new Map<string, { from: string; to: string; versions: Set<string>; latestSource: string; latestTarget: string; retracted: number; flags: Set<string> }>();
  for (const e of g.edges) {
    const k = `${e.sourceModule}|${e.targetModule}`;
    let m = mEdgeMap.get(k);
    if (!m) {
      m = { from: e.sourceModule, to: e.targetModule, versions: new Set(), latestSource: "", latestTarget: "", retracted: 0, flags: new Set() };
      mEdgeMap.set(k, m);
    }
    if (e.status === "active") {
      m.versions.add(e.sourceEt);
      if (e.sourceEt > m.latestSource) {
        m.latestSource = e.sourceEt;
        m.latestTarget = e.targetEt;
      }
    } else m.retracted++;
    e.flags.forEach((f) => m!.flags.add(f));
  }
  const mAdj = new Map<string, string[]>();
  for (const m of mEdgeMap.values()) {
    if (m.versions.size === 0) continue;
    if (!mAdj.has(m.from)) mAdj.set(m.from, []);
    mAdj.get(m.from)!.push(m.to);
  }
  const mSccs = tarjan([...moduleIds], mAdj);
  const moduleCycles = mSccs.filter((c) => c.length > 1);
  const selfModules = [...mEdgeMap.values()].filter((m) => m.from === m.to && m.versions.size > 0).map((m) => m.from);

  // depth on the condensation (longest path to a root)
  const compOf = new Map<string, number>();
  mSccs.forEach((c, i) => c.forEach((v) => compOf.set(v, i)));
  const depthMemo = new Map<number, number>();
  const compDepth = (ci: number, guard = 0): number => {
    if (depthMemo.has(ci)) return depthMemo.get(ci)!;
    if (guard > 200) return 0;
    let d = 0;
    for (const v of mSccs[ci])
      for (const w of mAdj.get(v) ?? []) {
        const cw = compOf.get(w)!;
        if (cw !== ci) d = Math.max(d, 1 + compDepth(cw, guard + 1));
      }
    depthMemo.set(ci, d);
    return d;
  };
  const modules = new Map<string, ModuleInfo>();
  for (const id of moduleIds) {
    const versions = [...new Set([...g.nodes.values()].filter((n) => n.moduleId === id && n.asSource).map((n) => n.et))].sort();
    modules.set(id, {
      id,
      name: moduleName(id, opts.names),
      namespace: namespaceOf(id),
      tier: tierOf(id),
      depth: compDepth(compOf.get(id)!),
      versions,
    });
  }
  const incomingModules = new Set([...mEdgeMap.values()].filter((m) => m.from !== m.to && m.versions.size).map((m) => m.to));
  const leafModules = [...moduleIds].filter((id) => !incomingModules.has(id) && modules.get(id)!.versions.length > 0);
  const srcTiers = new Set([...modules.values()].filter((m) => m.versions.length).map((m) => m.tier));
  const ownTier: Tier = srcTiers.has("national") ? "national" : srcTiers.has("edition") ? "edition" : "int-core";
  // modules authored by this package's publisher: evaluated at their latest version
  const ownModules = [...modules.values()].filter((m) => m.tier === ownTier && m.versions.length).sort((a, b) => b.depth - a.depth).map((m) => m.id);

  // ---- stats
  const ets = rows.map((r) => r.effectiveTime).filter(Boolean).sort();
  const stats = {
    rows: rows.length,
    active: rows.filter((r) => r.active).length,
    inactive: rows.filter((r) => !r.active).length,
    ids: new Set(rows.map((r) => r.id)).size,
    versionEdges: g.edges.length,
    sourceModules: new Set(rows.map((r) => r.moduleId)).size,
    dateMin: ets[0] ?? "",
    dateMax: ets[ets.length - 1] ?? "",
  };

  // ---- id strategy per source module
  const idStrategies: IdStrategy[] = [];
  const byModule = new Map<string, MdrsRow[]>();
  for (const r of rows) {
    if (!byModule.has(r.moduleId)) byModule.set(r.moduleId, []);
    byModule.get(r.moduleId)!.push(r);
  }
  for (const [mid, rs] of byModule) {
    const perId = new Map<string, Set<string>>();
    rs.forEach((r) => {
      if (!perId.has(r.id)) perId.set(r.id, new Set());
      perId.get(r.id)!.add(r.sourceEffectiveTime);
    });
    const multi = [...perId.values()].filter((s) => s.size > 1).length;
    const versions = new Set(rs.map((r) => r.sourceEffectiveTime)).size;
    let strategy: IdStrategy["strategy"] = "single";
    if (versions > 1) strategy = multi === 0 ? "new-id-per-version" : multi === perId.size ? "reuse-id" : "mixed";
    idStrategies.push({ moduleId: mid, ids: perId.size, rows: rs.length, versions, strategy });
  }

  // ---- closures for every source version
  const closures: ClosureReport[] = [];
  const sourceNodes = [...g.nodes.values()].filter((n) => n.asSource);
  for (const s of sourceNodes) {
    const directEdges = (g.out.get(s.key) ?? []).filter((e) => e.status === "active" && e.from !== e.to);
    const direct = directEdges.map((e) => e.to);
    const directModules = new Set(directEdges.map((e) => e.targetModule));
    const viaOthers = new Map<string, Set<string>>(); // module -> versions reached through a direct target
    for (const t of direct) {
      for (const k of closureWith(g, opts.workspace, t)) {
        const [moduleId, et] = k.split("@");
        const n = { moduleId, et };
        if (!viaOthers.has(n.moduleId)) viaOthers.set(n.moduleId, new Set());
        viaOthers.get(n.moduleId)!.add(n.et);
      }
    }
    const all = new Map<string, Set<string>>();
    for (const e of directEdges) {
      if (!all.has(e.targetModule)) all.set(e.targetModule, new Set());
      all.get(e.targetModule)!.add(e.targetEt);
    }
    for (const [m, vs] of viaOthers) {
      if (!all.has(m)) all.set(m, new Set());
      vs.forEach((v) => all.get(m)!.add(v));
    }
    all.delete(s.moduleId);
    const implicitModules = [...viaOthers.entries()]
      .filter(([m]) => !directModules.has(m) && m !== s.moduleId)
      .map(([moduleId, v]) => ({ moduleId, versions: [...v].sort() }));
    const redundantModules = [...directModules].filter((m) => viaOthers.has(m));
    const conflicts = [...all.entries()].filter(([, v]) => v.size > 1).map(([moduleId, v]) => ({ moduleId, versions: [...v].sort() }));
    const unresolved: string[] = [];
    const unresolvedWorkspace: string[] = [];
    const reach = new Set([...direct, ...closureWith(g, opts.workspace, s.key)]);
    for (const k of reach) {
      if (k.startsWith(MODEL + "@")) continue;
      const outs = (g.out.get(k) ?? []).filter((e) => e.status === "active");
      if (outs.length === 0) {
        unresolved.push(k);
        const ext = (opts.workspace?.out.get(k) ?? []).filter((e) => e.status === "active");
        if (!ext.length) unresolvedWorkspace.push(k);
      }
    }
    closures.push({ node: s.key, moduleId: s.moduleId, et: s.et, direct, implicitModules, redundantModules, conflicts, unresolved, unresolvedWorkspace });
  }
  closures.sort((a, b) => (a.moduleId === b.moduleId ? a.et.localeCompare(b.et) : a.moduleId.localeCompare(b.moduleId)));
  const cByNode = new Map(closures.map((c) => [c.node, c]));
  for (const e of g.edges) {
    const c = cByNode.get(e.from);
    if (!c || e.status !== "active") continue;
    if (c.redundantModules.includes(e.targetModule)) e.flags.push("redundant");
    if (c.conflicts.some((x) => x.moduleId === e.targetModule)) e.flags.push("conflict");
  }

  // ================= findings =================
  const edgeRows = (pred: (e: (typeof g.edges)[number]) => boolean) => [...new Set(g.edges.filter(pred).flatMap((e) => e.rows.map((r) => r.id)))];

  // id strategy
  const strat = idStrategies.filter((s) => s.versions > 1);
  const reuse = strat.filter((s) => s.strategy === "reuse-id");
  const perVersion = strat.filter((s) => s.strategy === "new-id-per-version");
  const mixed = strat.filter((s) => s.strategy === "mixed");
  if (opts.view === "full" || opts.view === "json") {
    if (reuse.length)
      findings.push({
        code: "ID-REUSE",
        severity: "info",
        title: "Member ids reused across module versions",
        detail: `${reuse.map((s) => `${nm(s.moduleId)}: ${s.ids} ids × ${s.versions} versions`).join("; ")}. A new version of the source module updates the same member (new effectiveTime, sourceEffectiveTime, targetEffectiveTime); the Snapshot therefore only holds the latest version of each dependency.`,
      });
    if (perVersion.length)
      findings.push({
        code: "ID-PER-VERSION",
        severity: "info",
        title: "New member id for every module version",
        detail: `${perVersion.map((s) => `${nm(s.moduleId)}: ${s.ids} ids / ${s.versions} versions`).join("; ")}. Each released version is its own immutable member, so the Snapshot keeps the full dependency history.`,
      });
    if (mixed.length)
      findings.push({
        code: "ID-MIXED",
        severity: "warning",
        title: "Mixed id strategy (hybrid)",
        detail: `${mixed.map((s) => `${nm(s.moduleId)}: ${s.ids} ids / ${s.versions} versions`).join("; ")}. Some versions have their own member while others update a reused member — Snapshot content depends on which strategy was used at each release.`,
      });
  }

  // snapshot scope
  if (opts.view !== "full") {
    const activeSrc = new Map<string, Set<string>>();
    rows.filter((r) => r.active).forEach((r) => {
      if (!activeSrc.has(r.moduleId)) activeSrc.set(r.moduleId, new Set());
      activeSrc.get(r.moduleId)!.add(r.sourceEffectiveTime);
    });
    const cumulative = [...activeSrc.entries()].filter(([, v]) => v.size > 1);
    const latestOnly = [...activeSrc.entries()].filter(([, v]) => v.size === 1);
    if (cumulative.length)
      findings.push({
        code: "SNAP-CUMULATIVE",
        severity: "info",
        title: "Snapshot holds several versions of the same module",
        detail: cumulative.map(([m, v]) => `${nm(m)}: ${v.size} versions (${fmtDate([...v].sort()[0])} → ${fmtDate([...v].sort().pop()!)})`).join("; "),
      });
    if (latestOnly.length)
      findings.push({
        code: "SNAP-LATEST",
        severity: "info",
        title: "Snapshot holds only the latest version of these modules",
        detail: latestOnly.map(([m, v]) => `${nm(m)} @ ${fmtDate([...v][0])}`).join("; "),
      });
  }

  // self dependencies
  if (selfModules.length)
    findings.push({
      code: "SELF-DEP",
      severity: "error",
      title: "Module declared as dependent on itself",
      detail: selfModules.map((m) => nm(m)).join("; ") + ". A module version cannot be a prerequisite of itself; if the intent is to record the module's own version, that belongs outside the MDRS.",
      rowIds: edgeRows((e) => e.flags.includes("self")),
    });

  // cycles
  for (const c of moduleCycles)
    findings.push({
      code: "CYCLE",
      severity: "error",
      title: "Dependency cycle between modules",
      detail: `${c.map((m) => nm(m)).join(" ⇄ ")}. The dependency graph must be acyclic: an implementation cannot decide which to load first, and version compatibility cannot be resolved.`,
      nodes: [...g.nodes.values()].filter((n) => c.includes(n.moduleId)).map((n) => n.key),
      rowIds: edgeRows((e) => c.includes(e.sourceModule) && c.includes(e.targetModule)),
    });

  // target after source
  const tas = g.edges.filter((e) => e.flags.includes("target-after-source") && e.status === "active");
  if (tas.length)
    findings.push({
      code: "TARGET-AFTER-SOURCE",
      severity: "error",
      title: "Target version is later than the source version",
      detail: tas.slice(0, 8).map((e) => `${nm(e.sourceModule)}@${fmtDate(e.sourceEt)} → ${nm(e.targetModule)}@${fmtDate(e.targetEt)}`).join("; ") + (tas.length > 8 ? ` … (+${tas.length - 8})` : ""),
      rowIds: tas.flatMap((e) => e.rows.map((r) => r.id)),
    });

  // ambiguous
  const amb = g.edges.filter((e) => e.flags.includes("ambiguous-target"));
  if (amb.length) {
    const groups = new Map<string, Set<string>>();
    amb.forEach((e) => {
      const k = `${nm(e.sourceModule)}@${fmtDate(e.sourceEt)} → ${nm(e.targetModule)}`;
      if (!groups.has(k)) groups.set(k, new Set());
      groups.get(k)!.add(fmtDate(e.targetEt));
    });
    findings.push({
      code: "AMBIGUOUS-TARGET",
      severity: "error",
      title: "One source version depends on two versions of the same module",
      detail: [...groups.entries()].map(([k, v]) => `${k}: ${[...v].join(" and ")}`).join("; "),
      rowIds: amb.flatMap((e) => e.rows.map((r) => r.id)),
    });
  }

  // phantom target versions
  const phantoms = [...g.nodes.values()].filter((n) => n.phantom && n.asTarget);
  if (phantoms.length) {
    const byMod = new Map<string, string[]>();
    phantoms.forEach((n) => {
      if (!byMod.has(n.moduleId)) byMod.set(n.moduleId, []);
      byMod.get(n.moduleId)!.push(n.et);
    });
    findings.push({
      code: "PHANTOM-TARGET",
      severity: "warning",
      title: "Target versions that no loaded MDRS describes as a released version",
      detail:
        [...byMod.entries()].map(([m, v]) => `${nm(m)}: ${v.sort().map(fmtDate).join(", ")}`).join("; ") +
        ". Either the target release is not loaded in the workspace, or targetEffectiveTime does not match an actual release of the target module (e.g. a date chosen by convention).",
      nodes: phantoms.map((n) => n.key),
      rowIds: edgeRows((e) => e.flags.includes("phantom-target")),
    });
  }

  // effectiveTime vs sourceEffectiveTime
  const etm = g.edges.filter((e) => e.flags.includes("et-mismatch"));
  if (etm.length)
    findings.push({
      code: "ET-MISMATCH",
      severity: "warning",
      title: "effectiveTime differs from sourceEffectiveTime on active rows",
      detail: `${etm.length} version edge(s). For an active row the member's effectiveTime should be the release in which the source module version was published.`,
      rowIds: etm.flatMap((e) => e.rows.filter((r) => r.active && r.effectiveTime !== r.sourceEffectiveTime).map((r) => r.id)),
    });

  // duplicates
  const dups = g.edges.filter((e) => e.flags.includes("duplicate-assertion"));
  if (dups.length)
    findings.push({
      code: "DUPLICATE",
      severity: "warning",
      title: "Same version dependency asserted by more than one member",
      detail: dups.slice(0, 6).map((e) => `${nm(e.sourceModule)}@${fmtDate(e.sourceEt)} → ${nm(e.targetModule)}@${fmtDate(e.targetEt)} (${new Set(e.rows.map((r) => r.id)).size} ids)`).join("; "),
      rowIds: dups.flatMap((e) => e.rows.map((r) => r.id)),
    });

  // retracted (inactivated) historical dependencies
  const retr = g.edges.filter((e) => e.status === "retracted");
  if (retr.length) {
    const byMod = new Map<string, number>();
    retr.forEach((e) => byMod.set(`${nm(e.sourceModule)} → ${nm(e.targetModule)}`, (byMod.get(`${nm(e.sourceModule)} → ${nm(e.targetModule)}`) ?? 0) + 1));
    findings.push({
      code: "RETRACTED",
      severity: "warning",
      title: "Published version dependencies later inactivated",
      detail: `${[...byMod.entries()].map(([k, v]) => `${k}: ${v}`).join("; ")}. Inactivating a row whose sourceEffectiveTime is a past release rewrites history: that release did depend on the target. If the dependency was wrong, the snapshot of that past release is now inconsistent with what was shipped.`,
      rowIds: retr.flatMap((e) => e.rows.map((r) => r.id)),
    });
  }

  // unreleased (json)
  const unrel = g.edges.filter((e) => e.flags.includes("unreleased"));
  if (unrel.length)
    findings.push({
      code: "UNRELEASED",
      severity: "warning",
      title: "Members not flagged as released",
      detail: `${unrel.length} version edge(s) (${[...new Set(unrel.map((e) => shortId(e.sourceModule, opts.names)))].join(", ")}) come from members with released=false in the terminology server.`,
      rowIds: unrel.flatMap((e) => e.rows.map((r) => r.id)),
    });

  // closure-based findings, evaluated on the latest version of each leaf module (what an implementer installs)
  const latestLeaf = ownModules
    .map((m) => cByNode.get(nodeKey(m, modules.get(m)!.versions.at(-1)!)))
    .filter((c): c is ClosureReport => !!c);
  const allClosuresWithImplicit = closures.filter((c) => c.implicitModules.length > 0);
  const implicitLatest = latestLeaf.filter((c) => c.implicitModules.length);
  if (implicitLatest.length || allClosuresWithImplicit.length)
    findings.push({
      code: "IMPLICIT",
      severity: opts.policy === "explicit-closure" ? "warning" : "info",
      title: "Dependencies that are only implied transitively",
      detail:
        (implicitLatest.length
          ? implicitLatest
              .map((c) => `${nm(c.moduleId)}@${fmtDate(c.et)} relies on ${c.implicitModules.map((i) => `${shortId(i.moduleId, opts.names)}@${i.versions.map(fmtDate).join("/")}`).join(", ")} via other modules`)
              .join("; ")
          : "Latest versions are explicit") +
        `. ${allClosuresWithImplicit.length} of ${closures.length} source versions in this view have at least one implied (non-declared) dependency.`,
      nodes: implicitLatest.map((c) => c.node),
    });
  const redundantAll = closures.filter((c) => c.redundantModules.length);
  if (redundantAll.length && opts.policy === "direct-only")
    findings.push({
      code: "REDUNDANT",
      severity: "info",
      title: "Transitive dependencies also declared explicitly",
      detail: `${redundantAll.length} of ${closures.length} source versions declare a module that is already reachable through another declared dependency (e.g. ${redundantAll
        .slice(-3)
        .map((c) => `${shortId(c.moduleId, opts.names)}@${fmtDate(c.et)} → ${c.redundantModules.map((m) => shortId(m, opts.names)).join(", ")}`)
        .join("; ")}). Under a direct-only policy these rows are unnecessary; under an explicit-closure policy they are required.`,
    });
  const conflictAll = closures.filter((c) => c.conflicts.length);
  if (conflictAll.length)
    findings.push({
      code: "VERSION-CONFLICT",
      severity: "error",
      title: "Closure reaches two versions of the same module",
      detail: conflictAll
        .slice(-6)
        .map((c) => `${shortId(c.moduleId, opts.names)}@${fmtDate(c.et)}: ${c.conflicts.map((x) => `${shortId(x.moduleId, opts.names)} ${x.versions.map(fmtDate).join(" vs ")}`).join("; ")}`)
        .join(" | ") + (conflictAll.length > 6 ? ` … (${conflictAll.length} source versions affected)` : ""),
      nodes: conflictAll.map((c) => c.node),
    });
  const unresolvedLatest = latestLeaf.filter((c) => c.unresolved.length);
  if (unresolvedLatest.length)
    findings.push({
      code: "NOT-SELF-CONTAINED",
      severity: "warning",
      title: "Dependency chain cannot be followed inside this file",
      detail:
        unresolvedLatest
          .map((c) => `${shortId(c.moduleId, opts.names)}@${fmtDate(c.et)} reaches ${c.unresolved.map((k) => k.replace(/@(\d{8})$/, (_, d) => `@${fmtDate(d)}`)).map((k) => { const [m, d] = k.split("@"); return `${shortId(m, opts.names)}@${d}`; }).join(", ")} for which the file carries no MDRS rows`) .join("; ") +
        ". The upstream MDRS rows (e.g. core → model component) are not redistributed, so a consumer must combine this file with the upstream release to verify the full chain.",
      nodes: unresolvedLatest.flatMap((c) => c.unresolved),
    });

  // upstream rows redistributed
  const upstream = rows.filter((r) => tierOf(r.moduleId) !== ownTier && r.moduleId !== r.referencedComponentId);
  if (upstream.length && ownTier !== "int-core") {
    const mods = [...new Set(upstream.map((r) => r.moduleId))];
    findings.push({
      code: "UPSTREAM-INCLUDED",
      severity: "info",
      title: "Upstream MDRS rows are redistributed in this file",
      detail: `${upstream.length} row(s) whose source module belongs to an upstream release: ${mods.map((m) => nm(m)).join("; ")}.`,
    });
  }

  const order: Record<string, number> = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  const moduleEdges = [...mEdgeMap.values()].map((m) => ({
    from: m.from,
    to: m.to,
    versions: m.versions.size,
    latestSource: m.latestSource,
    latestTarget: m.latestTarget,
    retracted: m.retracted,
    flags: [...m.flags],
  }));

  return { rows, graph: g, modules, moduleEdges, moduleCycles, closures, idStrategies, findings, stats, ownTier, leafModules, ownModules };
}

function shortId(id: string, names?: Record<string, string>) {
  const n = moduleName(id, names);
  return n === id ? id : n.replace(/^SNOMED CT /, "").replace(/ module$/i, "");
}

// -------- package-level comparison (practice profile) --------

export interface PracticeProfile {
  key: string;
  label: string;
  views: string[];
  leafModules: string[];
  idStrategy: string;
  snapshotScope: string;
  upstreamRows: string;
  closureStyle: string;
  selfContained: string;
  snapshotMatchesFull: string;
  cycles: number;
  selfDeps: number;
  phantomTargets: number;
  targetAfterSource: number;
  etMismatch: number;
  retracted: number;
  conflicts: number;
  errors: number;
  warnings: number;
}

export function namesOf(p: Package): Record<string, string> {
  return Object.assign({}, ...p.files.map((f) => f.names ?? {}));
}

export function compareSnapshot(full: SourceFile, snap: SourceFile): { missing: number; extra: number; changed: number } {
  const derived = new Map(deriveSnapshot(full.rows).map((r) => [r.id, r]));
  const provided = new Map(snap.rows.map((r) => [r.id, r]));
  let missing = 0,
    extra = 0,
    changed = 0;
  for (const [id, r] of derived) {
    const p = provided.get(id);
    if (!p) missing++;
    else if (p.effectiveTime !== r.effectiveTime || p.active !== r.active || p.targetEffectiveTime !== r.targetEffectiveTime) changed++;
  }
  for (const id of provided.keys()) if (!derived.has(id)) extra++;
  return { missing, extra, changed };
}

export function profilePackage(p: Package, registry: Registry, policy: ClosurePolicy, workspace?: VersionGraph): PracticeProfile {
  const names = namesOf(p);
  const full = p.files.find((f) => f.kind === "full");
  const snap = p.files.find((f) => f.kind === "snapshot") ?? p.files.find((f) => f.kind === "json");
  const primary = full ?? snap ?? p.files[0];
  const a = analyseRows(primary.rows, registry, { policy, view: primary.kind === "full" ? "full" : primary.kind, names, workspace });
  const s = snap ? analyseRows(snap.rows, registry, { policy, view: snap.kind === "json" ? "json" : "snapshot", names, workspace }) : undefined;

  // id strategy (on full if available, else json/snapshot)
  const strat = a.idStrategies.filter((x) => x.versions > 1);
  const kinds = new Set(strat.map((x) => x.strategy));
  const idStrategy = !strat.length ? "n/a (single version)" : kinds.size === 1 ? label(strat[0].strategy) : `hybrid (${[...kinds].map(label).join(" + ")})`;

  let snapshotScope = "—";
  if (s) {
    const act = new Map<string, Set<string>>();
    s.rows.filter((r) => r.active).forEach((r) => {
      if (!act.has(r.moduleId)) act.set(r.moduleId, new Set());
      act.get(r.moduleId)!.add(r.sourceEffectiveTime);
    });
    const multi = [...act.values()].filter((v) => v.size > 1).length;
    snapshotScope = multi === 0 ? "latest version only" : multi === act.size ? "all versions (cumulative)" : `mixed (${multi}/${act.size} modules cumulative)`;
  }

  const view = s ?? a;
  const upstreamMods = [...new Set(view.rows.filter((r) => tierOf(r.moduleId) !== view.ownTier).map((r) => r.moduleId))];
  const upstreamRows = view.ownTier === "int-core" ? "n/a (root release)" : upstreamMods.length ? `yes: ${upstreamMods.map((m) => shortId(m, names)).join(", ")}` : "no";

  const latest = view.ownModules.map((m) => view.closures.find((c) => c.moduleId === m && c.et === view.modules.get(m)!.versions.at(-1)));
  const anyImplicit = latest.some((c) => c && c.implicitModules.length);
  const anyRedundant = latest.some((c) => c && c.redundantModules.length);
  const closureStyle = latest.every((c) => c && c.direct.length === 0)
    ? "—"
    : anyImplicit && anyRedundant
      ? "partial (some transitive explicit)"
      : anyImplicit
        ? "direct only (transitive implied)"
        : anyRedundant
          ? "explicit closure"
          : "direct = closure (flat)";
  const selfContained = latest.some((c) => c && c.unresolved.length)
    ? `no (needs ${[...new Set(latest.flatMap((c) => c?.unresolved ?? []).map((k) => shortId(k.split("@")[0], names)))].join(", ")} rows from upstream)`
    : "yes";

  let snapshotMatchesFull = "—";
  const snapFile = p.files.find((f) => f.kind === "snapshot");
  if (full && snapFile) {
    const d = compareSnapshot(full, snapFile);
    snapshotMatchesFull = d.missing + d.extra + d.changed === 0 ? "yes" : `no (missing ${d.missing}, extra ${d.extra}, changed ${d.changed})`;
  }

  return {
    key: p.key,
    label: p.label,
    views: p.files.map((f) => f.kind),
    leafModules: view.ownModules,
    idStrategy,
    snapshotScope,
    upstreamRows,
    closureStyle,
    selfContained,
    snapshotMatchesFull,
    cycles: a.moduleCycles.length,
    selfDeps: a.moduleEdges.filter((m) => m.from === m.to && m.versions > 0).length,
    phantomTargets: [...a.graph.nodes.values()].filter((n) => n.phantom && n.asTarget).length,
    targetAfterSource: a.graph.edges.filter((e) => e.flags.includes("target-after-source") && e.status === "active").length,
    etMismatch: a.graph.edges.filter((e) => e.flags.includes("et-mismatch")).length,
    retracted: a.graph.edges.filter((e) => e.status === "retracted").length,
    conflicts: a.closures.filter((c) => c.conflicts.length).length,
    errors: a.findings.filter((f) => f.severity === "error").length,
    warnings: a.findings.filter((f) => f.severity === "warning").length,
  };
}

function label(s: string) {
  return s === "reuse-id" ? "reuse id per dependency" : s === "new-id-per-version" ? "new id per version" : s;
}

export { CORE, MODEL };
