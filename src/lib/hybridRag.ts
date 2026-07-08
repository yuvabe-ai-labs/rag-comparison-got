// Hybrid RAG — fuse Graph RAG and Vector RAG into one answer.
//
// The two retrievers have complementary blind spots:
//   - Graph  gives precise structured facts (relationships, counts, paths) but
//            misses narrative nuance and anything not modelled as an edge.
//   - Vector gives rich passage text but cannot aggregate or traverse, so it
//            fumbles multi-hop / "list all" / "how many" questions.
//
// Hybrid retrieves from BOTH in parallel, concatenates the graph facts and the
// text passages into one context, and asks the LLM to answer from the union —
// preferring graph facts for structure and passages for detail/gap-filling.

import { retrieveGraph, type LinkedEntity, type GraphEvidence } from "./graphRag";
import { retrieveContext } from "./vectorRag";
import { respond, ANSWER_MODEL } from "./openai";
import type { EvidenceSnippet } from "./types";

export interface HybridAnswer {
  answer: string;
  cypher: string;
  linked: LinkedEntity[];
  graphRows: string[];
  graphEvidence: GraphEvidence[];
  vectorSnippets: EvidenceSnippet[];
}

const HYBRID_INSTRUCTIONS = `You answer a Game of Thrones question using TWO complementary sources:
1. GRAPH FACTS — structured relationships/counts/paths extracted into a knowledge graph.
2. TEXT PASSAGES — episode synopsis excerpts.

How to combine them:
- Use GRAPH FACTS as the backbone for relationships, counts, paths and "list all"
  answers — they are complete and structured where passages are not.
- Use TEXT PASSAGES to add narrative detail, context, and to fill gaps the graph
  is missing.
- If the two conflict on a relationship/count, trust the GRAPH FACTS.
- Base every claim on the provided sources; if neither contains the answer, say so.
  Do not use outside knowledge. Be concise; give the full list/count when asked.`;

export async function askHybrid(question: string, model: string = ANSWER_MODEL): Promise<HybridAnswer> {
  const [graph, vector] = await Promise.all([
    retrieveGraph(question, model),
    retrieveContext(question),
  ]);

  const graphFacts = graph.ran && graph.rows.length ? graph.rows.join("\n") : "(no structured graph facts found)";
  const combined =
    `GRAPH FACTS (structured relationships):\n${graphFacts}\n\n` +
    `TEXT PASSAGES (episode synopses):\n${vector.context}`;

  const answer = await respond({
    model,
    instructions: HYBRID_INSTRUCTIONS,
    input: `Question: ${question}\n\n${combined}`,
    temperature: 0,
  });

  return {
    answer,
    cypher: graph.cypher,
    linked: graph.linked,
    graphRows: graph.rows,
    graphEvidence: graph.evidence,
    vectorSnippets: vector.snippets,
  };
}
