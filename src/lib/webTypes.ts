// Shapes shared between the streaming API route and the React UI.

export interface QuestionItem {
  category: string;
  question: string;
}

export interface SourceItem {
  label: string; // e.g. "s01e01 / s01e01_0002"
  detail?: string; // description / snippet
}

export interface MethodResult {
  answer: string;
  total: number | null;
  scores: Record<string, number>;
  sources: SourceItem[];
  cypher?: string; // graph / hybrid only
}

// ── Visual evidence shapes (client-safe; server fills them in) ──

export interface ScatterPoint {
  x: number;
  y: number;
  chunk_id: string;
  document_id: string;
  text: string;
  retrieved: boolean;
}

export interface ScatterData {
  points: ScatterPoint[];
  query: { x: number; y: number } | null;
}

export interface SubgraphNode {
  id: string;
  label: string;
  type: string;
}

export interface SubgraphEdge {
  source: string;
  target: string;
  relation: string;
  description?: string;
}

export interface Subgraph {
  nodes: SubgraphNode[];
  edges: SubgraphEdge[];
}

export interface ComparisonResult {
  question: string;
  category: string;
  methods: {
    vector: MethodResult;
    graph: MethodResult;
    hybrid: MethodResult;
  };
  verdict: string;
  scatter?: ScatterData | null;
  subgraph?: Subgraph | null;
  error?: string;
}
