"use client";

import {
  BaseEdge,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type Viewport,
} from "@xyflow/react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ViewAnalysis } from "@/lib/mdrs/analysis";
import { LANE_H, NODE_H, NODE_W, computeTimeline, type XScale } from "@/lib/mdrs/layout";
import { fmtDate, shortName } from "@/lib/mdrs/names";
import type { EdgeFlag, Tier, VersionEdge } from "@/lib/mdrs/types";

export const TIER_VAR: Record<Tier, string> = {
  "int-core": "var(--t-core)",
  "int-derivative": "var(--t-deriv)",
  edition: "var(--t-edition)",
  national: "var(--t-national)",
};

export interface Highlight {
  selected?: string;
  up: Set<string>;
  down: Set<string>;
  hitNodes: Set<string>;
  hitRows: Set<string>;
}

type VData = { label: string; tier: Tier; cls: string; title: string };
type LaneData = { shade: boolean };

const VersionNodeView = memo(function VersionNodeView({ data }: NodeProps<Node<VData>>) {
  return (
    <div className={`vnode ${data.cls}`} style={{ ["--tier" as string]: TIER_VAR[data.tier], width: NODE_W, height: NODE_H }} title={data.title}>
      <Handle className="h" type="source" position={Position.Top} id="st" isConnectable={false} />
      <Handle className="h" type="source" position={Position.Bottom} id="sb" isConnectable={false} />
      <Handle className="h" type="target" position={Position.Top} id="tt" isConnectable={false} />
      <Handle className="h" type="target" position={Position.Bottom} id="tb" isConnectable={false} />
      {data.label}
    </div>
  );
});

function LaneNodeView({ data }: NodeProps<Node<LaneData>>) {
  return <div className="lanebg" style={{ background: data.shade ? "var(--lane-b)" : "var(--lane-a)" }} />;
}

type DepData = { kind: EdgeKind; loop: boolean; state: "up" | "down" | "hit" | "dim" | "none" };
type EdgeKind = "normal" | "error" | "phantom" | "retracted" | "redundant" | "conflict";

const KIND_STYLE: Record<EdgeKind, { color: string; dash?: string; w: number }> = {
  normal: { color: "var(--edge)", w: 1.3 },
  redundant: { color: "var(--edge)", dash: "2 3", w: 1.1 },
  error: { color: "var(--err)", w: 2 },
  conflict: { color: "var(--warn)", w: 2 },
  phantom: { color: "var(--warn)", dash: "5 4", w: 1.6 },
  retracted: { color: "var(--faint)", dash: "4 4", w: 1.1 },
};

function DepEdge(p: EdgeProps<Edge<DepData>>) {
  const d = p.data!;
  const ks = KIND_STYLE[d.kind];
  let color = ks.color;
  let width = ks.w;
  let opacity = 0.9;
  if (d.state === "up") (color = d.kind === "error" ? "var(--err)" : "var(--accent)"), (width = 2.2), (opacity = 1);
  else if (d.state === "down") (color = "var(--down)"), (width = 2.2), (opacity = 1);
  else if (d.state === "hit") (color = "var(--err)"), (width = 2.4), (opacity = 1);
  else if (d.state === "dim") opacity = 0.12;
  let path: string;
  if (d.loop) {
    const { sourceX: x1, sourceY: y1, targetX: x2, targetY: y2 } = p;
    const lift = x1 === x2 ? 34 : Math.min(60, 18 + Math.abs(x2 - x1) * 0.15);
    const dx = x1 === x2 ? 26 : 0;
    path = `M ${x1 - dx / 2} ${y1} C ${x1 - dx} ${y1 - lift}, ${x2 + dx} ${y2 - lift}, ${x2 + dx / 2} ${y2}`;
  } else {
    [path] = getBezierPath({
      sourceX: p.sourceX,
      sourceY: p.sourceY,
      targetX: p.targetX,
      targetY: p.targetY,
      sourcePosition: p.sourcePosition,
      targetPosition: p.targetPosition,
      curvature: 0.35,
    });
  }
  const marker = d.state === "up" ? "mk-up" : d.state === "down" ? "mk-down" : d.state === "hit" || d.kind === "error" ? "mk-err" : d.kind === "phantom" || d.kind === "conflict" ? "mk-warn" : "mk-edge";
  return (
    <BaseEdge
      id={p.id}
      path={path}
      markerEnd={`url(#${marker})`}
      style={{ stroke: color, strokeWidth: width, strokeDasharray: ks.dash, opacity }}
      interactionWidth={8}
    />
  );
}

const nodeTypes = { v: VersionNodeView, lane: LaneNodeView };
const edgeTypes = { dep: DepEdge };

function edgeKind(e: VersionEdge): EdgeKind {
  if (e.status === "retracted") return "retracted";
  const err: EdgeFlag[] = ["self", "cycle", "target-after-source", "ambiguous-target"];
  if (e.flags.some((f) => err.includes(f))) return "error";
  if (e.flags.includes("conflict")) return "conflict";
  if (e.flags.includes("phantom-target")) return "phantom";
  if (e.flags.includes("redundant")) return "redundant";
  return "normal";
}

export interface TimelineProps {
  analysis: ViewAnalysis;
  names: Record<string, string>;
  scale: XScale;
  from?: string;
  to?: string;
  showRetracted: boolean;
  hideRedundant: boolean;
  onlyModules?: Set<string>;
  highlight: Highlight;
  onSelect: (key: string | undefined) => void;
  resetKey: string;
}

function Inner(props: TimelineProps) {
  const { analysis, names, highlight } = props;
  const layout = useMemo(
    () =>
      computeTimeline(analysis, {
        scale: props.scale,
        from: props.from,
        to: props.to,
        showRetracted: props.showRetracted,
        hideRedundant: props.hideRedundant,
        onlyModules: props.onlyModules,
      }),
    [analysis, props.scale, props.from, props.to, props.showRetracted, props.hideRedundant, props.onlyModules],
  );
  const [vp, setVp] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const rf = useReactFlow();
  const box = useRef<HTMLDivElement>(null);

  const focusing = !!highlight.selected || highlight.hitNodes.size > 0 || highlight.hitRows.size > 0;

  const nodes = useMemo<Node[]>(() => {
    const bgW = layout.width + 4000;
    const lanes: Node[] = layout.lanes.map((l) => ({
      id: `lane:${l.module.id}`,
      type: "lane",
      position: { x: -2000, y: l.y },
      data: { shade: l.index % 2 === 1 },
      draggable: false,
      selectable: false,
      focusable: false,
      zIndex: -1,
      style: { width: bgW, height: LANE_H },
    }));
    const vs: Node[] = layout.nodes.map((n) => {
      const cls = [n.asSource ? "src" : "", n.phantom ? "phantom" : ""];
      if (highlight.selected === n.key) cls.push("sel");
      else if (highlight.up.has(n.key)) cls.push("up");
      else if (highlight.down.has(n.key)) cls.push("down");
      else if (highlight.hitNodes.has(n.key)) cls.push("hit");
      else if (focusing) cls.push("dim");
      const m = analysis.modules.get(n.moduleId)!;
      return {
        id: n.key,
        type: "v",
        position: layout.pos.get(n.key)!,
        draggable: false,
        data: {
          label: fmtDate(n.et),
          tier: m.tier,
          cls: cls.join(" "),
          title: `${m.name} (${n.moduleId})\nversion ${fmtDate(n.et)}${n.phantom ? "\n⚠ no MDRS row describes this version as released" : ""}${!n.asSource ? "\n(referenced as target only)" : ""}`,
        },
      };
    });
    return [...lanes, ...vs];
  }, [layout, highlight, focusing, analysis]);

  const edges = useMemo<Edge[]>(() => {
    const laneIdx = new Map(layout.lanes.map((l) => [l.module.id, l.index]));
    return layout.edges.map((e) => {
      const si = laneIdx.get(e.sourceModule)!;
      const ti = laneIdx.get(e.targetModule)!;
      const loop = si === ti;
      const up = ti < si;
      let state: DepData["state"] = "none";
      const inUp = (k: string) => k === highlight.selected || highlight.up.has(k);
      const inDown = (k: string) => k === highlight.selected || highlight.down.has(k);
      if (highlight.selected && inUp(e.from) && inUp(e.to) && e.status === "active") state = "up";
      else if (highlight.selected && inDown(e.from) && inDown(e.to) && e.status === "active") state = "down";
      else if (highlight.hitRows.size && e.rows.some((r) => highlight.hitRows.has(r.id))) state = "hit";
      else if (focusing) state = "dim";
      return {
        id: e.key,
        source: e.from,
        target: e.to,
        sourceHandle: loop ? "st" : up ? "st" : "sb",
        targetHandle: loop ? "tt" : up ? "tb" : "tt",
        type: "dep",
        data: { kind: edgeKind(e), loop, state },
        zIndex: state === "none" || state === "dim" ? 0 : 5,
        selectable: false,
      } satisfies Edge<DepData>;
    });
  }, [layout, highlight, focusing]);

  // initial viewport: show the latest releases (right edge), lanes fully visible when possible
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const W = el.clientWidth || 800;
    const H = el.clientHeight || 400;
    const zoom = Math.max(0.45, Math.min(1, (H - 20) / Math.max(layout.height, 1), (W - 40) / Math.max(layout.width, 1)));
    const x = Math.min(24, W - 40 - layout.width * zoom);
    const v = { x, y: 8, zoom };
    rf.setViewport(v);
    setVp(v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.resetKey, layout.width, layout.height]);

  return (
    <div className="timeline">
      <div className="axis-corner">
        <span className="eyebrow">Module · version</span>
      </div>
      <div className="axis">
        {(() => {
          let last = -1e9;
          return layout.ticks.map((t, i) => {
          const left = t.x * vp.zoom + vp.x;
          if (left < -120 || left > 6000) return null;
          const gap = t.year ? 60 : 64;
          if (left - last < gap) return null;
          last = left;
          return (
            <div key={i} className={`tick ${t.year ? "year" : ""}`} style={{ left }}>
              {t.label}
            </div>
          );
          });
        })()}
      </div>
      <div className="lanes">
        {layout.lanes.map((l) => (
          <div
            key={l.module.id}
            className="lane-label"
            style={{ top: l.y * vp.zoom + vp.y, height: LANE_H * vp.zoom, ["--tier" as string]: TIER_VAR[l.module.tier] }}
            title={`${l.module.name}\n${l.module.id} · namespace ${l.module.namespace}\n${l.module.versions.length} version(s) described in this view`}
          >
            <span className="ln">{shortName(l.module.id, names)}</span>
            {vp.zoom > 0.55 && (
              <span className="li">
                {l.module.id} · {l.module.versions.length}v
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="canvas" ref={box}>
        <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden>
          <defs>
            {[
              ["mk-edge", "var(--edge)"],
              ["mk-up", "var(--accent)"],
              ["mk-down", "var(--down)"],
              ["mk-err", "var(--err)"],
              ["mk-warn", "var(--warn)"],
            ].map(([id, c]) => (
              <marker key={id} id={id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" style={{ fill: c }} />
              </marker>
            ))}
          </defs>
        </svg>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onMove={(_, v) => setVp(v)}
          onNodeClick={(_, n) => n.type === "v" && props.onSelect(n.id === highlight.selected ? undefined : n.id)}
          onPaneClick={() => props.onSelect(undefined)}
          minZoom={0.05}
          maxZoom={2.5}
          nodesConnectable={false}
          nodesDraggable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Controls showInteractive={false} position="bottom-left" />
          <MiniMap pannable zoomable nodeColor={(n) => (n.type === "lane" ? "transparent" : "#8c97a4")} position="bottom-right" />
        </ReactFlow>
      </div>
    </div>
  );
}

export default function Timeline(props: TimelineProps) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
