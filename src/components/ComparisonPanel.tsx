"use client";

import { Card } from "@/components/ui/card";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
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
        <ScrollArea className="rounded-md border border-border bg-white/2" style={{ maxHeight: 260 }}>
          <div className="p-3 text-sm leading-[1.55] whitespace-pre-wrap">{text}</div>
        </ScrollArea>
      ) : (
        <Processing />
      )}
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
  const judging = stages?.judge === "running";
  const anyRunning = stages && Object.values(stages).some((s) => s !== "done");

  // Evidence may arrive (own stream event) before the final result.
  const scatter = result?.scatter ?? partialScatter;
  const subgraph = result?.subgraph ?? partialSubgraph;
  const hasScatter = Boolean(scatter && scatter.points?.length);
  const hasSubgraph = Boolean(subgraph && subgraph.nodes?.length);

  return (
    <div className="space-y-4">
      {heading && <h2 className="text-xl font-semibold">{heading}</h2>}

      {stages && anyRunning && !result && <RunProgress stages={stages} />}

      {result?.error && (
        <Alert variant="destructive">
          <AlertDescription>Run error: {result.error}</AlertDescription>
        </Alert>
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
          <AlertTitle>📜 Verdict</AlertTitle>
          <AlertDescription>{result.verdict}</AlertDescription>
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
