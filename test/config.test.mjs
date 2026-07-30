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
      // Automatic merging is off until a human states the risk they accept.
      autoMergeEnabled: false,
      autoMergeRiskThreshold: 15,
      autoMergeRequiresRuntimeVerificationClear: true,
      planAdvisor: "none",
      augurFolder: "",
      securityScanEnabled: true,
      securityFailOnSeverity: "high",
      securityMaxCostUsd: 5,
    });
    writeSettings({
      anatomiaFolder: "E:/Document/Ars/Anatomia",
      fallbackReviewer: "claude-opus",
      concordiaContextEnabled: false,
      workerCount: 3,
      securityScanEnabled: false,
      securityFailOnSeverity: "medium",
      securityMaxCostUsd: 2.5,
    }, state.env);
    assert.deepEqual(readSettings(state.env).securityScanEnabled, false);
    assert.equal(readSettings(state.env).securityFailOnSeverity, "medium");
    assert.equal(readSettings(state.env).securityMaxCostUsd, 2.5);
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

test("rejects invalid security scan settings and defaults omitted ones", () => {
  const state = fixture();
  const valid = {
    anatomiaFolder: "Anatomia",
    fallbackReviewer: "codex-sol",
    concordiaContextEnabled: true,
    workerCount: 1,
  };
  try {
    assert.throws(
      () => writeSettings({ ...valid, securityFailOnSeverity: "urgent" }, state.env),
      /Security severity/,
    );
    assert.throws(
      () => writeSettings({ ...valid, securityMaxCostUsd: 0 }, state.env),
      /Security scan max cost/,
    );
    const written = writeSettings(valid, state.env);
    assert.equal(written.securityScanEnabled, true);
    assert.equal(written.securityFailOnSeverity, "high");
    assert.equal(written.securityMaxCostUsd, 5);
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

test("persists the human's auto-merge threshold and the plan advisor", () => {
  const state = fixture();
  try {
    writeSettings({
      anatomiaFolder: "E:/Document/Ars/Anatomia",
      fallbackReviewer: "codex-sol",
      concordiaContextEnabled: true,
      workerCount: 1,
      autoMergeEnabled: true,
      autoMergeRiskThreshold: 30,
      autoMergeRequiresRuntimeVerificationClear: false,
      planAdvisor: "augur",
      augurFolder: "E:/Document/Ars/Augur",
    }, state.env);
    const settings = readSettings(state.env);
    assert.equal(settings.autoMergeEnabled, true);
    assert.equal(settings.autoMergeRiskThreshold, 30);
    assert.equal(settings.autoMergeRequiresRuntimeVerificationClear, false);
    assert.equal(settings.planAdvisor, "augur");
    assert.equal(settings.augurFolder, "E:/Document/Ars/Augur");
    // An omitted field keeps what the operator already chose instead of silently
    // resetting the accepted risk to the default.
    writeSettings({
      anatomiaFolder: "E:/Document/Ars/Anatomia",
      fallbackReviewer: "codex-sol",
      concordiaContextEnabled: true,
      workerCount: 1,
    }, state.env);
    assert.equal(readSettings(state.env).autoMergeRiskThreshold, 30);
    assert.equal(readSettings(state.env).planAdvisor, "augur");
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test("rejects an out-of-range threshold, an unknown advisor and Augur without a folder", () => {
  const state = fixture();
  const base = {
    anatomiaFolder: "E:/Document/Ars/Anatomia",
    fallbackReviewer: "codex-sol",
    concordiaContextEnabled: true,
    workerCount: 1,
  };
  try {
    assert.throws(
      () => writeSettings({ ...base, autoMergeRiskThreshold: 101 }, state.env),
      /threshold must be an integer/,
    );
    assert.throws(
      () => writeSettings({ ...base, planAdvisor: "oracle" }, state.env),
      /Plan advisor must be/,
    );
    assert.throws(
      () => writeSettings({ ...base, planAdvisor: "augur", augurFolder: "" }, state.env),
      /Augur folder is required/,
    );
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});
