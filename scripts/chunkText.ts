// Episode-aware chunking for the single-file GOT synopsis.
//
// The source txt is structured as:
//   S1, Ep1
//   Winter Is Coming
//   •  <bullet paragraphs...>
//   S1, Ep2
//   The Kingsroad
//   ...
//
// Each episode becomes a "document" (document_id = s01e01, title = episode
// name). Episode bodies are then split into sentence-aligned chunks with
// character overlap so short paragraphs retain context across boundaries.
//
//   npm run build:chunks
//   npm run build:chunks -- --input "data/Game of Thrones All Synopsis.txt" --chunk-size 1000 --overlap 150

import fs from "fs";
import path from "path";

const DEFAULT_INPUT_FILE = "data/Game of Thrones All Synopsis.txt";
const DEFAULT_OUTPUT_FILE = "data/chunks/chunks.jsonl";
const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_OVERLAP = 150;

// Matches episode headers like "S1, Ep1", "S01 , Ep 10".
const EPISODE_MARKER = /^S\s*(\d+)\s*,\s*Ep\s*(\d+)\b/i;

interface Episode {
  document_id: string;
  title: string;
  body: string;
}

interface ChunkOut {
  document_id: string;
  chunk_id: string;
  title: string;
  text: string;
}

function normalizeText(text: string): string {
  // Drop bullet glyphs and collapse whitespace.
  return text.replace(/[•·◦●]/g, " ").replace(/\s+/g, " ").trim();
}

/** Split the single synopsis file into per-episode documents. */
function splitEpisodes(raw: string): Episode[] {
  const text = raw.replace(/^﻿/, ""); // strip BOM
  const lines = text.split(/\r?\n/);
  const episodes: Episode[] = [];

  let current: { document_id: string; title: string; body: string[] } | null = null;
  let expectingTitle = false;

  for (const line of lines) {
    const marker = line.trim().match(EPISODE_MARKER);
    if (marker) {
      if (current) episodes.push({ ...current, body: current.body.join("\n") });
      const season = String(Number(marker[1])).padStart(2, "0");
      const ep = String(Number(marker[2])).padStart(2, "0");
      current = { document_id: `s${season}e${ep}`, title: "", body: [] };
      expectingTitle = true;
      continue;
    }
    if (!current) continue; // preamble before the first marker
    if (expectingTitle) {
      if (line.trim() === "") continue; // skip blank lines before the title
      current.title = line.trim();
      expectingTitle = false;
      continue;
    }
    current.body.push(line);
  }
  if (current) episodes.push({ ...current, body: current.body.join("\n") });

  return episodes.map((e) => ({
    ...e,
    title: e.title || e.document_id.toUpperCase(),
  }));
}

/** Split text into sentence-aligned chunks with character-level overlap. */
function chunkTextWithOverlap(raw: string, chunkSize: number, overlap: number): string[] {
  const text = normalizeText(raw);
  if (!text) return [];

  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length === 0) return [];

  const chunks: string[] = [];
  let start = 0;

  while (start < sentences.length) {
    // Greedily fill up to chunkSize characters.
    let end = start;
    let length = 0;
    while (end < sentences.length) {
      const sep = end > start ? 1 : 0;
      const addition = sep + sentences[end].length;
      if (length + addition > chunkSize && end > start) break;
      length += addition;
      end += 1;
    }

    chunks.push(sentences.slice(start, end).join(" "));

    if (end >= sentences.length) break;

    // Walk back from 'end' to find where the overlap region starts so
    // consecutive chunks share ~overlap chars.
    let backChars = 0;
    let nextStart = end;
    for (let k = end - 1; k > start; k--) {
      backChars += sentences[k].length + 1;
      if (backChars >= overlap) {
        nextStart = k;
        break;
      }
    }

    // Always advance by at least one sentence to prevent infinite loops.
    start = Math.max(start + 1, nextStart);
  }

  return chunks.filter(Boolean);
}

function buildChunkRecords(episodes: Episode[], chunkSize: number, overlap: number): ChunkOut[] {
  const records: ChunkOut[] = [];
  for (const ep of episodes) {
    const textChunks = chunkTextWithOverlap(ep.body, chunkSize, overlap);
    console.log(`document_id=${ep.document_id}  title=${JSON.stringify(ep.title)}  chunks=${textChunks.length}`);
    textChunks.forEach((chunkText, i) => {
      const idx = String(i + 1).padStart(4, "0");
      records.push({
        document_id: ep.document_id,
        chunk_id: `${ep.document_id}_${idx}`,
        title: ep.title,
        text: chunkText,
      });
    });
  }
  return records;
}

function writeJsonl(records: ChunkOut[], outputFile: string): void {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const body = records.map((r) => JSON.stringify(r)).join("\n");
  fs.writeFileSync(outputFile, records.length ? body + "\n" : "", "utf-8");
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const opts = {
    inputFile: DEFAULT_INPUT_FILE,
    outputFile: DEFAULT_OUTPUT_FILE,
    chunkSize: DEFAULT_CHUNK_SIZE,
    overlap: DEFAULT_OVERLAP,
  };
  for (let i = 0; i < args.length; i++) {
    const v = args[i + 1];
    switch (args[i]) {
      case "--input": opts.inputFile = v; i++; break;
      case "--output-file": opts.outputFile = v; i++; break;
      case "--chunk-size": opts.chunkSize = Number(v); i++; break;
      case "--overlap": opts.overlap = Number(v); i++; break;
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv);
  const file = path.resolve(process.cwd(), opts.inputFile);

  if (!fs.existsSync(file)) {
    console.error(`Input file not found: ${opts.inputFile}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(file, "utf-8");
  const episodes = splitEpisodes(raw);

  if (episodes.length === 0) {
    console.warn(`No "S#, Ep#" episode markers found in ${opts.inputFile}.`);
    writeJsonl([], opts.outputFile);
    return;
  }

  console.log(`Parsed ${episodes.length} episode(s).`);
  const records = buildChunkRecords(episodes, opts.chunkSize, opts.overlap);
  writeJsonl(records, opts.outputFile);
  console.log(`Wrote ${records.length} chunk(s) to ${opts.outputFile}`);
}

main();
