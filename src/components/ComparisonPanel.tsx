"use client";

import { useState } from "react";
import { Card, Badge, Alert, Separator } from "@/components/ui/primitives";
import RubricBars from "./RubricBars";
import VectorScatter from "./VectorScatter";
import KgSubgraph from "./KgSubgraph";
import RunProgress, { type StageState } from "./RunProgress";
import { METHODS, MAX_TOTAL } from "@/lib/display";
import type { ComparisonResult, MethodResult, ScatterData, Subgraph } from "@/lib/webTypes";

export type PartialAnswers = Partial<Record<"vector" | "graph" | "hybrid", string>>;

function winners(result: ComparisonResult): Set<string> {
  const totals: Record<string, number | null> = {
    vector: result.methods.vector.total,
    graph: result.methods.graph.total,
    hybrid: result.methods.hybrid.total,
  };
  const valued = Object.entries(totals).filter(([, v]) => typeof v === "number") as [string, number][];
  if (!valued.length) return new Set();
  const top = Math.max(...valued.map(([, v]) => v));
  return new Set(valued.filter(([, v]) => v === top).map(([k]) => k));
}

function Processing({ height = 220 }: { height?: number }) {
  return (
    <div
      className="flex items-center justify-center rounded-md border border-dashed border-border text-sm text-amber-400"
      style={{ height }}
    >
      <span className="animate-pulse">⏳ Processing…</span>
    </div>
  );
}

function Sources({ method }: { method: MethodResult }) {
  const [show, setShow] = useState(false);
  if (!method.sources.length && !method.cypher) return null;
  return (
    <div className="mt-3 border-t border-border pt-2">
      <button onClick={() => setShow((s) => !s)} className="kg-micro hover:text-foreground">
        {show ? "▾" : "▸"} sources ({method.sources.length}){method.cypher ? " · cypher" : ""}
      </button>
      {show && (
        <div className="mt-2 space-y-2">
          {method.cypher && (
            <pre className="overflow-x-auto rounded bg-black/30 p-2 text-[11px] leading-relaxed text-emerald-300">
              {method.cypher}
            </pre>
          )}
          <ul className="space-y-1">
            {method.sources.slice(0, 12).map((s, i) => (
              <li key={i} className="text-[11px] leading-snug text-muted-foreground">
                <span className="text-slate-400">[{i + 1}]</span> {s.label}
                {s.detail ? <span className="text-slate-500"> — {s.detail}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function MethodColumn({
  label,
  icon,
  color,
  isWinner,
  method,
  answer,
}: {
  label: string;
  icon: string;
  color: string;
  isWinner: boolean;
  method?: MethodResult;
  answer?: string;
}) {
  const text = method?.answer || answer;
  return (
    <Card className="gap-3 p-4" style={{ borderTop: `3px solid ${color}` }}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-muted-foreground">
          {icon} {label}
          {isWinner ? " 🏆" : ""}
        </span>
        {method ? (
          <span className="text-2xl font-bold">
            {typeof method.total === "number" ? `${method.total} / ${MAX_TOTAL}` : "—"}
          </span>
        ) : null}
      </div>
      <p className="text-sm font-semibold">Answer</p>
      {text ? (
        <div className="kg-answer p-3" style={{ maxHeight: 260 }}>
          {text}
        </div>
      ) : (
        <Processing />
      )}
      {method ? <Sources method={method} /> : null}
    </Card>
  );
}

export default function ComparisonPanel({
  result,
  question,
  answers = {},
  scatter: partialScatter = null,
  subgraph: partialSubgraph = null,
  stages,
}: {
  result: ComparisonResult | null;
  question: string;
  answers?: PartialAnswers;
  scatter?: ScatterData | null;
  subgraph?: Subgraph | null;
  stages?: StageState;
}) {
  const win = result ? winners(result) : new Set<string>();
  const m = result?.methods;
  const [, vLabel, vIcon, vColor] = METHODS[0];
  const [, gLabel, gIcon, gColor] = METHODS[1];
  const [, hLabel, hIcon, hColor] = METHODS[2];

  const heading = result?.question || question;
  const cat = result?.category;
  const judging = stages?.judge === "running";
  const anyRunning = stages && Object.values(stages).some((s) => s !== "done");

  // Evidence may arrive (own stream event) before the final result.
  const scatter = result?.scatter ?? partialScatter;
  const subgraph = result?.subgraph ?? partialSubgraph;
  const hasScatter = Boolean(scatter && scatter.points?.length);
  const hasSubgraph = Boolean(subgraph && subgraph.nodes?.length);

  return (
    <div className="space-y-4">
      {cat && <Badge>{cat}</Badge>}
      {heading && <h2 className="text-xl font-semibold">{heading}</h2>}

      {stages && anyRunning && !result && <RunProgress stages={stages} />}

      {result?.error && (
        <Alert variant="destructive">Run error: {result.error}</Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <MethodColumn label={vLabel} icon={vIcon} color={vColor} isWinner={win.has("vector")} method={m?.vector} answer={answers.vector} />
        <MethodColumn label={gLabel} icon={gIcon} color={gColor} isWinner={win.has("graph")} method={m?.graph} answer={answers.graph} />
        <MethodColumn label={hLabel} icon={hIcon} color={hColor} isWinner={win.has("hybrid")} method={m?.hybrid} answer={answers.hybrid} />
      </div>

      {(hasScatter || hasSubgraph) && (
        <>
          <Separator />
          <p className="kg-micro">Visual Evidence</p>
          <div className="grid gap-4 lg:grid-cols-2">
            {hasScatter && (
              <Card className="gap-2 p-4" style={{ borderTop: `3px solid ${vColor}` }}>
                <p className="text-sm font-semibold">{vIcon} {vLabel} — Embedding Space (PCA 2D)</p>
                <VectorScatter data={scatter!} />
              </Card>
            )}
            {hasSubgraph && (
              <Card className="gap-2 p-4" style={{ borderTop: `3px solid ${gColor}` }}>
                <p className="text-sm font-semibold">{gIcon} {gLabel} — Knowledge Subgraph</p>
                <KgSubgraph subgraph={subgraph!} />
              </Card>
            )}
          </div>
        </>
      )}

      {result?.verdict && (
        <Alert>
          <span className="font-semibold">📜 Verdict</span> — {result.verdict}
        </Alert>
      )}

      {(result || judging) && (
        <>
          <Separator />
          <p className="kg-micro">Rubric Evaluation</p>
          <Card className="p-4">
            {result ? (
              <RubricBars result={result} />
            ) : (
              <p className="py-8 text-center text-sm text-amber-400">
                <span className="animate-pulse">⏳ Evaluating all three methods…</span>
              </p>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
