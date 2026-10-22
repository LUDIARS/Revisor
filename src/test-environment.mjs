// 登録テスト (準備段・テスト・Augur 動作ブロック) に渡す環境変数。
//
// 審査は開発用のチェックアウトを組み立てて試すので、 本番向けの設定を引き継ぐと準備段が壊れる。
// ワーカーの環境に NODE_ENV=production (や npm の dev 省略) があると `npm install` / `npm ci` が
// devDependencies (typescript 等) を入れず、 後段の build が `tsc` 不在で落ちる。 ワーカーをどこから
// 起動したかで NODE_ENV の有無が変わるため、 同じ PR が通ったり落ちたりする。
//
// SRP: 環境の組み立てだけ。 元の env は変えずに写しを返す。

/** 外す npm の設定 (Windows の環境変数は大文字小文字を区別しないので小文字で比べる)。 */
const NPM_DEV_OMITTING_KEYS = new Set(["npm_config_production", "npm_config_only"]);

function omitsDev(key, value) {
  const name = key.toLowerCase();
  if (name === "node_env") return String(value).trim().toLowerCase() === "production";
  if (NPM_DEV_OMITTING_KEYS.has(name)) return true;
  if (name === "npm_config_omit") return String(value).split(/[\s,]+/).includes("dev");
  return false;
}

/** 登録テスト用の環境: 開発依存を省かせる設定だけを外した写し。 */
export function registeredTestEnvironment(env) {
  const out = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!omitsDev(key, value)) out[key] = value;
  }
  return out;
}
