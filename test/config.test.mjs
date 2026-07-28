import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readAllowedHosts,
  readSettings,
  hasWorkflowToken,
  readWorkflowToken,
  writeAllowedHosts,
  writeWorkflowToken,
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

test("stores settings and encrypts local workflow secrets", () => {
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
    writeWorkflowToken("workflow-secret", state.env);
    assert.deepEqual(writeAllowedHosts([
      "Revisor.Example.com",
      "revisor.example.com:443",
    ], state.env), ["revisor.example.com"]);
    assert.equal(readWorkflowToken(state.env), "workflow-secret");
    assert.deepEqual(readAllowedHosts(state.env), ["revisor.example.com"]);
    assert.equal(hasWorkflowToken(state.env), true);
    const rawConfig = readFileSync(state.path, "utf8");
    assert.equal(rawConfig.includes("workflow-secret"), false);
    assert.equal(rawConfig.includes("revisor.example.com"), false);
    assert.equal(readSettings(state.env).workerCount, 3);
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test("validates configured allowed hosts and permits clearing them", () => {
  const state = fixture();
  try {
    assert.throws(
      () => writeAllowedHosts(["https://revisor.example.com"], state.env),
      /Allowed host is invalid/,
    );
    writeAllowedHosts(["revisor.example.com"], state.env);
    assert.deepEqual(writeAllowedHosts([], state.env), []);
    assert.deepEqual(readAllowedHosts(state.env), []);
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
    writeWorkflowToken("workflow-secret", state.env);
    unlinkSync(state.env.REVISOR_KEY_PATH);
    assert.throws(() => readWorkflowToken(state.env), /could not be decrypted/);
    assert.equal(hasWorkflowToken(state.env), false);
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});
