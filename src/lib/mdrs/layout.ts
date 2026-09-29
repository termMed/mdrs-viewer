import type { ViewAnalysis } from "./analysis";
import type { ModuleInfo, VersionEdge, VersionNode } from "./types";

export const LANE_H = 62;
export const NODE_W = 74;
export const NODE_H = 22;
const COL_W = 88;
const PX_PER_DAY = 2.4;

export type XScale = "compact" | "calendar";

export interface LaneLayout {
  module: ModuleInfo;
  y: number;
  index: number;
}

export interface TimelineLayout {
  lanes: LaneLayout[];
  pos: Map<string, { x: number; y: number }>;
  nodes: VersionNode[];
  edges: VersionEdge[];
  ticks: { x: number; label: string; year: boolean }[];
  width: number;
  height: number;
}

function dayNum(et: string) {
  return Date.UTC(+et.slice(0, 4), +et.slice(4, 6) - 1, +et.slice(6, 8)) / 86400000;
}

export function computeTimeline(
  a: ViewAnalysis,
  opts: { scale: XScale; from?: string; to?: string; showRetracted: boolean; hideRedundant: boolean; onlyModules?: Set<string> },
): TimelineLayout {
  // which nodes: sources inside range + their targets
  const inRange = (et: string) => (!opts.from || et >= opts.from) && (!opts.to || et <= opts.to);
  const edges = a.graph.edges.filter(
    (e) =>
      inRange(e.sourceEt) &&
      (opts.showRetracted || e.status === "active") &&
      !(opts.hideRedundant && e.flags.includes("redundant") && !e.flags.some((f) => f === "conflict" || f === "cycle")) &&
      (!opts.onlyModules || (opts.onlyModules.has(e.sourceModule) && opts.onlyModules.has(e.targetModule))),
  );
  const keep = new Set<string>();
  edges.forEach((e) => {
    keep.add(e.from);
    keep.add(e.to);
  });
  // include source-only nodes in range that lost all edges through filtering
  for (const n of a.graph.nodes.values())
    if (n.asSource && inRange(n.et) && (!opts.onlyModules || opts.onlyModules.has(n.moduleId))) keep.add(n.key);
  const nodes = [...keep].map((k) => a.graph.nodes.get(k)!).filter(Boolean);

  const mods = [...new Set(nodes.map((n) => n.moduleId))].map((id) => a.modules.get(id)!);
  const tierOrder = { "int-core": 0, "int-derivative": 1, edition: 2, national: 3 } as const;
  mods.sort((x, y) => x.depth - y.depth || tierOrder[x.tier] - tierOrder[y.tier] || x.name.localeCompare(y.name));
  const lanes: LaneLayout[] = mods.map((m, i) => ({ module: m, y: i * LANE_H, index: i }));
  const laneY = new Map(lanes.map((l) => [l.module.id, l.y]));

  const dates = [...new Set(nodes.map((n) => n.et))].filter(Boolean).sort();
  const pos = new Map<string, { x: number; y: number }>();
  const ticks: TimelineLayout["ticks"] = [];
  let width = 0;
  if (opts.scale === "compact") {
    const col = new Map(dates.map((d, i) => [d, i]));
    for (const n of nodes) pos.set(n.key, { x: (col.get(n.et) ?? 0) * COL_W, y: (laneY.get(n.moduleId) ?? 0) + (LANE_H - NODE_H) / 2 });
    let lastYear = "";
    dates.forEach((d, i) => {
      const y = d.slice(0, 4);
      ticks.push({ x: i * COL_W, label: y !== lastYear ? `${y} · ${d.slice(4, 6)}-${d.slice(6)}` : `${d.slice(4, 6)}-${d.slice(6)}`, year: y !== lastYear });
      lastYear = y;
    });
    width = dates.length * COL_W;
  } else {
    const d0 = dates.length ? dayNum(dates[0]) : 0;
    const x = (et: string) => (dayNum(et) - d0) * PX_PER_DAY;
    for (const n of nodes) pos.set(n.key, { x: x(n.et), y: (laneY.get(n.moduleId) ?? 0) + (LANE_H - NODE_H) / 2 });
    if (dates.length) {
      const y0 = +dates[0].slice(0, 4);
      const y1 = +dates[dates.length - 1].slice(0, 4);
      for (let y = y0; y <= y1 + 1; y++) {
        for (const m of ["01", "04", "07", "10"]) {
          const et = `${y}${m}01`;
          if (et < dates[0].slice(0, 6) + "01") continue;
          ticks.push({ x: x(et), label: m === "01" ? `${y}` : `${m}`, year: m === "01" });
        }
      }
      width = x(dates[dates.length - 1]) + NODE_W;
    }
  }
  return { lanes, pos, nodes, edges, ticks, width, height: lanes.length * LANE_H };
}
