import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { redactSecretLines } from "./leakage.mjs";

const SERVICE = "revisor";
const MAX_VALUE_LENGTH = 4_000;
const MAX_COLLECTION_ENTRIES = 100;
const MAX_NESTING_DEPTH = 8;
const MAX_RECORD_BYTES = 64 * 1_024;
const RESERVED_FIELDS = new Set(["timestamp", "level", "event", "service", "pid"]);

// Revisor の記録はこれまで stderr にしか出ておらず、 監督者のリングから溢れると
// 何も残らなかった。 出力先を 1 箇所に集め、 stderr と Vestigium の日次ファイルの
// 両方へ同じ 1 行を書く。 書式は既存の merge failure ログに合わせる。

export function resolveLogDirectory(env = process.env) {
  const root = env.REVISOR_LOG_DIR || env.VESTIGIUM_LOGS_DIR;
  return root ? join(root, SERVICE) : null;
}

// 認証つき git 操作は header や credential URL を設定に載せる。 git がそれを含む
// 文字列をエラーに出す経路があるため、共有の redactor が見ない形をここで潰す。
const SENSITIVE_HEADER =
  /\b((?:Authorization|Proxy-Authorization|Cookie|Set-Cookie|X-Api-Key)\s*:\s*)[^\r\n]+/gi;
const CREDENTIAL_URL = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;
const SENSITIVE_FIELD_NAMES = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "secret",
  "clientsecret",
  "password",
  "passwd",
  "privatekey",
  "credential",
  "credentials",
]);

// 自由文 (git の stderr、 例外の stack) がそのまま乗る場所なので、 秘密の除去と
// 長さの上限は書き手ではなくここで担保する。
function safeString(value) {
  const redacted = redactSecretLines(value)
    .replace(SENSITIVE_HEADER, "$1[redacted]")
    .replace(CREDENTIAL_URL, "$1[redacted]@");
  return redacted.length <= MAX_VALUE_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_VALUE_LENGTH)}[truncated ${redacted.length - MAX_VALUE_LENGTH} chars]`;
}

function isSensitiveField(key) {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return SENSITIVE_FIELD_NAMES.has(normalized)
    || ["token", "secret", "password", "privatekey", "apikey"]
      .some((suffix) => normalized.endsWith(suffix));
}

function safeValue(value, seen = new WeakSet(), depth = 0) {
  if (typeof value === "string") return safeString(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return "[unsupported]";
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_NESTING_DEPTH) return "[truncated depth]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const result = value
        .slice(0, MAX_COLLECTION_ENTRIES)
        .map((entry) => safeValue(entry, seen, depth + 1));
      if (value.length > MAX_COLLECTION_ENTRIES) {
        result.push(`[truncated ${value.length - MAX_COLLECTION_ENTRIES} entries]`);
      }
      return result;
    }
    const result = Object.create(null);
    const keys = Object.keys(value);
    for (const key of keys.slice(0, MAX_COLLECTION_ENTRIES)) {
      const entry = value[key];
      result[key] = isSensitiveField(key)
        ? "[redacted]"
        : safeValue(entry, seen, depth + 1);
    }
    if (keys.length > MAX_COLLECTION_ENTRIES) {
      result.truncatedEntries = keys.length - MAX_COLLECTION_ENTRIES;
    }
    return result;
  } finally {
    // Track the active recursion path, not every previously visited object: a
    // shared object in two fields is not a cycle and should remain observable.
    seen.delete(value);
  }
}

export function buildRecord(event, detail, { level, timestamp, pid }) {
  const record = Object.assign(Object.create(null), {
    timestamp,
    level,
    event,
    service: SERVICE,
    pid,
  });
  const detailKeys = Object.keys(detail ?? {});
  for (const key of detailKeys.slice(0, MAX_COLLECTION_ENTRIES)) {
    if (RESERVED_FIELDS.has(key)) continue;
    const value = detail[key];
    record[key] = isSensitiveField(key) ? "[redacted]" : safeValue(value);
  }
  if (detailKeys.length > MAX_COLLECTION_ENTRIES) {
    record.truncatedDetailEntries = detailKeys.length - MAX_COLLECTION_ENTRIES;
  }
  return record;
}

export function createServiceLog({
  env = process.env,
  clock = Date.now,
  append = appendFileSync,
  makeDirectory = mkdirSync,
  stream = process.stderr,
} = {}) {
  const directory = resolveLogDirectory(env);
  let prepared = false;
  return function log(event, detail = {}, { level = "info" } = {}) {
    let timestamp;
    let record;
    let line;
    try {
      timestamp = new Date(clock()).toISOString();
      record = buildRecord(event, detail, { level, timestamp, pid: process.pid });
      let serialized = JSON.stringify(record);
      const recordBytes = Buffer.byteLength(serialized, "utf8");
      if (recordBytes > MAX_RECORD_BYTES) {
        record = Object.assign(Object.create(null), {
          timestamp,
          level,
          event,
          service: SERVICE,
          pid: process.pid,
          truncatedRecordBytes: recordBytes,
        });
        serialized = JSON.stringify(record);
      }
      line = `${serialized}\n`;
    } catch {
      // A hostile getter, excessive nesting, or invalid injected clock must not
      // let diagnostics interrupt merge, worker, or shutdown behavior.
      return null;
    }
    try {
      stream.write(line);
    } catch {
      // stderr is best-effort too (for example, a supervisor may close its pipe first).
    }
    if (!directory) return record;
    try {
      if (!prepared) {
        makeDirectory(directory, { recursive: true, mode: 0o700 });
        prepared = true;
      }
      append(join(directory, `${timestamp.slice(0, 10)}.jsonl`), line, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch {
      // 記録の失敗でサービスを止めない。 stderr 側は既に出ている。
    }
    return record;
  };
}

export const serviceLog = createServiceLog();
