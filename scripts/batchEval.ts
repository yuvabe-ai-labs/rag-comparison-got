// Rubric evaluation runner: Vector vs Graph vs Hybrid, scored by an LLM judge.
// Adapted from rag-method-comparison/scripts/batchEval.ts.
//
// Runs every gold question (data/eval/questions.json) through all three
// pipelines, judges each with the 5-category rubric (evaluator.ts), prints a
// scoreboard, and writes one CSV row per question to data/eval/results.csv.
//
//   npm run eval
//   npm run eval -- --limit 3 --show-verdict
//   npm run eval -- --judge-model gpt-4.1-mini --output-file data/eval/run2.csv

import fs from "fs";
import path from "path";
import { loadEnv, checkEnv } from "../src/lib/env";
import { checkNeo4jEnv, verifyConnection, closeDriver } from "../src/lib/neo4j";
import { askQuestion } from "../src/lib/vectorRag";
import { askGraph } from "../src/lib/graphRag";
import { askHybrid } from "../src/lib/hybridRag";
import { evaluate, RUBRIC_DIMS, MAX_TOTAL, type Evaluation } from "../src/lib/evaluator";
import { ANSWER_MODEL } from "../src/lib/openai";

loadEnv();

const QUESTIONS_FILE = "data/eval/questions.json";
const DEFAULT_OUTPUT_FILE = "data/eval/results.csv";
const CATEGORIES = RUBRIC_DIMS.map(([key]) => key);
const SYSTEMS = ["vector_rag", "graph_rag", "hybrid_rag"] as const;

interface GoldQuestion {
  id: string;
  category: string;
  question: string;
}

function loadQuestions(limit: number): GoldQuestion[] {
  const parsed = JSON.parse(fs.readFileSync(QUESTIONS_FILE, "utf-8")) as { questions: GoldQuestion[] };
  const qs = parsed.questions;
  return limit > 0 ? qs.slice(0, limit) : qs;
}

// ── CSV helpers (RFC-4180) ──
function csvCell(value: unknown): string {
  const s = value === undefined || value === null ? "" : String(value);
  const oneLine = typeof value === "string" ? s.split(/\s+/).filter(Boolean).join(" ") : s;
  return /[",\r\n]/.test(oneLine) ? `"${oneLine.replace(/"/g, '""')}"` : oneLine;
}

function csvColumns(): string[] {
  const cols = ["index", "id", "category", "question", "vector_answer", "graph_answer", "hybrid_answer"];
  for (const sys of SYSTEMS) cols.push(`${sys}_total`);
  for (const sys of SYSTEMS) for (const c of CATEGORIES) cols.push(`${sys}_${c}`);
  cols.push("verdict", "error");
  return cols;
}

interface Args {
  limit: number;
  outputFile: string;
  judgeModel: string;
  showVerdict: boolean;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  const out: Args = { limit: 0, outputFile: DEFAULT_OUTPUT_FILE, judgeModel: ANSWER_MODEL, showVerdict: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--limit") out.limit = Number(args[++i]);
    else if (a === "--output-file") out.outputFile = args[++i];
    else if (a === "--judge-model") out.judgeModel = args[++i];
    else if (a === "--show-verdict") out.showVerdict = true;
  }
  return out;
}

function bar(total: number): string {
  const filled = Math.round((total / MAX_TOTAL) * 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function winner(ev: Evaluation): string {
  const totals: [string, number][] = [
    ["Vector", ev.vector_rag.total_score],
    ["Graph", ev.graph_rag.total_score],
    ["Hybrid", ev.hybrid_rag.total_score],
  ];
  const max = Math.max(...totals.map(([, t]) => t));
  const top = totals.filter(([, t]) => t === max).map(([n]) => n);
  return top.length === 1 ? top[0] : `tie (${top.join("/")})`;
}

async function main() {
  const args = parseArgs(process.argv);

  const env = checkEnv();
  const neo = checkNeo4jEnv();
  const missing = [...env.missing, ...neo.missing];
  if (missing.length) throw new Error(`Missing env vars: ${missing.join(", ")} (check .env.local)`);
  await verifyConnection();

  const questions = loadQuestions(args.limit);
  if (questions.length === 0) throw new Error(`No questions in ${QUESTIONS_FILE}`);

  const cols = csvColumns();
  fs.mkdirSync(path.dirname(args.outputFile), { recursive: true });
  const fd = fs.openSync(args.outputFile, "w");
  fs.writeSync(fd, "﻿" + cols.join(",") + "\r\n"); // BOM for Excel

  // Running totals for the averages summary.
  const sums: Record<string, number> = { vector_rag: 0, graph_rag: 0, hybrid_rag: 0 };
  const wins: Record<string, number> = {};
  let evaluated = 0;

  console.log(`\nRubric: ${RUBRIC_DIMS.map(([, l]) => l).join(", ")}  (0-2 each, max ${MAX_TOTAL})\n`);
  console.log(`${"#".padEnd(3)} ${"category".padEnd(16)} Vec  Gra  Hyb   winner`);
  console.log("-".repeat(60));

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const index = i + 1;
    const row: Record<string, unknown> = { index, id: q.id, category: q.category, question: q.question };

    const [vRes, gRes, hRes] = await Promise.allSettled([
      askQuestion(q.question),
      askGraph(q.question),
      askHybrid(q.question),
    ]);

    if (vRes.status !== "fulfilled" || gRes.status !== "fulfilled" || hRes.status !== "fulfilled") {
      const err = [vRes, gRes, hRes]
        .filter((r) => r.status === "rejected")
        .map((r) => (r as PromiseRejectedResult).reason?.message ?? String((r as PromiseRejectedResult).reason))
        .join("; ");
      row.error = err;
      fs.writeSync(fd, cols.map((c) => csvCell(row[c])).join(",") + "\r\n");
      console.log(`${String(index).padEnd(3)} ${q.category.padEnd(16)} (pipeline failed: ${err})`);
      continue;
    }

    const vector = vRes.value;
    const graph = gRes.value;
    const hybrid = hRes.value;
    row.vector_answer = vector.answer;
    row.graph_answer = graph.answer;
    row.hybrid_answer = hybrid.answer;

    let ev: Evaluation | undefined;
    try {
      ev = await evaluate(q.question, vector, graph, hybrid, args.judgeModel);
    } catch (e) {
      row.error = e instanceof Error ? e.message : String(e);
      fs.writeSync(fd, cols.map((c) => csvCell(row[c])).join(",") + "\r\n");
      console.log(`${String(index).padEnd(3)} ${q.category.padEnd(16)} (judge failed: ${row.error})`);
      continue;
    }

    for (const sys of SYSTEMS) {
      row[`${sys}_total`] = ev[sys].total_score;
      for (const c of CATEGORIES) row[`${sys}_${c}`] = ev[sys].category_scores[c];
      sums[sys] += ev[sys].total_score;
    }
    row.verdict = ev.verdict;
    fs.writeSync(fd, cols.map((c) => csvCell(row[c])).join(",") + "\r\n");
    evaluated++;

    const w = winner(ev);
    wins[w] = (wins[w] ?? 0) + 1;
    console.log(
      `${String(index).padEnd(3)} ${q.category.padEnd(16)} ` +
        `${String(ev.vector_rag.total_score).padStart(2)}   ${String(ev.graph_rag.total_score).padStart(2)}   ${String(ev.hybrid_rag.total_score).padStart(2)}    ${w}`,
    );
    if (args.showVerdict) console.log(`    → ${ev.verdict}`);
  }

  fs.closeSync(fd);

  if (evaluated > 0) {
    console.log("\n" + "=".repeat(60));
    console.log(`AVERAGE SCORE (over ${evaluated} question(s), max ${MAX_TOTAL})`);
    for (const [sys, label] of [["vector_rag", "Vector"], ["graph_rag", "Graph"], ["hybrid_rag", "Hybrid"]] as const) {
      const avg = sums[sys] / evaluated;
      console.log(`  ${label.padEnd(7)} ${avg.toFixed(2).padStart(5)} / ${MAX_TOTAL}  ${bar(avg)}`);
    }
    console.log(`\nWins: ${Object.entries(wins).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  }
  console.log(`\nWrote ${questions.length} row(s) to ${args.outputFile}`);
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
