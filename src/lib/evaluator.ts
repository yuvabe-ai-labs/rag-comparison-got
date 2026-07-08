// Rubric LLM-judge scoring Vector / Graph / Hybrid RAG outputs.
// Adapted from rag-method-comparison/src/lib/rag/evaluator.ts to this project's
// payload shapes (VectorPayload, GraphAnswer, HybridAnswer).
//
// The judge scores ONLY from the displayed answer + evidence — no outside
// knowledge — so it rewards grounded answers and penalises hallucination.

import { respond, ANSWER_MODEL } from "./openai";
import type { VectorPayload } from "./vectorRag";
import type { GraphAnswer } from "./graphRag";
import type { HybridAnswer } from "./hybridRag";

/** Rubric dimensions: [key, human label]. Each scored 0..2 (max total 10). */
export const RUBRIC_DIMS: [string, string][] = [
  ["relevance", "Relevance"],
  ["constraint_handling", "Constraint handling"],
  ["evidence_grounding", "Evidence grounding"],
  ["reasoning_transparency", "Reasoning transparency"],
  ["hallucination_resistance", "Hallucination resistance"],
];

const CATEGORIES = RUBRIC_DIMS.map(([key]) => key);
export const MAX_TOTAL = CATEGORIES.length * 2;

const SCORE_SCHEMA = {
  type: "object",
  properties: Object.fromEntries(CATEGORIES.map((c) => [c, { type: "integer", enum: [0, 1, 2] }])),
  required: CATEGORIES,
  additionalProperties: false,
};

const EVALUATION_SCHEMA = {
  type: "object",
  properties: {
    vector_rag: SCORE_SCHEMA,
    graph_rag: SCORE_SCHEMA,
    hybrid_rag: SCORE_SCHEMA,
    verdict: { type: "string" },
  },
  required: ["vector_rag", "graph_rag", "hybrid_rag", "verdict"],
  additionalProperties: false,
};

const JUDGE_INSTRUCTIONS = `You judge RAG system outputs for a Game of Thrones knowledge base. The input contains three systems: vector_rag, graph_rag, and hybrid_rag.

Judge ONLY from the user question, displayed answer text, and displayed evidence in
the input JSON. Do not use outside knowledge. Do not infer that hidden retrieval,
hidden graph data, or unstated evidence exists.

Score each category from 0 to 2:
- relevance: directly answers the user question.
- constraint_handling: respects explicit user constraints in the question (e.g.
  "list every", "how many", "shortest path").
- evidence_grounding: answer claims are supported by displayed evidence.
- reasoning_transparency: answer/evidence makes the basis of the result inspectable.
- hallucination_resistance: avoids unsupported claims beyond displayed evidence.

Scoring guide:
- 0: poor or contradicted by the displayed material.
- 1: partially satisfied or mixed.
- 2: clearly satisfied from the displayed material.

The verdict must be concise and explain which system answered best and why,
especially for multi-hop / aggregation questions that require chaining or
enumerating facts across characters, houses, and events. If tied, say why.`;

function displayedVector(p: VectorPayload) {
  return {
    answer: String(p.answer ?? ""),
    evidence: (p.evidence_snippets ?? []).map((e) => ({
      document_id: e.document_id,
      chunk_id: e.chunk_id,
      snippet: e.snippet,
    })),
  };
}

function displayedGraph(p: GraphAnswer) {
  return {
    answer: String(p.answer ?? ""),
    cypher: p.cypher ?? "",
    graph_rows: p.rows ?? [],
    evidence: (p.evidence ?? []).map((e) => ({
      episode: e.episode,
      chunk_id: e.chunk_id,
      description: e.description,
    })),
  };
}

function displayedHybrid(p: HybridAnswer) {
  return {
    answer: String(p.answer ?? ""),
    graph_evidence: (p.graphEvidence ?? []).map((e) => ({
      episode: e.episode,
      chunk_id: e.chunk_id,
      description: e.description,
    })),
    text_evidence: (p.vectorSnippets ?? []).map((e) => ({
      document_id: e.document_id,
      chunk_id: e.chunk_id,
      snippet: e.snippet,
    })),
  };
}

function validateScores(scores: Record<string, unknown>): Record<string, number> {
  const validated: Record<string, number> = {};
  for (const category of CATEGORIES) {
    const score = scores?.[category];
    if (score !== 0 && score !== 1 && score !== 2) {
      throw new Error(`Invalid ${category} score: ${JSON.stringify(score)}`);
    }
    validated[category] = Number(score);
  }
  return validated;
}

function withTotal(scores: Record<string, unknown>) {
  const validated = validateScores(scores || {});
  const total = Object.values(validated).reduce((a, b) => a + b, 0);
  return { category_scores: validated, total_score: total };
}

export interface SystemScore {
  category_scores: Record<string, number>;
  total_score: number;
}

export interface Evaluation {
  vector_rag: SystemScore;
  graph_rag: SystemScore;
  hybrid_rag: SystemScore;
  verdict: string;
}

export async function evaluate(
  question: string,
  vector: VectorPayload,
  graph: GraphAnswer,
  hybrid: HybridAnswer,
  model: string = ANSWER_MODEL,
): Promise<Evaluation> {
  const input = JSON.stringify(
    {
      user_question: question,
      vector_rag: displayedVector(vector),
      graph_rag: displayedGraph(graph),
      hybrid_rag: displayedHybrid(hybrid),
    },
    null,
    2,
  );

  const out = await respond({
    model,
    instructions: JUDGE_INSTRUCTIONS,
    input,
    text: {
      format: { type: "json_schema", name: "got_rag_evaluation", schema: EVALUATION_SCHEMA, strict: true },
    },
  });

  const payload = JSON.parse(out);
  return {
    vector_rag: withTotal(payload.vector_rag ?? {}),
    graph_rag: withTotal(payload.graph_rag ?? {}),
    hybrid_rag: withTotal(payload.hybrid_rag ?? {}),
    verdict: String(payload.verdict ?? "").trim(),
  };
}
