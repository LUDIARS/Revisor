import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  readAllowedHosts,
  readSettings,
  hasWorkflowToken,
  hasDiscordWebhookUrl,
  optionalDiscordWebhookUrl,
  hasGitHubAppCredentials,
  readGitHubAppCredentials,
  readWorkflowToken,
  writeAllowedHosts,
  writeWorkflowToken,
  writeGitHubAppCredentials,
  removeGitHubAppCredentials,
  removeDiscordWebhookUrl,
  writeDiscordWebhookUrl,
  writeSettings,
} from "../src/config.mjs";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

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

test("encrypts, reads, and removes the Discord webhook URL", () => {
  const state = fixture();
  const webhookUrl = "https://discord.com/api/webhooks/123456/abc";
  try {
    assert.equal(optionalDiscordWebhookUrl(state.env), null);
    assert.equal(hasDiscordWebhookUrl(state.env), false);
    writeDiscordWebhookUrl(webhookUrl, state.env);
    assert.equal(optionalDiscordWebhookUrl(state.env), webhookUrl);
    assert.equal(hasDiscordWebhookUrl(state.env), true);
    assert.equal(readFileSync(state.path, "utf8").includes(webhookUrl), false);
    assert.throws(
      () => writeDiscordWebhookUrl("https://example.com/webhook", state.env),
      /Discord webhook URL must be a https:\/\/discord\.com\/api\/webhooks\/\.\.\. URL/,
    );
    removeDiscordWebhookUrl(state.env);
    assert.equal(optionalDiscordWebhookUrl(state.env), null);
    assert.equal(hasDiscordWebhookUrl(state.env), false);
  } finally {
    removeFixture(state.directory);
  }
});

test("resolves a relative anatomiaFolder to an absolute path on read, basis = config file directory (legacy config, cwd-independent)", () => {
  // 2026-08-09 実障害: %LOCALAPPDATA%\LUDIARS\revisor.config.json に
  // anatomiaFolder="../Anatomia" が保存されており、resolveAnatomiaCli() が
  // 呼び出し元プロセスの cwd を基準に解決するため cwd 次第で別フォルダを指した。
  // 基準は cwd ではなく設定ファイルの置き場所 (dirname(configPath)) に固定する。
  const state = fixture();
  try {
    writeFileSync(state.path, JSON.stringify({
      version: 1,
      settings: { anatomiaFolder: "../Anatomia" },
      secrets: {},
    }), "utf8");
    const resolved = readSettings(state.env).anatomiaFolder;
    assert.ok(resolved.startsWith("Anatomia") === false, "must not stay relative");
    assert.equal(resolved.endsWith("Anatomia"), true);
    assert.equal(resolved, resolve(state.directory, "..", "Anatomia"));
  } finally {
    removeFixture(state.directory);
  }
});

test("resolved anatomiaFolder is independent of process cwd", () => {
  const state = fixture();
  const originalCwd = process.cwd();
  try {
    writeFileSync(state.path, JSON.stringify({
      version: 1,
      settings: { anatomiaFolder: "../Anatomia" },
      secrets: {},
    }), "utf8");
    const fromOriginalCwd = readSettings(state.env).anatomiaFolder;
    process.chdir(tmpdir());
    const fromDifferentCwd = readSettings(state.env).anatomiaFolder;
    assert.equal(fromDifferentCwd, fromOriginalCwd);
  } finally {
    process.chdir(originalCwd);
    removeFixture(state.directory);
  }
});

test("writeSettings persists an absolute anatomiaFolder even when given a relative one", () => {
  const state = fixture();
  try {
    writeSettings({
      anatomiaFolder: "../Anatomia",
      fallbackReviewer: "codex-sol",
      workerCount: 1,
    }, state.env);
    const stored = JSON.parse(readFileSync(state.path, "utf8"));
    assert.notEqual(stored.settings.anatomiaFolder, "../Anatomia");
    assert.equal(stored.settings.anatomiaFolder, resolve(state.directory, "..", "Anatomia"));
  } finally {
    removeFixture(state.directory);
  }
});

test("writeSettings keeps an absolute reviewScratchRoot and defaults to empty", () => {
  const state = fixture();
  try {
    writeSettings({
      anatomiaFolder: "/abs/Anatomia",
      fallbackReviewer: "codex-sol",
      workerCount: 1,
    }, state.env);
    assert.equal(readSettings(state.env).reviewScratchRoot, "");

    writeSettings({
      anatomiaFolder: "/abs/Anatomia",
      fallbackReviewer: "codex-sol",
      workerCount: 1,
      reviewScratchRoot: " /scratch/revisor ",
    }, state.env);
    assert.equal(readSettings(state.env).reviewScratchRoot, "/scratch/revisor");
  } finally {
    removeFixture(state.directory);
  }
});

// 相対パスは解決の基点が呼び出し側の cwd で変わる。審査は使い捨て worktree を
// cwd にして走るので、保存を許すと同じ設定が実行ごとに別の場所を指す。
test("writeSettings refuses a relative reviewScratchRoot", () => {
  const state = fixture();
  try {
    assert.throws(() => writeSettings({
      anatomiaFolder: "/abs/Anatomia",
      fallbackReviewer: "codex-sol",
      workerCount: 1,
      reviewScratchRoot: "scratch",
    }, state.env), /absolute path/);
  } finally {
    removeFixture(state.directory);
  }
});

// 保存済みの設定が壊れていても Revisor 全体が起動不能にならないこと。読み取りは
// 既定へ落とすだけにしてある。
test("readSettings falls back to the OS temporary directory for an invalid stored value", () => {
  const state = fixture();
  try {
    writeSettings({
      anatomiaFolder: "/abs/Anatomia",
      fallbackReviewer: "codex-sol",
      workerCount: 1,
    }, state.env);
    const stored = JSON.parse(readFileSync(state.path, "utf8"));
    stored.settings.reviewScratchRoot = "relative/path";
    writeFileSync(state.path, JSON.stringify(stored));
    assert.equal(readSettings(state.env).reviewScratchRoot, "");
  } finally {
    removeFixture(state.directory);
  }
});

test("writeSettings persists an absolute augurFolder even when given a relative one", () => {
  const state = fixture();
  try {
    writeSettings({
      anatomiaFolder: "/abs/Anatomia",
      fallbackReviewer: "codex-sol",
      workerCount: 1,
      planAdvisor: "augur",
      augurFolder: "../Augur",
    }, state.env);
    const stored = JSON.parse(readFileSync(state.path, "utf8"));
    assert.notEqual(stored.settings.augurFolder, "../Augur");
    assert.equal(stored.settings.augurFolder, resolve(state.directory, "..", "Augur"));
  } finally {
    removeFixture(state.directory);
  }
});

test("stores settings and encrypts local workflow secrets", () => {
  const state = fixture();
  try {
    assert.deepEqual(readSettings(state.env), {
      anatomiaFolder: "",
      // 空欄は「OS の一時領域を使う」。作業領域の置き場所は設定しない限り既定のまま。
      reviewScratchRoot: "",
      anatomiaReviewGateEnabled: true,
      // 2026-09-01 からドメイン未定義は既定で止める (advisory は台帳整備中のリポ向け)。
      anatomiaDualLayerGateMode: "enforced",
      // 反対モデルレビューが既定。fallbackReviewer は provider 不明時の
      // 保険で、Codex 系列。
      fallbackReviewer: "codex-sol",
      oppositeModelReviewEnabled: true,
      // 空文字は「モデルを強制しない」。
      forcedReviewModel: "",
      // 運用既定ですべての reviewer stage を Mid に固定する。
      forcedReviewEffort: "medium",
      concordiaContextEnabled: true,
      workerCount: 1,
      fastLaneSlots: 0,
      largeReviewLineThreshold: 1_000,
      multiDomainReviewThreshold: 3,
      costValidationModeEnabled: false,
      costValidationSkipReview: false,
      costValidationSkipGenius: false,
      costValidationSkipAnatomiaDomain: false,
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
      anatomiaReviewGateEnabled: false,
      fallbackReviewer: "claude-opus",
      concordiaContextEnabled: false,
      workerCount: 3,
      fastLaneSlots: 2,
      largeReviewLineThreshold: 750,
      multiDomainReviewThreshold: 2,
      costValidationModeEnabled: true,
      securityScanEnabled: false,
      securityFailOnSeverity: "medium",
      securityMaxCostUsd: 2.5,
      securityScanEffort: "low",
      securityScanModel: " gpt-5.6-terra ",
    }, state.env);
    assert.equal(readSettings(state.env).anatomiaReviewGateEnabled, false);
    // Untouched by that write: the dual-layer gate keeps its enforced default.
    assert.equal(readSettings(state.env).anatomiaDualLayerGateMode, "enforced");
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
    assert.equal(readSettings(state.env).fastLaneSlots, 2);
    assert.throws(() => writeSettings({
      anatomiaFolder: "E:/Document/Ars/Anatomia",
      fallbackReviewer: "codex-sol",
      workerCount: 1,
      fastLaneSlots: 1,
    }, state.env), /leave one standard review slot/);
    assert.throws(() => writeSettings({
      anatomiaFolder: "E:/Document/Ars/Anatomia",
      fallbackReviewer: "codex-sol",
      workerCount: 2,
      fastLaneSlots: 2,
    }, state.env), /leave one standard review slot/);
    assert.equal(readSettings(state.env).largeReviewLineThreshold, 750);
    assert.equal(readSettings(state.env).multiDomainReviewThreshold, 2);
    assert.equal(readSettings(state.env).costValidationModeEnabled, true);
    assert.equal(readSettings(state.env).costValidationSkipReview, true);
    assert.equal(readSettings(state.env).costValidationSkipGenius, true);
    assert.equal(readSettings(state.env).costValidationSkipAnatomiaDomain, true);
  } finally {
    removeFixture(state.directory);
  }
});

test("defaults a missing forced review effort but disables a corrupt stored override", () => {
  const state = fixture();
  try {
    writeFileSync(state.path, `${JSON.stringify({
      version: 1,
      settings: {},
      secrets: {},
    })}\n`, "utf8");
    assert.equal(readSettings(state.env).forcedReviewEffort, "medium");

    writeFileSync(state.path, `${JSON.stringify({
      version: 1,
      settings: { forcedReviewEffort: "ultra" },
      secrets: {},
    })}\n`, "utf8");
    assert.equal(readSettings(state.env).forcedReviewEffort, "");
    assert.throws(() => writeSettings({
      anatomiaFolder: "/abs/Anatomia",
      fallbackReviewer: "codex-sol",
      forcedReviewEffort: "ultra",
      workerCount: 1,
    }, state.env), /Forced review effort is invalid/);
  } finally {
    removeFixture(state.directory);
  }
});

test("persists each cost validation skip independently", () => {
  const state = fixture();
  try {
    writeSettings({
      anatomiaFolder: "E:/Document/Ars/Anatomia",
      fallbackReviewer: "codex-sol",
      workerCount: 1,
      costValidationSkipReview: true,
      costValidationSkipGenius: false,
      costValidationSkipAnatomiaDomain: false,
    }, state.env);
    const settings = readSettings(state.env);
    assert.equal(settings.costValidationModeEnabled, true);
    assert.equal(settings.costValidationSkipReview, true);
    assert.equal(settings.costValidationSkipGenius, false);
    assert.equal(settings.costValidationSkipAnatomiaDomain, false);
  } finally {
    removeFixture(state.directory);
  }
});

test("encrypts and removes GitHub App credentials", () => {
  const state = fixture();
  const privateKey = [
    ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
    "test-only",
    ["-----END", "PRIVATE KEY-----"].join(" "),
  ].join("\n");
  try {
    assert.equal(hasGitHubAppCredentials(state.env), false);
    assert.deepEqual(
      writeGitHubAppCredentials({ appId: "4436890", privateKey }, state.env),
      { appId: "4436890" },
    );
    assert.deepEqual(readGitHubAppCredentials(state.env), { appId: "4436890", privateKey });
    assert.equal(readFileSync(state.path, "utf8").includes(privateKey), false);
    removeGitHubAppCredentials(state.env);
    assert.equal(hasGitHubAppCredentials(state.env), false);
  } finally {
    removeFixture(state.directory);
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
    removeFixture(state.directory);
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
    removeFixture(state.directory);
  }
});

test("rejects invalid review scale thresholds", () => {
  const state = fixture();
  const base = {
    anatomiaFolder: "Anatomia",
    fallbackReviewer: "codex-sol",
    workerCount: 1,
  };
  try {
    assert.throws(
      () => writeSettings({ ...base, largeReviewLineThreshold: 0 }, state.env),
      /Large review line threshold/,
    );
    assert.throws(
      () => writeSettings({ ...base, multiDomainReviewThreshold: 1.5 }, state.env),
      /Multi-domain review threshold/,
    );
  } finally {
    removeFixture(state.directory);
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
    removeFixture(state.directory);
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
    removeFixture(state.directory);
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
    removeFixture(state.directory);
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
    removeFixture(state.directory);
  }
});

test("the Anatomia dual-layer gate mode defaults to enforced and only accepts advisory|enforced", () => {
  const state = fixture();
  try {
    const required = {
      anatomiaFolder: "E:/Document/Ars/Anatomia",
      fallbackReviewer: "codex-sol",
      workerCount: 1,
    };
    assert.equal(readSettings(state.env).anatomiaDualLayerGateMode, "enforced");
    writeSettings({ ...required, anatomiaDualLayerGateMode: "advisory" }, state.env);
    assert.equal(readSettings(state.env).anatomiaDualLayerGateMode, "advisory");
    // A write that omits the key keeps the current value.
    writeSettings({ ...required, workerCount: 2 }, state.env);
    assert.equal(readSettings(state.env).anatomiaDualLayerGateMode, "advisory");
    assert.throws(
      () => writeSettings({ ...required, anatomiaDualLayerGateMode: "strict" }, state.env),
      /advisory, enforced/,
    );
    // A persisted value the reader does not know falls back to the enforced default.
    const stored = JSON.parse(readFileSync(state.path, "utf8"));
    stored.settings.anatomiaDualLayerGateMode = "bogus";
    writeFileSync(state.path, JSON.stringify(stored));
    assert.equal(readSettings(state.env).anatomiaDualLayerGateMode, "enforced");
  } finally {
    removeFixture(state.directory);
  }
});

test("keeps a stored fallback reviewer and persists the opposite-model toggle", () => {
  const state = fixture();
  try {
    // 既定が codex-sol でも、明示保存された claude-opus は残る。
    // 片方だけを見て残りを既定へ落とす正規化だと、ここが黙って書き換わる。
    writeSettings({
      anatomiaFolder: "E:/Document/Ars/Anatomia",
      fallbackReviewer: "claude-opus",
      workerCount: 1,
    }, state.env);
    assert.equal(readSettings(state.env).fallbackReviewer, "claude-opus");
    assert.equal(readSettings(state.env).oppositeModelReviewEnabled, true);
    writeSettings({
      anatomiaFolder: "E:/Document/Ars/Anatomia",
      fallbackReviewer: "claude-opus",
      workerCount: 1,
      oppositeModelReviewEnabled: false,
    }, state.env);
    assert.equal(readSettings(state.env).oppositeModelReviewEnabled, false);
    // 省略した書き込みは運用者が選んだ値を維持する。
    writeSettings({
      anatomiaFolder: "E:/Document/Ars/Anatomia",
      fallbackReviewer: "claude-opus",
      workerCount: 2,
    }, state.env);
    assert.equal(readSettings(state.env).oppositeModelReviewEnabled, false);
    // キーを持たない旧設定は既定 (defaults()) を採る。真偽値を `=== true` で
    // 畳むと、ここが既定ではなく常に false になり、既定を反転させたときに
    // 既存環境だけ黙って取り残される。
    const stored = JSON.parse(readFileSync(state.path, "utf8"));
    delete stored.settings.oppositeModelReviewEnabled;
    writeFileSync(state.path, JSON.stringify(stored));
    // defaults().oppositeModelReviewEnabled と同じ値。既定を変えるならここも動く。
    assert.equal(readSettings(state.env).oppositeModelReviewEnabled, true);
    // 真偽値でない永続値も既定へ落とす。
    stored.settings.oppositeModelReviewEnabled = "yes";
    writeFileSync(state.path, JSON.stringify(stored));
    assert.equal(readSettings(state.env).oppositeModelReviewEnabled, true);
    assert.throws(
      () => writeSettings({
        anatomiaFolder: "E:/Document/Ars/Anatomia",
        fallbackReviewer: "gemini",
        workerCount: 1,
      }, state.env),
      /Fallback reviewer is invalid/,
    );
  } finally {
    removeFixture(state.directory);
  }
});
