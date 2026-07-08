// Phase 4 — Graph RAG query engine.
//
// Pipeline for one question:
//   1. link  — pull entity mentions out of the question and match them to graph
//              nodes via the `entityNames` full-text index.
//   2. cypher — ask the LLM to write ONE read-only Cypher query over the closed
//              schema, seeded with the linked entities' exact canonical names.
//   3. run   — execute it (after a read-only guard) and serialise the rows.
//   4. answer — have the LLM write a grounded answer from those rows.
//
// This is what lets the graph answer multi-hop / aggregation / path questions
// that vector RAG cannot: retrieval is graph traversal, not chunk similarity.

import neo4j from "neo4j-driver";
import { getSession } from "./neo4j";
import { respond, ANSWER_MODEL } from "./openai";
import { schemaForPrompt } from "./graphSchema";
import type { Subgraph, SubgraphNode, SubgraphEdge } from "./webTypes";

export interface LinkedEntity {
  mention: string;
  id: string;
  name: string;
  type: string;
  score: number;
}

export interface GraphEvidence {
  chunk_id: string;
  episode: string;
  description: string;
}

// Subgraph shapes live in webTypes (client-safe) and are re-exported for callers.
export type { Subgraph, SubgraphNode, SubgraphEdge } from "./webTypes";

export interface GraphAnswer {
  answer: string;
  cypher: string;
  linked: LinkedEntity[];
  rows: string[];
  evidence: GraphEvidence[];
  subgraph: Subgraph;
}

/** Strip a ```-fenced block if the model added one. */
function stripFence(text: string): string {
  let t = text.trim();
  if (t.startsWith("```")) t = t.replace(/^```(?:json|cypher)?\s*/i, "").replace(/```\s*$/, "").trim();
  return t;
}

/** Escape Lucene special characters so a raw name is a safe full-text query. */
function luceneEscape(s: string): string {
  return s.replace(/[+\-&|!(){}\[\]^"~*?:\\/]/g, " ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// 1. Entity linking
// ---------------------------------------------------------------------------

const LINK_INSTRUCTIONS = `Extract the named entities (characters, houses, places, titles, groups, events)
referred to in the user's Game of Thrones question. Return the surface names as
written. Return ONLY JSON: {"mentions": ["...", "..."]}. If none, {"mentions": []}.`;

async function extractMentions(question: string, model: string): Promise<string[]> {
  const raw = await respond({ model, instructions: LINK_INSTRUCTIONS, input: question, temperature: 0 });
  try {
    const parsed = JSON.parse(stripFence(raw));
    const arr = (parsed as { mentions?: unknown[] }).mentions;
    if (Array.isArray(arr)) return arr.filter((m): m is string => typeof m === "string" && m.trim().length > 0);
  } catch {
    /* fall through */
  }
  return [];
}

export async function linkEntities(question: string, model: string): Promise<LinkedEntity[]> {
  const mentions = await extractMentions(question, model);
  const linked: LinkedEntity[] = [];
  const seen = new Set<string>();
  const session = getSession();
  try {
    for (const mention of mentions) {
      const q = luceneEscape(mention);
      if (!q) continue;
      const res = await session.run(
        `CALL db.index.fulltext.queryNodes('entityNames', $q) YIELD node, score
         RETURN node.id AS id, node.name AS name, node.type AS type, score
         ORDER BY score DESC LIMIT 1`,
        { q },
      );
      const rec = res.records[0];
      if (!rec) continue;
      const id = rec.get("id") as string;
      if (seen.has(id)) continue;
      seen.add(id);
      linked.push({
        mention,
        id,
        name: rec.get("name") as string,
        type: rec.get("type") as string,
        score: rec.get("score") as number,
      });
    }
  } finally {
    await session.close();
  }
  return linked;
}

// ---------------------------------------------------------------------------
// 2. Text-to-Cypher
// ---------------------------------------------------------------------------

function cypherInstructions(): string {
  return `You translate a Game of Thrones question into ONE read-only Cypher query for Neo4j.

GRAPH MODEL:
- Every node also has the label :Entity and properties { id, name, type, aliases, mentions }.
- Node labels are exactly these types, and relationship types/directions are:

${schemaForPrompt()}

- Relationships have properties { chunk_ids, episodes, descriptions, count }.

RULES:
- Match entities by their .name property (use the EXACT canonical names supplied below).
- Respect relationship DIRECTION as documented (e.g. (killer)-[:KILLED]->(victim)).
- For "how are X and Y connected / related" questions, bind and return the whole
  path, never just the endpoints:
    MATCH p = shortestPath((a:Entity {name:"X"})-[*..6]-(b:Entity {name:"Y"}))
    RETURN [n IN nodes(p) | n.name] AS chain, relationships(p) AS rels
- Use count()/collect() for aggregation/"how many"/"list all" questions.
- Always RETURN enough to actually answer the question (names, the path, the
  count) — not just the entities that were matched.
- To cite sources, bind the relationship to a variable and RETURN the variable
  ITSELF (not its properties), e.g. MATCH (a)-[r:KILLED]->(b) RETURN b.name, r.
  Its provenance is then extracted automatically. Never reference a relationship
  TYPE (e.g. KILLED.descriptions) as if it were a variable.
- READ-ONLY ONLY. Never use CREATE, MERGE, SET, DELETE, REMOVE, DROP, CALL, LOAD.
- Always include a LIMIT (<= 100) unless using count().

Respond with ONLY the Cypher query — no prose, no markdown fences.`;
}

const WRITE_KEYWORDS = /\b(CREATE|MERGE|SET|DELETE|REMOVE|DROP|DETACH|FOREACH|LOAD)\b|CALL\s*\{|CALL\s+db|CALL\s+apoc/i;

export function isReadOnlyCypher(cypher: string): boolean {
  return !WRITE_KEYWORDS.test(cypher);
}

export async function generateCypher(
  question: string,
  linked: LinkedEntity[],
  model: string,
  previous?: { cypher: string; error: string },
): Promise<string> {
  const known = linked.length
    ? "Known entities in the graph (use these exact names):\n" +
      linked.map((l) => `- "${l.name}" (${l.type})`).join("\n")
    : "No entities were pre-linked; match by name yourself.";
  const repair = previous
    ? `\n\nYour previous query failed. Fix it.\nPrevious Cypher:\n${previous.cypher}\nError:\n${previous.error}`
    : "";
  const raw = await respond({
    model,
    instructions: cypherInstructions(),
    input: `${known}\n\nQuestion: ${question}${repair}`,
    temperature: 0,
  });
  return stripFence(raw);
}

// ---------------------------------------------------------------------------
// 3. Execute + serialise
// ---------------------------------------------------------------------------

function toPlain(value: unknown): unknown {
  if (neo4j.isInt(value)) return (value as { toNumber(): number }).toNumber();
  if (Array.isArray(value)) return value.map(toPlain);
  if (neo4j.isNode(value)) return (value as { properties: { name?: string } }).properties.name ?? "(node)";
  if (neo4j.isRelationship(value)) {
    const r = value as { type: string; properties: Record<string, unknown> };
    const desc = (r.properties.descriptions as string[])?.[0];
    return desc ? `[${r.type}: ${desc}]` : `[${r.type}]`;
  }
  if (neo4j.isPath(value)) {
    const p = value as { segments: { relationship: { type: string }; end: { properties: { name?: string } } }[]; start: { properties: { name?: string } } };
    const names = [p.start.properties.name, ...p.segments.map((s) => s.end.properties.name)];
    return names.join(" -> ");
  }
  return value;
}

/** Pull chunk_id/episode/description provenance out of any relationships returned. */
function collectEvidence(records: import("neo4j-driver").Record[]): GraphEvidence[] {
  const out: GraphEvidence[] = [];
  const seen = new Set<string>();
  const fromRel = (r: { properties: Record<string, unknown> }) => {
    const props = r.properties;
    const chunks = (props.chunk_ids as string[]) ?? [];
    const episodes = (props.episodes as string[]) ?? [];
    const descs = (props.descriptions as string[]) ?? [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk_id = chunks[i];
      if (!chunk_id || seen.has(chunk_id)) continue;
      seen.add(chunk_id);
      out.push({ chunk_id, episode: episodes[i] ?? episodes[0] ?? "", description: descs[i] ?? descs[0] ?? "" });
    }
  };
  const walk = (v: unknown) => {
    if (neo4j.isRelationship(v)) fromRel(v as { properties: Record<string, unknown> });
    else if (neo4j.isPath(v)) for (const s of (v as { segments: { relationship: unknown }[] }).segments) walk(s.relationship);
    else if (Array.isArray(v)) v.forEach(walk);
  };
  for (const rec of records) for (const key of rec.keys) walk(rec.get(key));
  return out;
}

async function runCypher(cypher: string): Promise<{ rows: string[]; evidence: GraphEvidence[] }> {
  const session = getSession();
  try {
    const res = await session.run(cypher);
    const rows = res.records.map((rec) =>
      rec.keys.map((k) => `${String(k)}=${JSON.stringify(toPlain(rec.get(k)))}`).join("  "),
    );
    return { rows, evidence: collectEvidence(res.records) };
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// 4. Answer
// ---------------------------------------------------------------------------

const ANSWER_INSTRUCTIONS = `You answer a Game of Thrones question using ONLY the graph query results provided.
- Base every claim on the rows. If they are empty or insufficient, say the graph
  has no answer — do not use outside knowledge.
- Be concise and direct. For "list"/"how many" questions, give the full list/count.`;

const MAX_CYPHER_ATTEMPTS = 3;
const SUBGRAPH_LIMIT = 80;

export interface GraphRetrieval {
  linked: LinkedEntity[];
  cypher: string;
  rows: string[];
  evidence: GraphEvidence[];
  subgraph: Subgraph;
  ran: boolean;
  error?: string;
}

/**
 * Fetch a small neighbourhood subgraph around the linked entities for the
 * "knowledge subgraph" visualisation. Always populated (works for path,
 * aggregation and count questions alike) because it seeds on the linked nodes.
 */
export async function fetchSubgraph(ids: string[]): Promise<Subgraph> {
  if (!ids.length) return { nodes: [], edges: [] };
  const session = getSession();
  try {
    const res = await session.run(
      `MATCH (a:Entity)-[r]->(b:Entity)
       WHERE a.id IN $ids OR b.id IN $ids
       RETURN a.id AS sid, a.name AS sname, a.type AS stype,
              type(r) AS rel, coalesce(r.descriptions[0], '') AS descr,
              b.id AS oid, b.name AS oname, b.type AS otype
       LIMIT $limit`,
      { ids, limit: neo4j.int(SUBGRAPH_LIMIT) },
    );
    const nodes = new Map<string, SubgraphNode>();
    const edges: SubgraphEdge[] = [];
    const edgeSeen = new Set<string>();
    for (const rec of res.records) {
      const sid = rec.get("sid") as string;
      const oid = rec.get("oid") as string;
      if (!nodes.has(sid)) nodes.set(sid, { id: sid, label: rec.get("sname") as string, type: rec.get("stype") as string });
      if (!nodes.has(oid)) nodes.set(oid, { id: oid, label: rec.get("oname") as string, type: rec.get("otype") as string });
      const rel = rec.get("rel") as string;
      const key = `${sid}|${rel}|${oid}`;
      if (edgeSeen.has(key)) continue;
      edgeSeen.add(key);
      edges.push({ source: sid, target: oid, relation: rel, description: (rec.get("descr") as string) || undefined });
    }
    return { nodes: [...nodes.values()], edges };
  } finally {
    await session.close();
  }
}

/**
 * Retrieval only (no answer synthesis): link entities → generate Cypher →
 * run with a self-repair loop, plus a neighbourhood subgraph for the viz.
 * Shared by askGraph and the hybrid method.
 */
export async function retrieveGraph(question: string, model: string = ANSWER_MODEL): Promise<GraphRetrieval> {
  const linked = await linkEntities(question, model);
  const subgraphPromise = fetchSubgraph(linked.map((l) => l.id)).catch(() => ({ nodes: [], edges: [] }));

  let cypher = "";
  let rows: string[] = [];
  let evidence: GraphEvidence[] = [];
  let lastError = "";
  for (let attempt = 0; attempt < MAX_CYPHER_ATTEMPTS; attempt++) {
    cypher = await generateCypher(question, linked, model, attempt > 0 ? { cypher, error: lastError } : undefined);
    if (!isReadOnlyCypher(cypher)) {
      return { linked, cypher, rows: [], evidence: [], subgraph: await subgraphPromise, ran: false, error: "generated query was not read-only" };
    }
    try {
      ({ rows, evidence } = await runCypher(cypher));
      return { linked, cypher, rows, evidence, subgraph: await subgraphPromise, ran: true };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { linked, cypher, rows: [], evidence: [], subgraph: await subgraphPromise, ran: false, error: lastError };
}

export async function askGraph(question: string, model: string = ANSWER_MODEL): Promise<GraphAnswer> {
  const g = await retrieveGraph(question, model);
  if (!g.ran) {
    const answer = g.error === "generated query was not read-only"
      ? "Refused: the generated query was not read-only."
      : `The generated Cypher failed after ${MAX_CYPHER_ATTEMPTS} attempts: ${g.error}`;
    return { answer, cypher: g.cypher, linked: g.linked, rows: [], evidence: [], subgraph: g.subgraph };
  }

  const context = g.rows.length ? g.rows.join("\n") : "(no rows returned)";
  const answer = await respond({
    model,
    instructions: ANSWER_INSTRUCTIONS,
    input: `Question: ${question}\n\nGraph query results:\n${context}`,
    temperature: 0,
  });

  return { answer, cypher: g.cypher, linked: g.linked, rows: g.rows, evidence: g.evidence, subgraph: g.subgraph };
}
