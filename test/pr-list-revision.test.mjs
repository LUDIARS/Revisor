import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openRevisorDatabase } from "../src/revisor-db.mjs";
import { ensurePrListRevision, readPrListRevision } from "../src/pr-list-revision.mjs";
import { PrListCache, ListResponseCache } from "../src/pr-list-cache.mjs";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

function withDatabase(run) {
  const directory = mkdtempSync(join(tmpdir(), "revisor-pr-list-revision-"));
  const path = join(directory, "state.db");
  const database = openRevisorDatabase(path);
  // A raw/older client need not know about the new revision protocol.
  const other = new DatabaseSync(path);
  try {
    ensurePrListRevision(database);
    run(database, other);
  } finally {
    other.close();
    database.close();
    removeFixture(directory);
  }
}

test("queue and unrelated metadata commits preserve both projection and response caches", () => {
  withDatabase((database, other) => {
    const projected = new PrListCache();
    const serialized = new ListResponseCache();
    let builds = 0;
    let serializations = 0;
    const read = () => {
      const source = projected.read({
        version: readPrListRevision(database), settingsKey: "settings",
        build: () => { builds++; return []; },
      });
      return serialized.render(source, "summary|open", () => { serializations++; return "body"; });
    };
    read();
    other.prepare("INSERT INTO jobs VALUES (?, ?)").run("job", '{"status":"queued"}');
    other.prepare("UPDATE jobs SET record = ? WHERE id = ?").run('{"status":"running"}', "job");
    other.exec("INSERT INTO meta VALUES ('unrelated-counter', '2'); DELETE FROM jobs");
    read();
    assert.equal(builds, 1);
    assert.equal(serializations, 1);
    other.prepare("INSERT INTO pull_requests VALUES (?, ?)").run("pr", "{}");
    read();
    assert.equal(builds, 2);
    assert.equal(serializations, 2);
  });
});

for (const table of ["pull_requests", "pull_request_anatomia", "pull_request_review_reports", "repositories"]) {
  test(`${table} inserts, updates, replacements and deletes invalidate across connections`, () => {
    withDatabase((database, other) => {
      let previous = readPrListRevision(database);
      for (const [connection, sql, args] of [
        [database, `INSERT INTO ${table} VALUES (?, ?)`, ["id", "{}"]],
        [other, `UPDATE ${table} SET record = ? WHERE id = ?`, ['{"version":2}', "id"]],
        [other, `INSERT OR REPLACE INTO ${table} VALUES (?, ?)`, ["id", '{"version":3}']],
        [database, `DELETE FROM ${table} WHERE id = ?`, ["id"]],
      ]) {
        connection.prepare(sql).run(...args);
        const current = readPrListRevision(database);
        assert.notEqual(current, previous);
        assert.equal(readPrListRevision(other), current);
        previous = current;
      }
    });
  });
}

test("uncommitted changes and rollbacks do not invalidate another connection's snapshot", () => {
  withDatabase((database, other) => {
    const before = readPrListRevision(database);
    other.exec("BEGIN IMMEDIATE");
    try {
      other.prepare("INSERT INTO pull_requests VALUES (?, ?)").run("id", "{}");
      assert.notEqual(readPrListRevision(other), before);
      assert.equal(readPrListRevision(database), before);
      // Installed schemas must not acquire a write lock on every connection.
      ensurePrListRevision(database);
    } finally {
      other.exec("ROLLBACK");
    }
    assert.equal(readPrListRevision(database), before);
    assert.equal(readPrListRevision(other), before);
    other.prepare("INSERT INTO pull_requests VALUES (?, ?)").run("id", "{}");
    assert.notEqual(readPrListRevision(database), before);
  });
});

test("installation is idempotent, preserves existing records, and missing tokens disable caching", () => {
  withDatabase((database, other) => {
    other.prepare("INSERT INTO pull_requests VALUES (?, ?)").run("existing", '{"status":"open"}');
    const before = readPrListRevision(database);
    ensurePrListRevision(other);
    assert.equal(readPrListRevision(database), before);
    assert.equal(database.prepare("SELECT record FROM pull_requests WHERE id = ?").get("existing").record,
      '{"status":"open"}');
    assert.equal(database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'pr_list_revision_%'").get().n, 12);
    other.prepare("DELETE FROM meta WHERE key = ?").run("pr_list_revision");
    assert.equal(readPrListRevision(database), null);
  });
});
