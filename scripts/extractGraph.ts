// Phase 1 — extract schema-constrained (subject, relation, object) triples from
// each chunk of data/chunks/chunks.jsonl into data/graph/triples.jsonl.
//
// Nothing here touches Neo4j. The goal is to produce a plain, inspectable JSONL
// of facts you can eyeball BEFORE loading a graph. Every triple carries its
// source document_id/chunk_id so later phases (entity resolution, load) keep
// provenance for citations.
//
//   npm run extract:graph -- --limit 5        # cheap first look at a few chunks
//   npm run extract:graph                      # full corpus (~850 LLM calls)
//   npm run extract:graph -- show              # summarise an existing triples file
//   npm run extract:graph -- --concurrency 6   # parallel extraction workers

import fs from "fs";
import path from "path";
import { loadEnv } from "../src/lib/env";
import { getClient, ANSWER_MODEL } from "../src/lib/openai";
import {
  schemaForPrompt,
  isNodeType,
  isRelationType,
  isRelationTypeAllowed,
  isPlaceholderName,
  type GraphTriple,
} from "../src/lib/graphSchema";
import type { ChunkRecord } from "../src/lib/types";

loadEnv();

const DEFAULT_CHUNKS_FILE = "data/chunks/chunks.jsonl";
const DEFAULT_TRIPLES_FILE = "data/graph/triples.jsonl";
const DEFAULT_CONCURRENCY = 4;

const INSTRUCTIONS = `You extract a knowledge graph from Game of Thrones episode synopses.

Read the passage and list every explicit fact that matches the ontology below.
Rules:
- Use ONLY the listed node types and relation types. Discard anything that does not fit.
- NAMED ENTITIES ONLY. Every subject and object must be a proper name (Ned Stark,
  House Lannister, Winterfell, Night's Watch). SKIP generic, descriptive or
  collective references: "the deserter", "a direwolf", "Drogo's army", "Ned's
  sister", "the men", "south of the wall". If you cannot name BOTH ends, drop it.
- Use the fullest name available; never use pronouns ("he"/"she"/"they") or a
  bare first name when a surname appears elsewhere in the passage.
- Pick the relation that MATCHES the evidence. If the text says brother/sister,
  use SIBLING_OF (never PARENT_OF). If it says father/mother/son/daughter, use
  PARENT_OF in parent->child direction. Re-read your description and confirm the
  relation and its direction agree with it before emitting.
- Respect direction: KILLED is killer->victim, CAPTURED is captor->captive,
  PARENT_OF is parent->child, BASTARD_OF is child->parent.
- Only extract facts STATED in this passage. Do not infer from world knowledge.
- PRECISION OVER RECALL. Emit a triple only when the passage states the fact
  outright. If you are unsure of the relation, the direction, or either name,
  DROP it. A missing fact is fine; a wrong fact is not.
- KILLED means the subject actually causes the object's death IN THIS PASSAGE.
  Do NOT emit KILLED for ordering/plotting/threatening/attempting a death, for a
  fight the victim survives, or for a death with no named killer. The victim must
  be a single named Character (never a House, Group, Title, army or Event).
- SIBLING_OF only when the text calls them brother/sister/twin. Do NOT infer it
  from sharing a house, a scene, a parent, or an alliance. Parents, children,
  wards, spouses, allies and enemies are NOT siblings.
- MARRIED_TO only for an explicit spouse/betrothal. Allies, lovers named only as
  such, and family members are not spouses.
- HOLDS_TITLE only when the passage explicitly grants/attributes that rank to the
  character; do not tag everyone present in a royal scene as holding the title.
- "description" is a short phrase (<=15 words) grounded in the passage.
- If the passage contains no valid facts, return {"triples": []}.

${schemaForPrompt()}

EXAMPLES (illustrating the rules, not the current passage):
Passage: "Ned beheads a captured deserter while his son Bran watches. Bran's sister Arya is also a Stark."
Correct: {"triples": [
  {"subject": "Ned Stark", "subject_type": "Character", "relation": "PARENT_OF", "object": "Bran Stark", "object_type": "Character", "description": "Bran is Ned's son"},
  {"subject": "Bran Stark", "subject_type": "Character", "relation": "SIBLING_OF", "object": "Arya Stark", "object_type": "Character", "description": "Arya is Bran's sister"}
]}
Note: the "deserter" is unnamed, so no KILLED triple is emitted.

Passage: "Viserys Targaryen marries off his sister Daenerys to the warlord Khal Drogo."
Correct: {"triples": [
  {"subject": "Viserys Targaryen", "subject_type": "Character", "relation": "SIBLING_OF", "object": "Daenerys Targaryen", "object_type": "Character", "description": "Daenerys is Viserys's sister"},
  {"subject": "Daenerys Targaryen", "subject_type": "Character", "relation": "MARRIED_TO", "object": "Khal Drogo", "object_type": "Character", "description": "Daenerys is married to Khal Drogo"}
]}

Respond with ONLY a JSON object of this exact shape (no prose, no markdown fences):
{"triples": [
  {"subject": "...", "subject_type": "Character", "relation": "KILLED", "object": "...", "object_type": "Character", "description": "..."}
]}`;

function readChunks(file: string): ChunkRecord[] {
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ChunkRecord);
}

/** Strip accidental ```json fences and parse the model's JSON reply. */
function parseTriples(raw: string): unknown[] {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { triples?: unknown[] }).triples)) {
    return (parsed as { triples: unknown[] }).triples;
  }
  return [];
}

// Lowercase common nouns that betray a descriptive (non-named) reference when
// they appear as a whole word: "Ned Stark's sister", "Lannister soldiers".
// Legit proper names ("King's Landing", "Night's Watch") never contain these
// as a bare lowercase word.
const DESCRIPTOR_WORD =
  /\b(army|armies|soldiers?|men|guards?|forces?|people|sister|brother|son|daughter|mother|father|wife|husband|cousins?|uncle|aunt|nephew|niece|child|children|bastard|servants?|assassins?)\b/;

// Generic role words that are not names even when the model capitalises them
// ("Deserter", "Prisoner"). Matched case-insensitively against the WHOLE name,
// so multi-word proper names like "Second Sons" or "Sons of the Harpy" are safe.
const GENERIC_ROLE = new Set([
  "deserter", "deserters", "prisoner", "prisoners", "captive", "captives",
  "ranger", "rangers", "villager", "villagers", "assassin", "wildling",
  "wildlings", "guest", "guests", "stranger", "strangers", "boy", "girl",
]);

/**
 * A proper name in this corpus starts with a capital letter (or a digit, for
 * things like "Seven Kingdoms") and is not a descriptive paraphrase. Rejects
 * generic common nouns ("deserter") and possessive descriptions the model
 * sometimes emits in place of a name ("Ned Stark's sister", "Robb's brother").
 */
function isProperName(name: string): boolean {
  if (!/^[A-Z0-9]/.test(name)) return false;
  if (GENERIC_ROLE.has(name.trim().toLowerCase())) return false;
  // Possessive followed by a lowercase word: "Ned Stark's sister". Sparing
  // legitimate possessive place/group names whose next word is capitalised
  // ("King's Landing", "Night's Watch").
  if (/'s\s+[a-z]/.test(name)) return false;
  if (DESCRIPTOR_WORD.test(name)) return false;
  return true;
}

/** Keep only well-formed triples that respect the closed ontology. */
function validate(rawTriples: unknown[], chunk: ChunkRecord): GraphTriple[] {
  const out: GraphTriple[] = [];
  for (const t of rawTriples) {
    if (!t || typeof t !== "object") continue;
    const r = t as Record<string, unknown>;
    const subject = typeof r.subject === "string" ? r.subject.trim() : "";
    const object = typeof r.object === "string" ? r.object.trim() : "";
    if (!subject || !object) continue;
    // Named entities are capitalised in this corpus; drop generic common-noun
    // nodes the model occasionally emits ("deserter", "pup", "direwolf").
    if (!isProperName(subject) || !isProperName(object)) continue;
    // Reject placeholder tokens ("N/A", "Unknown") emitted in place of a real fact.
    if (isPlaceholderName(subject) || isPlaceholderName(object)) continue;
    if (!isNodeType(r.subject_type) || !isNodeType(r.object_type)) continue;
    if (!isRelationType(r.relation)) continue;
    // Enforce ontology directionality (e.g. KILLED must target a Character, not
    // a House/Title/Event). Drops mistyped triples before they reach the file.
    if (!isRelationTypeAllowed(r.relation, r.subject_type, r.object_type)) continue;
    out.push({
      subject,
      subject_type: r.subject_type,
      relation: r.relation,
      object,
      object_type: r.object_type,
      description: typeof r.description === "string" ? r.description.trim() : "",
      document_id: chunk.document_id,
      chunk_id: chunk.chunk_id,
    });
  }
  return out;
}

async function extractChunk(chunk: ChunkRecord, model: string): Promise<GraphTriple[]> {
  const input = `Episode ${chunk.document_id} — "${chunk.title ?? ""}"\n\nPassage:\n${chunk.text}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = await getClient().responses.create({
    model,
    instructions: INSTRUCTIONS,
    input,
    temperature: 0,
  } as any);
  const text: string = res.output_text ?? "";
  return validate(parseTriples(text), chunk);
}

/** Run an async worker over items with bounded concurrency, preserving order. */
async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function run(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await worker(items[i], i);
    }
  }
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, run);
  await Promise.all(runners);
  return results;
}

async function extractAll(opts: Opts): Promise<void> {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required (check .env.local).");

  let chunks = readChunks(opts.chunksFile).filter((c) => (c.text ?? "").trim());
  if (chunks.length === 0) throw new Error(`No chunks in ${opts.chunksFile}. Run: npm run build:chunks`);
  if (opts.limit > 0) chunks = chunks.slice(0, opts.limit);

  console.log(`Extracting triples from ${chunks.length} chunk(s) with ${opts.model} (concurrency ${opts.concurrency}) ...`);

  fs.mkdirSync(path.dirname(opts.triplesFile), { recursive: true });
  const stream = fs.createWriteStream(opts.triplesFile, { flags: "w" });

  let done = 0;
  let total = 0;
  let failed = 0;
  const perChunk = await mapPool(chunks, opts.concurrency, async (chunk) => {
    let triples: GraphTriple[] = [];
    try {
      triples = await extractChunk(chunk, opts.model);
    } catch (err) {
      failed++;
      console.error(`  ! ${chunk.chunk_id}: ${err instanceof Error ? err.message : err}`);
    }
    done++;
    if (done % 25 === 0 || done === chunks.length) {
      console.log(`  ${done}/${chunks.length} chunks  (${total + triples.length} triples so far)`);
    }
    return triples;
  });

  // Write in stable chunk order.
  for (const triples of perChunk) {
    for (const t of triples) {
      stream.write(JSON.stringify(t) + "\n");
      total++;
    }
  }
  await new Promise<void>((resolve) => stream.end(resolve));

  console.log(`\nWrote ${total} triple(s) to ${opts.triplesFile}`);
  if (failed) console.log(`  (${failed} chunk(s) failed extraction)`);
  summarise(opts.triplesFile);
}

/** Print counts per relation type + a few samples — the eyeball view. */
function summarise(file: string): void {
  if (!fs.existsSync(file)) {
    console.error(`No triples file at ${file}.`);
    return;
  }
  const triples = fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as GraphTriple);

  const byRelation = new Map<string, number>();
  const subjects = new Set<string>();
  const objects = new Set<string>();
  for (const t of triples) {
    byRelation.set(t.relation, (byRelation.get(t.relation) ?? 0) + 1);
    subjects.add(t.subject);
    objects.add(t.object);
  }

  console.log(`\n=== TRIPLES SUMMARY (${file}) ===`);
  console.log(`Total triples     : ${triples.length}`);
  console.log(`Distinct subjects : ${subjects.size}`);
  console.log(`Distinct objects  : ${objects.size}`);
  console.log(`\nBy relation:`);
  [...byRelation.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([rel, n]) => console.log(`  ${rel.padEnd(18)} ${n}`));

  console.log(`\nSample:`);
  triples.slice(0, 15).forEach((t) => {
    console.log(`  (${t.subject}) -[${t.relation}]-> (${t.object})   [${t.chunk_id}]`);
  });
}

interface Opts {
  command: "extract" | "show";
  chunksFile: string;
  triplesFile: string;
  model: string;
  limit: number;
  concurrency: number;
}

function parseArgs(argv: string[]): Opts {
  const args = argv.slice(2);
  const opts: Opts = {
    command: "extract",
    chunksFile: DEFAULT_CHUNKS_FILE,
    triplesFile: DEFAULT_TRIPLES_FILE,
    model: ANSWER_MODEL,
    limit: 0,
    concurrency: DEFAULT_CONCURRENCY,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = args[i + 1];
    if (a === "show" || a === "extract") opts.command = a;
    else if (a === "--chunks-file") { opts.chunksFile = v; i++; }
    else if (a === "--triples-file") { opts.triplesFile = v; i++; }
    else if (a === "--model") { opts.model = v; i++; }
    else if (a === "--limit") { opts.limit = Number(v); i++; }
    else if (a === "--concurrency") { opts.concurrency = Math.max(1, Number(v)); i++; }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.command === "show") {
    summarise(opts.triplesFile);
    return;
  }
  await extractAll(opts);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nError:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
