import { getMeta, setMeta, withImmediateTransaction } from "./revisor-db.mjs";

const SCHEMA_KEY = "pr_list_revision_schema";
const REVISION_KEY = "pr_list_revision";
const TABLES = ["pull_requests", "pull_request_anatomia", "pull_request_review_reports", "repositories"];

/** @implements SPEC-PR-LIST-REVISION */
export function ensurePrListRevision(database) {
  if (getMeta(database, SCHEMA_KEY) === "1") return;
  withImmediateTransaction(database, () => {
    // Another process may have installed the triggers while we waited for the lock.
    if (getMeta(database, SCHEMA_KEY) === "1") return;
    if (getMeta(database, REVISION_KEY) === null) setMeta(database, REVISION_KEY, "0");
    for (const table of TABLES) {
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        // Both identifiers come from fixed internal lists, never API input.
        database.exec(`
          CREATE TRIGGER IF NOT EXISTS pr_list_revision_${table}_${operation.toLowerCase()}
          AFTER ${operation} ON ${table}
          BEGIN
            UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = '${REVISION_KEY}';
          END;
        `);
      }
    }
    setMeta(database, SCHEMA_KEY, "1");
  });
}

/** Return null rather than cache indefinitely if the required revision is missing. */
export function readPrListRevision(database) {
  const revision = getMeta(database, REVISION_KEY);
  return revision === null ? null : `pr-list-v1:${revision}`;
}
