// Minimal .env.local loader (no Next.js dependency for a CLI-only project).

import fs from "fs";
import path from "path";

/** Parse .env.local and populate process.env (existing vars win). */
export function loadEnv(): void {
  const file = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

export function checkEnv(): { ready: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!process.env.OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  return { ready: missing.length === 0, missing };
}
