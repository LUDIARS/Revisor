import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { decryptString, encryptString, isEncryptedBlob } from "./crypto.mjs";
import { RevisorError } from "./errors.mjs";
import { normalizeAllowedHosts } from "./host-policy.mjs";

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

function defaults() {
  return {
    anatomiaFolder: "",
    fallbackReviewer: "codex-sol",
    concordiaContextEnabled: true,
    workerCount: 1,
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
  return {
    anatomiaFolder: typeof value.anatomiaFolder === "string"
      ? value.anatomiaFolder
      : base.anatomiaFolder,
    fallbackReviewer: value.fallbackReviewer === "claude-opus"
      ? "claude-opus"
      : base.fallbackReviewer,
    concordiaContextEnabled: value.concordiaContextEnabled !== false,
    workerCount: Number.isInteger(value.workerCount)
      && value.workerCount >= 1
      && value.workerCount <= 8
      ? value.workerCount
      : base.workerCount,
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
    augurFolder: typeof value.augurFolder === "string" ? value.augurFolder : base.augurFolder,
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
  const anatomiaFolder = typeof settings?.anatomiaFolder === "string"
    ? settings.anatomiaFolder.trim()
    : "";
  if (!anatomiaFolder) throw new RevisorError("Anatomia folder is required.");
  if (
    settings.fallbackReviewer !== "codex-sol"
    && settings.fallbackReviewer !== "claude-opus"
  ) {
    throw new RevisorError("Fallback reviewer is invalid.");
  }
  const workerCount = Number(settings.workerCount);
  if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > 8) {
    throw new RevisorError("Worker count must be an integer from 1 to 8.");
  }
  const current = readSettings(env);
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
    : String(settings.augurFolder).trim();
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
  const config = readConfig(env);
  config.settings = {
    anatomiaFolder,
    fallbackReviewer: settings.fallbackReviewer,
    concordiaContextEnabled: settings.concordiaContextEnabled !== false,
    workerCount,
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
