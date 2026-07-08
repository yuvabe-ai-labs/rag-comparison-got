// OpenAI client + embedding/answer helpers. Ported from rag-method-comparison.

import OpenAI from "openai";

let client: OpenAI | null = null;

export function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}

export const ANSWER_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_BATCH_SIZE = 64;

/** Embed texts in batches; preserves input order. */
export async function embedTexts(
  texts: string[],
  model: string,
): Promise<number[][]> {
  const out: number[][] = [];
  for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(start, start + EMBEDDING_BATCH_SIZE);
    const res = await getClient().embeddings.create({ model, input: batch });
    for (const item of res.data) out.push(item.embedding as number[]);
  }
  return out;
}

interface RespondOptions {
  model: string;
  instructions: string;
  input: string;
  temperature?: number;
  // Optional Responses API `text` param, e.g. { format: { type: "json_schema", ... } }
  // for structured outputs. Passed through untouched.
  text?: unknown;
}

/** Thin wrapper over the Responses API returning output_text. */
export async function respond(opts: RespondOptions): Promise<string> {
  const params: Record<string, unknown> = {
    model: opts.model,
    instructions: opts.instructions,
    input: opts.input,
  };
  if (opts.temperature !== undefined) params.temperature = opts.temperature;
  if (opts.text !== undefined) params.text = opts.text;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = await getClient().responses.create(params as any);
  return (res.output_text ?? "").trim();
}
