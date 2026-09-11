import { getMeta, setMeta } from "./revisor-db.mjs";

// PR 記録の `anatomia` (Anatomia 差分解析の成果) は `pull_request_anatomia` に置き、
// `pull_requests.record` には入れない。 解析結果にはリポ全関数の複雑度が現在とベースラインの
// 2 本入り、 1 件で数 MB になる。 本体に入れたままだと、 一覧の SELECT と JSON.parse が
// 毎回 DB 全体 (150MB 超) を読み、 Concordia へ 140MB の一覧を返していた。 一覧には
// 要らないので本体から外し、 単一 PR の取得でだけ付け戻す。

const SPLIT_MIGRATED_KEY = "anatomia_split";
// `"anatomiaGate":` を拾わないよう、 キー名を引用符とコロンまで含めて探す。
const INLINE_ANATOMIA_MARKER = "\"anatomia\":";

/**
 * 本体 record から `anatomia` を外す。 `inline` はキーが本体に在ったか。
 *
 * 移行後も、 旧コードのまま動いている審査ワーカーは本体へ `anatomia` を書く。
 * 本体に在る値はそのプロセスの最新の書き込みなので、 別テーブルより優先する。
 */
export function detachAnatomia(record) {
  if (!Object.hasOwn(record, "anatomia")) {
    return { light: record, anatomia: undefined, inline: false };
  }
  const { anatomia, ...light } = record;
  return { light, anatomia, inline: true };
}

/** 別テーブルの解析結果。 行が無ければ undefined (記録にキーが無かった状態)。 */
export function readAnatomia(database, id) {
  const row = database.prepare("SELECT record FROM pull_request_anatomia WHERE id = ?").get(id);
  return row ? JSON.parse(row.record) : undefined;
}

/**
 * 解析結果を書く。 null は「解析を捨てた」 (再審査の初期化) という値なので行として残し、
 * キーごと無い (undefined) ときだけ行を消す。 往復で記録の形を変えないため。
 */
export function writeAnatomia(database, id, anatomia) {
  if (anatomia === undefined) {
    database.prepare("DELETE FROM pull_request_anatomia WHERE id = ?").run(id);
    return;
  }
  database
    .prepare("INSERT OR REPLACE INTO pull_request_anatomia (id, record) VALUES (?, ?)")
    .run(id, JSON.stringify(anatomia));
}

/** 本体に解析結果を持つ旧形式の記録を残しているか。 移行済みの database は読むだけで済ませる。 */
export function needsAnatomiaSplit(database) {
  return !getMeta(database, SPLIT_MIGRATED_KEY);
}

/**
 * 本体に入っている解析結果を別テーブルへ移す。 一度だけ行い、 済んだことは database 自身が
 * 記憶する。 呼び出し側の書き込みトランザクションの中で呼ぶこと。
 *
 * @returns 移した記録の数
 */
export function splitInlineAnatomia(database) {
  if (!needsAnatomiaSplit(database)) return 0;
  const ids = database
    .prepare("SELECT id FROM pull_requests WHERE instr(record, ?) > 0")
    .all(INLINE_ANATOMIA_MARKER);
  const select = database.prepare("SELECT record FROM pull_requests WHERE id = ?");
  const saveLight = database.prepare("UPDATE pull_requests SET record = ? WHERE id = ?");
  let moved = 0;
  for (const { id } of ids) {
    const { light, anatomia, inline } = detachAnatomia(JSON.parse(select.get(id).record));
    // 入れ子の値に同じキー名が在っただけの記録は、 本体に何も持っていない。
    if (!inline) continue;
    writeAnatomia(database, id, anatomia);
    saveLight.run(JSON.stringify(light), id);
    moved += 1;
  }
  setMeta(database, SPLIT_MIGRATED_KEY, "1");
  return moved;
}
