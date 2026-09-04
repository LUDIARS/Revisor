import { assertSafeRef, assertSafeSha, git } from "./workspace.mjs";

/**
 * 登録 checkout の base が `origin/<base>` とどれだけ離れているかを見る。
 *
 * 審査は **base の内容で判定する**。 登録 checkout が古いと、 その後 origin に入った
 * 宣言や設定 (spec/domains 等) が一切効かず、 PR が `action_required` で止まる。
 * しかも**止まってから初めて分かる** — 理由も「ドメインが無い」等の別の顔で出るので、
 * 乖離が原因だと辿り着くまでに時間がかかる。
 *
 * ここは **fetch しない**。 追跡 ref (`refs/remotes/origin/<base>`) を読むだけの
 * 読み取り専用の照会で、 ネットワークにも共有状態にも触らない。 そのぶん
 * 「最後に fetch した時点」より先の GitHub 側は見えない。
 */

/** ローカルとリモートの関係。 直し方が違うので区別する。 */
export const DIVERGENCE_STATES = /** @type {const} */ ([
  "in_sync",
  "ahead",
  "behind",
  "diverged",
  "no_remote_ref",
  "unknown",
]);

const STATE_TEXT = {
  in_sync: "一致",
  ahead: "ローカルが先行 (publish 待ち — Revisor の通常形)",
  behind: "リモートが先行 (fast-forward で追いつける)",
  diverged: "双方向に乖離 (fast-forward 不可 — 取り込み方の判断が要る)",
  no_remote_ref: "追跡 ref が無い",
  unknown: "判定できなかった",
};

export function describeDivergence(state) {
  return STATE_TEXT[state] ?? STATE_TEXT.unknown;
}

function result(state, { ahead = 0, behind = 0, changedFiles = null } = {}) {
  return { state, ahead, behind, changedFiles, detail: describeDivergence(state) };
}

async function remoteRefExists(rootPath, remoteRef, run) {
  try {
    await run(rootPath, ["show-ref", "--verify", "--quiet", remoteRef]);
    return true;
  } catch (error) {
    // show-ref の status 1 だけが「該当 ref なし」。起動不能や壊れた repository まで
    // ref 不在として正常扱いすると、診断対象そのものを一覧から隠してしまう。
    if (error?.exitCode === 1) return false;
    throw error;
  }
}

function commitCount(output) {
  const count = Number(String(output).trim());
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("git rev-list returned an invalid commit count");
  }
  return count;
}

async function changedFileCount(rootPath, localRef, remoteRef, run) {
  try {
    // -z ならファイル名に改行があっても 1 path を 1 件として数えられる。
    const names = await run(rootPath, ["diff", "--name-only", "-z", `${remoteRef}..${localRef}`]);
    return names.split("\0").filter(Boolean).length;
  } catch {
    // 内容差は付加情報。取得できなくても commit graph による状態は返す。
    return null;
  }
}

/**
 * @param {object} input
 * @param {string} input.rootPath 登録 checkout
 * @param {string} input.baseRef base branch 名
 * @returns {Promise<{state: string, ahead: number, behind: number, changedFiles: number|null, detail: string}>}
 */
export async function inspectBaseDivergence({ rootPath, baseRef, run = git }) {
  const localRef = `refs/heads/${baseRef}`;
  const remoteRef = `refs/remotes/origin/${baseRef}`;
  try {
    assertSafeRef(baseRef, "base_ref");
    if (!await remoteRefExists(rootPath, remoteRef, run)) {
      return result("no_remote_ref");
    }
    const local = (await run(rootPath, ["rev-parse", "--verify", localRef])).trim();
    const remote = (await run(rootPath, ["rev-parse", "--verify", remoteRef])).trim();
    assertSafeSha(local, "local base sha");
    assertSafeSha(remote, "remote base sha");
    if (local.toLowerCase() === remote.toLowerCase()) {
      return result("in_sync");
    }
    const ahead = commitCount(await run(rootPath, ["rev-list", "--count", `${remoteRef}..${localRef}`]));
    const behind = commitCount(await run(rootPath, ["rev-list", "--count", `${localRef}..${remoteRef}`]));
    if (ahead === 0 && behind === 0) {
      throw new Error("different refs produced no divergent commits");
    }
    const state = ahead > 0 && behind > 0 ? "diverged" : ahead > 0 ? "ahead" : "behind";
    // 「先行しているが内容は同じ」を見分ける。 登録時の .revisor-version コミットだけなら
    // 実体は一致していて、 直す必要が無い。
    const changedFiles = await changedFileCount(rootPath, localRef, remoteRef, run);
    return result(state, { ahead, behind, changedFiles });
  } catch {
    // git の stderr には資格情報、private endpoint、絶対 path が入りうる。CLI/JSON に
    // 生の例外を載せず、状態だけを公開する。
    return result("unknown");
  }
}

/** 審査に影響する状態か (base が古いまま判定される)。 */
export function blocksReview(state) {
  return state === "behind" || state === "diverged";
}

/** 修正が必要、または判定不能で人の確認が必要な状態か。 */
export function needsAttention(state) {
  return blocksReview(state) || state === "unknown";
}
