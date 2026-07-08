"use client";

export type StageStatus = "pending" | "running" | "done";

export interface StageState {
  vector: StageStatus;
  graph: StageStatus;
  hybrid: StageStatus;
  judge: StageStatus;
}

const STAGES: { key: keyof StageState; label: string }[] = [
  { key: "vector", label: "Vector RAG" },
  { key: "graph", label: "Graph RAG" },
  { key: "hybrid", label: "Hybrid RAG" },
  { key: "judge", label: "Judging" },
];

function icon(status: StageStatus): string {
  if (status === "done") return "✓";
  if (status === "running") return "⏳";
  return "•";
}

export default function RunProgress({ stages }: { stages: StageState }) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <p className="kg-micro mb-2">Running pipelines…</p>
      <ul className="flex flex-wrap gap-x-6 gap-y-1.5 text-sm">
        {STAGES.map(({ key, label }) => {
          const status = stages[key];
          const color =
            status === "done" ? "text-emerald-400" : status === "running" ? "text-amber-400" : "text-muted-foreground";
          return (
            <li key={key} className={`flex items-center gap-2 ${color}`}>
              <span className="w-4 text-center">{icon(status)}</span>
              <span>{label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
