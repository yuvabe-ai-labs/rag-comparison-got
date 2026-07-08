# rag-comparison-got

Vector RAG over the full Game of Thrones episode synopses (`data/Game of Thrones All Synopsis.txt`, ~250 pages / ~73 episodes). CLI-only port of the vector pipeline from `rag-method-comparison`, adapted for the larger dataset.

## Setup

```bash
npm install
cp .env.local.example .env.local   # then fill in OPENAI_API_KEY
```

## Pipeline

```bash
npm run build:chunks     # split by S#,Ep# markers -> episode docs -> data/chunks/chunks.jsonl
npm run build:vector     # embed each chunk -> data/vector/{meta.json, embeddings.bin}
npm run build:pipeline   # both of the above
npm run build:vector -- show   # inspect the store without re-embedding
```

## Ask

```bash
npm run ask -- "Who killed Ned Stark?"
npm run ask -- "Who sits the Iron Throne at the end?" --top-k 8 --show-chunks
```

## How storage differs from `rag-method-comparison`

The reference project stores text + embeddings together in one JSON where each
1536-d vector is written as text (~20 KB/chunk). For this larger corpus that
would be ~16 MB and slow to parse. Here the vectors are split out:

- **`data/vector/meta.json`** — chunk metadata only (`document_id, chunk_id,
  title, text, text_hash`), small and readable.
- **`data/vector/embeddings.bin`** — raw `Float32`, `count × dim` contiguous
  (~4.6 MB). Row `i` of `meta.chunks` ↔ floats `[i*dim, (i+1)*dim)`.

Loading is a zero-parse `new Float32Array(buffer)`; `vectorAt(i)` returns a
zero-copy subarray. Both `data/chunks/` and `data/vector/` are gitignored and
rebuilt with `npm run build:pipeline`.

Retrieval (`src/lib/vectorRag.ts`) is brute-force cosine + hybrid
lexical/cue reranking — identical logic to the reference, fine at this scale
(~850 chunks).
