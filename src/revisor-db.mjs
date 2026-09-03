import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveConfigPath } from "./config.mjs";

// PR 記録と審査キューの正本を 1 つの SQLite database に置く。
// JSON ファイル + rename だった頃は、外部の読み手が state を開いているだけで
// atomic rename が EPERM になり、無関係な PR の審査が巻き添えで落ちた。
// SQLite (WAL) は読み手が書き手を壊せないので、この事故そのものが起きない。

const DB_PATH_ENV = "REVISOR_DB_PATH";

// SQLite file header (magic string) の先頭 15 バイト。 16 バイト目は NUL なので文字列
// 比較には含めない。 旧 JSON state と DB を同じパスで受けたとき、中身で区別する。
const SQLITE_MAGIC = "SQLite format 3";

function isSqliteFile(path) {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(SQLITE_MAGIC.length);
    const bytes = readSync(fd, header, 0, header.length, 0);
    return header.subarray(0, bytes).toString("latin1") === SQLITE_MAGIC;
  } finally {
    closeSync(fd);
  }
}

export function resolveDbPath(env = process.env) {
  return env[DB_PATH_ENV] ?? join(dirname(resolveConfigPath(env)), "revisor.db");
}

/**
 * `path` に旧 JSON ファイルが居るならパースして返し、ファイルを `.migrated` へ退避する。
 * SQLite file / 不在 / 空なら null。 パースできない内容は呼び出し側の「unreadable」契約へ
 * そのまま投げる — 退避は妥当な JSON を確認できたときだけ行い、壊れたファイルを
 * 黙って除けない。
 */
export function displaceLegacyJson(path) {
  if (!existsSync(path)) return null;
  if (isSqliteFile(path)) return null;
  const raw = readFileSync(path, "utf8");
  // 併走プロセスが DB を作った直後、 ファイルは存在するのにまだ SQLite ヘッダが
  // 書かれていない一瞬がある。 その瞬間に読むと SQLite file と判定できず、 空文字を
  // 「壊れた旧 JSON」とみなして state ごと unreadable にしていた (8 プロセス同時起動で
  // 再現。 原因は `Unexpected end of JSON input`)。 空ファイルには退避すべき中身が無く、
  // SQLite はそのまま新規 DB として開けるので、 移行対象なしとして扱う。
  if (raw.length === 0) return null;
  // 上の header 読み取り後に別プロセスが初期化を終えることがある。 同じファイルを
  // 読み直した結果も SQLite なら、 legacy JSON として parse してはいけない。
  if (raw.startsWith(SQLITE_MAGIC)) return null;
  const value = JSON.parse(raw);
  archiveLegacyJson(path);
  return value;
}

/**
 * 旧 JSON を既存の退避ファイルを上書きせずに移す。 COPYFILE_EXCL で退避名を予約してから
 * 元を消すので、POSIX の rename が既存の `.migrated` を置換することもない。
 */
export function archiveLegacyJson(path) {
  for (let suffix = 0; ; suffix += 1) {
    const archivePath = suffix === 0 ? `${path}.migrated` : `${path}.migrated.${suffix}`;
    try {
      copyFileSync(path, archivePath, constants.COPYFILE_EXCL);
      unlinkSync(path);
      return archivePath;
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      throw error;
    }
  }
}

/**
 * database を開き、スキーマを整えて返す。
 *
 * busy_timeout は旧 file lock の待ち上限 (60 秒) を引き継ぐ。 journal_mode より先に
 * 設定しないと、併走プロセスが居るときの WAL 切り替えが即座に SQLITE_BUSY で落ちる。
 */
export function openRevisorDatabase(path) {
  mkdirSync(dirname(path), { recursive: true });
  // Permission repair must not run for an existing database. On Windows, the
  // service can keep the DB/WAL open while another CLI process connects; a
  // concurrent chmod then fails with EPERM before SQLite can use its WAL
  // concurrency controls.
  const isNewDatabase = !existsSync(path);
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA busy_timeout = 60000");
    enableWalMode(database);
    database.exec("PRAGMA synchronous = NORMAL");
    database.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS repositories (id TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pull_requests (id TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, record TEXT NOT NULL);
    `);
    if (isNewDatabase) secureDatabaseFiles(path);
    return database;
  } catch (error) {
    try {
      database.close();
    } catch {
      // 初期化エラーを優先する。 close は失敗した初期化の best-effort cleanup。
    }
    throw error;
  }
}

/**
 * WAL への切り替えを、 併走プロセスが居ても短い上限内で再試行する。
 *
 * journal_mode の変更は一瞬だけ排他アクセスを要求し、 そこは busy_timeout の
 * busy handler を通らないので、 別プロセスが同じ DB を開いているだけで
 * `database is locked` が即座に返る。 DB が未作成の瞬間に複数プロセスが同時に開くと
 * 踏む (実測: 8 プロセス × 8 回で 64 回中 9 回)。 一度 WAL になれば以後は no-op なので、
 * 詰まるのは初回だけ。 排他窓はミリ秒なので短い待ちを繰り返せば足りる。
 */
const WAL_SWITCH_ATTEMPTS = 50;
const WAL_SWITCH_DELAY_MS = 20;

function enableWalMode(database) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      database.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (error) {
      if (attempt >= WAL_SWITCH_ATTEMPTS || !isBusyError(error)) throw error;
      sleepSync(WAL_SWITCH_DELAY_MS);
    }
  }
}

function isBusyError(error) {
  return error?.errcode === 5
    || error?.code === "SQLITE_BUSY"
    || /database is locked|SQLITE_BUSY/i.test(String(error?.message ?? ""));
}

/** 同期パスなので Atomics で待つ (この関数の呼び出し元は同期 API)。 */
function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

// PR の本文・作業ツリーの絶対パス・診断は DB と WAL に入る。旧 JSON と同じく、
// 初回作成時だけ所有者のみが読めるモードへ明示的にそろえる。既存 DB の
// permission repair は、稼働中サービスとの並行アクセスを壊すため行わない。
function secureDatabaseFiles(path) {
  for (const filePath of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(filePath)) chmodSync(filePath, 0o600);
  }
}

/**
 * read-modify-write をプロセス間で直列化する。 BEGIN IMMEDIATE が旧 file lock の
 * 役割を担い、取れない間は busy_timeout の範囲で待つ。
 *
 * @implements SPEC-DAEMONLESS-PROCESS-LOCKS
 */
export function withImmediateTransaction(database, run) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // すでに rollback 済み (BEGIN 自体の失敗など)。 元のエラーを優先する。
    }
    throw error;
  }
}

/** 複数 SELECT を同じスナップショットで読む。 書かない読み手は書き手を待たせない。 */
export function withReadTransaction(database, run) {
  database.exec("BEGIN");
  try {
    return run();
  } finally {
    database.exec("COMMIT");
  }
}

export function getMeta(database, key) {
  const row = database.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : null;
}

export function setMeta(database, key, value) {
  database
    .prepare("INSERT INTO meta (key, value) VALUES (?, ?)"
      + " ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, String(value));
}

/** 採番カウンタを 1 つ進め、進める前の値を返す。 未初期化は 1 から始まる。 */
export function takeCounter(database, key) {
  const current = Number.parseInt(getMeta(database, key) ?? "1", 10);
  setMeta(database, key, current + 1);
  return current;
}
