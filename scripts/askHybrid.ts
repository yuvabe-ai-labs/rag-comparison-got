// CLI: run one question through Hybrid RAG (graph facts + vector passages).
//
//   npm run ask:hybrid -- "How is Jon Snow connected to Tywin Lannister?"
//   npm run ask:hybrid -- "Who does Arya Stark kill?" --show-cypher

import { loadEnv, checkEnv } from "../src/lib/env";
import { checkNeo4jEnv, verifyConnection, closeDriver } from "../src/lib/neo4j";
import { askHybrid } from "../src/lib/hybridRag";

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
    console.error('Usage: npm run ask:hybrid -- "<question>" [--show-cypher]');
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

  const result = await askHybrid(question);

  console.log("\n=== ANSWER (hybrid) ===");
  console.log(result.answer);

  console.log("\n=== LINKED ENTITIES ===");
  if (result.linked.length) result.linked.forEach((l) => console.log(`  "${l.mention}" -> ${l.name} (${l.type})`));
  else console.log("  (none)");

  if (showCypher) {
    console.log("\n=== GRAPH CYPHER ===");
    console.log(result.cypher);
    console.log("\n=== GRAPH ROWS ===");
    result.graphRows.slice(0, 20).forEach((r) => console.log(`  ${r}`));
    if (result.graphRows.length > 20) console.log(`  ... and ${result.graphRows.length - 20} more`);
  }

  console.log("\n=== SOURCES ===");
  console.log(`Graph edges: ${result.graphEvidence.length}   Vector chunks: ${result.vectorSnippets.length}`);
  result.graphEvidence.slice(0, 5).forEach((e, i) =>
    console.log(`  [graph ${i + 1}] ${e.episode} / ${e.chunk_id}  ${e.description ? `— ${e.description}` : ""}`),
  );
  result.vectorSnippets.slice(0, 5).forEach((e, i) =>
    console.log(`  [text ${i + 1}] ${e.document_id} / ${e.chunk_id}`),
  );
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
