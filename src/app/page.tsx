"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import Sidebar from "@/components/Sidebar";
import ComparisonPanel, { type PartialAnswers } from "@/components/ComparisonPanel";
import type { StageState } from "@/components/RunProgress";
import type { ComparisonResult, QuestionItem, ScatterData, Subgraph } from "@/lib/webTypes";

const EMPTY_STAGES: StageState = { vector: "pending", graph: "pending", hybrid: "pending", judge: "pending" };

export default function Home() {
  const [questions, setQuestions] = useState<QuestionItem[]>([]);
  const [ready, setReady] = useState(true);
  const [missing, setMissing] = useState<string[]>([]);
  const [question, setQuestion] = useState("");
  const [running, setRunning] = useState(false);
  const [stages, setStages] = useState<StageState>(EMPTY_STAGES);
  const [answers, setAnswers] = useState<PartialAnswers>({});
  const [scatter, setScatter] = useState<ScatterData | null>(null);
  const [subgraph, setSubgraph] = useState<Subgraph | null>(null);
  const [result, setResult] = useState<ComparisonResult | null>(null);
  const [error, setError] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetch("/api/questions")
      .then((r) => r.json())
      .then((d) => {
        setQuestions(d.questions ?? []);
        setReady(Boolean(d.ready));
        setMissing(d.missing ?? []);
      })
      .catch(() => {});
  }, []);

  const onPick = useCallback((q: string) => {
    setQuestion(q);
    textareaRef.current?.focus();
  }, []);

  const run = useCallback(async () => {
    const q = question.trim();
    if (!q || running) return;
    setRunning(true);
    setError("");
    setResult(null);
    setAnswers({});
    setScatter(null);
    setSubgraph(null);
    setStages(EMPTY_STAGES);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      if (!res.body) throw new Error("No response stream.");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const evt = JSON.parse(line);
          if (evt.type === "stage") {
            setStages((s) => ({ ...s, [evt.stage]: evt.status }));
          } else if (evt.type === "answer") {
            setAnswers((a) => ({ ...a, [evt.method]: String(evt.answer ?? "") }));
          } else if (evt.type === "evidence") {
            setScatter((evt.scatter as ScatterData) ?? null);
            setSubgraph((evt.subgraph as Subgraph) ?? null);
          } else if (evt.type === "result") {
            setResult(evt.result as ComparisonResult);
          } else if (evt.type === "error") {
            setError(String(evt.error));
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, [question, running]);

  const showPanel = running || Boolean(result);

  return (
    <div className="min-h-screen">
      <Sidebar questions={questions} onPick={onPick} />

      <main className="px-6 py-8 md:ml-[22rem]">
        <div className="mx-auto max-w-6xl">
          <h1 className="mb-1 text-lg font-bold text-slate-100">Game of Thrones — RAG Method Comparison</h1>
          <p className="mb-6 text-sm text-muted-foreground">Vector vs Graph vs Hybrid, judged live by a 5-dimension rubric.</p>

          {!ready && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>
                Live mode needs these env vars: {missing.join(", ")}. Neo4j must also be running with the graph imported.
              </AlertDescription>
            </Alert>
          )}

          <p className="kg-micro mb-1">Question</p>
          <Textarea
            ref={textareaRef}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Type a question or pick one from the sidebar…"
            className="mb-3 min-h-[90px] resize-y"
          />
          <Button onClick={run} disabled={!ready || running || !question.trim()} size="lg" className="mb-4 w-full">
            {running ? "Running…" : "▶ Run Comparison"}
          </Button>

          <div className="my-6 border-t border-border" />

          {error && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>Pipeline failed: {error}</AlertDescription>
            </Alert>
          )}

          {showPanel ? (
            <ComparisonPanel
              result={result}
              question={question}
              answers={answers}
              scatter={scatter}
              subgraph={subgraph}
              stages={stages}
            />
          ) : !error ? (
            <p className="text-sm text-muted-foreground">
              Pick a question and click <strong>▶ Run Comparison</strong> to compare all three methods live.
            </p>
          ) : null}
        </div>
      </main>
    </div>
  );
}
