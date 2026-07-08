// Loads the split binary vector store:
//   data/vector/meta.json      -> { embedding_model, dim, count, chunks[] }
//   data/vector/embeddings.bin -> Float32, count * dim contiguous
//
// Row i of meta.chunks corresponds to floats [i*dim, (i+1)*dim) in the .bin.
// The vectors are read once into a single Float32Array; vectorAt(i) returns a
// zero-copy subarray view, so there is no per-query allocation or JSON parsing.

import fs from "fs";
import path from "path";
import type { ChunkMeta, VectorMeta } from "./types";

const DATA_DIR = path.join(process.cwd(), "data", "vector");
const META_FILE = path.join(DATA_DIR, "meta.json");
const BIN_FILE = path.join(DATA_DIR, "embeddings.bin");

export interface VectorStore {
  embedding_model: string;
  dim: number;
  count: number;
  chunks: ChunkMeta[];
  /** Zero-copy view of chunk i's embedding. */
  vectorAt(i: number): Float32Array;
}

let cache: VectorStore | null = null;

export function getVectorStore(): VectorStore {
  if (cache) return cache;

  if (!fs.existsSync(META_FILE) || !fs.existsSync(BIN_FILE)) {
    throw new Error(
      `Vector store not found in ${DATA_DIR}. Build it with: npm run build:pipeline`,
    );
  }

  const meta = JSON.parse(fs.readFileSync(META_FILE, "utf-8")) as VectorMeta;

  // Read the raw bytes and reinterpret them as one contiguous Float32Array.
  const buf = fs.readFileSync(BIN_FILE);
  const vectors = new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );

  const expected = meta.count * meta.dim;
  if (vectors.length !== expected) {
    throw new Error(
      `embeddings.bin has ${vectors.length} floats but meta expects ${expected} ` +
        `(count=${meta.count} * dim=${meta.dim}). Rebuild with: npm run build:pipeline`,
    );
  }

  cache = {
    embedding_model: meta.embedding_model,
    dim: meta.dim,
    count: meta.count,
    chunks: meta.chunks,
    vectorAt(i: number): Float32Array {
      const start = i * meta.dim;
      return vectors.subarray(start, start + meta.dim);
    },
  };
  return cache;
}
