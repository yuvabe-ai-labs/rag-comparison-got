import { NextResponse } from "next/server";
import { loadEnv, checkEnv } from "@/lib/env";
import { checkNeo4jEnv } from "@/lib/neo4j";
import { loadQuestions } from "@/lib/questions";

export const runtime = "nodejs";

export async function GET() {
  loadEnv();
  const questions = loadQuestions();
  const env = checkEnv();
  const neo = checkNeo4jEnv();
  const missing = [...env.missing, ...neo.missing];
  return NextResponse.json({ questions, ready: missing.length === 0, missing });
}
