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

const SECURITY_SEVERITIES = new Set(["critical", "high", "medium", "low"]);

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
