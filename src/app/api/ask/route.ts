import { loadEnv, checkEnv } from "@/lib/env";
import { checkNeo4jEnv, verifyConnection } from "@/lib/neo4j";
import { loadQuestions } from "@/lib/questions";
import { askQuestion } from "@/lib/vectorRag";
import { askGraph } from "@/lib/graphRag";
import { askHybrid } from "@/lib/hybridRag";
import { evaluate } from "@/lib/evaluator";
import { buildScatter } from "@/lib/pca";
import { RUBRIC_DIMS } from "@/lib/display";
import type { ComparisonResult, MethodResult, SourceItem, ScatterData } from "@/lib/webTypes";

export const runtime = "nodejs";
export const maxDuration = 300;

const DIMS = RUBRIC_DIMS.map(([k]) => k);

// Stream staged NDJSON so the UI shows live progress, then a final `result`.
export async function POST(req: Request) {
  loadEnv();
  const body = await req.json().catch(() => ({}));
  const question = String(body?.question ?? "").trim();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      try {
        if (!question) throw new Error("Question is required.");
        const env = checkEnv();
        const neo = checkNeo4jEnv();
        const missing = [...env.missing, ...neo.missing];
        if (missing.length) throw new Error(`Missing env vars: ${missing.join(", ")}`);
        await verifyConnection();

        const category = loadQuestions().find((q) => q.question === question)?.category ?? "";

        // Vector + Graph run in parallel; stream each answer as it lands.
        send({ type: "stage", stage: "vector", status: "running" });
        send({ type: "stage", stage: "graph", status: "running" });
        const vectorPromise = askQuestion(question).then((v) => {
          send({ type: "stage", stage: "vector", status: "done" });
          send({ type: "answer", method: "vector", answer: String(v.answer ?? "") });
          return v;
        });
        const graphPromise = askGraph(question).then((g) => {
          send({ type: "stage", stage: "graph", status: "done" });
          send({ type: "answer", method: "graph", answer: String(g.answer ?? "") });
          return g;
        });
        const [vector, graph] = await Promise.all([vectorPromise, graphPromise]);

        send({ type: "stage", stage: "hybrid", status: "running" });
        const hybrid = await askHybrid(question);
        send({ type: "stage", stage: "hybrid", status: "done" });
        send({ type: "answer", method: "hybrid", answer: String(hybrid.answer ?? "") });

        // Visual evidence is ready once retrieval is done — surface it before
        // the judge runs. Scatter can be heavy (PCA), so tolerate failure.
        let scatter: ScatterData | null = null;
        try {
          scatter = buildScatter(vector.query_embedding, new Set(vector.chunk_id ?? []));
        } catch {
          scatter = null;
        }
        send({ type: "evidence", scatter, subgraph: graph.subgraph });

        send({ type: "stage", stage: "judge", status: "running" });
        const evaluation = await evaluate(question, vector, graph, hybrid);
        send({ type: "stage", stage: "judge", status: "done" });

        const vectorSources: SourceItem[] = vector.evidence_snippets.map((e) => ({
          label: `${e.document_id} / ${e.chunk_id}`,
          detail: e.snippet,
        }));
        const graphSources: SourceItem[] = graph.evidence.map((e) => ({
          label: `${e.episode} / ${e.chunk_id}`,
          detail: e.description,
        }));
        const hybridSources: SourceItem[] = [
          ...hybrid.graphEvidence.map((e) => ({ label: `graph · ${e.episode} / ${e.chunk_id}`, detail: e.description })),
          ...hybrid.vectorSnippets.map((e) => ({ label: `text · ${e.document_id} / ${e.chunk_id}`, detail: e.snippet })),
        ];

        const method = (
          answer: string,
          sys: "vector_rag" | "graph_rag" | "hybrid_rag",
          sources: SourceItem[],
          cypher?: string,
        ): MethodResult => {
          const s = evaluation[sys];
          const scores: Record<string, number> = {};
          for (const d of DIMS) scores[d] = s.category_scores[d] ?? 0;
          return { answer, total: s.total_score, scores, sources, cypher };
        };

        const result: ComparisonResult = {
          question,
          category,
          methods: {
            vector: method(vector.answer, "vector_rag", vectorSources),
            graph: method(graph.answer, "graph_rag", graphSources, graph.cypher),
            hybrid: method(hybrid.answer, "hybrid_rag", hybridSources, hybrid.cypher),
          },
          verdict: evaluation.verdict,
          scatter,
          subgraph: graph.subgraph,
        };
        send({ type: "result", result });
      } catch (err) {
        send({ type: "error", error: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
