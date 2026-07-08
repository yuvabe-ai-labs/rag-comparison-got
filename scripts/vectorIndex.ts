// Build the split binary vector store over GOT chunks.
//
// Embeds title + text for each chunk with text-embedding-3-small and writes:
//   data/vector/meta.json      -> { embedding_model, dim, count, chunks[] } (no vectors)
//   data/vector/embeddings.bin -> Float32, count * dim contiguous
//
//   npm run build:vector          # = index
//   npm run build:vector -- show

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { loadEnv } from "../src/lib/env";
import { embedTexts, EMBEDDING_MODEL } from "../src/lib/openai";
import type { ChunkMeta, ChunkRecord, VectorMeta } from "../src/lib/types";

loadEnv();

const DEFAULT_CHUNKS_FILE = "data/chunks/chunks.jsonl";
const DEFAULT_META_FILE = "data/vector/meta.json";
const DEFAULT_BIN_FILE = "data/vector/embeddings.bin";

function readJsonl(file: string): ChunkRecord[] {
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ChunkRecord);
}

function compact(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function sha1(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex");
}

async function buildStore(
  chunksFile: string,
  metaFile: string,
  binFile: string,
  model: string,
): Promise<void> {
  const chunks = readJsonl(chunksFile).filter((c) => (c.text ?? "").trim());
  if (chunks.length === 0) throw new Error(`No chunks found in ${chunksFile}. Run: npm run build:chunks`);

  // Embedding title + text gives better semantic coverage when titles name key entities.
  const inputs = chunks.map((c) => compact(`${c.title ?? ""}\n${c.text}`));

  console.log(`Embedding ${inputs.length} chunk(s) with ${model} ...`);
  const embeddings = await embedTexts(inputs, model);
  const dim = embeddings[0]?.length ?? 0;
  if (!dim) throw new Error("Received empty embeddings from the API.");

  // Flatten all vectors into one contiguous Float32Array, row-major (chunk i at i*dim).
  const flat = new Float32Array(embeddings.length * dim);
  embeddings.forEach((vec, i) => {
    if (vec.length !== dim) throw new Error(`Embedding ${i} has dim ${vec.length}, expected ${dim}.`);
    flat.set(vec, i * dim);
  });

  const metaChunks: ChunkMeta[] = chunks.map((c) => ({
    document_id: c.document_id ?? "",
    chunk_id: c.chunk_id ?? "",
    title: c.title ?? "",
    text: c.text,
    text_hash: sha1(compact(c.text)),
  }));

  const meta: VectorMeta = {
    embedding_model: model,
    dim,
    count: metaChunks.length,
    chunks: metaChunks,
  };

  fs.mkdirSync(path.dirname(metaFile), { recursive: true });
  fs.writeFileSync(metaFile, JSON.stringify(meta) + "\n", "utf-8");
  // Write the raw little-endian Float32 bytes.
  fs.writeFileSync(binFile, Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength));

  const binMb = (flat.byteLength / 1e6).toFixed(2);
  console.log(`Wrote ${meta.count} embedding(s), dim=${dim}`);
  console.log(`  ${metaFile}`);
  console.log(`  ${binFile}  (${binMb} MB)`);
}

function showStore(metaFile: string, binFile: string): void {
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf-8")) as VectorMeta;
  const binBytes = fs.existsSync(binFile) ? fs.statSync(binFile).size : 0;
  console.log(`Embedding model : ${meta.embedding_model ?? "unknown"}`);
  console.log(`Dim             : ${meta.dim}`);
  console.log(`Total chunks    : ${meta.count}`);
  console.log(`Binary size     : ${(binBytes / 1e6).toFixed(2)} MB`);
  console.log();
  meta.chunks.slice(0, 20).forEach((chunk, i) => {
    const idx = String(i + 1).padStart(2, "0");
    console.log(`[${idx}] ${chunk.chunk_id}  text=${JSON.stringify(chunk.text.slice(0, 80))}...`);
  });
  if (meta.chunks.length > 20) console.log(`... and ${meta.chunks.length - 20} more`);
}

interface Opts {
  command: "index" | "show";
  chunksFile: string;
  metaFile: string;
  binFile: string;
  model: string;
}

function parseArgs(argv: string[]): Opts {
  const args = argv.slice(2);
  const opts: Opts = {
    command: "index",
    chunksFile: DEFAULT_CHUNKS_FILE,
    metaFile: DEFAULT_META_FILE,
    binFile: DEFAULT_BIN_FILE,
    model: EMBEDDING_MODEL,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = args[i + 1];
    if (a === "index" || a === "show") opts.command = a;
    else if (a === "--chunks-file") { opts.chunksFile = v; i++; }
    else if (a === "--meta-file") { opts.metaFile = v; i++; }
    else if (a === "--bin-file") { opts.binFile = v; i++; }
    else if (a === "--embedding-model") { opts.model = v; i++; }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);

  if (opts.command === "show") {
    showStore(opts.metaFile, opts.binFile);
    return;
  }

  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required (check .env.local).");
  await buildStore(opts.chunksFile, opts.metaFile, opts.binFile, opts.model);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nError:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
