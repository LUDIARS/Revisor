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

const LOCAL_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CONFIG_PATH_ENV = "REVISOR_CONFIG_PATH";
const KEY_PATH_ENV = "REVISOR_KEY_PATH";
const MASTER_KEY_ENV = "REVISOR_MASTER_KEY";

function defaults() {
  return {
    anatomiaFolder: "",
    fallbackReviewer: "codex-sol",
    concordiaContextEnabled: true,
    workerCount: 1,
  };
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
  const config = readConfig(env);
  config.settings = {
    anatomiaFolder,
    fallbackReviewer: settings.fallbackReviewer,
    concordiaContextEnabled: settings.concordiaContextEnabled !== false,
    workerCount,
  };
  writeConfig(config, env);
  return readSettings(env);
}

export function readOriginToken(env = process.env) {
  const configPath = resolveConfigPath(env);
  const blob = readConfig(env).secrets.originToken;
  if (!isEncryptedBlob(blob)) {
    throw new RevisorError("PR gate origin token is not configured.");
  }
  try {
    const value = decryptString(blob, readMasterKey(configPath, env)).trim();
    if (!value) throw new Error("empty token");
    return value;
  } catch (error) {
    throw new RevisorError("PR gate origin token could not be decrypted.", {
      cause: error,
    });
  }
}

export function writeOriginToken(token, env = process.env) {
  const value = String(token ?? "").trim();
  if (!value) throw new RevisorError("PR gate origin token must not be empty.");
  const configPath = resolveConfigPath(env);
  const config = readConfig(env);
  config.secrets.originToken = encryptString(
    value,
    readOrCreateMasterKey(configPath, env),
  );
  writeConfig(config, env);
}

export function hasOriginToken(env = process.env) {
  try {
    readOriginToken(env);
    return true;
  } catch {
    return false;
  }
}
