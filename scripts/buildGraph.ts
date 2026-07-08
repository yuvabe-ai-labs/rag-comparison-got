// Phase 3 — load the resolved knowledge graph into Neo4j.
//
// Reads data/graph/entities.json + data/graph/triples.resolved.jsonl and writes
// nodes + relationships into the configured Neo4j database. Edges are aggregated
// so each (subject, relation, object) becomes ONE relationship carrying all its
// provenance (chunk_ids, episodes, descriptions) — MERGE keeps it idempotent.
//
//   npm run build:graph              # wipe the target DB, then load (default)
//   npm run build:graph -- --no-reset  # merge into existing data without wiping
//   npm run build:graph -- show        # print node/relationship counts only

import fs from "fs";
import neo4j from "neo4j-driver";
import { loadEnv } from "../src/lib/env";
import { getSession, getDbName, checkNeo4jEnv, verifyConnection, closeDriver } from "../src/lib/neo4j";
import { NODE_TYPES, isNodeType, isRelationType, isRelationTypeAllowed, type NodeType } from "../src/lib/graphSchema";

loadEnv();

const DEFAULT_ENTITIES_FILE = "data/graph/entities.json";
const DEFAULT_RESOLVED_FILE = "data/graph/triples.resolved.jsonl";
const BATCH = 500;

interface EntityRow {
  id: string;
  canonical_name: string;
  type: NodeType;
  aliases: string[];
  mentions: number;
}

interface ResolvedTriple {
  subject_id: string;
  relation: string;
  object_id: string;
  description: string;
  document_id: string;
  chunk_id: string;
}

interface EdgeAgg {
  subject_id: string;
  relation: string;
  object_id: string;
  chunk_ids: string[];
  episodes: string[];
  descriptions: string[];
  count: number;
}

function loadEntities(file: string): EntityRow[] {
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { entities: EntityRow[] };
  return parsed.entities.filter((e) => isNodeType(e.type));
}

function loadResolved(file: string): ResolvedTriple[] {
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ResolvedTriple);
}

interface AggResult {
  edges: EdgeAgg[];
  dropped: { unknownId: number; selfLoop: number; typeViolation: number };
}

/** Collapse duplicate triples into one edge per (subject, relation, object). */
function aggregateEdges(
  triples: ResolvedTriple[],
  typeById: Map<string, NodeType>,
): AggResult {
  const byKey = new Map<string, EdgeAgg>();
  const dropped = { unknownId: 0, selfLoop: 0, typeViolation: 0 };
  for (const t of triples) {
    if (!isRelationType(t.relation)) continue;
    const subjType = typeById.get(t.subject_id);
    const objType = typeById.get(t.object_id);
    if (!subjType || !objType) { dropped.unknownId++; continue; }
    if (t.subject_id === t.object_id) { dropped.selfLoop++; continue; }
    // Enforce the ontology's directionality: e.g. KILLED must go
    // Character/Group -> Character, never -> House/Title/Event.
    if (!isRelationTypeAllowed(t.relation, subjType, objType)) { dropped.typeViolation++; continue; }
    const key = `${t.subject_id}|${t.relation}|${t.object_id}`;
    let e = byKey.get(key);
    if (!e) {
      e = { subject_id: t.subject_id, relation: t.relation, object_id: t.object_id, chunk_ids: [], episodes: [], descriptions: [], count: 0 };
      byKey.set(key, e);
    }
    if (t.chunk_id && !e.chunk_ids.includes(t.chunk_id)) e.chunk_ids.push(t.chunk_id);
    if (t.document_id && !e.episodes.includes(t.document_id)) e.episodes.push(t.document_id);
    if (t.description && !e.descriptions.includes(t.description)) e.descriptions.push(t.description);
    e.count += 1;
  }
  return { edges: [...byKey.values()], dropped };
}

async function runBatched<T>(rows: T[], cypher: string): Promise<void> {
  const session = getSession();
  try {
    for (let i = 0; i < rows.length; i += BATCH) {
      await session.run(cypher, { rows: rows.slice(i, i + BATCH) });
    }
  } finally {
    await session.close();
  }
}

async function createSchema(): Promise<void> {
  const session = getSession();
  try {
    for (const type of NODE_TYPES) {
      // Label is from our closed enum, so string interpolation is safe here.
      await session.run(
        `CREATE CONSTRAINT ${type.toLowerCase()}_id IF NOT EXISTS FOR (n:\`${type}\`) REQUIRE n.id IS UNIQUE`,
      );
    }
    // Full-text index over names + aliases powers entity linking in Phase 4.
    await session.run(
      `CREATE FULLTEXT INDEX entityNames IF NOT EXISTS FOR (n:Entity) ON EACH [n.name, n.aliases]`,
    );
  } finally {
    await session.close();
  }
}

async function wipe(): Promise<void> {
  const session = getSession();
  try {
    await session.run(`MATCH (n) DETACH DELETE n`);
  } finally {
    await session.close();
  }
}

async function loadGraph(opts: Opts): Promise<void> {
  const check = checkNeo4jEnv();
  if (!check.ready) throw new Error(`Missing env vars: ${check.missing.join(", ")} (check .env.local)`);
  await verifyConnection();

  const entities = loadEntities(opts.entitiesFile);
  const triples = loadResolved(opts.resolvedFile);
  const typeById = new Map<string, NodeType>(entities.map((e) => [e.id, e.type]));
  const { edges, dropped } = aggregateEdges(triples, typeById);

  console.log(`DB "${getDbName()}": loading ${entities.length} nodes and ${edges.length} unique edges (from ${triples.length} triples).`);
  console.log(
    `  dropped triples: ${dropped.typeViolation} type-violation, ${dropped.selfLoop} self-loop, ${dropped.unknownId} unknown-entity`,
  );

  if (opts.reset) {
    console.log("Wiping existing graph (--reset) ...");
    await wipe();
  }
  await createSchema();

  // Nodes, grouped by type so each MERGE uses the right label.
  const byType = new Map<NodeType, EntityRow[]>();
  for (const e of entities) {
    if (!byType.has(e.type)) byType.set(e.type, []);
    byType.get(e.type)!.push(e);
  }
  for (const [type, rows] of byType) {
    const payload = rows.map((e) => ({ id: e.id, name: e.canonical_name, aliases: e.aliases, mentions: neo4j.int(e.mentions) }));
    await runBatched(
      payload,
      `UNWIND $rows AS row
       MERGE (n:\`${type}\` {id: row.id})
       SET n:Entity, n.name = row.name, n.type = '${type}', n.aliases = row.aliases, n.mentions = row.mentions`,
    );
    console.log(`  nodes: ${type.padEnd(10)} ${rows.length}`);
  }

  // Relationships, grouped by relation type.
  const byRel = new Map<string, EdgeAgg[]>();
  for (const e of edges) {
    if (!byRel.has(e.relation)) byRel.set(e.relation, []);
    byRel.get(e.relation)!.push(e);
  }
  for (const [rel, rows] of byRel) {
    const payload = rows.map((e) => ({
      subject_id: e.subject_id,
      object_id: e.object_id,
      chunk_ids: e.chunk_ids,
      episodes: e.episodes,
      descriptions: e.descriptions,
      count: neo4j.int(e.count),
    }));
    await runBatched(
      payload,
      `UNWIND $rows AS row
       MATCH (s:Entity {id: row.subject_id})
       MATCH (o:Entity {id: row.object_id})
       MERGE (s)-[r:\`${rel}\`]->(o)
       SET r.chunk_ids = row.chunk_ids, r.episodes = row.episodes, r.descriptions = row.descriptions, r.count = row.count`,
    );
  }
  console.log(`  relationships: ${edges.length} across ${byRel.size} relation type(s)`);

  await showCounts();
}

async function showCounts(): Promise<void> {
  const session = getSession();
  try {
    const nodes = await session.run(`MATCH (n) RETURN count(n) AS c`);
    const rels = await session.run(`MATCH ()-[r]->() RETURN count(r) AS c`);
    const byLabel = await session.run(
      `MATCH (n:Entity) RETURN n.type AS type, count(*) AS c ORDER BY c DESC`,
    );
    const byRel = await session.run(
      `MATCH ()-[r]->() RETURN type(r) AS rel, count(*) AS c ORDER BY c DESC`,
    );
    console.log(`\n=== NEO4J "${getDbName()}" ===`);
    console.log(`Total nodes         : ${nodes.records[0].get("c")}`);
    console.log(`Total relationships : ${rels.records[0].get("c")}`);
    console.log(`\nNodes by type:`);
    for (const r of byLabel.records) console.log(`  ${String(r.get("type")).padEnd(12)} ${r.get("c")}`);
    console.log(`\nTop relations:`);
    for (const r of byRel.records.slice(0, 10)) console.log(`  ${String(r.get("rel")).padEnd(18)} ${r.get("c")}`);
  } finally {
    await session.close();
  }
}

interface Opts {
  command: "load" | "show";
  entitiesFile: string;
  resolvedFile: string;
  reset: boolean;
}

function parseArgs(argv: string[]): Opts {
  const args = argv.slice(2);
  const opts: Opts = {
    command: "load",
    entitiesFile: DEFAULT_ENTITIES_FILE,
    resolvedFile: DEFAULT_RESOLVED_FILE,
    reset: true,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = args[i + 1];
    if (a === "show" || a === "load") opts.command = a;
    else if (a === "--no-reset") opts.reset = false;
    else if (a === "--entities-file") { opts.entitiesFile = v; i++; }
    else if (a === "--resolved-file") { opts.resolvedFile = v; i++; }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.command === "show") {
    const check = checkNeo4jEnv();
    if (!check.ready) throw new Error(`Missing env vars: ${check.missing.join(", ")} (check .env.local)`);
    await verifyConnection();
    await showCounts();
    return;
  }
  await loadGraph(opts);
}

main()
  .then(async () => {
    await closeDriver();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("\nError:", err instanceof Error ? err.message : err);
    await closeDriver();
    process.exit(1);
  });
