// CLI: run one question through vector RAG.
//
//   npm run ask -- "Who killed Ned Stark?"
//   npm run ask -- "Who sits the Iron Throne?" --top-k 8 --show-chunks

import { loadEnv, checkEnv } from "../src/lib/env";
import { askQuestion, DEFAULT_TOP_K, DEFAULT_CANDIDATE_K } from "../src/lib/vectorRag";

loadEnv();

interface Args {
  question: string;
  topK: number;
  candidateK: number;
  showChunks: boolean;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  const out: Args = {
    question: "",
    topK: DEFAULT_TOP_K,
    candidateK: DEFAULT_CANDIDATE_K,
    showChunks: false,
  };
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--top-k") out.topK = Number(args[++i]);
    else if (a === "--candidate-k") out.candidateK = Number(args[++i]);
    else if (a === "--show-chunks") out.showChunks = true;
    else rest.push(a);
  }
  out.question = rest.join(" ").trim();
  return out;
}

async function main() {
  const { question, topK, candidateK, showChunks } = parseArgs(process.argv);
  if (!question) {
    console.error('Usage: npm run ask -- "<question>" [--top-k N] [--candidate-k N] [--show-chunks]');
    process.exit(1);
  }

  const { ready, missing } = checkEnv();
  if (!ready) {
    console.error(`Missing env vars: ${missing.join(", ")} (check .env.local)`);
    process.exit(1);
  }

  const result = await askQuestion(question, topK, candidateK);

  console.log("\n=== ANSWER ===");
  console.log(result.answer);

  console.log("\n=== SOURCES ===");
  result.evidence_snippets.forEach((ev, i) => {
    console.log(`[${i + 1}] ${ev.document_id} / ${ev.chunk_id}`);
    if (showChunks) console.log(`    ${ev.snippet}`);
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nError:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
