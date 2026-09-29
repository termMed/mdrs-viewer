"use client";

import { BaseEdge, Controls, EdgeLabelRenderer, Handle, Position, ReactFlow, ReactFlowProvider, type Edge, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import ELK, { type ElkExtendedEdge } from "elkjs/lib/elk.bundled.js";
import { useEffect, useState } from "react";
import type { ViewAnalysis } from "@/lib/mdrs/analysis";
import { TIER_LABEL, fmtDate, shortName } from "@/lib/mdrs/names";
import type { Tier } from "@/lib/mdrs/types";
import { TIER_VAR } from "./Timeline";

type MData = { name: string; id: string; tier: Tier; versions: number; first?: string; last?: string; cyc: boolean };
type EData = { points: { x: number; y: number }[]; label: string; bad: boolean; retractedOnly: boolean };

function ModuleNode({ data }: NodeProps<Node<MData>>) {
  return (
    <div
      style={{
        width: 230,
        minHeight: 64,
        border: `1.5px solid ${data.cyc ? "var(--err)" : TIER_VAR[data.tier]}`,
        borderRadius: 8,
        background: "var(--panel)",
        padding: "6px 10px",
        display: "grid",
        gap: 2,
        boxShadow: `inset 4px 0 0 ${TIER_VAR[data.tier]}`,
      }}
    >
      <Handle type="source" position={Position.Top} style={{ opacity: 0 }} isConnectable={false} />
      <Handle type="target" position={Position.Bottom} style={{ opacity: 0 }} isConnectable={false} />
      <div style={{ fontWeight: 600, fontSize: 12.5, lineHeight: 1.2 }}>{data.name}</div>
      <div className="mono" style={{ fontSize: 10.5, color: "var(--muted)" }}>
        {data.id}
      </div>
      <div style={{ fontSize: 11, color: "var(--muted)" }}>
        {data.versions ? `${data.versions} version${data.versions > 1 ? "s" : ""} · ${fmtDate(data.first!)} → ${fmtDate(data.last!)}` : "target only (no rows as source)"}
      </div>
    </div>
  );
}

function ElkEdge({ id, data }: EdgeProps<Edge<EData>>) {
  const pts = data!.points;
  const d = pts.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" ");
  const mid = pts[Math.floor(pts.length / 2)];
  const prev = pts[Math.floor(pts.length / 2) - 1] ?? mid;
  const lx = (mid.x + prev.x) / 2;
  const ly = (mid.y + prev.y) / 2;
  const color = data!.bad ? "var(--err)" : data!.retractedOnly ? "var(--faint)" : "var(--edge)";
  return (
    <>
      <BaseEdge id={id} path={d} markerEnd={`url(#${data!.bad ? "mg-err" : "mg-edge"})`} style={{ stroke: color, strokeWidth: data!.bad ? 2 : 1.4, strokeDasharray: data!.retractedOnly ? "4 4" : undefined }} />
      <EdgeLabelRenderer>
        <div
          className="mono"
          style={{
            position: "absolute",
            transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)`,
            fontSize: 10,
            background: "var(--panel)",
            border: `1px solid ${data!.bad ? "var(--err)" : "var(--line)"}`,
            color: data!.bad ? "var(--err)" : "var(--muted)",
            borderRadius: 4,
            padding: "1px 4px",
            whiteSpace: "pre",
            pointerEvents: "none",
          }}
        >
          {data!.label}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { m: ModuleNode };
const edgeTypes = { elk: ElkEdge };
const elk = new ELK();

export default function ModuleGraph({ analysis, names }: { analysis: ViewAnalysis; names: Record<string, string> }) {
  const [graph, setGraph] = useState<{ nodes: Node[]; edges: Edge[] } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const cyc = new Set(analysis.moduleCycles.flat());
    analysis.moduleEdges.filter((e) => e.from === e.to && e.versions > 0).forEach((e) => cyc.add(e.from));
    const mods = [...analysis.modules.values()];
    const g = {
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "UP",
        "elk.layered.spacing.nodeNodeBetweenLayers": "90",
        "elk.spacing.nodeNode": "40",
        "elk.edgeRouting": "SPLINES",
        "elk.spacing.edgeLabel": "6",
      },
      children: mods.map((m) => ({ id: m.id, width: 230, height: 64 })),
      edges: analysis.moduleEdges.map((e, i) => ({
        id: `e${i}`,
        sources: [e.from],
        targets: [e.to],
        labels: [{ text: "x", width: 150, height: 30 }],
      })),
    };
    elk
      .layout(g)
      .then((res) => {
        if (cancelled) return;
        const nodes: Node[] = (res.children ?? []).map((c) => {
          const m = analysis.modules.get(c.id)!;
          return {
            id: c.id,
            type: "m",
            position: { x: c.x ?? 0, y: c.y ?? 0 },
            draggable: false,
            data: { name: shortName(m.id, names), id: m.id, tier: m.tier, versions: m.versions.length, first: m.versions[0], last: m.versions.at(-1), cyc: cyc.has(m.id) },
          };
        });
        const edges: Edge[] = (res.edges ?? []).map((re, i) => {
          const me = analysis.moduleEdges[i];
          const sec = (re as ElkExtendedEdge).sections?.[0];
          const points = sec ? [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint] : [];
          const bad = me.from === me.to || (cyc.has(me.from) && cyc.has(me.to)) || me.flags.includes("target-after-source") || me.flags.includes("ambiguous-target");
          const label =
            me.versions > 0
              ? `${me.versions} version${me.versions > 1 ? "s" : ""}${me.retracted ? ` (+${me.retracted} retracted)` : ""}\nlatest ${fmtDate(me.latestSource)} → ${fmtDate(me.latestTarget)}`
              : `${me.retracted} retracted`;
          return { id: re.id, source: me.from, target: me.to, type: "elk", data: { points, label, bad, retractedOnly: me.versions === 0 } };
        });
        setGraph({ nodes, edges });
      })
      .catch(() => setGraph({ nodes: [], edges: [] }));
    return () => {
      cancelled = true;
    };
  }, [analysis, names]);

  return (
    <div style={{ height: "100%", minHeight: 420, display: "grid", gridTemplateRows: "auto 1fr" }}>
      <div className="controls" style={{ background: "var(--panel)" }}>
        <p className="note">
          Module-level summary of the same rows. Each arrow aggregates every version-to-version row between two modules; it is the view the SI demonstrator draws, with version counts and the latest pair added. Use the timeline to see which version depends on which.
        </p>
        <div className="legend">
          {(Object.keys(TIER_VAR) as Tier[]).map((t) => (
            <span key={t}>
              <b style={{ background: TIER_VAR[t] }} />
              {TIER_LABEL[t]}
            </span>
          ))}
          <span>
            <i style={{ borderTopColor: "var(--err)" }} />
            cycle / self-dependency
          </span>
        </div>
      </div>
      <div style={{ position: "relative", minHeight: 0 }}>
        <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden>
          <defs>
            {[
              ["mg-edge", "var(--edge)"],
              ["mg-err", "var(--err)"],
            ].map(([id, c]) => (
              <marker key={id} id={id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" style={{ fill: c }} />
              </marker>
            ))}
          </defs>
        </svg>
        {graph && (
          <ReactFlowProvider>
            <ReactFlow nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} fitView proOptions={{ hideAttribution: true }} nodesConnectable={false} minZoom={0.1}>
              <Controls showInteractive={false} position="bottom-left" />
            </ReactFlow>
          </ReactFlowProvider>
        )}
      </div>
    </div>
  );
}
