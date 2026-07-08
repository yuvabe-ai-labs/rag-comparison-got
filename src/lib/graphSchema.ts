// Closed ontology for the Game of Thrones knowledge graph.
//
// This file is the single source of truth for what the graph may contain.
// The extractor (scripts/extractGraph.ts) renders the schema below into its
// prompt so the LLM can only emit these node labels and relation types, and
// the Neo4j loader (later) uses the same enums for constraints/indexes.
//
// Keep the ontology SMALL and CLOSED. Open-ended extraction produces messy,
// unmergeable graphs; a fixed vocabulary is what makes multi-hop, aggregation
// and path queries answerable where vector RAG cannot reach.

/** Node labels. Every entity resolves to exactly one of these. */
export const NODE_TYPES = [
  "Character", // a named person (Ned Stark, Arya, Cersei, Jon Snow)
  "House", // a noble house (House Stark, House Lannister, House Targaryen)
  "Location", // a place (Winterfell, King's Landing, The Wall, Dragonstone)
  "Title", // a position/rank (King, Hand of the King, Warden of the North)
  "Group", // an organisation/faction (Night's Watch, White Walkers, Unsullied)
  "Event", // a named happening (Red Wedding, Battle of Blackwater)
] as const;

export type NodeType = (typeof NODE_TYPES)[number];

/**
 * Relationship types. Each entry documents its intended (subject -> object)
 * node types; the `hint` is shown to the extractor. Directionality matters:
 * KILLED goes killer -> victim, PARENT_OF goes parent -> child, etc.
 */
export interface RelationDef {
  relation: string;
  subjectTypes: NodeType[];
  objectTypes: NodeType[];
  hint: string;
}

export const RELATION_DEFS: RelationDef[] = [
  // --- Kinship (Character -> Character) ---
  { relation: "PARENT_OF", subjectTypes: ["Character"], objectTypes: ["Character"], hint: "parent -> child (biological or adoptive)" },
  { relation: "SIBLING_OF", subjectTypes: ["Character"], objectTypes: ["Character"], hint: "brother/sister of (either direction)" },
  { relation: "MARRIED_TO", subjectTypes: ["Character"], objectTypes: ["Character"], hint: "spouse of / betrothed to" },
  { relation: "BASTARD_OF", subjectTypes: ["Character"], objectTypes: ["Character"], hint: "illegitimate child -> parent" },

  // --- Allegiance / power ---
  { relation: "MEMBER_OF_HOUSE", subjectTypes: ["Character"], objectTypes: ["House"], hint: "character belongs to a noble house" },
  { relation: "SWORN_TO", subjectTypes: ["Character", "House"], objectTypes: ["Character", "House"], hint: "bannerman/vassal loyal to a lord or house" },
  { relation: "ALLIED_WITH", subjectTypes: ["House", "Character"], objectTypes: ["House", "Character"], hint: "formal alliance between houses/characters" },
  { relation: "RULES", subjectTypes: ["Character"], objectTypes: ["Location", "House"], hint: "rules/governs a place or leads a house" },
  { relation: "MEMBER_OF_GROUP", subjectTypes: ["Character"], objectTypes: ["Group"], hint: "belongs to an organisation/faction" },

  // --- Actions (mostly Character -> Character) ---
  { relation: "KILLED", subjectTypes: ["Character", "Group"], objectTypes: ["Character"], hint: "killer -> victim (only when death is stated)" },
  { relation: "CAPTURED", subjectTypes: ["Character", "Group"], objectTypes: ["Character"], hint: "captor -> captive / took prisoner" },
  { relation: "IMPRISONED", subjectTypes: ["Character", "Group"], objectTypes: ["Character"], hint: "jailer -> prisoner (held/kept imprisoned)" },
  { relation: "BETRAYED", subjectTypes: ["Character"], objectTypes: ["Character", "House"], hint: "betrayer -> betrayed party" },
  { relation: "SAVED", subjectTypes: ["Character"], objectTypes: ["Character"], hint: "rescuer -> rescued" },
  { relation: "CROWNED", subjectTypes: ["Character", "Group"], objectTypes: ["Character"], hint: "who crowns/proclaims -> new ruler" },

  // --- Titles & places ---
  { relation: "HOLDS_TITLE", subjectTypes: ["Character"], objectTypes: ["Title"], hint: "character holds a rank/position" },
  { relation: "LOCATED_AT", subjectTypes: ["Character", "Group"], objectTypes: ["Location"], hint: "is present at / based at a place" },
  { relation: "TRAVELED_TO", subjectTypes: ["Character", "Group"], objectTypes: ["Location"], hint: "journeys to a place" },

  // --- Events ---
  { relation: "PARTICIPATED_IN", subjectTypes: ["Character", "Group", "House"], objectTypes: ["Event"], hint: "takes part in a named event" },
  { relation: "OCCURRED_AT", subjectTypes: ["Event"], objectTypes: ["Location"], hint: "event happened at a place" },
];

export const RELATION_TYPES = RELATION_DEFS.map((r) => r.relation);
export type RelationType = (typeof RELATION_TYPES)[number];

/** A single extracted fact, with provenance back to the source chunk. */
export interface GraphTriple {
  subject: string; // surface name as written in the source text
  subject_type: NodeType;
  relation: RelationType;
  object: string;
  object_type: NodeType;
  description: string; // short evidence phrase, in the source's own words
  document_id: string; // episode id, e.g. s01e01 (added by the extractor)
  chunk_id: string; // provenance for citations (added by the extractor)
}

/** Render the ontology as a compact block for the extraction prompt. */
export function schemaForPrompt(): string {
  const nodes = NODE_TYPES.join(", ");
  const rels = RELATION_DEFS.map(
    (r) => `- ${r.relation} (${r.subjectTypes.join("|")} -> ${r.objectTypes.join("|")}): ${r.hint}`,
  ).join("\n");
  return `NODE TYPES:\n${nodes}\n\nRELATION TYPES:\n${rels}`;
}

const NODE_SET = new Set<string>(NODE_TYPES);
const RELATION_SET = new Set<string>(RELATION_TYPES);
const RELATION_DEF_BY_NAME = new Map<string, RelationDef>(RELATION_DEFS.map((d) => [d.relation, d]));

/**
 * True when a (subject_type, relation, object_type) triple is allowed by the
 * ontology's directionality rules. Rejects e.g. KILLED -> House/Title/Event,
 * which the extractor and loader must never turn into edges.
 */
export function isRelationTypeAllowed(
  relation: string,
  subjectType: NodeType,
  objectType: NodeType,
): boolean {
  const def = RELATION_DEF_BY_NAME.get(relation);
  if (!def) return false;
  return def.subjectTypes.includes(subjectType) && def.objectTypes.includes(objectType);
}

/**
 * Placeholder / non-entity tokens the LLM sometimes emits instead of returning
 * an empty result (e.g. "Robb Stark -[PARENT_OF]-> N/A"). These must never
 * become graph nodes. Compared case-insensitively against the trimmed name.
 */
const PLACEHOLDER_NAMES = new Set([
  "n/a", "na", "none", "null", "nil", "unknown", "unnamed", "tbd", "n.a.",
  "no one", "nobody", "someone", "somebody", "anyone", "various", "unspecified",
]);

export function isPlaceholderName(name: string): boolean {
  return PLACEHOLDER_NAMES.has(name.trim().toLowerCase());
}

export function isNodeType(v: unknown): v is NodeType {
  return typeof v === "string" && NODE_SET.has(v);
}

export function isRelationType(v: unknown): v is RelationType {
  return typeof v === "string" && RELATION_SET.has(v);
}
