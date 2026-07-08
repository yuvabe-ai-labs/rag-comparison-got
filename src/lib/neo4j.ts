// Neo4j driver singleton + helpers. Mirrors the openai.ts client pattern.
//
// Reads connection details from the environment (see .env.local):
//   NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD, NEO4J_DB_NAME

import neo4j, { type Driver, type Session } from "neo4j-driver";

let driver: Driver | null = null;

export function getDriver(): Driver {
  if (!driver) {
    const uri = process.env.NEO4J_URI;
    const user = process.env.NEO4J_USERNAME;
    const password = process.env.NEO4J_PASSWORD;
    if (!uri || !user || !password) {
      throw new Error("NEO4J_URI, NEO4J_USERNAME and NEO4J_PASSWORD are required (check .env.local).");
    }
    driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  }
  return driver;
}

/** Target database (Neo4j Desktop/Enterprise named DB; defaults to "neo4j"). */
export function getDbName(): string {
  return process.env.NEO4J_DB_NAME || "neo4j";
}

/** Open a session against the configured database. Caller must close it. */
export function getSession(): Session {
  return getDriver().session({ database: getDbName() });
}

export function checkNeo4jEnv(): { ready: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const key of ["NEO4J_URI", "NEO4J_USERNAME", "NEO4J_PASSWORD"]) {
    if (!process.env[key]) missing.push(key);
  }
  return { ready: missing.length === 0, missing };
}

/** Verify connectivity with a clear error if the DB is unreachable. */
export async function verifyConnection(): Promise<void> {
  try {
    await getDriver().verifyConnectivity({ database: getDbName() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cannot reach Neo4j at ${process.env.NEO4J_URI} (db="${getDbName()}"). ` +
        `Is the database started in Neo4j Desktop?\n  ${msg}`,
    );
  }
}

export async function closeDriver(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
  }
}
