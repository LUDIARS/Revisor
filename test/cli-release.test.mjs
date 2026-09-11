import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../src/cli.mjs";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("release CLI sends a confirmed file-backed request to the local API", async () => {
  const directory = mkdtempSync(join(tmpdir(), "revisor-cli-release-"));
  const notesFile = join(directory, "notes.md");
  writeFileSync(notesFile, "Release notes from a file.", "utf8");
  let received;
  let output = "";
  try {
    assert.equal(await main([
      "release", "LUDIARS/Product", "--kind", "minor", "--title", "Product 1.5",
      "--notes-file", notesFile, "--expected-version", "1.4.8", "--json",
    ], {
      cwd: process.cwd(),
      stdout: { write: (value) => { output += value; return true; } },
      fetchImpl: async (url, options) => {
        received = { url, options };
        return response(200, { release: { repository: "LUDIARS/Product", tag: "v1.5.0" } });
      },
    }), 0);
    assert.match(received.url, /\/v1\/repositories\/LUDIARS%2FProduct\/releases$/);
    assert.deepEqual(JSON.parse(received.options.body), {
      kind: "minor", expectedVersion: "1.4.8", title: "Product 1.5",
      notes: "Release notes from a file.", confirmed: true,
    });
    assert.match(output, /"tag": "v1.5.0"/);
  } finally {
    removeFixture(directory);
  }
});

test("release CLI surfaces local API conflict and validation messages", async () => {
  const directory = mkdtempSync(join(tmpdir(), "revisor-cli-release-"));
  const notesFile = join(directory, "notes.md");
  writeFileSync(notesFile, "Release notes.", "utf8");
  const args = ["release", "LUDIARS/Product", "--kind", "major", "--title", "Product 2", "--notes-file", notesFile, "--expected-version", "1.4.8"];
  try {
    await assert.rejects(
      main(args, { cwd: process.cwd(), fetchImpl: async () => response(409, { error: "Version changed." }) }),
      /Version changed/,
    );
    await assert.rejects(
      main(args, { cwd: process.cwd(), fetchImpl: async () => response(400, { error: "kind is invalid." }) }),
      /kind is invalid/,
    );
  } finally {
    removeFixture(directory);
  }
});
