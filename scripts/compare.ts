// Phase 5 — side-by-side: Vector RAG vs Graph RAG on gold questions.
//
// Runs each curated question (data/eval/questions.json) through BOTH pipelines
// and prints the answers together, so the cases where vector similarity cannot
// assemble the answer but graph traversal can are visible at a glance.
//
//   npm run compare
//   npm run compare -- --show-cypher      # also print the generated Cypher
//   npm run compare -- --limit 2          # first 2 questions only
//   npm run compare -- --only path        # only questions of a category

import fs from "fs";
import { loadEnv, checkEnv } from "../src/lib/env";
import { checkNeo4jEnv, verifyConnection, closeDriver } from "../src/lib/neo4j";
import { askQuestion } from "../src/lib/vectorRag";
import { askGraph } from "../src/lib/graphRag";
import { askHybrid } from "../src/lib/hybridRag";

loadEnv();

const QUESTIONS_FILE = "data/eval/questions.json";

interface GoldQuestion {
  id: string;
  category: string;
  question: string;
  why_vector_struggles: string;
}

function loadQuestions(): GoldQuestion[] {
  const parsed = JSON.parse(fs.readFileSync(QUESTIONS_FILE, "utf-8")) as { questions: GoldQuestion[] };
  return parsed.questions;
}

interface Args {
  showCypher: boolean;
  limit: number;
  only: string;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  const out: Args = { showCypher: false, limit: 0, only: "" };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--show-cypher") out.showCypher = true;
    else if (a === "--limit") out.limit = Number(args[++i]);
    else if (a === "--only") out.only = args[++i];
  }
  return out;
}

function indent(text: string, pad = "    "): string {
  return text
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

async function main() {
  const args = parseArgs(process.argv);

  const env = checkEnv();
  const neo = checkNeo4jEnv();
  const missing = [...env.missing, ...neo.missing];
  if (missing.length) {
    console.error(`Missing env vars: ${missing.join(", ")} (check .env.local)`);
    process.exit(1);
  }
  await verifyConnection();

  let questions = loadQuestions();
  if (args.only) questions = questions.filter((q) => q.category === args.only);
  if (args.limit > 0) questions = questions.slice(0, args.limit);

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    console.log("\n" + "=".repeat(80));
    console.log(`Q${i + 1} [${q.category}]  ${q.question}`);
    console.log(`why vector struggles: ${q.why_vector_struggles}`);
    console.log("=".repeat(80));

    // Run all three pipelines concurrently; isolate failures per side.
    const [vector, graph, hybrid] = await Promise.allSettled([
      askQuestion(q.question),
      askGraph(q.question),
      askHybrid(q.question),
    ]);

    console.log("\n-- VECTOR RAG --");
    if (vector.status === "fulfilled") {
      console.log(indent(vector.value.answer));
      console.log(`    [sources: ${vector.value.evidence_snippets.length} chunks]`);
    } else {
      console.log(indent(`(failed) ${vector.reason?.message ?? vector.reason}`));
    }

    console.log("\n-- GRAPH RAG --");
    if (graph.status === "fulfilled") {
      console.log(indent(graph.value.answer));
      console.log(`    [sources: ${graph.value.evidence.length} edges | linked: ${graph.value.linked.map((l) => l.name).join(", ") || "none"}]`);
      if (args.showCypher) console.log(indent(`Cypher: ${graph.value.cypher}`, "    "));
    } else {
      console.log(indent(`(failed) ${graph.reason?.message ?? graph.reason}`));
    }

    console.log("\n-- HYBRID RAG --");
    if (hybrid.status === "fulfilled") {
      console.log(indent(hybrid.value.answer));
      console.log(`    [sources: ${hybrid.value.graphEvidence.length} edges + ${hybrid.value.vectorSnippets.length} chunks]`);
      if (args.showCypher) console.log(indent(`Cypher: ${hybrid.value.cypher}`, "    "));
    } else {
      console.log(indent(`(failed) ${hybrid.reason?.message ?? hybrid.reason}`));
    }
  }
  console.log("\n" + "=".repeat(80));
  console.log(`Compared ${questions.length} question(s).`);
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
