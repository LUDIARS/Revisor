import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
      // CLI 既定の xhigh は予算を先に食い潰してスキャンを未完了にするので、
      // 完走を優先して medium を既定にする。
      securityScanEffort: "medium",
      securityScanModel: "",
    });
    writeSettings({
      anatomiaFolder: "E:/Document/Ars/Anatomia",
      fallbackReviewer: "claude-opus",
      concordiaContextEnabled: false,
      workerCount: 3,
      securityScanEnabled: false,
      securityFailOnSeverity: "medium",
      securityMaxCostUsd: 2.5,
      securityScanEffort: "low",
      securityScanModel: " gpt-5.6-terra ",
    }, state.env);
    assert.deepEqual(readSettings(state.env).securityScanEnabled, false);
    assert.equal(readSettings(state.env).securityFailOnSeverity, "medium");
    assert.equal(readSettings(state.env).securityMaxCostUsd, 2.5);
    assert.equal(readSettings(state.env).securityScanEffort, "low");
    assert.equal(readSettings(state.env).securityScanModel, "gpt-5.6-terra");
    // 未知の effort は保存させない。 CLI へそのまま渡る値なので、 不正値を通すと
    // スキャン自体が落ちて「未完了」= マージ不可になり、 原因も見えなくなる。
    assert.throws(
      () => writeSettings({
        anatomiaFolder: "E:/Document/Ars/Anatomia",
        fallbackReviewer: "claude-opus",
        workerCount: 1,
        securityScanEffort: "ultra",
      }, state.env),
      /Security scan effort must be one of/,
    );
    // モデル名は cmd.exe 経由の argv にそのまま乗るので、 コマンド区切り文字を
    // 含む値やフラグに見える値は保存させない (`&` の後ろが別コマンドとして走り、
    // `-` 始まりは --auth chatgpt を押しのけるフラグとして読まれる)。 文字列以外も
    // 拒否する — 文字列化してから検査すると `null` が "null" として書式検査を通り、
    // `--model null` でスキャンが毎回落ちて「未完了」= マージ不可になる。
    for (const model of ["gpt&whoami", "--auth", "gpt 5", "gpt|tee x", null, ["gpt-5.6"]]) {
      assert.throws(
        () => writeSettings({
          anatomiaFolder: "E:/Document/Ars/Anatomia",
          fallbackReviewer: "claude-opus",
          workerCount: 1,
          securityScanModel: model,
        }, state.env),
        /Security scan model must be a bare model name/,
      );
    }
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
    assert.equal(written.securityScanEffort, "medium");
    assert.equal(written.securityScanModel, "");
    // 手書きの設定ファイルは writeSettings を通らないので、 CLI へ渡る前に読み側でも
    // 落とす。 effort/model は argv に乗る値で、 未知の effort はスキャンを落として
    // 「未完了」= マージ不可になり、 細工したモデル名は cmd.exe で別コマンドになる。
    writeFileSync(state.path, `${JSON.stringify({
      version: 1,
      settings: { securityScanEffort: "ultra", securityScanModel: "gpt&whoami" },
      secrets: {},
    })}\n`, "utf8");
    assert.equal(readSettings(state.env).securityScanEffort, "medium");
    assert.equal(readSettings(state.env).securityScanModel, "");
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
