// Shared types for the vector RAG pipeline.

/** A chunk record as written to data/chunks/chunks.jsonl. */
export interface ChunkRecord {
  document_id: string;
  chunk_id: string;
  title?: string;
  text: string;
}

/** Per-chunk metadata stored in data/vector/meta.json (no embedding vector). */
export interface ChunkMeta {
  document_id: string;
  chunk_id: string;
  title: string;
  text: string;
  text_hash: string;
}

/** Header of data/vector/meta.json. Vectors live alongside in embeddings.bin. */
export interface VectorMeta {
  embedding_model: string;
  dim: number;
  count: number;
  chunks: ChunkMeta[];
}

export interface EvidenceSnippet {
  document_id: string;
  chunk_id: string;
  snippet: string;
  matched_terms?: string[];
}
