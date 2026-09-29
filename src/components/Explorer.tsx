"use client";

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { analyseRows, namesOf, profilePackage, type ViewAnalysis } from "@/lib/mdrs/analysis";
import { availableViews, buildGraph, buildRegistry, closure, dependents, fileFor, rowsForView } from "@/lib/mdrs/graph";
import { TIER_LABEL, fmtDate, moduleName, shortName } from "@/lib/mdrs/names";
import { groupIntoPackages, parseAny, parseSnowstormJson } from "@/lib/mdrs/parse";
import type { ClosurePolicy, Finding, Package, SourceFile, Tier, ViewMode } from "@/lib/mdrs/types";
import type { XScale } from "@/lib/mdrs/layout";
import type { Highlight } from "./Timeline";

// graph components touch the DOM (React Flow, ELK) and are loaded on the client only
const Timeline = lazy(() => import("./Timeline"));
const ModuleGraph = lazy(() => import("./ModuleGraph"));

const TIER_VAR: Record<Tier, string> = {
  "int-core": "var(--t-core)",
  "int-derivative": "var(--t-deriv)",
  edition: "var(--t-edition)",
  national: "var(--t-national)",
};

type Tab = "timeline" | "modules" | "findings" | "rows" | "compare";

const VIEW_LABEL: Record<ViewMode, string> = {
  full: "Full",
  snapshot: "Snapshot",
  delta: "Delta",
  json: "Snowstorm JSON",
  derived: "Snapshot as of…",
};

const DEFAULT_PKG = "DEMOB_20260531";

export default function Explorer() {
  const [packages, setPackages] = useState<Package[]>([]);
  const [selKey, setSelKey] = useState<string>("");
  const [view, setView] = useState<ViewMode>("full");
  const [asOf, setAsOf] = useState<string>("");
  const [policy, setPolicy] = useState<ClosurePolicy>("direct-only");
  const [tab, setTab] = useState<Tab>("timeline");
  const [scale, setScale] = useState<XScale>("compact");
  const [fromYear, setFromYear] = useState<string>("auto");
  const [showRetracted, setShowRetracted] = useState(true);
  const [hideRedundant, setHideRedundant] = useState(false);
  const [selected, setSelected] = useState<string | undefined>();
  const [hit, setHit] = useState<Finding | undefined>();
  const [loadError, setLoadError] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [showRemote, setShowRemote] = useState(false);
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadSamples = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const list: string[] = await (await fetch("samples/manifest.json")).json();
      const files = await Promise.all(
        list.map(async (n) => {
          const t = await (await fetch(`samples/${encodeURIComponent(n)}`)).text();
          return parseAny(t, n);
        }),
      );
      const pk = groupIntoPackages(files);
      setPackages(pk);
      setSelKey((k) => k || (pk.find((p) => p.key === DEFAULT_PKG)?.key ?? pk[0]?.key ?? ""));
    } catch (e) {
      setLoadError(`Could not load the sample packages (${(e as Error).message}). Upload MDRS files instead.`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSamples();
  }, [loadSamples]);

  const addFiles = useCallback(async (fl: FileList | File[]) => {
    const arr = [...fl];
    const parsed: SourceFile[] = [];
    const errs: string[] = [];
    for (const f of arr) {
      try {
        parsed.push(parseAny(await f.text(), f.name));
      } catch (e) {
        errs.push(`${f.name}: ${(e as Error).message}`);
      }
    }
    setLoadError(errs.join(" · "));
    if (!parsed.length) return;
    setPackages((prev) => {
      const next = groupIntoPackages(parsed, prev);
      return next;
    });
    const { packageFromName } = await import("@/lib/mdrs/parse");
    setSelKey(packageFromName(parsed[0].name).key);
    setView(parsed[0].kind === "json" ? "json" : parsed[0].kind);
    setSelected(undefined);
    setHit(undefined);
  }, []);

  const pkg = packages.find((p) => p.key === selKey);
  const views = pkg ? availableViews(pkg) : [];
  const effView: ViewMode = pkg && views.includes(view) ? view : (views[0] ?? "full");

  const registry = useMemo(() => buildRegistry(packages), [packages]);
  const workspace = useMemo(() => buildGraph(packages.flatMap((p) => p.files.flatMap((f) => f.rows)), registry), [packages, registry]);
  const names = useMemo(() => (pkg ? namesOf(pkg) : {}), [pkg]);

  const releaseDates = useMemo(() => {
    const f = pkg && fileFor(pkg, "full");
    return f ? [...new Set(f.rows.map((r) => r.effectiveTime).filter(Boolean))].sort().reverse() : [];
  }, [pkg]);

  const analysis: ViewAnalysis | undefined = useMemo(() => {
    if (!pkg) return undefined;
    const rows = rowsForView(pkg, effView, effView === "derived" || effView === "full" ? asOf || undefined : undefined);
    return analyseRows(rows, registry, { policy, view: effView, names, workspace });
  }, [pkg, effView, asOf, registry, policy, names, workspace]);

  const profiles = useMemo(() => packages.map((p) => profilePackage(p, registry, policy, workspace)), [packages, registry, policy, workspace]);

  // default time window: Full views start 3 calendar years before the latest release
  const years = useMemo(() => {
    if (!analysis) return [];
    return [...new Set([...analysis.graph.nodes.values()].map((n) => n.et.slice(0, 4)))].filter(Boolean).sort();
  }, [analysis]);
  const from = useMemo(() => {
    if (fromYear === "all") return undefined;
    if (fromYear !== "auto") return `${fromYear}0101`;
    if (effView === "full" && analysis?.stats.dateMax) return `${+analysis.stats.dateMax.slice(0, 4) - 2}0101`;
    return undefined;
  }, [fromYear, effView, analysis]);

  const highlight: Highlight = useMemo(() => {
    const h: Highlight = { selected, up: new Set(), down: new Set(), hitNodes: new Set(), hitRows: new Set() };
    if (analysis && selected && analysis.graph.nodes.has(selected)) {
      h.up = closure(analysis.graph, selected);
      h.down = dependents(analysis.graph, selected);
    } else h.selected = undefined;
    if (hit) {
      hit.nodes?.forEach((k) => h.hitNodes.add(k));
      hit.rowIds?.forEach((k) => h.hitRows.add(k));
    }
    return h;
  }, [analysis, selected, hit]);

  const selectPkg = (k: string) => {
    setSelKey(k);
    setSelected(undefined);
    setHit(undefined);
    setAsOf("");
    setFromYear("auto");
  };

  const counts = (key: string) => {
    const pr = profiles.find((p) => p.key === key);
    return pr ? { e: pr.errors, w: pr.warnings } : { e: 0, w: 0 };
  };

  return (
    <div
      className="shell"
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
      }}
    >
      <header className="topbar">
        <div className="brand">
          <h1>MDRS Explorer</h1>
          <small>module versions, not modules</small>
        </div>
        <div className="spacer" />
        <label className="field" htmlFor="policy">
          Closure policy
          <select id="policy" value={policy} onChange={(e) => setPolicy(e.target.value as ClosurePolicy)}>
            <option value="direct-only">Direct only (transitive implied)</option>
            <option value="explicit-closure">Explicit closure required</option>
          </select>
        </label>
        <button className="btn" onClick={() => setShowRemote(true)}>
          Snowstorm JSON…
        </button>
        <button className="btn primary" onClick={() => fileInput.current?.click()}>
          Upload MDRS files
        </button>
        <input
          ref={fileInput}
          id="file-input"
          type="file"
          multiple
          accept=".txt,.json,text/plain,application/json"
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </header>

      <div className="body">
        <aside className="rail">
          <div className={`dropzone ${over ? "over" : ""}`}>
            Drop <code>der2_ssRefset_ModuleDependency…Full/Snapshot</code> files or Snowstorm <code>members</code> JSON here. Files stay in your browser.
          </div>
          {loadError && <p className="err-text" style={{ margin: 0, fontSize: 12.5 }}>{loadError}</p>}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="eyebrow">Packages ({packages.length})</span>
            <span style={{ display: "flex", gap: 4 }}>
              <button className="btn small" onClick={loadSamples} disabled={loading}>
                {loading ? "Loading…" : "Samples"}
              </button>
              <button
                className="btn small"
                onClick={() => {
                  setPackages([]);
                  setSelKey("");
                }}
              >
                Clear
              </button>
            </span>
          </div>
          {packages.map((p) => {
            const c = counts(p.key);
            return (
              <button key={p.key} className="pkg" aria-current={p.key === selKey} onClick={() => selectPkg(p.key)}>
                <span className="name">{p.label}</span>
                <span className="meta">
                  {p.files.map((f) => (
                    <span key={f.kind} className="chip">
                      {f.kind} · {f.rows.length}
                    </span>
                  ))}
                  {c.e > 0 && <span className="chip err">{c.e} error{c.e > 1 ? "s" : ""}</span>}
                  {c.w > 0 && <span className="chip warn">{c.w} warning{c.w > 1 ? "s" : ""}</span>}
                </span>
              </button>
            );
          })}
          {!packages.length && !loading && <p className="note">No packages loaded. Upload files or load the samples.</p>}
        </aside>

        <main className="work">
          <nav className="tabs" role="tablist">
            {(
              [
                ["timeline", "Version timeline"],
                ["modules", "Module graph"],
                ["findings", `Findings${analysis ? ` (${analysis.findings.filter((f) => f.severity !== "info").length})` : ""}`],
                ["rows", "Rows"],
                ["compare", "Compare practices"],
              ] as [Tab, string][]
            ).map(([t, l]) => (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
                {l}
              </button>
            ))}
          </nav>

          {tab !== "compare" && pkg && (
            <div className="controls">
              <div className="seg" role="group" aria-label="View">
                {(["full", "snapshot", "delta", "json", "derived"] as ViewMode[])
                  .filter((v) => views.includes(v))
                  .map((v) => (
                    <button key={v} aria-pressed={effView === v} onClick={() => setView(v)}>
                      {VIEW_LABEL[v]}
                    </button>
                  ))}
              </div>
              {(effView === "derived" || effView === "full") && releaseDates.length > 0 && (
                <label className="field" htmlFor="asof">
                  {effView === "full" ? "Rows published up to" : "As of release"}
                  <select id="asof" value={asOf} onChange={(e) => setAsOf(e.target.value)}>
                    <option value="">latest ({fmtDate(releaseDates[0])})</option>
                    {releaseDates.slice(1).map((d) => (
                      <option key={d} value={d}>
                        {fmtDate(d)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {tab === "timeline" && (
                <>
                  <div className="seg" role="group" aria-label="Time scale">
                    <button aria-pressed={scale === "compact"} onClick={() => setScale("compact")}>
                      Release order
                    </button>
                    <button aria-pressed={scale === "calendar"} onClick={() => setScale("calendar")}>
                      Calendar
                    </button>
                  </div>
                  <label className="field" htmlFor="from">
                    From
                    <select id="from" value={fromYear} onChange={(e) => setFromYear(e.target.value)}>
                      <option value="auto">{effView === "full" ? "last 3 years" : "all"}</option>
                      <option value="all">all</option>
                      {years.map((y) => (
                        <option key={y} value={y}>
                          {y}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field" htmlFor="retr">
                    <input id="retr" type="checkbox" checked={showRetracted} onChange={(e) => setShowRetracted(e.target.checked)} /> inactive rows
                  </label>
                  <label className="field" htmlFor="red">
                    <input id="red" type="checkbox" checked={hideRedundant} onChange={(e) => setHideRedundant(e.target.checked)} /> hide explicit-transitive arrows
                  </label>
                </>
              )}
              {hit && (
                <span className="chip err" style={{ cursor: "pointer" }} onClick={() => setHit(undefined)}>
                  Highlighting {hit.code} ✕
                </span>
              )}
            </div>
          )}

          <div className={`content ${tab === "compare" || tab === "modules" ? "noinspector" : ""}`}>
            <div className="pane" style={tab === "timeline" || tab === "modules" ? { overflow: "hidden" } : undefined}>
              <Suspense fallback={<p className="empty">Loading graph…</p>}>
              {!pkg || !analysis ? (
                tab === "compare" ? (
                  <Compare profiles={profiles} onOpen={(k) => (selectPkg(k), setTab("timeline"))} />
                ) : (
                  <p className="empty">Load MDRS files to begin.</p>
                )
              ) : tab === "timeline" ? (
                analysis.graph.edges.length ? (
                  <Timeline
                    analysis={analysis}
                    names={names}
                    scale={scale}
                    from={from}
                    showRetracted={showRetracted}
                    hideRedundant={hideRedundant}
                    highlight={highlight}
                    onSelect={(k) => {
                      setSelected(k);
                      if (k) setHit(undefined);
                    }}
                    resetKey={`${pkg.key}|${effView}|${asOf}|${scale}|${fromYear}`}
                  />
                ) : (
                  <p className="empty">No rows in this view.</p>
                )
              ) : tab === "modules" ? (
                <ModuleGraph analysis={analysis} names={names} />
              ) : tab === "findings" ? (
                <Findings
                  findings={analysis.findings}
                  onShow={(f) => {
                    setHit(f);
                    setSelected(undefined);
                    setTab("timeline");
                    setFromYear("all");
                  }}
                />
              ) : tab === "rows" ? (
                <Rows analysis={analysis} names={names} onPick={(k) => (setSelected(k), setTab("timeline"))} />
              ) : (
                <Compare profiles={profiles} onOpen={(k) => (selectPkg(k), setTab("timeline"))} />
              )}
              </Suspense>
            </div>
            {tab !== "compare" && tab !== "modules" && pkg && analysis && (
              <Inspector analysis={analysis} names={names} selected={highlight.selected} onSelect={setSelected} policy={policy} pkg={pkg} view={effView} />
            )}
          </div>
        </main>
      </div>

      {showRemote && <RemoteDialog onClose={() => setShowRemote(false)} onLoaded={(f) => (addFiles([f]), setShowRemote(false))} />}
    </div>
  );
}

// ------------------------------------------------------------------ inspector

function Inspector({
  analysis,
  names,
  selected,
  onSelect,
  policy,
  pkg,
  view,
}: {
  analysis: ViewAnalysis;
  names: Record<string, string>;
  selected?: string;
  onSelect: (k?: string) => void;
  policy: ClosurePolicy;
  pkg: Package;
  view: ViewMode;
}) {
  const nm = (k: string) => {
    const [m, d] = k.split("@");
    return (
      <>
        <button onClick={() => onSelect(k)}>{shortName(m, names)}</button> <span className="mono">{fmtDate(d)}</span>
      </>
    );
  };
  if (!selected) {
    const s = analysis.stats;
    const f = fileFor(pkg, view);
    return (
      <aside className="inspector">
        <section>
          <span className="eyebrow">{VIEW_LABEL[view]} view</span>
          <h3>{pkg.label}</h3>
          <div className="meta" style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            <span className="chip">{s.rows} rows</span>
            <span className="chip">{s.ids} member ids</span>
            <span className="chip">{s.versionEdges} version dependencies</span>
            {s.inactive > 0 && <span className="chip warn">{s.inactive} inactive</span>}
          </div>
          <p className="note" style={{ fontSize: 12.5 }}>
            Published {fmtDate(s.dateMin)} → {fmtDate(s.dateMax)}
            {f?.warnings.length ? ` · ${f.warnings.join(" · ")}` : ""}
          </p>
        </section>
        <section>
          <span className="eyebrow">What the latest release needs</span>
          {analysis.ownModules.map((m) => {
            const last = analysis.modules.get(m)!.versions.at(-1)!;
            const c = analysis.closures.find((x) => x.moduleId === m && x.et === last);
            if (!c) return null;
            return (
              <div key={m} style={{ display: "grid", gap: 4 }}>
                <div>
                  <button className="btn small" onClick={() => onSelect(c.node)}>
                    {shortName(m, names)} <span className="mono">{fmtDate(last)}</span>
                  </button>
                </div>
                <ul className="deplist">
                  {c.direct.map((k) => (
                    <li key={k}>
                      {nm(k)}
                      <span className="chip">declared</span>
                    </li>
                  ))}
                  {c.implicitModules.map((i) => (
                    <li key={i.moduleId}>
                      <span>{shortName(i.moduleId, names)}</span> <span className="mono">{i.versions.map(fmtDate).join(", ")}</span>
                      <span className={`chip ${policy === "explicit-closure" ? "warn" : "info"}`}>implied</span>
                    </li>
                  ))}
                  {c.conflicts.map((x) => (
                    <li key={x.moduleId}>
                      <span>{shortName(x.moduleId, names)}</span> <span className="mono">{x.versions.map(fmtDate).join(" vs ")}</span>
                      <span className="chip err">conflict</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </section>
        <Legend />
      </aside>
    );
  }
  const n = analysis.graph.nodes.get(selected)!;
  const m = analysis.modules.get(n.moduleId)!;
  const c = analysis.closures.find((x) => x.node === selected);
  const outs = analysis.graph.out.get(selected) ?? [];
  const ins = analysis.graph.inc.get(selected) ?? [];
  return (
    <aside className="inspector">
      <section>
        <span className="eyebrow" style={{ color: TIER_VAR[m.tier] }}>
          {TIER_LABEL[m.tier]}
        </span>
        <h3>{moduleName(n.moduleId, names)}</h3>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          <span className="chip mono">{n.moduleId}</span>
          <span className="chip ok mono">version {fmtDate(n.et)}</span>
          {n.phantom && <span className="chip warn">not a described release</span>}
          {!n.asSource && <span className="chip">target only</span>}
        </div>
        <button className="btn small" style={{ justifySelf: "start" }} onClick={() => onSelect(undefined)}>
          Clear selection
        </button>
      </section>
      <section>
        <span className="eyebrow">Declared dependencies ({outs.length})</span>
        {outs.length ? (
          <ul className="deplist">
            {outs.map((e) => (
              <li key={e.key}>
                {nm(e.to)}
                {e.status === "retracted" && <span className="chip warn">inactivated</span>}
                {e.flags
                  .filter((f) => f !== "redundant")
                  .map((f) => (
                    <span key={f} className={`chip ${["self", "cycle", "target-after-source", "ambiguous-target"].includes(f) ? "err" : "warn"}`}>
                      {f}
                    </span>
                  ))}
                {e.flags.includes("redundant") && <span className="chip">also transitive</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="note">No MDRS rows in this view describe this version as a source.</p>
        )}
      </section>
      {c && c.implicitModules.length > 0 && (
        <section>
          <span className="eyebrow">Implied through other modules</span>
          <ul className="deplist">
            {c.implicitModules.map((i) => (
              <li key={i.moduleId}>
                {shortName(i.moduleId, names)} <span className="mono">{i.versions.map(fmtDate).join(", ")}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {c && c.conflicts.length > 0 && (
        <section>
          <span className="eyebrow" style={{ color: "var(--err)" }}>
            Version conflicts in closure
          </span>
          <ul className="deplist">
            {c.conflicts.map((x) => (
              <li key={x.moduleId}>
                {shortName(x.moduleId, names)} <span className="mono">{x.versions.map(fmtDate).join(" vs ")}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <span className="eyebrow">Required by ({ins.filter((e) => e.from !== e.to).length})</span>
        {ins.length ? (
          <ul className="deplist">
            {ins
              .filter((e) => e.from !== e.to)
              .sort((a, b) => b.sourceEt.localeCompare(a.sourceEt))
              .slice(0, 40)
              .map((e) => (
                <li key={e.key}>
                  {nm(e.from)}
                  {e.status === "retracted" && <span className="chip warn">inactivated</span>}
                </li>
              ))}
          </ul>
        ) : (
          <p className="note">Nothing in this view depends on this version.</p>
        )}
      </section>
      <section>
        <span className="eyebrow">Rows</span>
        <div className="tablewrap">
          <table className="grid">
            <thead>
              <tr>
                <th>id</th>
                <th>effectiveTime</th>
                <th>act</th>
                <th>target</th>
              </tr>
            </thead>
            <tbody>
              {outs.flatMap((e) =>
                e.rows.map((r) => (
                  <tr key={`${r.id}${r.effectiveTime}${r.line}`} className={r.active ? "" : "inactive"}>
                    <td className="mono" title={r.id}>
                      {r.id.slice(0, 8)}
                    </td>
                    <td className="mono">{r.effectiveTime || "—"}</td>
                    <td>{r.active ? "1" : "0"}</td>
                    <td className="mono">
                      {shortName(r.referencedComponentId, names)}@{r.targetEffectiveTime}
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      </section>
    </aside>
  );
}

function Legend() {
  return (
    <section>
      <span className="eyebrow">Reading the timeline</span>
      <div className="legend" style={{ display: "grid", gap: 6 }}>
        <span>Each lane is a module; each box is one module version (its sourceEffectiveTime). Arrows run from the dependent version to the exact target version.</span>
        {(Object.keys(TIER_VAR) as Tier[]).map((t) => (
          <span key={t}>
            <b style={{ background: TIER_VAR[t] }} />
            {TIER_LABEL[t]}
          </span>
        ))}
        <span>
          <i />
          declared dependency
        </span>
        <span>
          <i className="dot" />
          declared, also reachable transitively
        </span>
        <span>
          <i className="dash" style={{ borderTopColor: "var(--warn)" }} />
          target version not described as released
        </span>
        <span>
          <i style={{ borderTopColor: "var(--warn)" }} />
          involved in a version conflict
        </span>
        <span>
          <i style={{ borderTopColor: "var(--err)" }} />
          self-dependency, cycle, target after source
        </span>
        <span>
          <i className="dash" style={{ borderTopColor: "var(--faint)" }} />
          inactivated row
        </span>
        <span>Click a version to trace what it needs (blue) and what needs it (pink).</span>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ findings

function Findings({ findings, onShow }: { findings: Finding[]; onShow: (f: Finding) => void }) {
  if (!findings.length) return <p className="empty">No findings for this view.</p>;
  return (
    <div className="findings">
      {findings.map((f, i) => (
        <article key={i} className={`finding ${f.severity}`}>
          <div className="stripe" />
          <div className="fb">
            <div className="ft">
              <span className={`chip ${f.severity === "error" ? "err" : f.severity === "warning" ? "warn" : "info"}`}>{f.severity}</span>
              <span className="mono" style={{ color: "var(--muted)", fontWeight: 400 }}>
                {f.code}
              </span>
              <span>{f.title}</span>
              {(f.nodes?.length || f.rowIds?.length) && (
                <button className="btn small" onClick={() => onShow(f)}>
                  Show on timeline
                </button>
              )}
            </div>
            <p>{f.detail}</p>
          </div>
        </article>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ rows

function Rows({ analysis, names, onPick }: { analysis: ViewAnalysis; names: Record<string, string>; onPick: (k: string) => void }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"source" | "et">("source");
  const flagOf = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const e of analysis.graph.edges) for (const r of e.rows) m.set(`${r.id}|${r.effectiveTime}|${r.line}`, e.flags);
    return m;
  }, [analysis]);
  const rows = useMemo(() => {
    const ql = q.toLowerCase();
    const r = analysis.rows.filter(
      (x) =>
        !ql ||
        [x.id, x.effectiveTime, x.moduleId, x.referencedComponentId, x.sourceEffectiveTime, x.targetEffectiveTime, moduleName(x.moduleId, names), moduleName(x.referencedComponentId, names)]
          .join(" ")
          .toLowerCase()
          .includes(ql),
    );
    return [...r].sort((a, b) =>
      sort === "et"
        ? b.effectiveTime.localeCompare(a.effectiveTime)
        : a.moduleId.localeCompare(b.moduleId) || b.sourceEffectiveTime.localeCompare(a.sourceEffectiveTime) || a.referencedComponentId.localeCompare(b.referencedComponentId),
    );
  }, [analysis, q, sort, names]);
  return (
    <div className="pad">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <label className="field" htmlFor="rowq">
          Filter
          <input id="rowq" type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="id, module, date…" />
        </label>
        <div className="seg">
          <button aria-pressed={sort === "source"} onClick={() => setSort("source")}>
            By source module
          </button>
          <button aria-pressed={sort === "et"} onClick={() => setSort("et")}>
            By effectiveTime
          </button>
        </div>
        <span className="note">{rows.length} rows</span>
      </div>
      <div className="tablewrap">
        <table className="grid">
          <thead>
            <tr>
              <th>id</th>
              <th>effectiveTime</th>
              <th>active</th>
              <th>moduleId (source)</th>
              <th>sourceEffectiveTime</th>
              <th>referencedComponentId (target)</th>
              <th>targetEffectiveTime</th>
              <th>flags</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.id}|${r.effectiveTime}|${r.line}`} className={r.active ? "" : "inactive"} onClick={() => onPick(`${r.moduleId}@${r.sourceEffectiveTime}`)} style={{ cursor: "pointer" }}>
                <td className="mono" title={r.id}>
                  {r.id.slice(0, 8)}…
                </td>
                <td className="mono">
                  {r.effectiveTime || "—"}
                  {r.released === false && <span className="chip warn">unreleased</span>}
                </td>
                <td>{r.active ? 1 : 0}</td>
                <td>
                  {shortName(r.moduleId, names)} <span className="mono" style={{ color: "var(--muted)" }}>{r.moduleId}</span>
                </td>
                <td className="mono">{r.sourceEffectiveTime}</td>
                <td>
                  {shortName(r.referencedComponentId, names)} <span className="mono" style={{ color: "var(--muted)" }}>{r.referencedComponentId}</span>
                </td>
                <td className="mono">{r.targetEffectiveTime}</td>
                <td>
                  <span style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                    {(flagOf.get(`${r.id}|${r.effectiveTime}|${r.line}`) ?? []).map((f) => (
                      <span key={f} className={`chip ${["self", "cycle", "target-after-source", "ambiguous-target"].includes(f) ? "err" : f === "redundant" ? "" : "warn"}`}>
                        {f}
                      </span>
                    ))}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ compare

function Compare({ profiles, onOpen }: { profiles: ReturnType<typeof profilePackage>[]; onOpen: (k: string) => void }) {
  const rowsDef: [string, (p: (typeof profiles)[number]) => React.ReactNode][] = [
    ["Files", (p) => p.views.join(" + ")],
    ["Own modules", (p) => p.leafModules.length],
    ["Member id strategy", (p) => p.idStrategy],
    ["Snapshot content", (p) => p.snapshotScope],
    ["Snapshot = derived from Full", (p) => p.snapshotMatchesFull],
    ["Upstream rows redistributed", (p) => p.upstreamRows],
    ["Transitive dependencies (latest)", (p) => p.closureStyle],
    ["Chain verifiable within file", (p) => p.selfContained],
    ["Cycles", (p) => num(p.cycles, "err")],
    ["Self-dependencies", (p) => num(p.selfDeps, "err")],
    ["Target later than source", (p) => num(p.targetAfterSource, "err")],
    ["Versions with conflicting closure", (p) => num(p.conflicts, "err")],
    ["Target versions not described", (p) => num(p.phantomTargets, "warn")],
    ["effectiveTime ≠ sourceEffectiveTime", (p) => num(p.etMismatch, "warn")],
    ["Inactivated version rows", (p) => num(p.retracted, "warn")],
  ];
  return (
    <div className="pad">
      <p className="note">
        Maintenance practices side by side, computed from each package&apos;s Full file (Snapshot or JSON where no Full was loaded). Target versions are checked against every module version described anywhere in the loaded workspace, so loading the International release makes the check stricter for everyone.
      </p>
      <div className="tablewrap">
        <table className="grid compare">
          <thead>
            <tr>
              <th>Practice</th>
              {profiles.map((p) => (
                <th key={p.key}>
                  <button className="btn small" onClick={() => onOpen(p.key)}>
                    {p.label}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowsDef.map(([l, f]) => (
              <tr key={l}>
                <td>
                  <strong>{l}</strong>
                </td>
                {profiles.map((p) => (
                  <td key={p.key}>{f(p)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function num(n: number, sev: "err" | "warn") {
  return n ? <span className={`chip ${sev}`}>{n}</span> : <span style={{ color: "var(--faint)" }}>0</span>;
}

// ------------------------------------------------------------------ remote / paste

function RemoteDialog({ onClose, onLoaded }: { onClose: () => void; onLoaded: (f: File) => void }) {
  const [url, setUrl] = useState("https://snowstorm.example.org/snowstorm/snomed-ct/MAIN/SNOMEDCT-XX/members?referenceSet=900000000000534007&limit=1000");
  const [text, setText] = useState("");
  const [name, setName] = useState("Snowstorm_MDRS.json");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const fetchIt = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const t = await r.text();
      parseSnowstormJson(t, name);
      onLoaded(new File([t], name));
    } catch (e) {
      setErr(
        `The server did not return JSON to this page (${(e as Error).message}). Public Snowstorm instances usually block cross-site requests or require a human check. Open the URL in a browser tab, copy the JSON, and paste it below.`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Load Snowstorm JSON">
        <h3 style={{ margin: 0 }}>Load MDRS from Snowstorm</h3>
        <p className="note">
          Use the <code>members</code> endpoint with <code>referenceSet=900000000000534007</code>. Leave <code>active</code> unset to also see inactivated members, and raise <code>limit</code> above the total.
        </p>
        <label htmlFor="rurl" className="eyebrow">
          Members URL
        </label>
        <input id="rurl" value={url} onChange={(e) => setUrl(e.target.value)} />
        <div>
          <button className="btn" onClick={fetchIt} disabled={busy}>
            {busy ? "Fetching…" : "Fetch"}
          </button>
        </div>
        <label htmlFor="rname" className="eyebrow">
          Package name
        </label>
        <input id="rname" value={name} onChange={(e) => setName(e.target.value)} />
        <label htmlFor="rjson" className="eyebrow">
          Or paste the JSON response
        </label>
        <textarea id="rjson" value={text} onChange={(e) => setText(e.target.value)} placeholder='{"items":[ … ], "total": …}' />
        {err && <p className="err-text" style={{ margin: 0 }}>{err}</p>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!text.trim()}
            onClick={() => {
              try {
                parseSnowstormJson(text, name);
                onLoaded(new File([text], name.endsWith(".json") ? name : `${name}.json`));
              } catch (e) {
                setErr(`That text is not valid JSON: ${(e as Error).message}`);
              }
            }}
          >
            Load pasted JSON
          </button>
        </div>
      </div>
    </div>
  );
}
