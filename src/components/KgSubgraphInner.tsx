"use client";

import { useEffect, useRef } from "react";
import { Network, DataSet } from "vis-network/standalone";
import { NODE_COLORS, DEFAULT_NODE_COLOR } from "@/lib/display";
import type { Subgraph } from "@/lib/webTypes";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type VisNode = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type VisEdge = any;

export default function KgSubgraphInner({ subgraph }: { subgraph: Subgraph }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current || !subgraph?.nodes?.length) return;

    const nodes = new DataSet<VisNode>(
      subgraph.nodes.map((n) => {
        const color = NODE_COLORS[n.type] ?? DEFAULT_NODE_COLOR;
        return {
          id: n.id,
          label: n.label,
          title: `${n.label} (${n.type})`,
          shape: "dot",
          size: 13,
          color: { background: color, border: color, highlight: { background: color, border: "#fbbf24" } },
          font: { color: "#e6e8eb", size: 11 },
        };
      }),
    );

    const edges = new DataSet<VisEdge>(
      subgraph.edges.map((e, i) => ({
        id: i,
        from: e.source,
        to: e.target,
        label: e.relation,
        title: e.description || e.relation,
      })),
    );

    const network = new Network(
      containerRef.current,
      { nodes, edges },
      {
        physics: {
          solver: "forceAtlas2Based",
          forceAtlas2Based: { gravitationalConstant: -60, springLength: 120 },
          stabilization: { iterations: 150 },
        },
        edges: {
          arrows: { to: { enabled: true, scaleFactor: 0.55 } },
          color: { color: "#4a5568", highlight: "#fbbf24" },
          font: { size: 10, color: "#ffffff", align: "middle", background: "#1e293b", strokeWidth: 3, strokeColor: "#0e1117" },
          smooth: { enabled: true, type: "continuous", roundness: 0.5 },
        },
        nodes: { shape: "dot", size: 13, borderWidth: 1, font: { size: 11, color: "#e6e8eb" } },
        interaction: { hover: true },
      },
    );

    return () => network.destroy();
  }, [subgraph]);

  if (!subgraph?.nodes?.length) {
    return <p className="text-xs text-muted-foreground">No subgraph for this question.</p>;
  }

  return <div ref={containerRef} style={{ height: "400px", width: "100%", background: "#0e1117", borderRadius: 6 }} />;
}
