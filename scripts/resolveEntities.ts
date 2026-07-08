// Phase 2 — entity resolution.
//
// Reads data/graph/triples.jsonl (surface-form facts) and produces:
//   data/graph/entities.json          -> canonical entities { id, name, type, aliases[] }
//   data/graph/triples.resolved.jsonl -> triples rewritten to canonical entity ids
//
// It does three things the raw extraction can't:
//   1. ALIAS MERGE  — "Eddard Stark"/"Ned Stark", "King Robert Baratheon"/"Robert
//      Baratheon" collapse to one canonical entity (an LLM pass, since it needs
//      GoT knowledge to know these are the same person).
//   2. NOISE PRUNE  — descriptive phrases that aren't entities ("Ned Stark's
//      sister", "Men who captured Jaime", "Unnamed man...") are dropped.
//   3. TYPE VOTE    — one node type per entity (majority of observed types as a
//      deterministic fallback when the LLM is unsure).
//
//   npm run resolve:graph                 # full run
//   npm run resolve:graph -- --limit 80   # only resolve the 80 most-frequent names (dev)
//   npm run resolve:graph -- show         # summarise an existing entities.json

import fs from "fs";
import path from "path";
import { loadEnv } from "../src/lib/env";
import { getClient, ANSWER_MODEL } from "../src/lib/openai";
import { NODE_TYPES, isNodeType, isPlaceholderName, type GraphTriple, type NodeType } from "../src/lib/graphSchema";

loadEnv();

const DEFAULT_TRIPLES_FILE = "data/graph/triples.jsonl";
const DEFAULT_ENTITIES_FILE = "data/graph/entities.json";
const DEFAULT_RESOLVED_FILE = "data/graph/triples.resolved.jsonl";
const DEFAULT_BATCH_SIZE = 60;
const DEFAULT_CONCURRENCY = 4;

/** A surface name observed in the raw triples, with its stats. */
interface Mention {
  surface: string;
  typeVotes: Record<string, number>; // observed node types -> count
  majorityType: NodeType;
  count: number;
}

/** The LLM's decision for one surface name. */
interface Decision {
  surface: string;
  canonical: string; // canonical full name, aliases share this
  type: NodeType;
  keep: boolean; // false = descriptive/non-entity noise, drop it
}

/** A merged canonical entity written to entities.json. */
interface ResolvedEntity {
  id: string; // e.g. character:ned-stark
  canonical_name: string;
  type: NodeType;
  aliases: string[]; // surface forms that map here
  mentions: number; // total triple endpoints
}

interface ResolvedTriple {
  subject_id: string;
  subject_name: string;
  subject_type: NodeType;
  relation: string;
  object_id: string;
  object_name: string;
  object_type: NodeType;
  description: string;
  document_id: string;
  chunk_id: string;
}

const INSTRUCTIONS = `You are canonicalising entity names extracted from Game of Thrones synopses.

You receive a list of surface names, each with its most common node type and how
often it appeared. For EACH surface name decide:
- "canonical": the single canonical full name for the real entity. Aliases of the
  SAME entity MUST map to the SAME canonical string. Strip honorific/title
  prefixes and use the character's real name: "King Robert Baratheon" ->
  "Robert Baratheon"; "Ser Jaime Lannister" -> "Jaime Lannister"; "Eddard Stark"
  and "Ned Stark" -> "Ned Stark"; "Queen Cersei Baratheon"/"Cersei Lannister" ->
  "Cersei Lannister"; "The Imp" -> "Tyrion Lannister". For houses/locations/
  titles/groups/events, canonicalise to the standard name ("House Stark",
  "King's Landing", "Hand of the King", "Night's Watch").
- "type": one of ${NODE_TYPES.join(", ")}. Correct obvious mislabels (e.g. "The
  Mountain" is a Character, not a Title).
- "keep": false if the surface is NOT a real named entity — descriptive or
  possessive phrases ("Ned Stark's sister", "Daenerys Targaryen's followers"),
  groups of unnamed people ("Men who captured Jaime", "Four men who knifed Jon
  Snow", "Unnamed man..."), or generic references ("Deserter", "the pup"). Use
  true for genuine named entities.

Respond with ONLY JSON of this exact shape (no prose, no markdown fences):
{"decisions": [
  {"surface": "<echo the input surface exactly>", "canonical": "...", "type": "Character", "keep": true}
]}`;

/**
 * Manual corrections for rare, known LLM mis-merges the automated passes get
 * wrong. Keyed by surface form (case-insensitive) -> forced canonical + type.
 * e.g. "Halfhand" is Qhorin Halfhand, NOT Jon Snow.
 */
const MANUAL_ALIAS_OVERRIDES: Record<string, { canonical: string; type: NodeType }> = {
  halfhand: { canonical: "Qhorin Halfhand", type: "Character" },
};

const CONSOLIDATE_INSTRUCTIONS = `You are de-duplicating a list of canonical Game of Thrones entity names of type "{TYPE}".

Some names in the list refer to the SAME real entity (aliases, nicknames, spelling
variants, or a short form of a longer name). Group ONLY those that are genuinely
the same entity.

STRICT rules:
- Do NOT merge distinct entities that merely share a word. "King" vs "Hand of the
  King" vs "King in the North" are DIFFERENT titles. "Jon Snow" vs "Jon Arryn" are
  DIFFERENT people. "House Stark" vs "House Karstark" are DIFFERENT houses.
- Only merge when you are confident it is the same entity, e.g. "Drogo"/"Khal Drogo",
  "Eddison Tollett"/"Eddison"/"Tollett", "Luwin"/"Maester Luwin", "Vale"/"The Vale".
- For each merge group pick "canonical" = the fullest correct name.
- Return ONLY groups with 2+ members. Names that stand alone are omitted.

Respond with ONLY JSON (no prose, no fences):
{"groups": [{"canonical": "Drogo", "members": ["Drogo", "Khal Drogo"]}]}`;

interface MergeGroup {
  canonical: string;
  members: string[];
}

function readTriples(file: string): GraphTriple[] {
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as GraphTriple);
}

/** Collect unique surface names with type votes + frequency. */
function collectMentions(triples: GraphTriple[]): Map<string, Mention> {
  const byName = new Map<string, Mention>();
  const bump = (surface: string, type: string) => {
    let m = byName.get(surface);
    if (!m) {
      m = { surface, typeVotes: {}, majorityType: "Character", count: 0 };
      byName.set(surface, m);
    }
    m.typeVotes[type] = (m.typeVotes[type] ?? 0) + 1;
    m.count += 1;
  };
  for (const t of triples) {
    bump(t.subject, t.subject_type);
    bump(t.object, t.object_type);
  }
  // Resolve each mention's majority type.
  for (const m of byName.values()) {
    let best: NodeType = "Character";
    let bestN = -1;
    for (const [type, n] of Object.entries(m.typeVotes)) {
      if (isNodeType(type) && n > bestN) {
        best = type;
        bestN = n;
      }
    }
    m.majorityType = best;
  }
  return byName;
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "unknown";
}

function parseDecisions(raw: string): Decision[] {
  let text = raw.trim();
  if (text.startsWith("```")) text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : (parsed as { decisions?: unknown[] })?.decisions;
  if (!Array.isArray(arr)) return [];
  const out: Decision[] = [];
  for (const d of arr) {
    if (!d || typeof d !== "object") continue;
    const r = d as Record<string, unknown>;
    const surface = typeof r.surface === "string" ? r.surface : "";
    const canonical = typeof r.canonical === "string" ? r.canonical.trim() : "";
    if (!surface || !canonical) continue;
    out.push({
      surface,
      canonical,
      type: isNodeType(r.type) ? r.type : "Character",
      keep: r.keep !== false,
    });
  }
  return out;
}

async function decideBatch(batch: Mention[], model: string): Promise<Decision[]> {
  const list = batch
    .map((m) => `- "${m.surface}" (type=${m.majorityType}, seen ${m.count}x)`)
    .join("\n");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = await getClient().responses.create({
    model,
    instructions: INSTRUCTIONS,
    input: `Canonicalise these ${batch.length} surface names:\n${list}`,
    temperature: 0,
  } as any);
  return parseDecisions(res.output_text ?? "");
}

async function mapPool<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function run(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

function parseGroups(raw: string): MergeGroup[] {
  let text = raw.trim();
  if (text.startsWith("```")) text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed) ? parsed : (parsed as { groups?: unknown[] })?.groups;
  if (!Array.isArray(arr)) return [];
  const out: MergeGroup[] = [];
  for (const g of arr) {
    if (!g || typeof g !== "object") continue;
    const r = g as Record<string, unknown>;
    const members = Array.isArray(r.members) ? r.members.filter((m): m is string => typeof m === "string") : [];
    const canonical = typeof r.canonical === "string" ? r.canonical.trim() : "";
    if (members.length >= 2 && canonical) out.push({ canonical, members });
  }
  return out;
}

/**
 * Second pass: within each node type, ask the LLM to merge entities that are the
 * same real thing but were canonicalised differently across independent batches
 * (e.g. "Drogo" and "Khal Drogo"). Merges winners absorb losers; returns the
 * final entity list and an oldId -> newId remap to apply to the surface index.
 */
async function consolidate(
  entities: ResolvedEntity[],
  model: string,
  concurrency: number,
): Promise<{ entities: ResolvedEntity[]; idRemap: Map<string, string> }> {
  const byType = new Map<NodeType, ResolvedEntity[]>();
  for (const e of entities) {
    if (!byType.has(e.type)) byType.set(e.type, []);
    byType.get(e.type)!.push(e);
  }

  const idRemap = new Map<string, string>();
  const removed = new Set<string>();
  const types = [...byType.keys()];

  await mapPool(types, concurrency, async (type) => {
    const ents = byType.get(type)!;
    if (ents.length < 2) return;
    const list = ents.map((e) => `- "${e.canonical_name}" (${e.mentions})`).join("\n");
    let groups: MergeGroup[] = [];
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await getClient().responses.create({
        model,
        instructions: CONSOLIDATE_INSTRUCTIONS.replace("{TYPE}", type),
        input: `De-duplicate these ${ents.length} "${type}" names:\n${list}`,
        temperature: 0,
      } as any);
      groups = parseGroups(res.output_text ?? "");
    } catch (err) {
      console.error(`  ! consolidate ${type} failed: ${err instanceof Error ? err.message : err}`);
    }

    const byName = new Map(ents.map((e) => [e.canonical_name.toLowerCase().trim(), e]));
    for (const g of groups) {
      const members = g.members.map((m) => byName.get(m.toLowerCase().trim())).filter((e): e is ResolvedEntity => !!e);
      if (members.length < 2) continue;
      // Winner = the member matching the chosen canonical, else the most-mentioned.
      const winner =
        members.find((e) => e.canonical_name.toLowerCase().trim() === g.canonical.toLowerCase().trim()) ??
        members.slice().sort((a, b) => b.mentions - a.mentions)[0];
      winner.canonical_name = g.canonical || winner.canonical_name;
      for (const loser of members) {
        if (loser.id === winner.id || removed.has(loser.id)) continue;
        for (const a of loser.aliases) if (!winner.aliases.includes(a)) winner.aliases.push(a);
        winner.mentions += loser.mentions;
        idRemap.set(loser.id, winner.id);
        removed.add(loser.id);
      }
    }
  });

  const finalEntities = entities.filter((e) => !removed.has(e.id)).sort((a, b) => b.mentions - a.mentions);
  return { entities: finalEntities, idRemap };
}

async function resolve(opts: Opts): Promise<void> {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required (check .env.local).");

  const allTriples = readTriples(opts.triplesFile);
  // Drop any lingering placeholder-token edges before resolving.
  const triples = allTriples.filter(
    (t) => !isPlaceholderName(t.subject) && !isPlaceholderName(t.object),
  );
  if (triples.length === 0) throw new Error(`No triples in ${opts.triplesFile}. Run: npm run extract:graph`);
  const skippedPlaceholders = allTriples.length - triples.length;
  if (skippedPlaceholders) console.log(`Skipped ${skippedPlaceholders} placeholder-token triple(s).`);

  const mentions = [...collectMentions(triples).values()].sort((a, b) => b.count - a.count);
  const targets = opts.limit > 0 ? mentions.slice(0, opts.limit) : mentions;
  console.log(`Resolving ${targets.length} unique surface name(s) with ${opts.model} ...`);

  // Batch the names for the LLM canonicalisation pass.
  const batches: Mention[][] = [];
  for (let i = 0; i < targets.length; i += opts.batchSize) batches.push(targets.slice(i, i + opts.batchSize));

  let doneBatches = 0;
  const perBatch = await mapPool(batches, opts.concurrency, async (batch) => {
    let decisions: Decision[] = [];
    try {
      decisions = await decideBatch(batch, opts.model);
    } catch (err) {
      console.error(`  ! batch failed: ${err instanceof Error ? err.message : err}`);
    }
    doneBatches++;
    console.log(`  ${doneBatches}/${batches.length} batches`);
    return decisions;
  });

  // Index decisions by surface; fall back to keep-as-is for any the LLM missed.
  const decisionBySurface = new Map<string, Decision>();
  for (const decisions of perBatch) for (const d of decisions) decisionBySurface.set(d.surface, d);

  const mentionBySurface = new Map(mentions.map((m) => [m.surface, m]));
  function decisionFor(surface: string): Decision {
    const ov = MANUAL_ALIAS_OVERRIDES[surface.toLowerCase().trim()];
    if (ov) return { surface, canonical: ov.canonical, type: ov.type, keep: true };
    const d = decisionBySurface.get(surface);
    if (d) return d;
    const m = mentionBySurface.get(surface);
    return { surface, canonical: surface, type: m?.majorityType ?? "Character", keep: true };
  }

  // Build canonical entities: group kept surfaces by (normalised canonical, type).
  const entityByKey = new Map<string, ResolvedEntity>();
  const idBySurface = new Map<string, string>(); // surface -> entity id (or "" if dropped)

  for (const m of targets) {
    const d = decisionFor(m.surface);
    if (!d.keep || isPlaceholderName(m.surface) || isPlaceholderName(d.canonical)) {
      idBySurface.set(m.surface, "");
      continue;
    }
    const key = `${d.type}::${d.canonical.toLowerCase().replace(/\s+/g, " ").trim()}`;
    let ent = entityByKey.get(key);
    if (!ent) {
      ent = { id: `${d.type.toLowerCase()}:${slug(d.canonical)}`, canonical_name: d.canonical, type: d.type, aliases: [], mentions: 0 };
      entityByKey.set(key, ent);
    }
    if (!ent.aliases.includes(m.surface)) ent.aliases.push(m.surface);
    ent.mentions += m.count;
    idBySurface.set(m.surface, ent.id);
  }

  const firstPass = [...entityByKey.values()].sort((a, b) => b.mentions - a.mentions);

  // Second pass: merge cross-batch duplicate entities (e.g. "Drogo"/"Khal Drogo").
  console.log(`Consolidating ${firstPass.length} entities to merge cross-batch duplicates ...`);
  const { entities, idRemap } = await consolidate(firstPass, opts.model, opts.concurrency);
  for (const [surface, id] of idBySurface) {
    if (id && idRemap.has(id)) idBySurface.set(surface, idRemap.get(id)!);
  }
  console.log(`Merged ${firstPass.length - entities.length} duplicate entit(y/ies) -> ${entities.length} total.`);

  // Rewrite triples to canonical ids; drop any touching a pruned/unresolved endpoint.
  const resolvedTriples: ResolvedTriple[] = [];
  let dropped = 0;
  const entityById = new Map(entities.map((e) => [e.id, e]));
  for (const t of triples) {
    const sid = idBySurface.get(t.subject);
    const oid = idBySurface.get(t.object);
    if (!sid || !oid) {
      dropped++;
      continue;
    }
    const s = entityById.get(sid)!;
    const o = entityById.get(oid)!;
    if (s.id === o.id) {
      dropped++; // self-loop after merge (e.g. an alias related to itself)
      continue;
    }
    resolvedTriples.push({
      subject_id: s.id,
      subject_name: s.canonical_name,
      subject_type: s.type,
      relation: t.relation,
      object_id: o.id,
      object_name: o.canonical_name,
      object_type: o.type,
      description: t.description,
      document_id: t.document_id,
      chunk_id: t.chunk_id,
    });
  }

  fs.mkdirSync(path.dirname(opts.entitiesFile), { recursive: true });
  fs.writeFileSync(opts.entitiesFile, JSON.stringify({ count: entities.length, entities }, null, 2) + "\n", "utf-8");
  fs.writeFileSync(opts.resolvedFile, resolvedTriples.map((t) => JSON.stringify(t)).join("\n") + "\n", "utf-8");

  console.log(`\nWrote ${entities.length} canonical entit(y/ies) to ${opts.entitiesFile}`);
  console.log(`Wrote ${resolvedTriples.length} resolved triple(s) to ${opts.resolvedFile}  (dropped ${dropped})`);
  summarise(opts.entitiesFile, opts.resolvedFile);
}

function summarise(entitiesFile: string, resolvedFile?: string): void {
  if (!fs.existsSync(entitiesFile)) {
    console.error(`No entities file at ${entitiesFile}.`);
    return;
  }
  const { entities } = JSON.parse(fs.readFileSync(entitiesFile, "utf-8")) as { entities: ResolvedEntity[] };
  const byType = new Map<string, number>();
  for (const e of entities) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);

  console.log(`\n=== ENTITIES SUMMARY (${entitiesFile}) ===`);
  console.log(`Total canonical entities: ${entities.length}`);
  console.log(`By type:`);
  [...byType.entries()].sort((a, b) => b[1] - a[1]).forEach(([t, n]) => console.log(`  ${t.padEnd(12)} ${n}`));

  console.log(`\nTop entities + merged aliases:`);
  entities.slice(0, 15).forEach((e) => {
    const extra = e.aliases.filter((a) => a !== e.canonical_name);
    const aliasStr = extra.length ? `  aliases: ${extra.slice(0, 4).join(", ")}${extra.length > 4 ? " …" : ""}` : "";
    console.log(`  [${e.type}] ${e.canonical_name} (${e.mentions})${aliasStr}`);
  });

  if (resolvedFile && fs.existsSync(resolvedFile)) {
    const n = fs.readFileSync(resolvedFile, "utf-8").split("\n").filter((l) => l.trim()).length;
    console.log(`\nResolved triples: ${n}  (${resolvedFile})`);
  }
}

interface Opts {
  command: "resolve" | "show";
  triplesFile: string;
  entitiesFile: string;
  resolvedFile: string;
  model: string;
  batchSize: number;
  concurrency: number;
  limit: number;
}

function parseArgs(argv: string[]): Opts {
  const args = argv.slice(2);
  const opts: Opts = {
    command: "resolve",
    triplesFile: DEFAULT_TRIPLES_FILE,
    entitiesFile: DEFAULT_ENTITIES_FILE,
    resolvedFile: DEFAULT_RESOLVED_FILE,
    model: ANSWER_MODEL,
    batchSize: DEFAULT_BATCH_SIZE,
    concurrency: DEFAULT_CONCURRENCY,
    limit: 0,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = args[i + 1];
    if (a === "show" || a === "resolve") opts.command = a;
    else if (a === "--triples-file") { opts.triplesFile = v; i++; }
    else if (a === "--entities-file") { opts.entitiesFile = v; i++; }
    else if (a === "--resolved-file") { opts.resolvedFile = v; i++; }
    else if (a === "--model") { opts.model = v; i++; }
    else if (a === "--batch-size") { opts.batchSize = Math.max(1, Number(v)); i++; }
    else if (a === "--concurrency") { opts.concurrency = Math.max(1, Number(v)); i++; }
    else if (a === "--limit") { opts.limit = Number(v); i++; }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.command === "show") {
    summarise(opts.entitiesFile, opts.resolvedFile);
    return;
  }
  await resolve(opts);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nError:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
