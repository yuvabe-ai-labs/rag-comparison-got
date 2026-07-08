// CLI: run one question through Graph RAG (Neo4j).
//
//   npm run ask:graph -- "Who does Arya Stark kill?"
//   npm run ask:graph -- "How are Jon Snow and Daenerys related?" --show-cypher

import { loadEnv, checkEnv } from "../src/lib/env";
import { checkNeo4jEnv, verifyConnection, closeDriver } from "../src/lib/neo4j";
import { askGraph } from "../src/lib/graphRag";

loadEnv();

interface Args {
  question: string;
  showCypher: boolean;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  const out: Args = { question: "", showCypher: false };
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--show-cypher") out.showCypher = true;
    else rest.push(a);
  }
  out.question = rest.join(" ").trim();
  return out;
}

async function main() {
  const { question, showCypher } = parseArgs(process.argv);
  if (!question) {
    console.error('Usage: npm run ask:graph -- "<question>" [--show-cypher]');
    process.exit(1);
  }

  const env = checkEnv();
  const neo = checkNeo4jEnv();
  const missing = [...env.missing, ...neo.missing];
  if (missing.length) {
    console.error(`Missing env vars: ${missing.join(", ")} (check .env.local)`);
    process.exit(1);
  }
  await verifyConnection();

  const result = await askGraph(question);

  console.log("\n=== ANSWER ===");
  console.log(result.answer);

  console.log("\n=== LINKED ENTITIES ===");
  if (result.linked.length) {
    result.linked.forEach((l) => console.log(`  "${l.mention}" -> ${l.name} (${l.type})`));
  } else {
    console.log("  (none)");
  }

  if (showCypher) {
    console.log("\n=== CYPHER ===");
    console.log(result.cypher);
    console.log("\n=== ROWS ===");
    result.rows.slice(0, 20).forEach((r) => console.log(`  ${r}`));
    if (result.rows.length > 20) console.log(`  ... and ${result.rows.length - 20} more`);
  }

  console.log("\n=== SOURCES ===");
  if (result.evidence.length) {
    result.evidence.slice(0, 10).forEach((e, i) =>
      console.log(`[${i + 1}] ${e.episode} / ${e.chunk_id}  ${e.description ? `— ${e.description}` : ""}`),
    );
  } else {
    console.log("  (no relationship-level provenance in result)");
  }
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
