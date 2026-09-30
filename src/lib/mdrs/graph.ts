import type { EdgeFlag, MdrsRow, Package, SourceFile, VersionEdge, VersionNode, ViewMode } from "./types";

export const MODEL = "900000000000012004";
export const CORE = "900000000000207008";

export const nodeKey = (moduleId: string, et: string) => `${moduleId}@${et}`;

/**
 * Registry of module versions that are *described* somewhere in the workspace
 * (a module version exists when at least one MDRS row has it as source).
 * The model component never appears as a source; it is released with core,
 * so its known versions are those of core.
 */
export type Registry = Map<string, Set<string>>;

export function buildRegistry(packages: Package[]): Registry {
  const reg: Registry = new Map();
  for (const p of packages)
    for (const f of p.files)
      for (const r of f.rows) {
        if (!r.sourceEffectiveTime) continue;
        if (!reg.has(r.moduleId)) reg.set(r.moduleId, new Set());
        reg.get(r.moduleId)!.add(r.sourceEffectiveTime);
      }
  if (reg.has(CORE)) reg.set(MODEL, new Set([...(reg.get(MODEL) ?? []), ...reg.get(CORE)!]));
  return reg;
}

/** Latest state per member id as at `asOf` (inclusive). Rows without effectiveTime (unpublished) are kept only when asOf is empty. */
export function deriveSnapshot(rows: MdrsRow[], asOf?: string): MdrsRow[] {
  const latest = new Map<string, MdrsRow>();
  for (const r of rows) {
    if (asOf && (!r.effectiveTime || r.effectiveTime > asOf)) continue;
    const prev = latest.get(r.id);
    if (!prev || (r.effectiveTime || "99999999") >= (prev.effectiveTime || "99999999")) latest.set(r.id, r);
  }
  return [...latest.values()];
}

export function availableViews(p: Package): ViewMode[] {
  const kinds = new Set(p.files.map((f) => f.kind));
  const v: ViewMode[] = [];
  if (kinds.has("full")) v.push("full");
  if (kinds.has("snapshot")) v.push("snapshot");
  if (kinds.has("delta")) v.push("delta");
  if (kinds.has("json")) v.push("json");
  if (kinds.has("full")) v.push("derived");
  return v;
}

export function fileFor(p: Package, view: ViewMode): SourceFile | undefined {
  const kind = view === "derived" ? "full" : view;
  return p.files.find((f) => f.kind === kind);
}

/** Rows for a package view. `asOf` limits Full/derived views to rows published on or before that date. */
export function rowsForView(p: Package, view: ViewMode, asOf?: string): MdrsRow[] {
  const f = fileFor(p, view);
  if (!f) return [];
  if (view === "derived") return deriveSnapshot(f.rows, asOf);
  if (asOf && view === "full") return f.rows.filter((r) => r.effectiveTime && r.effectiveTime <= asOf);
  return f.rows;
}

export interface VersionGraph {
  nodes: Map<string, VersionNode>;
  edges: VersionEdge[];
  out: Map<string, VersionEdge[]>;
  inc: Map<string, VersionEdge[]>;
}

export function buildGraph(rows: MdrsRow[], registry: Registry): VersionGraph {
  const groups = new Map<string, MdrsRow[]>();
  for (const r of rows) {
    const k = [r.moduleId, r.sourceEffectiveTime, r.referencedComponentId, r.targetEffectiveTime].join("|");
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const nodes = new Map<string, VersionNode>();
  const touch = (moduleId: string, et: string, role: "s" | "t") => {
    const k = nodeKey(moduleId, et);
    let n = nodes.get(k);
    if (!n) {
      const known = registry.has(moduleId);
      n = { key: k, moduleId, et, asSource: false, asTarget: false, phantom: false, moduleKnown: known };
      nodes.set(k, n);
    }
    if (role === "s") n.asSource = true;
    else n.asTarget = true;
    return n;
  };

  const edges: VersionEdge[] = [];
  for (const [k, grp] of groups) {
    grp.sort((a, b) => (a.effectiveTime || "99999999").localeCompare(b.effectiveTime || "99999999"));
    const last = grp[grp.length - 1];
    const s = touch(last.moduleId, last.sourceEffectiveTime, "s");
    const t = touch(last.referencedComponentId, last.targetEffectiveTime, "t");
    const flags: EdgeFlag[] = [];
    if (last.moduleId === last.referencedComponentId) flags.push("self");
    if (last.targetEffectiveTime > last.sourceEffectiveTime) flags.push("target-after-source");
    if (grp.some((r) => r.active && r.effectiveTime && r.effectiveTime !== r.sourceEffectiveTime)) flags.push("et-mismatch");
    if (new Set(grp.filter((r) => r.active).map((r) => r.id)).size > 1) flags.push("duplicate-assertion");
    if (grp.some((r) => r.released === false)) flags.push("unreleased");
    // Snowstorm JSON: the member was first released at releasedEffectiveTime but now carries a later state
    if (grp.some((r) => r.released && r.releasedEffectiveTime && r.effectiveTime && r.releasedEffectiveTime < r.effectiveTime)) flags.push("repurposed");
    edges.push({
      key: k,
      from: s.key,
      to: t.key,
      sourceModule: last.moduleId,
      targetModule: last.referencedComponentId,
      sourceEt: last.sourceEffectiveTime,
      targetEt: last.targetEffectiveTime,
      status: last.active ? "active" : "retracted",
      rows: grp,
      flags,
    });
  }

  // phantom target versions
  for (const n of nodes.values()) {
    const known = registry.get(n.moduleId);
    if (known && !known.has(n.et)) n.phantom = true;
  }
  for (const e of edges) if (nodes.get(e.to)!.phantom) e.flags.push("phantom-target");

  // ambiguous: same source version -> two versions of the same target module
  const bySrcTgt = new Map<string, VersionEdge[]>();
  for (const e of edges) {
    if (e.status !== "active") continue;
    const k = `${e.from}|${e.targetModule}`;
    if (!bySrcTgt.has(k)) bySrcTgt.set(k, []);
    bySrcTgt.get(k)!.push(e);
  }
  for (const list of bySrcTgt.values()) if (list.length > 1) list.forEach((e) => e.flags.push("ambiguous-target"));

  const out = new Map<string, VersionEdge[]>();
  const inc = new Map<string, VersionEdge[]>();
  for (const e of edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from)!.push(e);
    if (!inc.has(e.to)) inc.set(e.to, []);
    inc.get(e.to)!.push(e);
  }

  // version-level cycles
  const activeAdj = new Map<string, string[]>();
  for (const e of edges) if (e.status === "active") {
    if (!activeAdj.has(e.from)) activeAdj.set(e.from, []);
    activeAdj.get(e.from)!.push(e.to);
  }
  const sccs = tarjan([...nodes.keys()], activeAdj);
  const inCycle = new Set<string>();
  for (const c of sccs) if (c.length > 1) c.forEach((k) => inCycle.add(k));
  for (const e of edges) if (e.status === "active" && (e.flags.includes("self") || (inCycle.has(e.from) && inCycle.has(e.to)))) e.flags.push("cycle");

  return { nodes, edges, out, inc };
}

/** Tarjan strongly connected components (iterative). */
export function tarjan(vertices: string[], adj: Map<string, string[]>): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  for (const v0 of vertices) {
    if (idx.has(v0)) continue;
    const work: [string, number][] = [[v0, 0]];
    while (work.length) {
      const [v, i] = work[work.length - 1];
      if (i === 0) {
        idx.set(v, index);
        low.set(v, index);
        index++;
        stack.push(v);
        onStack.add(v);
      }
      const ns = adj.get(v) ?? [];
      if (i < ns.length) {
        work[work.length - 1][1] = i + 1;
        const w = ns[i];
        if (!idx.has(w)) work.push([w, 0]);
        else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      } else {
        work.pop();
        if (work.length) {
          const p = work[work.length - 1][0];
          low.set(p, Math.min(low.get(p)!, low.get(v)!));
        }
        if (low.get(v) === idx.get(v)) {
          const comp: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            comp.push(w);
          } while (w !== v);
          out.push(comp);
        }
      }
    }
  }
  return out;
}

/** All version nodes reachable from `start` over active, non-self edges (excluding start). */
export function closure(g: VersionGraph, start: string): Set<string> {
  const seen = new Set<string>();
  const q = [start];
  while (q.length) {
    const v = q.pop()!;
    for (const e of g.out.get(v) ?? []) {
      if (e.status !== "active" || e.from === e.to) continue;
      if (!seen.has(e.to) && e.to !== start) {
        seen.add(e.to);
        q.push(e.to);
      }
    }
  }
  return seen;
}

/** All version nodes that (transitively) depend on `start`. */
export function dependents(g: VersionGraph, start: string): Set<string> {
  const seen = new Set<string>();
  const q = [start];
  while (q.length) {
    const v = q.pop()!;
    for (const e of g.inc.get(v) ?? []) {
      if (e.status !== "active" || e.from === e.to) continue;
      if (!seen.has(e.from) && e.from !== start) {
        seen.add(e.from);
        q.push(e.from);
      }
    }
  }
  return seen;
}
