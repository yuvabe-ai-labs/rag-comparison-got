"use client";

import createPlotlyComponent from "react-plotly.js/factory";
import Plotly from "plotly.js-dist-min";
import type { Data, Layout } from "plotly.js";
import { METHODS, RUBRIC_DIMS } from "@/lib/display";
import type { ComparisonResult } from "@/lib/webTypes";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Plot = createPlotlyComponent(Plotly as any);

const DIM_LABELS = RUBRIC_DIMS.map(([, label]) => label);

export default function RubricBarsInner({ result }: { result: ComparisonResult }) {
  const traces: Data[] = METHODS.map(([key, label, icon, color]) => {
    const m = result.methods[key as keyof ComparisonResult["methods"]];
    const scores = RUBRIC_DIMS.map(([dim]) => m?.scores?.[dim] ?? 0);
    return {
      x: DIM_LABELS,
      y: scores,
      type: "bar",
      name: `${icon} ${label}`,
      marker: { color, line: { color: "rgba(255,255,255,0.18)", width: 1 }, opacity: 0.92 },
      text: scores.map((s) => (s ? String(s) : "")),
      textposition: "outside",
      textfont: { color: "#cbd5e1", size: 10 },
      cliponaxis: false,
      hovertemplate: "%{x}: <b>%{y}/2</b><extra>" + icon + " " + label + "</extra>",
    } as Data;
  });

  const layout: Partial<Layout> = {
    barmode: "group",
    bargap: 0.32,
    bargroupgap: 0.12,
    height: 360,
    showlegend: true,
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { color: "#e6e8eb", size: 11 },
    hoverlabel: { bgcolor: "#0f172a", bordercolor: "rgba(148,163,184,0.3)", font: { size: 11 } },
    xaxis: { showgrid: false, zeroline: false, showline: true, linecolor: "rgba(148,163,184,0.2)", tickfont: { size: 11, color: "#cbd5e1" } },
    yaxis: { range: [0, 2.25], dtick: 0.5, gridcolor: "rgba(148,163,184,0.1)", zeroline: false, tickfont: { size: 10, color: "#94a3b8" }, title: { text: "Score", font: { size: 11, color: "#94a3b8" } } },
    margin: { l: 48, r: 16, t: 16, b: 40 },
    legend: { orientation: "h", x: 0.5, xanchor: "center", y: 1.12, yanchor: "bottom", bgcolor: "rgba(0,0,0,0)", font: { size: 11, color: "#e2e8f0" }, itemsizing: "constant" },
  };

  return (
    <Plot
      data={traces}
      layout={layout}
      config={{ displayModeBar: false, responsive: true }}
      style={{ width: "100%", height: "360px" }}
      useResizeHandler
    />
  );
}
