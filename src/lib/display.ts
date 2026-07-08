// Client-safe display constants (no server imports).

export const RUBRIC_DIMS: ReadonlyArray<readonly [string, string]> = [
  ["relevance", "Relevance"],
  ["constraint_handling", "Constraint"],
  ["evidence_grounding", "Evidence"],
  ["reasoning_transparency", "Reasoning"],
  ["hallucination_resistance", "Hallucination"],
];

// (method key, display label, icon, accent color).
export const METHODS: ReadonlyArray<readonly [string, string, string, string]> = [
  ["vector", "Vector", "🔵", "#3B82F6"],
  ["graph", "Graph", "🟢", "#22C55E"],
  ["hybrid", "Hybrid", "🟣", "#A855F7"],
];

export const MAX_TOTAL = RUBRIC_DIMS.length * 2; // 10

// Node-type colors for the knowledge subgraph (the 6 ontology node types).
export const NODE_COLORS: Record<string, string> = {
  Character: "#7dd3fc",
  House: "#fbbf24",
  Location: "#34d399",
  Title: "#c084fc",
  Group: "#f472b6",
  Event: "#fb923c",
};
export const DEFAULT_NODE_COLOR = "#9aa3b2";
