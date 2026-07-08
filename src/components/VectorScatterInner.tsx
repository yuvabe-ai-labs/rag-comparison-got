"use client";

import createPlotlyComponent from "react-plotly.js/factory";
import Plotly from "plotly.js-dist-min";
import type { Data, Layout } from "plotly.js";
import type { ScatterData } from "@/lib/webTypes";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Plot = createPlotlyComponent(Plotly as any);

export default function VectorScatterInner({ data }: { data: ScatterData }) {
  if (!data?.points?.length) {
    return <p className="text-xs text-muted-foreground">Chunk embeddings unavailable.</p>;
  }

  const traces: Data[] = [];

  // Dashed lines from the query star to each retrieved chunk.
  if (data.query) {
    const lineX: (number | null)[] = [];
    const lineY: (number | null)[] = [];
    for (const p of data.points) {
      lineX.push(data.query.x, p.x, null);
      lineY.push(data.query.y, p.y, null);
    }
    traces.push({
      x: lineX,
      y: lineY,
      mode: "lines",
      line: { dash: "dot", color: "#f59e0b", width: 1.2 },
      showlegend: false,
      hoverinfo: "skip",
      type: "scatter",
    });
  }

  // Retrieved chunks.
  traces.push({
    x: data.points.map((p) => p.x),
    y: data.points.map((p) => p.y),
    mode: "markers",
    type: "scatter",
    name: "Retrieved chunk",
    marker: { size: 11, color: "#3B82F6", opacity: 0.95, line: { color: "#e2e8f0", width: 1.5 } },
    text: data.points.map((p) => `<b>${p.document_id}</b><br>${p.text}`),
    hovertemplate: "%{text}<extra></extra>",
  });

  // Query star.
  if (data.query) {
    traces.push({
      x: [data.query.x],
      y: [data.query.y],
      mode: "markers",
      type: "scatter",
      name: "Query ★",
      marker: { size: 18, symbol: "star", color: "#f59e0b", line: { color: "#000000", width: 1 } },
      hovertemplate: "Query<extra></extra>",
    });
  }

  const layout: Partial<Layout> = {
    height: 400,
    showlegend: true,
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(14,17,23,1)",
    font: { color: "#e6e8eb", size: 11 },
    xaxis: { showgrid: false, zeroline: false, showticklabels: false, title: { text: "PCA component 1", font: { size: 10, color: "#6b7280" } } },
    yaxis: { showgrid: false, zeroline: false, showticklabels: false, title: { text: "PCA component 2", font: { size: 10, color: "#6b7280" } } },
    margin: { l: 36, r: 8, t: 12, b: 36 },
    legend: { bgcolor: "rgba(14,17,23,0.8)", font: { size: 10 }, itemsizing: "constant" },
  };

  return (
    <Plot
      data={traces}
      layout={layout}
      config={{ displayModeBar: false, responsive: true }}
      style={{ width: "100%", height: "400px" }}
      useResizeHandler
    />
  );
}
