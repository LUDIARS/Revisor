import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { decryptString, encryptString, isEncryptedBlob } from "./crypto.mjs";
import { RevisorError } from "./errors.mjs";
import { isDiscordWebhookUrl } from "./discord-webhook.mjs";
import { normalizeAllowedHosts } from "./host-policy.mjs";
import { defaultFastLaneSlots, fastLaneReservation } from "./review-lane.mjs";
import { isForcedReviewModel } from "./forced-review-model.mjs";

const LOCAL_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CONFIG_PATH_ENV = "REVISOR_CONFIG_PATH";
const KEY_PATH_ENV = "REVISOR_KEY_PATH";
const MASTER_KEY_ENV = "REVISOR_MASTER_KEY";
const GITHUB_APP_PRIVATE_KEY_PATTERN = /^-----BEGIN (?:RSA )?PRIVATE KEY-----/;

const SECURITY_SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const SECURITY_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
// The model name is the only security-scan argument a human types freely, and it
// ends up in a `codex-security` argv that `runNamedCli` launches through
// `cmd.exe /d /s /c` on Windows. cmd.exe re-parses that command line, so a value
// carrying `&`, `|`, `>` or `^` would run as a second command, and a value
// starting with `-` would be read as a CLI flag instead of a model (silently
// displacing `--auth chatgpt` and its billing guarantee). Only a bare model
// identifier is accepted; the empty string means "CLI default model".
const SECURITY_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function isSecurityModel(value) {
  return value === "" || SECURITY_MODEL_PATTERN.test(value);
}

const DUAL_LAYER_GATE_MODES = new Set(["advisory", "enforced"]);
// 保存できるレビュアー id。reviewerInvocation が知っている系列と 1:1 で、
// ここに無い値は設定として受け付けない。
const REVIEWERS = new Set(["codex-sol", "claude-opus"]);

function defaults() {
  return {
    anatomiaFolder: "",
    // 審査・マージ・走査の使い捨て作業領域を置く親ディレクトリ。空なら OS の
    // 一時領域。システムドライブの空きが乏しい機械で、審査ごとに作られる
    // 登録リポジトリの worktree とそのビルド成果物を別ドライブへ逃がすための口。
    reviewScratchRoot: "",
    anatomiaReviewGateEnabled: true,
    // Anatomia's dual-layer domain gate (program / business) starts advisory:
    // its findings are surfaced next to the legacy target-domain verdict so the
    // two can be compared during migration, and only "enforced" lets it block.
    anatomiaDualLayerGateMode: "advisory",
    // 反対モデルレビューが既定なので、fallbackReviewer は作成者の provider が
    // 判別できないときだけ使われる。Codex 系列を既定にして、Claude 主体の
    // 実装が Claude 自身の審査に倒れないようにする。
    fallbackReviewer: "codex-sol",
    // 反対モデルレビュー (作成者と別系列で審査する) を行うかどうか。一時的に
    // 既定を無効にして全審査を Claude 系列へ寄せたが、作成者と同じ系列が
    // 自分の実装を通す形になるため neco の指示で既定を有効へ戻した
    // (2026-08-22)。コストを寄せたい運用だけ設定で無効にする。
    oppositeModelReviewEnabled: true,
    // 空文字は「強制しない」。差分規模から選ばれる tier ごとモデルを
    // 踏み潰して全審査を1モデルに固定したいときだけ設定する。
    forcedReviewModel: "",
    concordiaContextEnabled: true,
    workerCount: 1,
    fastLaneSlots: 0,
    largeReviewLineThreshold: 1_000,
    multiDomainReviewThreshold: 3,
    costValidationModeEnabled: false,
    costValidationSkipReview: false,
    costValidationSkipGenius: false,
    costValidationSkipAnatomiaDomain: false,
    // Automatic merging stays off until a human sets the risk they accept. The
    // threshold is the human's decision, so there is no safe value to assume.
    autoMergeEnabled: false,
    autoMergeRiskThreshold: 15,
    autoMergeRequiresRuntimeVerificationClear: true,
    planAdvisor: "none",
    augurFolder: "",
    securityScanEnabled: true,
    securityFailOnSeverity: "high",
    securityMaxCostUsd: 5,
    // codex-security の既定 effort は xhigh で、 PR ごとに走らせると推論コストが
    // 予算 (securityMaxCostUsd) を先に食い潰し、 スキャンが自己中断して exit 2 =
    // 「未完了」 になる。 未完了はマージをブロックするので、 既定を xhigh より下げて
    // 「完走すること」 を優先する。 深く見たいリポだけ設定で上げる。
    securityScanEffort: "medium",
    // 空なら CLI 既定モデル。 より安いモデルへ寄せたいときだけ設定する。
    securityScanModel: "",
  };
}

const PLAN_ADVISOR_VALUES = new Set(["none", "augur", "reviewer"]);

function riskThreshold(value, fallback) {
  const score = Number(value);
  return Number.isInteger(score) && score >= 0 && score <= 100 ? score : fallback;
}

export function resolveConfigPath(
  env = process.env,
  platform = process.platform,
  home = homedir(),
) {
  if (env[CONFIG_PATH_ENV]) return env[CONFIG_PATH_ENV];
  if (platform === "win32" && env.LOCALAPPDATA) {
    return join(env.LOCALAPPDATA, "LUDIARS", "revisor.config.json");
  }
  return join(home, ".config", "ludiars", "revisor.config.json");
}

function resolveKeyPath(configPath, env) {
  return env[KEY_PATH_ENV] ?? join(dirname(configPath), "revisor.config.key");
}

// anatomiaFolder / augurFolder は resolve(anatomiaFolder) で cwd 基準に解決されるため、
// 相対パスのまま持つと呼び出し元プロセスの cwd 次第で別フォルダを指す
// (2026-08-09 実障害: "../Anatomia" が cwd で揺れた)。cwd ではなく設定ファイルの
// 置き場所という固定された基準で絶対化する。
export function resolveToolFolder(input, env = process.env) {
  const trimmed = typeof input === "string" ? input.trim() : "";
  if (!trimmed) return trimmed;
  if (isAbsolute(trimmed)) return trimmed;
  const configDir = dirname(resolveConfigPath(env));
  return resolve(configDir, trimmed);
}

function readMasterKey(configPath, env) {
  const override = env[MASTER_KEY_ENV]?.trim();
  if (override) return override;
  const keyPath = resolveKeyPath(configPath, env);
  if (existsSync(keyPath)) {
    const key = readFileSync(keyPath, "utf8").trim();
    if (!LOCAL_KEY_PATTERN.test(key)) {
      throw new RevisorError(`Revisor config key has an invalid format: ${keyPath}`);
    }
    return key;
  }
  throw new RevisorError(`Revisor config key is unavailable: ${keyPath}`);
}

function readOrCreateMasterKey(configPath, env) {
  try {
    return readMasterKey(configPath, env);
  } catch (error) {
    const keyPath = resolveKeyPath(configPath, env);
    if (existsSync(keyPath)) throw error;
  }
  const keyPath = resolveKeyPath(configPath, env);
  mkdirSync(dirname(keyPath), { recursive: true });
  const key = randomBytes(32).toString("base64url");
  try {
    writeFileSync(keyPath, `${key}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return key;
  } catch (error) {
    if (error?.code === "EEXIST") return readOrCreateMasterKey(configPath, env);
    throw new RevisorError(`Revisor config key could not be created: ${keyPath}`, {
      cause: error,
    });
  }
}

function readConfig(env) {
  const path = resolveConfigPath(env);
  if (!existsSync(path)) return { version: 1, settings: {}, secrets: {} };
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (
      !value
      || value.version !== 1
      || typeof value.settings !== "object"
      || typeof value.secrets !== "object"
    ) {
      throw new Error("invalid schema");
    }
    return value;
  } catch (error) {
    throw new RevisorError(`Revisor config is unreadable: ${path}`, { cause: error });
  }
}

function writeConfig(value, env) {
  const path = resolveConfigPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function readSettings(env = process.env) {
  const value = readConfig(env).settings;
  const base = defaults();
  const legacyCostValidationMode = value.costValidationModeEnabled === true;
  const costValidationSkipReview = typeof value.costValidationSkipReview === "boolean"
    ? value.costValidationSkipReview
    : legacyCostValidationMode;
  const costValidationSkipGenius = typeof value.costValidationSkipGenius === "boolean"
    ? value.costValidationSkipGenius
    : legacyCostValidationMode;
  const costValidationSkipAnatomiaDomain = typeof value.costValidationSkipAnatomiaDomain === "boolean"
    ? value.costValidationSkipAnatomiaDomain
    : legacyCostValidationMode;
  const workerCount = Number.isInteger(value.workerCount)
    && value.workerCount >= 1
    && value.workerCount <= 8
    ? value.workerCount
    : base.workerCount;
  let fastLaneSlots = defaultFastLaneSlots(workerCount);
  try {
    fastLaneSlots = fastLaneReservation(workerCount, value.fastLaneSlots);
  } catch {
    // Legacy configs have no fastLaneSlots. Invalid persisted values are not
    // allowed to steal the last standard slot; fall back to the safe default.
  }
  return {
    // レガシー設定 ("../Anatomia" 等) にも効くよう読み取り時点で絶対パス化する。
    anatomiaFolder: resolveToolFolder(value.anatomiaFolder, env) || base.anatomiaFolder,
    // 読み取りは寛容にする。相対パスや非文字列が保存されていても既定 (OS の
    // 一時領域) へ落とすだけにして、設定 1 つで Revisor 全体が起動不能に
    // ならないようにする。不正値を拒むのは書き込み側の責務。
    reviewScratchRoot: typeof value.reviewScratchRoot === "string"
      && isAbsolute(value.reviewScratchRoot.trim())
      ? value.reviewScratchRoot.trim()
      : base.reviewScratchRoot,
    anatomiaReviewGateEnabled: value.anatomiaReviewGateEnabled !== false,
    anatomiaDualLayerGateMode: DUAL_LAYER_GATE_MODES.has(value.anatomiaDualLayerGateMode)
      ? value.anatomiaDualLayerGateMode
      : base.anatomiaDualLayerGateMode,
    // 既知の 2 値はそのまま保つ。片方だけを見て残りを既定へ落とすと、
    // 既定を入れ替えたときに保存済みの明示設定まで書き換わってしまう。
    fallbackReviewer: REVIEWERS.has(value.fallbackReviewer)
      ? value.fallbackReviewer
      : base.fallbackReviewer,
    // 既定は defaults() から取る。真偽値を `=== true` で畳むと、キーを持たない
    // 旧設定が既定ではなく常に false へ落ちる。既定を反転させたとき新規設定だけ
    // 効いて既存環境が黙って取り残される。
    oppositeModelReviewEnabled: typeof value.oppositeModelReviewEnabled === "boolean"
      ? value.oppositeModelReviewEnabled
      : base.oppositeModelReviewEnabled,
    forcedReviewModel: isForcedReviewModel(value.forcedReviewModel)
      ? value.forcedReviewModel
      : base.forcedReviewModel,
    concordiaContextEnabled: value.concordiaContextEnabled !== false,
    workerCount,
    fastLaneSlots,
    largeReviewLineThreshold: Number.isInteger(value.largeReviewLineThreshold)
      && value.largeReviewLineThreshold >= 1
      ? value.largeReviewLineThreshold
      : base.largeReviewLineThreshold,
    multiDomainReviewThreshold: Number.isInteger(value.multiDomainReviewThreshold)
      && value.multiDomainReviewThreshold >= 1
      ? value.multiDomainReviewThreshold
      : base.multiDomainReviewThreshold,
    // Legacy callers stored one boolean for all three skips. Keep accepting it
    // while exposing the independent values that the settings UI now owns.
    costValidationModeEnabled: costValidationSkipReview
      || costValidationSkipGenius
      || costValidationSkipAnatomiaDomain,
    costValidationSkipReview,
    costValidationSkipGenius,
    costValidationSkipAnatomiaDomain,
    autoMergeEnabled: value.autoMergeEnabled === true,
    autoMergeRiskThreshold: riskThreshold(
      value.autoMergeRiskThreshold,
      base.autoMergeRiskThreshold,
    ),
    autoMergeRequiresRuntimeVerificationClear:
      value.autoMergeRequiresRuntimeVerificationClear !== false,
    planAdvisor: PLAN_ADVISOR_VALUES.has(value.planAdvisor)
      ? value.planAdvisor
      : base.planAdvisor,
    augurFolder: resolveToolFolder(value.augurFolder, env) || base.augurFolder,
    securityScanEnabled: value.securityScanEnabled !== false,
    securityFailOnSeverity: SECURITY_SEVERITIES.has(value.securityFailOnSeverity)
      ? value.securityFailOnSeverity
      : base.securityFailOnSeverity,
    securityMaxCostUsd: Number.isFinite(value.securityMaxCostUsd)
      && value.securityMaxCostUsd > 0
      ? value.securityMaxCostUsd
      : base.securityMaxCostUsd,
    securityScanEffort: SECURITY_EFFORTS.has(value.securityScanEffort)
      ? value.securityScanEffort
      : base.securityScanEffort,
    securityScanModel: typeof value.securityScanModel === "string"
      && isSecurityModel(value.securityScanModel.trim())
      ? value.securityScanModel.trim()
      : base.securityScanModel,
  };
}

export function writeSettings(settings, env = process.env) {
  const anatomiaFolderInput = typeof settings?.anatomiaFolder === "string"
    ? settings.anatomiaFolder.trim()
    : "";
  if (!anatomiaFolderInput) throw new RevisorError("Anatomia folder is required.");
  const anatomiaFolder = resolveToolFolder(anatomiaFolderInput, env);
  if (!REVIEWERS.has(settings.fallbackReviewer)) {
    throw new RevisorError("Fallback reviewer is invalid.");
  }
  const workerCount = Number(settings.workerCount);
  if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > 8) {
    throw new RevisorError("Worker count must be an integer from 1 to 8.");
  }
  const fastLaneSlots = settings.fastLaneSlots === undefined
    ? defaultFastLaneSlots(workerCount)
    : Number(settings.fastLaneSlots);
  try {
    fastLaneReservation(workerCount, fastLaneSlots);
  } catch (error) {
    throw new RevisorError(error instanceof Error ? error.message : String(error));
  }
  const current = readSettings(env);
  // 未設定 (undefined) は現在値の維持、明示された値は登録済みモデルのみ。
  // 未知の値を黙って "" に落とすと「強制したつもりで効いていない」状態に
  // なるため、書き込み時点で拒否する。
  const forcedReviewModel = settings.forcedReviewModel === undefined
    ? current.forcedReviewModel
    : settings.forcedReviewModel;
  if (!isForcedReviewModel(forcedReviewModel)) {
    throw new RevisorError("Forced review model is invalid.");
  }
  const skipCostValidation = (key) => {
    if (settings[key] !== undefined) return settings[key] === true;
    if (settings.costValidationModeEnabled !== undefined) {
      return settings.costValidationModeEnabled === true;
    }
    return current[key] === true;
  };
  const costValidationSkipReview = skipCostValidation("costValidationSkipReview");
  const costValidationSkipGenius = skipCostValidation("costValidationSkipGenius");
  const costValidationSkipAnatomiaDomain = skipCostValidation(
    "costValidationSkipAnatomiaDomain",
  );
  const largeReviewLineThreshold = settings.largeReviewLineThreshold === undefined
    ? current.largeReviewLineThreshold
    : Number(settings.largeReviewLineThreshold);
  if (!Number.isInteger(largeReviewLineThreshold) || largeReviewLineThreshold < 1) {
    throw new RevisorError("Large review line threshold must be a positive integer.");
  }
  const multiDomainReviewThreshold = settings.multiDomainReviewThreshold === undefined
    ? current.multiDomainReviewThreshold
    : Number(settings.multiDomainReviewThreshold);
  if (!Number.isInteger(multiDomainReviewThreshold) || multiDomainReviewThreshold < 1) {
    throw new RevisorError("Multi-domain review threshold must be a positive integer.");
  }
  const autoMergeRiskThreshold = settings.autoMergeRiskThreshold === undefined
    ? current.autoMergeRiskThreshold
    : Number(settings.autoMergeRiskThreshold);
  if (
    !Number.isInteger(autoMergeRiskThreshold)
    || autoMergeRiskThreshold < 0
    || autoMergeRiskThreshold > 100
  ) {
    throw new RevisorError("Auto-merge risk threshold must be an integer from 0 to 100.");
  }
  const planAdvisor = settings.planAdvisor === undefined
    ? current.planAdvisor
    : settings.planAdvisor;
  if (!PLAN_ADVISOR_VALUES.has(planAdvisor)) {
    throw new RevisorError("Plan advisor must be none, augur, or reviewer.");
  }
  const augurFolder = settings.augurFolder === undefined
    ? current.augurFolder
    : resolveToolFolder(String(settings.augurFolder).trim(), env);
  if (planAdvisor === "augur" && !augurFolder) {
    throw new RevisorError("Augur folder is required when Augur plans the review.");
  }
  const securityFailOnSeverity = settings.securityFailOnSeverity
    ?? defaults().securityFailOnSeverity;
  if (!SECURITY_SEVERITIES.has(securityFailOnSeverity)) {
    throw new RevisorError(
      "Security severity must be one of: critical, high, medium, low.",
    );
  }
  const securityMaxCostUsd = settings.securityMaxCostUsd === undefined
    ? defaults().securityMaxCostUsd
    : Number(settings.securityMaxCostUsd);
  if (!Number.isFinite(securityMaxCostUsd) || securityMaxCostUsd <= 0) {
    throw new RevisorError("Security scan max cost must be a positive USD amount.");
  }
  // effort は CLI にそのまま渡るので、 不正値を保存させない (未知の値でスキャン自体が
  // 落ちると「未完了」= マージ不可になり、 原因が設定であることも見えなくなる)。
  const securityScanEffort = settings.securityScanEffort === undefined
    ? current.securityScanEffort
    : settings.securityScanEffort;
  if (!SECURITY_EFFORTS.has(securityScanEffort)) {
    throw new RevisorError(
      "Security scan effort must be one of: minimal, low, medium, high, xhigh.",
    );
  }
  // Only a string is a model name. Coercing first would turn `null` into the
  // literal "null", which passes the format check and then reaches the CLI as
  // `--model null`: every scan dies on an unknown model, normalizes to
  // `error` = 「未完了」 = マージ不可、 and the exit code is all that is reported,
  // so nothing points back at the setting. `readSettings` already refuses
  // non-strings on the read side.
  const modelInput = settings.securityScanModel;
  const securityScanModel = modelInput === undefined
    ? current.securityScanModel
    : (typeof modelInput === "string" ? modelInput.trim() : modelInput);
  if (typeof securityScanModel !== "string" || !isSecurityModel(securityScanModel)) {
    throw new RevisorError(
      "Security scan model must be a bare model name (letters, digits, dot, dash, underscore).",
    );
  }
  // 相対パスを受け付けない。使い捨て作業領域は審査中の worktree を cwd にして
  // 作られるので、相対だと同じ設定が実行のたびに別の場所を指す。
  const scratchInput = settings.reviewScratchRoot;
  const reviewScratchRoot = scratchInput === undefined
    ? current.reviewScratchRoot
    : (typeof scratchInput === "string" ? scratchInput.trim() : scratchInput);
  if (typeof reviewScratchRoot !== "string"
    || (reviewScratchRoot !== "" && !isAbsolute(reviewScratchRoot))) {
    throw new RevisorError(
      "Review scratch root must be an absolute path, or empty to use the OS temporary directory.",
    );
  }
  const anatomiaDualLayerGateMode = settings.anatomiaDualLayerGateMode === undefined
    ? current.anatomiaDualLayerGateMode
    : settings.anatomiaDualLayerGateMode;
  if (!DUAL_LAYER_GATE_MODES.has(anatomiaDualLayerGateMode)) {
    throw new RevisorError(
      "Anatomia dual-layer gate mode must be one of: advisory, enforced.",
    );
  }
  const config = readConfig(env);
  config.settings = {
    anatomiaFolder,
    reviewScratchRoot,
    anatomiaReviewGateEnabled: settings.anatomiaReviewGateEnabled === undefined
      ? current.anatomiaReviewGateEnabled
      : settings.anatomiaReviewGateEnabled !== false,
    anatomiaDualLayerGateMode,
    fallbackReviewer: settings.fallbackReviewer,
    oppositeModelReviewEnabled: settings.oppositeModelReviewEnabled === undefined
      ? current.oppositeModelReviewEnabled
      : settings.oppositeModelReviewEnabled === true,
    forcedReviewModel,
    concordiaContextEnabled: settings.concordiaContextEnabled !== false,
    workerCount,
    fastLaneSlots,
    largeReviewLineThreshold,
    multiDomainReviewThreshold,
    costValidationModeEnabled: costValidationSkipReview
      || costValidationSkipGenius
      || costValidationSkipAnatomiaDomain,
    costValidationSkipReview,
    costValidationSkipGenius,
    costValidationSkipAnatomiaDomain,
    autoMergeEnabled: settings.autoMergeEnabled === undefined
      ? current.autoMergeEnabled
      : settings.autoMergeEnabled === true,
    autoMergeRiskThreshold,
    autoMergeRequiresRuntimeVerificationClear:
      settings.autoMergeRequiresRuntimeVerificationClear === undefined
        ? current.autoMergeRequiresRuntimeVerificationClear
        : settings.autoMergeRequiresRuntimeVerificationClear !== false,
    planAdvisor,
    augurFolder,
    securityScanEnabled: settings.securityScanEnabled !== false,
    securityFailOnSeverity,
    securityMaxCostUsd,
    securityScanEffort,
    securityScanModel,
  };
  writeConfig(config, env);
  return readSettings(env);
}

export function readWorkflowToken(env = process.env) {
  const configPath = resolveConfigPath(env);
  const secrets = readConfig(env).secrets;
  const blob = secrets.workflowToken ?? secrets.originToken;
  if (!isEncryptedBlob(blob)) {
    throw new RevisorError("Local workflow token is not configured.");
  }
  try {
    const value = decryptString(blob, readMasterKey(configPath, env)).trim();
    if (!value) throw new Error("empty token");
    return value;
  } catch (error) {
    throw new RevisorError("Local workflow token could not be decrypted.", {
      cause: error,
    });
  }
}

export function writeWorkflowToken(token, env = process.env) {
  const value = String(token ?? "").trim();
  if (!value) throw new RevisorError("Local workflow token must not be empty.");
  const configPath = resolveConfigPath(env);
  const config = readConfig(env);
  config.secrets.workflowToken = encryptString(
    value,
    readOrCreateMasterKey(configPath, env),
  );
  writeConfig(config, env);
}

export function hasWorkflowToken(env = process.env) {
  try {
    readWorkflowToken(env);
    return true;
  } catch {
    return false;
  }
}

export function writeDiscordWebhookUrl(url, env = process.env) {
  const value = String(url ?? "").trim();
  if (!isDiscordWebhookUrl(value)) {
    throw new RevisorError(
      "Discord webhook URL must be a https://discord.com/api/webhooks/... URL.",
    );
  }
  const configPath = resolveConfigPath(env);
  const config = readConfig(env);
  config.secrets.discordWebhookUrl = encryptString(
    value,
    readOrCreateMasterKey(configPath, env),
  );
  writeConfig(config, env);
}

export function removeDiscordWebhookUrl(env = process.env) {
  const config = readConfig(env);
  delete config.secrets.discordWebhookUrl;
  writeConfig(config, env);
}

export function optionalDiscordWebhookUrl(env = process.env) {
  const configPath = resolveConfigPath(env);
  const blob = readConfig(env).secrets.discordWebhookUrl;
  if (blob === undefined) return null;
  try {
    const value = decryptString(blob, readMasterKey(configPath, env)).trim();
    if (!isDiscordWebhookUrl(value)) throw new Error("invalid webhook URL");
    return value;
  } catch (error) {
    throw new RevisorError("Discord webhook URL could not be decrypted.", { cause: error });
  }
}

export function hasDiscordWebhookUrl(env = process.env) {
  return optionalDiscordWebhookUrl(env) !== null;
}

export function readGitHubAppCredentials(env = process.env) {
  const configPath = resolveConfigPath(env);
  const config = readConfig(env);
  const blob = config.secrets.githubAppCredentials;
  const legacyBlob = config.secrets.githubAppPrivateKey;
  if (!isEncryptedBlob(blob) && !isEncryptedBlob(legacyBlob)) {
    throw new RevisorError("GitHub App credentials are not configured.");
  }
  try {
    const masterKey = readMasterKey(configPath, env);
    const value = isEncryptedBlob(blob)
      ? JSON.parse(decryptString(blob, masterKey))
      : {
          appId: config.settings.githubAppId,
          privateKey: decryptString(legacyBlob, masterKey),
        };
    const appId = String(value?.appId ?? "").trim();
    const privateKey = String(value?.privateKey ?? "").trim();
    if (!/^\d+$/.test(appId) || Number(appId) < 1) throw new Error("invalid App id");
    if (!GITHUB_APP_PRIVATE_KEY_PATTERN.test(privateKey)) {
      throw new Error("invalid PEM private key");
    }
    return { appId, privateKey };
  } catch (error) {
    throw new RevisorError("GitHub App credentials could not be decrypted.", {
      cause: error,
    });
  }
}

export function writeGitHubAppCredentials(credentials, env = process.env) {
  const appId = String(credentials?.appId ?? "").trim();
  const privateKey = String(credentials?.privateKey ?? "").trim();
  if (!/^\d+$/.test(appId) || Number(appId) < 1) {
    throw new RevisorError("GitHub App id must be a positive integer.");
  }
  if (!GITHUB_APP_PRIVATE_KEY_PATTERN.test(privateKey)) {
    throw new RevisorError("GitHub App private key must be a PEM private key.");
  }
  const configPath = resolveConfigPath(env);
  const config = readConfig(env);
  config.secrets.githubAppCredentials = encryptString(
    JSON.stringify({ appId, privateKey }),
    readOrCreateMasterKey(configPath, env),
  );
  delete config.secrets.githubAppPrivateKey;
  delete config.settings.githubAppId;
  writeConfig(config, env);
  return { appId };
}

export function removeGitHubAppCredentials(env = process.env) {
  const config = readConfig(env);
  delete config.secrets.githubAppCredentials;
  delete config.secrets.githubAppPrivateKey;
  delete config.settings.githubAppId;
  writeConfig(config, env);
}

export function hasGitHubAppCredentials(env = process.env) {
  try {
    readGitHubAppCredentials(env);
    return true;
  } catch {
    return false;
  }
}

export function readAllowedHosts(env = process.env) {
  const configPath = resolveConfigPath(env);
  const blob = readConfig(env).secrets.allowedHosts;
  if (blob === undefined) return [];
  if (!isEncryptedBlob(blob)) {
    throw new RevisorError("Allowed hosts config is not encrypted.");
  }
  try {
    const value = JSON.parse(decryptString(blob, readMasterKey(configPath, env)));
    return normalizeAllowedHosts(value);
  } catch (error) {
    throw new RevisorError("Allowed hosts config could not be decrypted.", {
      cause: error,
    });
  }
}

export function writeAllowedHosts(hosts, env = process.env) {
  let normalized;
  try {
    normalized = normalizeAllowedHosts(hosts);
  } catch (error) {
    throw new RevisorError(
      error instanceof Error ? error.message : "Allowed hosts are invalid.",
      { cause: error },
    );
  }
  const configPath = resolveConfigPath(env);
  const config = readConfig(env);
  if (normalized.length === 0) {
    delete config.secrets.allowedHosts;
  } else {
    config.secrets.allowedHosts = encryptString(
      JSON.stringify(normalized),
      readOrCreateMasterKey(configPath, env),
    );
  }
  writeConfig(config, env);
  return readAllowedHosts(env);
}
