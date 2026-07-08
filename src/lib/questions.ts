// Load the curated gold questions (data/eval/questions.json) for the sidebar.

import fs from "fs";
import path from "path";
import type { QuestionItem } from "./webTypes";

export function loadQuestions(): QuestionItem[] {
  const file = path.join(process.cwd(), "data", "eval", "questions.json");
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      questions: { category?: string; question: string }[];
    };
    return (parsed.questions ?? [])
      .filter((q) => q.question)
      .map((q) => ({ category: q.category ?? "", question: q.question }));
  } catch {
    return [];
  }
}
