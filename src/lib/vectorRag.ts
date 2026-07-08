// Vector RAG over Game of Thrones chunks.
// Ported from rag-method-comparison/src/lib/rag/vectorRag.ts, adapted to read
// the split binary vector store (meta.json + embeddings.bin) instead of one
// big JSON. Retrieval logic (hybrid embedding + lexical + cue rerank) unchanged.

import { embedTexts, respond, ANSWER_MODEL } from "./openai";
import { getVectorStore, type VectorStore } from "./vectorStore";
import type { ChunkMeta, EvidenceSnippet } from "./types";

export const DEFAULT_TOP_K = 10;
export const DEFAULT_CANDIDATE_K = 30;

const STOP_WORDS = new Set([
  "about", "after", "also", "and", "are", "can", "did", "does", "for", "from",
  "has", "have", "how", "into", "not", "that", "the", "this", "was", "what",
  "when", "which", "who", "with", "would",
]);

const EVIDENCE_CUE_TERMS = new Set([
  "allegiance", "ally", "ancestor", "battle", "betray", "betrayal", "betrothal",
  "betrothed", "claim", "commander", "conflict", "conspiracy", "conspired",
  "crown", "death", "enemy", "family", "fight", "fostered", "grandson",
  "grandfather", "hierarchy", "house", "kill", "killing", "king", "knight",
  "lady", "lineage", "lord", "loyal", "loyalty", "marriage", "marry", "member",
  "murder", "noble", "orchestrated", "pledge", "plotted", "poison", "poisoned",
  "power", "queen", "rank", "rebel", "reign", "rule", "ruling", "schemed",
  "steward", "sworn", "throne", "title", "traitor", "ward", "war", "wed",
  "wedding",
]);

const CONFLICT_TERMS = new Set([
  "assassin", "battle", "betray", "betrayal", "blood", "conspiracy",
  "conspired", "dead", "death", "enemy", "execute", "kill", "killed", "murder",
  "orchestrated", "plotted", "poison", "poisoned", "rebel", "rebellion",
  "revenge", "schemed", "slain", "traitor", "treachery", "war", "wound",
]);

const ALLIANCE_TERMS = new Set([
  "allegiance", "ally", "banner", "betrothed", "betrothal", "fostered",
  "friend", "honor", "house", "knight", "lord", "loyal", "loyalty", "married",
  "oath", "protect", "raised", "sworn", "vassal", "ward", "wed",
]);

const QUERY_EXPANSIONS: Record<string, string[]> = {
  ned: ["eddard stark", "lord stark", "stark"],
  eddard: ["ned stark", "lord stark"],
  jon: ["jon snow", "bastard", "snow", "aegon targaryen"],
  cersei: ["queen cersei", "lannister"],
  tywin: ["lord tywin", "lannister", "warden"],
  daenerys: ["dany", "khaleesi", "targaryen", "mother of dragons", "stormborn"],
  dany: ["daenerys", "khaleesi", "targaryen"],
  robb: ["robb stark", "king in the north"],
  sansa: ["sansa stark", "stark"],
  arya: ["arya stark", "stark"],
  bran: ["brandon stark", "stark"],
  catelyn: ["lady stark", "tully", "cat"],
  jamie: ["kingslayer", "lannister"],
  jaime: ["kingslayer", "lannister"],
  tyrion: ["imp", "lannister"],
  rickard: ["rickard stark", "lord stark", "stark"],
  lyanna: ["lyanna stark", "stark", "tower of joy"],
  benjen: ["benjen stark", "first ranger", "stark"],
  hoster: ["hoster tully", "lord tully", "tully", "riverrun"],
  lysa: ["lysa tully", "lysa arryn", "tully", "arryn"],
  edmure: ["edmure tully", "tully", "riverrun"],
  rhaella: ["rhaella targaryen", "targaryen"],
  rhaegar: ["rhaegar targaryen", "prince of dragonstone", "targaryen"],
  viserys: ["viserys targaryen", "targaryen"],
  elia: ["elia martell", "princess", "martell"],
  oberyn: ["red viper", "oberyn martell", "martell"],
  margaery: ["margaery tyrell", "tyrell", "queen"],
  tommen: ["tommen baratheon", "baratheon", "king"],
  renly: ["renly baratheon", "baratheon"],
  mormont: ["jeor mormont", "old bear", "lord commander"],
  jeor: ["jeor mormont", "lord commander"],
  alliser: ["alliser thorne", "master at arms"],
  thorne: ["alliser thorne"],
  janos: ["janos slynt", "city watch"],
  slynt: ["janos slynt", "city watch"],
  petyr: ["petyr baelish", "littlefinger"],
  littlefinger: ["petyr baelish", "lord baelish"],
  baelish: ["petyr baelish", "littlefinger"],
  walder: ["walder frey", "frey"],
  roose: ["roose bolton", "bolton"],
  lannister: ["house lannister", "casterly rock", "lion", "westerlands"],
  stark: ["house stark", "winterfell", "wolf", "north"],
  targaryen: ["house targaryen", "dragonstone", "dragon"],
  baratheon: ["house baratheon", "storms end"],
  tully: ["house tully", "riverrun", "riverlands"],
  arryn: ["house arryn", "eyrie", "vale"],
  martell: ["house martell", "dorne", "sunspear"],
  tyrell: ["house tyrell", "highgarden", "reach"],
  frey: ["house frey", "twins"],
  bolton: ["house bolton", "dreadfort"],
  greyjoy: ["house greyjoy", "pyke", "iron islands"],
  winterfell: ["stark seat", "north"],
  eyrie: ["house arryn", "vale of arryn"],
  throne: ["iron throne", "king", "ruler", "rule"],
  kill: ["killed", "murder", "death", "slain"],
  killed: ["murder", "death", "slain", "executed"],
  betray: ["betrayal", "traitor", "treachery", "turncloak"],
  conspire: ["conspiracy", "plotted", "schemed", "planned"],
  conspired: ["conspiracy", "plot", "scheme", "orchestrated"],
  married: ["wife", "husband", "wedding", "spouse"],
  betrothed: ["betrothal", "promised", "engaged"],
  allegiance: ["loyal", "sworn", "banner", "vassal"],
  member: ["member of", "belonging to", "part of"],
  rules: ["lord of", "controls", "governs"],
  grandfather: ["father", "parent", "ancestor"],
  grandmother: ["mother", "parent", "ancestor"],
  ward: ["raised", "fostered", "wardship"],
  hierarchy: ["rank", "command", "order", "structure"],
  commander: ["lord commander", "mormont", "jon snow"],
};

const LEXICAL_PHRASES = [
  "house stark", "house lannister", "house targaryen", "house baratheon",
  "house tully", "house arryn", "house martell", "house tyrell",
  "house bolton", "house frey", "house greyjoy",
  "king in the north", "iron throne", "red wedding",
  "lord commander", "first ranger", "night's watch", "nights watch",
  "tower of joy", "hand of the king", "vale of arryn",
  "red viper", "mad king", "war of five kings",
];

const ANSWER_INSTRUCTIONS = `You answer questions about Game of Thrones characters, houses, places, and events.

You have NO prior knowledge of this domain. Answer strictly and only from the retrieved context provided. If the context does not contain enough information, say "I cannot answer from the provided context."

Rules:
- Answer only from the retrieved chunks in the user message.
- Do not use outside knowledge or general GOT lore not present in the retrieved text.
- If the chunks do not contain enough information, say that clearly.
- Keep the answer concise and grounded in the retrieved text.

For conflict, political, or relationship questions:
- Compare allegiances, family ties, conflicts, and betrayals when the retrieved chunks support them.
- Do not treat absence of evidence as proof of innocence or alliance.
- If the user asks about exclusions or negations, identify what the retrieved text does and does not support.
- If evidence is mixed or incomplete, say so clearly.
- Prefer a direct answer first, then a short evidence-based explanation.
`;

// ── set / text helpers ──────────────────────────────────────────────────────

function inter(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const x of a) if (b.has(x)) out.add(x);
  return out;
}

function diff(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const x of a) if (!b.has(x)) out.add(x);
  return out;
}

export function compactText(text: unknown): string {
  return String(text).replace(/\s+/g, " ").trim();
}

export function wordTerms(text: string): Set<string> {
  const terms = new Set<string>();
  const matches = text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)?/g) || [];
  for (const term of matches) {
    if (term.length <= 2) continue;
    terms.add(term);
    if (term.endsWith("s") && term.length > 4) terms.add(term.slice(0, -1));
  }
  return terms;
}

export function questionTerms(question: string): Set<string> {
  return diff(wordTerms(question), STOP_WORDS);
}

export function expandedQueryTerms(question: string): Set<string> {
  const terms = new Set(questionTerms(question));
  const lowered = question.toLowerCase();
  for (const [key, expansions] of Object.entries(QUERY_EXPANSIONS)) {
    if (terms.has(key) || lowered.includes(key)) {
      for (const expansion of expansions) {
        for (const w of wordTerms(expansion)) terms.add(w);
      }
    }
  }
  return diff(terms, STOP_WORDS);
}

export function expandedQueryText(question: string): string {
  const expansions = [...diff(expandedQueryTerms(question), questionTerms(question))].sort();
  if (expansions.length === 0) return question;
  return question + "\nRelevant alternate wording: " + expansions.slice(0, 40).join(", ");
}

export interface QuestionProfile {
  expanded_terms: string[];
  asks_conflict: boolean;
  asks_conspiracy: boolean;
  asks_political: boolean;
  asks_explanation: boolean;
  asks_family: boolean;
  asks_hierarchy: boolean;
}

export function classifyQuestion(question: string): QuestionProfile {
  const terms = expandedQueryTerms(question);
  const lowered = question.toLowerCase();
  const hasPhrase = (phrases: string[]) => phrases.some((p) => lowered.includes(p));
  return {
    expanded_terms: [...terms].sort(),
    asks_conflict:
      inter(terms, CONFLICT_TERMS).size > 0 ||
      hasPhrase(["killed by", "betrayed", "without", "avoid", "enemy of", "against"]),
    asks_conspiracy: hasPhrase([
      "conspired", "conspiracy", "planned", "plotted", "schemed", "orchestrated",
      "who planned", "red wedding", "poisoned", "who poisoned",
    ]),
    asks_political: hasPhrase([
      "who rules", "allegiance", "more powerful", "loyal to", "sworn to", "compare",
    ]),
    asks_explanation: lowered.startsWith("why") || lowered.includes("explain") || lowered.includes("trace"),
    asks_family: hasPhrase([
      "grandfather", "grandmother", "ancestor", "descended", "lineage",
      "related to", "blood relation", "family tree", "grandchild", "nephew", "aunt", "uncle",
      "betrothed", "betrothal", "through marriage", "connected through",
    ]),
    asks_hierarchy: hasPhrase([
      "chain of command", "rank", "served under", "hierarchy",
      "lord commander", "first ranger", "steward", "ranger", "builder",
      "who served", "who held",
    ]),
  };
}

// ── scoring ─────────────────────────────────────────────────────────────────

export function cosineSimilarity(left: ArrayLike<number>, right: ArrayLike<number>): number {
  let num = 0, ln = 0, rn = 0;
  const n = Math.min(left.length, right.length);
  for (let i = 0; i < n; i++) {
    num += left[i] * right[i];
    ln += left[i] * left[i];
    rn += right[i] * right[i];
  }
  ln = Math.sqrt(ln);
  rn = Math.sqrt(rn);
  if (!ln || !rn) return 0;
  return num / (ln * rn);
}

function lexicalScore(text: string, terms: Set<string>): number {
  const textTerms = wordTerms(text);
  if (terms.size === 0) return 0;
  const directHits = inter(terms, textTerms).size;
  const coverage = directHits / Math.max(terms.size, 1);
  let phraseBonus = 0;
  const lowered = text.toLowerCase();
  for (const phrase of LEXICAL_PHRASES) {
    if (lowered.includes(phrase)) phraseBonus += 0.04;
  }
  return Math.min(1.0, coverage + phraseBonus);
}

function cueScore(text: string, profile: QuestionProfile): number {
  const terms = wordTerms(text);
  let score = 0;
  if (profile.asks_conflict) score += 0.08 * inter(terms, CONFLICT_TERMS).size;
  if (profile.asks_conspiracy)
    score += 0.08 * inter(terms, new Set(["conspired", "conspiracy", "plotted", "schemed", "orchestrated", "poisoned", "planned", "traitor"])).size;
  if (profile.asks_political)
    score += 0.08 * inter(terms, new Set(["rule", "throne", "lord", "king", "queen", "allegiance", "sworn", "crown"])).size;
  if (profile.asks_explanation)
    score += 0.08 * inter(terms, new Set(["because", "reason", "cause", "result", "led", "leading"])).size;
  if (profile.asks_family)
    score += 0.08 * inter(terms, new Set(["parent", "father", "mother", "sibling", "brother", "sister", "married", "betrothed", "ancestor", "lineage", "grandson", "grandfather", "nephew", "aunt", "uncle"])).size;
  if (profile.asks_hierarchy)
    score += 0.08 * inter(terms, new Set(["commander", "ranger", "steward", "builder", "rank", "order", "sworn", "lord", "master"])).size;
  score += 0.03 * inter(terms, EVIDENCE_CUE_TERMS).size;
  score += 0.03 * inter(terms, ALLIANCE_TERMS).size;
  return Math.min(score, 1.0);
}

type ScoredChunk = ChunkMeta & {
  embedding_score: number;
  score: number;
  rerank_score?: number;
  matched_terms?: string[];
  rerank_reason?: string;
};

function rerankScore(chunk: ScoredChunk, profile: QuestionProfile): number {
  const text = compactText(`${chunk.title || ""} ${chunk.text || ""}`);
  const terms = new Set(profile.expanded_terms);
  const embeddingComponent = Number(chunk.embedding_score ?? chunk.score ?? 0);
  const lexicalComponent = lexicalScore(text, terms);
  const cueComponent = cueScore(text, profile);
  return 0.62 * embeddingComponent + 0.25 * lexicalComponent + 0.13 * cueComponent;
}

// ── retrieval ───────────────────────────────────────────────────────────────

async function retrieveCandidateChunks(
  question: string,
  store: VectorStore,
  candidateK: number,
): Promise<[ScoredChunk[], number[]]> {
  const query = expandedQueryText(question);
  const queryEmbedding = (await embedTexts([query], store.embedding_model))[0];
  const scored: ScoredChunk[] = store.chunks.map((chunk, i) => {
    const embeddingScore = cosineSimilarity(queryEmbedding, store.vectorAt(i));
    return { ...chunk, embedding_score: embeddingScore, score: embeddingScore };
  });
  scored.sort((a, b) => b.embedding_score - a.embedding_score);
  return [scored.slice(0, candidateK), queryEmbedding];
}

function dedupeChunks(chunks: ScoredChunk[], maxChunks: number): ScoredChunk[] {
  const deduped: ScoredChunk[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    let key = `${chunk.document_id || ""} ${chunk.chunk_id || ""}`;
    if (!chunk.document_id && !chunk.chunk_id) {
      key = chunk.text_hash || compactText(chunk.text || "");
    }
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(chunk);
    if (deduped.length >= maxChunks) break;
  }
  return deduped;
}

function hybridRerank(question: string, candidates: ScoredChunk[], topK: number): ScoredChunk[] {
  const profile = classifyQuestion(question);
  const profTerms = new Set(profile.expanded_terms);
  const reranked: ScoredChunk[] = candidates.map((chunk) => {
    const text = compactText(`${chunk.title || ""} ${chunk.text || ""}`);
    const hybrid = rerankScore(chunk, profile);
    const matchedTerms = [...inter(profTerms, wordTerms(text))].sort();
    return {
      ...chunk,
      score: hybrid,
      rerank_score: hybrid,
      matched_terms: matchedTerms,
      rerank_reason: "hybrid embedding + lexical + GOT cue score",
    };
  });
  reranked.sort((a, b) => (b.rerank_score ?? 0) - (a.rerank_score ?? 0));
  return dedupeChunks(reranked, topK);
}

async function retrieveChunks(
  question: string,
  store: VectorStore,
  topK: number,
  candidateK: number,
): Promise<[ScoredChunk[], number[]]> {
  const [candidates, queryEmbedding] = await retrieveCandidateChunks(question, store, Math.max(candidateK, topK));
  const hybrid = hybridRerank(question, candidates, Math.max(Math.floor(candidateK / 2), topK));
  return [dedupeChunks(hybrid, topK), queryEmbedding];
}

// ── evidence snippet selection ──────────────────────────────────────────────

function sentenceWindows(text: string): string[] {
  const sentences = compactText(text)
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const windows = [...sentences];
  for (let i = 0; i + 1 < sentences.length; i++) {
    if (sentences[i].length < 220) windows.push(`${sentences[i]} ${sentences[i + 1]}`);
  }
  return windows;
}

function snippetScore(snippet: string, terms: Set<string>): number {
  const st = wordTerms(snippet);
  let score = 4 * inter(terms, st).size;
  score += inter(EVIDENCE_CUE_TERMS, st).size;
  score += 2 * inter(CONFLICT_TERMS, st).size;
  score += 2 * inter(ALLIANCE_TERMS, st).size;
  return score;
}

export function evidenceSnippet(text: string, question: string, maxLength = 320): string {
  const terms = expandedQueryTerms(question);
  const windows = sentenceWindows(text);
  const candidates = windows.length ? windows : [text];
  let best = candidates[0];
  let bestScore = -1;
  for (const w of candidates) {
    const s = snippetScore(w, terms);
    if (s > bestScore) {
      bestScore = s;
      best = w;
    }
  }
  if (best.length <= maxLength) return best;
  return best.slice(0, maxLength - 3).trimEnd() + "...";
}

// ── synthesis ───────────────────────────────────────────────────────────────

export function contextForAnswer(
  chunks: { document_id: string; chunk_id: string; title?: string; text: string; score?: number; matched_terms?: string[] }[],
): string {
  return chunks
    .map(
      (chunk, i) =>
        `[Chunk ${i + 1}]\n` +
        `document_id: ${chunk.document_id}\n` +
        `chunk_id: ${chunk.chunk_id}\n` +
        `title: ${chunk.title ?? ""}\n` +
        `retrieval_score: ${Number(chunk.score ?? 0).toFixed(6)}\n` +
        `matched_terms: ${(chunk.matched_terms ?? []).join(", ")}\n` +
        `text: ${chunk.text}`,
    )
    .join("\n\n");
}

/**
 * Retrieval only (no answer synthesis) — used by the hybrid method to fold
 * vector chunks into a combined context. Returns the formatted context block
 * plus per-chunk evidence snippets for citation.
 */
export async function retrieveContext(
  question: string,
  topK: number = DEFAULT_TOP_K,
  candidateK: number = DEFAULT_CANDIDATE_K,
): Promise<{ context: string; snippets: EvidenceSnippet[] }> {
  const store = getVectorStore();
  const [chunks] = await retrieveChunks(question, store, topK, candidateK);
  const context = contextForAnswer(chunks);
  const snippets: EvidenceSnippet[] = chunks.map((chunk) => ({
    document_id: chunk.document_id,
    chunk_id: chunk.chunk_id,
    snippet: evidenceSnippet(chunk.text, question),
    matched_terms: chunk.matched_terms ?? [],
  }));
  return { context, snippets };
}

async function synthesizeAnswer(question: string, chunks: ScoredChunk[], model: string): Promise<string> {
  const profile = classifyQuestion(question);
  return respond({
    model,
    instructions: ANSWER_INSTRUCTIONS,
    input:
      `Question:\n${question}\n\n` +
      `Question profile:\n${JSON.stringify(profile, null, 2)}\n\n` +
      `Retrieved chunks:\n${contextForAnswer(chunks)}`,
  });
}

export interface VectorPayload {
  answer: string;
  question_profile: QuestionProfile;
  retrieved_chunks: Record<string, unknown>[];
  document_id: string[];
  chunk_id: string[];
  evidence_snippets: EvidenceSnippet[];
  query_embedding: number[] | null;
}

function resultPayload(
  answer: string,
  question: string,
  chunks: ScoredChunk[],
  queryEmbedding: number[] | null,
): VectorPayload {
  const retrievedChunks = chunks.map((chunk) => ({
    document_id: chunk.document_id,
    chunk_id: chunk.chunk_id,
    title: chunk.title,
    text: chunk.text,
    embedding_score: Number((chunk.embedding_score ?? 0).toFixed(6)),
    rerank_score: Number((chunk.rerank_score ?? chunk.score ?? 0).toFixed(6)),
    score: Number((chunk.score ?? 0).toFixed(6)),
    matched_terms: chunk.matched_terms ?? [],
    rerank_reason: chunk.rerank_reason ?? "",
  }));
  const snippets: EvidenceSnippet[] = chunks.map((chunk) => ({
    document_id: chunk.document_id,
    chunk_id: chunk.chunk_id,
    snippet: evidenceSnippet(chunk.text, question),
    matched_terms: chunk.matched_terms ?? [],
  }));
  return {
    answer,
    question_profile: classifyQuestion(question),
    retrieved_chunks: retrievedChunks,
    document_id: chunks.map((c) => c.document_id),
    chunk_id: chunks.map((c) => c.chunk_id),
    evidence_snippets: snippets,
    query_embedding: queryEmbedding,
  };
}

export async function askQuestion(
  question: string,
  topK: number = DEFAULT_TOP_K,
  candidateK: number = DEFAULT_CANDIDATE_K,
  model: string = ANSWER_MODEL,
): Promise<VectorPayload> {
  if (topK <= 0) throw new Error("top-k must be greater than 0");
  if (candidateK < topK) throw new Error("candidate-k must be greater than or equal to top-k");
  const store = getVectorStore();
  const [chunks, queryEmbedding] = await retrieveChunks(question, store, topK, candidateK);
  if (chunks.length === 0) throw new Error("Vector store contains no chunks");
  const answer = await synthesizeAnswer(question, chunks, model);
  return resultPayload(answer, question, chunks, queryEmbedding);
}
