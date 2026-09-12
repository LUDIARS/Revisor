/**
 * Concordia のセッションは、起動した shell に git の hook 注入を入れる:
 *   GIT_CONFIG_COUNT=N, GIT_CONFIG_KEY_i=core.hooksPath,
 *   GIT_CONFIG_VALUE_i=%TEMP%\concordia-session-hooks\<id>, CONCORDIA_SESSION_HOOK_RUNNER=...
 * これは「セッション自身の git」を監視するためのもので、そこから起動される Revisor CLI
 * (repo register / pr submit / pr retry / run-worker …) と、CLI が派生させる git やワーカーには
 * 不要どころか害になる。導入処理が一時ディレクトリを「元 hook」として捕獲し (2026-09-12)、
 * ラッパーが壊れると Revisor 側の intake まで止まる。
 *
 * ここでは注入された core.hooksPath のスロットと CONCORDIA_SESSION_HOOK_* だけを外し、
 * 残りの GIT_CONFIG_* スロット (例: 認証 extraheader) は詰め直して保つ。
 */

const SESSION_HOOK_KEYS = ["CONCORDIA_SESSION_HOOK_RUNNER", "CONCORDIA_SESSION_HOOK_CONFIG_INDEX"];
const SESSION_HOOK_DIRECTORY = /concordia-session-hooks/i;

function isSessionHookSlot(key, value) {
  return String(key ?? "").trim().toLowerCase() === "core.hookspath"
    && SESSION_HOOK_DIRECTORY.test(String(value ?? ""));
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ env: Record<string, string | undefined>, stripped: boolean }}
 */
export function stripSessionHookInjection(env) {
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? "", 10);
  const hasSessionKeys = SESSION_HOOK_KEYS.some((key) => key in env);
  if (!Number.isInteger(count) || count < 0 || count > 1024) {
    if (!hasSessionKeys) return { env, stripped: false };
    const cleaned = { ...env };
    for (const key of SESSION_HOOK_KEYS) delete cleaned[key];
    return { env: cleaned, stripped: true };
  }
  const kept = [];
  let removed = 0;
  for (let slot = 0; slot < count; slot += 1) {
    const key = env[`GIT_CONFIG_KEY_${slot}`];
    const value = env[`GIT_CONFIG_VALUE_${slot}`];
    if (isSessionHookSlot(key, value)) removed += 1;
    else kept.push([key, value]);
  }
  if (removed === 0 && !hasSessionKeys) return { env, stripped: false };
  const cleaned = { ...env };
  for (let slot = 0; slot < count; slot += 1) {
    delete cleaned[`GIT_CONFIG_KEY_${slot}`];
    delete cleaned[`GIT_CONFIG_VALUE_${slot}`];
  }
  kept.forEach(([key, value], slot) => {
    if (key !== undefined) cleaned[`GIT_CONFIG_KEY_${slot}`] = key;
    if (value !== undefined) cleaned[`GIT_CONFIG_VALUE_${slot}`] = value;
  });
  if (kept.length > 0) cleaned.GIT_CONFIG_COUNT = String(kept.length);
  else delete cleaned.GIT_CONFIG_COUNT;
  for (const key of SESSION_HOOK_KEYS) delete cleaned[key];
  return { env: cleaned, stripped: true };
}

/**
 * process.env を所定の形に書き換える (CLI の入口で 1 回だけ呼ぶ)。
 * 削除は `delete` で行う。空文字を残すと git が「空の hooksPath」と解釈する。
 */
export function applySessionHookInjectionStrip(target = process.env) {
  const { env, stripped } = stripSessionHookInjection({ ...target });
  if (!stripped) return false;
  for (const key of Object.keys(target)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key) || SESSION_HOOK_KEYS.includes(key)) delete target[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key) && value !== undefined) target[key] = value;
  }
  return true;
}
