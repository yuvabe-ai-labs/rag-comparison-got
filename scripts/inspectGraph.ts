// Ad-hoc graph inspection — checks whether the loaded Neo4j graph holds
// correct Game of Thrones information. Not part of the pipeline.
import { loadEnv } from "../src/lib/env";
import { getSession, verifyConnection, closeDriver } from "../src/lib/neo4j";

loadEnv();

async function q(cypher: string, params: Record<string, unknown> = {}) {
  const s = getSession();
  try {
    const r = await s.run(cypher, params);
    return r.records;
  } finally {
    await s.close();
  }
}

function line(...xs: unknown[]) {
  console.log(...xs);
}

async function main() {
  await verifyConnection();

  line("\n############ 1. NODE-TYPE SANITY (mislabeled entities?) ############");
  for (const t of ["Character", "House", "Location", "Title", "Group", "Event"]) {
    const recs = await q(
      `MATCH (n:${t}) RETURN n.name AS name ORDER BY n.mentions DESC LIMIT 12`,
    );
    line(`\n${t}:`);
    line("  " + recs.map((r) => r.get("name")).join(" | "));
  }

  line("\n\n############ 2. SPOT-CHECK CANON FACTS ############");
  const canon: Array<[string, string]> = [
    ["Who killed Ned Stark?", `MATCH (k)-[:KILLED]->(v {name:'Ned Stark'}) RETURN k.name AS a`],
    ["Ned Stark's children (PARENT_OF)?", `MATCH (:Character {name:'Ned Stark'})-[:PARENT_OF]->(c) RETURN c.name AS a`],
    ["Who is married to Cersei-related MARRIED_TO?", `MATCH (a {name:'Cersei Lannister'})-[:MARRIED_TO]-(b) RETURN b.name AS a`],
    ["Robb Stark siblings?", `MATCH (:Character {name:'Robb Stark'})-[:SIBLING_OF]-(s) RETURN DISTINCT s.name AS a`],
    ["Who killed Robb Stark?", `MATCH (k)-[:KILLED]->(v {name:'Robb Stark'}) RETURN k.name AS a`],
    ["Daenerys' dragons / house?", `MATCH (:Character {name:'Daenerys Targaryen'})-[:MEMBER_OF_HOUSE]->(h) RETURN h.name AS a`],
    ["Jon Snow member of group?", `MATCH (:Character {name:'Jon Snow'})-[:MEMBER_OF_GROUP]->(g) RETURN g.name AS a`],
    ["Who holds title 'King'?", `MATCH (c)-[:HOLDS_TITLE]->(t) WHERE t.name =~ '(?i).*king.*' RETURN DISTINCT c.name AS a LIMIT 15`],
    ["Red Wedding participants?", `MATCH (x)-[:PARTICIPATED_IN]->(e) WHERE e.name =~ '(?i).*red wedding.*' RETURN x.name AS a`],
    ["Jaime & Cersei sibling?", `MATCH (:Character {name:'Jaime Lannister'})-[:SIBLING_OF]-(s) RETURN s.name AS a`],
  ];
  for (const [label, cypher] of canon) {
    const recs = await q(cypher);
    const vals = recs.map((r) => r.get("a")).filter(Boolean);
    line(`\nQ: ${label}`);
    line(`   -> ${vals.length ? vals.join(", ") : "(no result)"}`);
  }

  line("\n\n############ 3. DIRECTIONALITY / LOGIC CHECKS ############");
  // self-loops
  const selfKill = await q(`MATCH (a)-[r:KILLED]->(a) RETURN a.name AS a`);
  line(`Self-KILLED (a killed a): ${selfKill.length}  ${selfKill.map((r) => r.get("a")).slice(0, 5).join(", ")}`);
  const selfParent = await q(`MATCH (a)-[:PARENT_OF]->(a) RETURN a.name AS a`);
  line(`Self-PARENT_OF: ${selfParent.length}`);
  // mutual PARENT_OF (a parent b AND b parent a) — a logical impossibility
  const mutualParent = await q(
    `MATCH (a)-[:PARENT_OF]->(b)-[:PARENT_OF]->(a) RETURN a.name AS a, b.name AS b`,
  );
  line(`Mutual PARENT_OF cycles (impossible): ${mutualParent.length}`);
  for (const r of mutualParent.slice(0, 8)) line(`   ${r.get("a")} <-> ${r.get("b")}`);
  // a KILLED b but b later does things? just report dead chars with outgoing actions
  const deadActors = await q(
    `MATCH (x)-[:KILLED]->(v)
     WITH DISTINCT v
     MATCH (v)-[r:KILLED|CAPTURED|SAVED]->() RETURN v.name AS a, count(r) AS c ORDER BY c DESC LIMIT 10`,
  );
  line(`\nChars marked KILLED that still perform actions (may be fine — killed later):`);
  for (const r of deadActors.slice(0, 8)) line(`   ${r.get("a")} (${r.get("c")} outgoing actions)`);

  line("\n\n############ 4. TYPE-CONSTRAINT VIOLATIONS vs schema ############");
  // KILLED object should be a Character
  const badKill = await q(
    `MATCH (a)-[:KILLED]->(o) WHERE NOT o:Character RETURN a.name AS a, labels(o) AS l, o.name AS o LIMIT 15`,
  );
  line(`KILLED -> non-Character objects: ${badKill.length}`);
  for (const r of badKill.slice(0, 10)) line(`   ${r.get("a")} KILLED ${r.get("o")} [${r.get("l")}]`);
  // MEMBER_OF_HOUSE object should be House
  const badHouse = await q(
    `MATCH (a)-[:MEMBER_OF_HOUSE]->(o) WHERE NOT o:House RETURN a.name AS a, labels(o) AS l, o.name AS o LIMIT 15`,
  );
  line(`MEMBER_OF_HOUSE -> non-House objects: ${badHouse.length}`);
  for (const r of badHouse.slice(0, 10)) line(`   ${r.get("a")} -> ${r.get("o")} [${r.get("l")}]`);

  line("\n\n############ 5. ISOLATED / DUPLICATE NODES ############");
  const orphans = await q(`MATCH (n) WHERE NOT (n)--() RETURN n.type AS t, n.name AS a`);
  line(`Isolated nodes (no relationships): ${orphans.length}`);
  for (const r of orphans.slice(0, 15)) line(`   ${r.get("a")} [${r.get("t")}]`);
  // possible duplicate characters (same last token)
  const dups = await q(
    `MATCH (a:Character), (b:Character)
     WHERE a.id < b.id AND toLower(a.name) CONTAINS toLower(b.name)
     RETURN a.name AS a, b.name AS b LIMIT 20`,
  );
  line(`\nPossible unmerged duplicates (one name contains another):`);
  for (const r of dups.slice(0, 20)) line(`   "${r.get("a")}"  ~  "${r.get("b")}"`);

  line("\n\n############ 6. SAMPLE EDGES WITH EVIDENCE ############");
  for (const rel of ["KILLED", "PARENT_OF", "SIBLING_OF", "MARRIED_TO", "BETRAYED"]) {
    const recs = await q(
      `MATCH (a)-[r:${rel}]->(b) RETURN a.name AS a, b.name AS b, r.descriptions[0] AS d, r.episodes AS e ORDER BY r.count DESC LIMIT 4`,
    );
    line(`\n--- ${rel} ---`);
    for (const r of recs) {
      line(`   ${r.get("a")} -> ${r.get("b")}  | ${String(r.get("d") ?? "").slice(0, 90)}`);
    }
  }
}

main()
  .then(async () => { await closeDriver(); process.exit(0); })
  .catch(async (e) => { console.error(e); await closeDriver(); process.exit(1); });
