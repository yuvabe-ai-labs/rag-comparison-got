// Server-side PCA for the embedding scatter. The PCA basis depends only on the
// static chunk embeddings, so fit + project every chunk once and cache; per
// request just project the query embedding into the same basis. Raw embeddings
// never leave the server — only 2D coordinates of retrieved chunks are shipped.

import { PCA } from "ml-pca";
import { getVectorStore } from "./vectorStore";
import type { ScatterData, ScatterPoint } from "./webTypes";

interface PcaCache {
  pca: PCA;
  coords: number[][];
  docIds: string[];
  chunkIds: string[];
  texts: string[];
}

let cache: PcaCache | null = null;

function getPca(): PcaCache {
  if (!cache) {
    const store = getVectorStore();
    // ml-pca needs plain number[][]; copy the zero-copy Float32 views out once.
    const embeddings: number[][] = [];
    for (let i = 0; i < store.count; i++) embeddings.push(Array.from(store.vectorAt(i)));
    const pca = new PCA(embeddings);
    const coords = pca.predict(embeddings, { nComponents: 2 }).to2DArray();
    cache = {
      pca,
      coords,
      docIds: store.chunks.map((c) => c.document_id),
      chunkIds: store.chunks.map((c) => c.chunk_id),
      texts: store.chunks.map((c) => c.text.slice(0, 120).replace(/\n/g, " ") + "…"),
    };
  }
  return cache;
}

export function buildScatter(
  queryEmbedding: number[] | null | undefined,
  retrievedChunkIds: Set<string>,
): ScatterData {
  const { pca, coords, docIds, chunkIds, texts } = getPca();
  // Ship only the retrieved chunks (plus the query). The PCA basis is still fit
  // on the full corpus so their relative positions stay meaningful.
  const points: ScatterPoint[] = coords
    .map((xy, i) => ({
      x: xy[0],
      y: xy[1],
      chunk_id: chunkIds[i],
      document_id: docIds[i],
      text: texts[i],
      retrieved: retrievedChunkIds.has(chunkIds[i]),
    }))
    .filter((p) => p.retrieved);

  let query: { x: number; y: number } | null = null;
  if (queryEmbedding && queryEmbedding.length) {
    const q = pca.predict([queryEmbedding], { nComponents: 2 }).to2DArray()[0];
    query = { x: q[0], y: q[1] };
  }
  return { points, query };
}
