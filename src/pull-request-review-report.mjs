import { getMeta, setMeta } from "./revisor-db.mjs";

// PR 記録の `reviewReport` (審査レポート本文) は `pull_request_review_reports` に置き、
// `pull_requests.record` には入れない。 レポートは登録チェック単位の出力を持ち、 全件で
// PR 記録の 9 割超 (2026-10-02 実測 277 MB / 290 MB) を占める。 本体に入れたままだと、
// 一覧・リポジトリ一覧・Test Workflow・自動マージのスイープが毎回 DB 全体を JSON.parse し、
// 1 回 4 秒前後イベントループを止めていた。 一覧には版だけを残し、 本文は単一 PR の取得で
// 付け戻す。 `pull-request-anatomia.mjs` と同じ形。

const SPLIT_MIGRATED_KEY = "review_report_split";
// `"reviewReportVersion":` を拾わないよう、 キー名を引用符とコロンまで含めて探す。
const INLINE_REVIEW_REPORT_MARKER = "\"reviewReport\":";

/** 一覧用の記録が持つ版。 本文を読まずに板の「詳細あり」と差分検知に使う。 */
export const REVIEW_REPORT_VERSION_KEY = "reviewReportVersion";

/**
 * 本体 record から `reviewReport` を外し、 版だけを `reviewReportVersion` に残す。
 * `inline` はキーが本体に在ったか。
 *
 * 移行後も、 旧コードのまま動いている審査ワーカーは本体へ `reviewReport` を書く。
 * 本体に在る値はそのプロセスの最新の書き込みなので、 別テーブルより優先する。
 */
export function detachReviewReport(record) {
  if (!Object.hasOwn(record, "reviewReport")) {
    return { light: record, reviewReport: undefined, inline: false };
  }
  const { reviewReport, ...rest } = record;
  return {
    light: { ...rest, [REVIEW_REPORT_VERSION_KEY]: reviewReport?.version ?? null },
    reviewReport,
    inline: true,
  };
}

/**
 * 単一 PR の完全な記録へ戻す。 版は一覧用の写しなので外し、 本文を付ける。
 * どちらにも本文が無ければ (未審査) キーを作らない。
 */
export function attachReviewReport(light, reviewReport) {
  const { [REVIEW_REPORT_VERSION_KEY]: _version, ...rest } = light;
  return reviewReport === undefined ? rest : { ...rest, reviewReport };
}

/** 別テーブルの本文。 行が無ければ undefined (記録にキーが無かった状態)。 */
export function readReviewReport(database, id) {
  const row = database
    .prepare("SELECT record FROM pull_request_review_reports WHERE id = ?")
    .get(id);
  return row ? JSON.parse(row.record) : undefined;
}

/** 複数 PR の本文をまとめて読む (一覧の `include=reviewReport` 用)。 */
export function readReviewReports(database, ids) {
  const select = database.prepare("SELECT record FROM pull_request_review_reports WHERE id = ?");
  const reports = new Map();
  for (const id of ids) {
    const row = select.get(id);
    if (row) reports.set(id, JSON.parse(row.record));
  }
  return reports;
}

/**
 * 本文を書く。 null は「本文を捨てた」 (再審査の初期化) という値なので行として残し、
 * キーごと無い (undefined) ときだけ行を消す。 往復で記録の形を変えないため。
 */
export function writeReviewReport(database, id, reviewReport) {
  if (reviewReport === undefined) {
    database.prepare("DELETE FROM pull_request_review_reports WHERE id = ?").run(id);
    return;
  }
  database
    .prepare("INSERT OR REPLACE INTO pull_request_review_reports (id, record) VALUES (?, ?)")
    .run(id, JSON.stringify(reviewReport));
}

/** 本体に本文を持つ旧形式の記録を残しているか。 移行済みの database は読むだけで済ませる。 */
export function needsReviewReportSplit(database) {
  return !getMeta(database, SPLIT_MIGRATED_KEY);
}

/** 1 トランザクションで移す記録の数。 実データで全件 (2,356 件・約 290 MB) が 35 秒かかった。 */
export const REVIEW_REPORT_SPLIT_BATCH = 50;

/**
 * 本体に入っている本文を、 id 順に `afterId` の次から最大 `limit` 件だけ別テーブルへ移す。
 * 呼び出し側の書き込みトランザクションの中で呼ぶこと。
 *
 * 全件を 1 トランザクションで移すと書き込みロックを数十秒握り、 併走する審査ワーカーや
 * CLI が busy_timeout (60 秒) を使い切りかねない。 小分けにして間で他プロセスを通す。
 * 対象が尽きたら移行済みを database 自身に記憶させ、 `done: true` を返す。
 *
 * @returns {{ moved: number, lastId: string | null, done: boolean }}
 */
export function splitInlineReviewReportBatch(database, {
  afterId = "",
  limit = REVIEW_REPORT_SPLIT_BATCH,
} = {}) {
  if (!needsReviewReportSplit(database)) return { moved: 0, lastId: null, done: true };
  const ids = database
    .prepare("SELECT id FROM pull_requests WHERE id > ? AND instr(record, ?) > 0 ORDER BY id LIMIT ?")
    .all(afterId, INLINE_REVIEW_REPORT_MARKER, limit);
  if (ids.length === 0) {
    setMeta(database, SPLIT_MIGRATED_KEY, "1");
    return { moved: 0, lastId: null, done: true };
  }
  const select = database.prepare("SELECT record FROM pull_requests WHERE id = ?");
  const saveLight = database.prepare("UPDATE pull_requests SET record = ? WHERE id = ?");
  let moved = 0;
  for (const { id } of ids) {
    const { light, reviewReport, inline } = detachReviewReport(JSON.parse(select.get(id).record));
    // 入れ子の値に同じキー名が在っただけの記録は、 本体に何も持っていない。 id 順の
    // カーソルで進むので、 こうした記録で同じバッチを繰り返すことはない。
    if (!inline) continue;
    writeReviewReport(database, id, reviewReport);
    saveLight.run(JSON.stringify(light), id);
    moved += 1;
  }
  return { moved, lastId: ids.at(-1).id, done: false };
}

/**
 * 本体に入っている本文を全件別テーブルへ移す。 `runBatch` は 1 バッチを書き込み
 * トランザクションで包んで実行する関数 (呼び出し側が持つ)。
 *
 * @returns 移した記録の数
 */
export function splitInlineReviewReports(database, runBatch = (batch) => batch()) {
  let afterId = "";
  let moved = 0;
  for (;;) {
    const result = runBatch(() => splitInlineReviewReportBatch(database, { afterId }));
    moved += result.moved;
    if (result.done) return moved;
    afterId = result.lastId;
  }
}
