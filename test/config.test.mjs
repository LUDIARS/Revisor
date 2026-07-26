import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  hasOriginToken,
  readOriginToken,
  readSettings,
  writeOriginToken,
  writeSettings,
} from "../src/config.mjs";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "revisor-config-"));
  return {
    directory,
    path: join(directory, "config.json"),
    env: {
      REVISOR_CONFIG_PATH: join(directory, "config.json"),
      REVISOR_KEY_PATH: join(directory, "config.key"),
    },
  };
}

test("stores settings and encrypts the origin token", () => {
  const state = fixture();
  try {
    assert.deepEqual(readSettings(state.env), {
      anatomiaFolder: "",
      fallbackReviewer: "codex-sol",
      concordiaContextEnabled: true,
      workerCount: 1,
    });
    writeSettings({
      anatomiaFolder: "E:/Document/Ars/Anatomia",
      fallbackReviewer: "claude-opus",
      concordiaContextEnabled: false,
      workerCount: 3,
    }, state.env);
    writeOriginToken("origin-secret", state.env);
    assert.equal(readOriginToken(state.env), "origin-secret");
    assert.equal(hasOriginToken(state.env), true);
    assert.equal(readFileSync(state.path, "utf8").includes("origin-secret"), false);
    assert.equal(readSettings(state.env).workerCount, 3);
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test("rejects invalid worker settings", () => {
  const state = fixture();
  try {
    assert.throws(() => writeSettings({
      anatomiaFolder: "Anatomia",
      fallbackReviewer: "codex-sol",
      concordiaContextEnabled: true,
      workerCount: 0,
    }, state.env), /Worker count/);
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test("fails without replacing a missing encryption key", () => {
  const state = fixture();
  try {
    writeOriginToken("origin-secret", state.env);
    unlinkSync(state.env.REVISOR_KEY_PATH);
    assert.throws(() => readOriginToken(state.env), /could not be decrypted/);
    assert.equal(hasOriginToken(state.env), false);
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});
