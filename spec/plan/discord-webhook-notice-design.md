# 審査 lifecycle 通知の Discord webhook 直送化 (feat/discord-webhook-notice)

## 背景

Revisor の審査 lifecycle 通知 (発行 / 審査通過 / 審査失敗 / 再審査 / マージ /
取り下げ / バイパスマージ) は、現在 Concordia の `報告` チャンネル
(`POST /v1/chat`) 経由で Discord へ配送されている。この経路には構造的な穴がある
(2026-08-13 調査、実データで確認済み):

- Cc の Discord egress (`discord/egress.ts` `handleChatPosted`) は配送前に
  `isChatRelayTarget` で **投稿セッションの Discord チャンネルが active** で
  あることを要求する。提出セッションが ended / lost だと、`報告` の
  forceMeta 分岐 (共有 #houkoku 行き) に到達する前にメッセージごと捨てられる。
- レビューは提出から完了まで数十分〜数時間かかるため「完了時点で提出
  セッションは終了済み」が常態。特に委託 (spawn) セッションは提出直後に
  終了するので、委託経由 PR の完了通知はほぼ確実に Discord に出ない。
- さらに現行 `notifyPullRequestLifecycle` は `sessionId` 必須のため、
  CLI 提出の PR はそもそも一度も通知されない。

**方針 (neco 指示 2026-08-13): 通知を Cc 経由から独立させ、Revisor 自身が
保持する Discord webhook で直接流す。** 提出セッションへの完了 inject
(`review-completion-notice` → Cc `/v1/sessions/:id/inject`) はセッション
宛の対話でありこの穴とは別物なので、現状のまま残す。

## 変更ファイル

### 1. 新規 `src/discord-webhook.mjs`

```js
import { RevisorError } from "./errors.mjs";

// Discord の message content 上限。超過分は切り、切ったことを末尾で示す。
const MAX_CONTENT_LENGTH = 2000;
const TRUNCATION_SUFFIX = "… (省略)";

// 送信先は Discord の webhook endpoint だけを許す。設定が汚染されても審査
// タイトル等が任意ホストへ出ない。
const WEBHOOK_URL_PATTERN =
  /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/;

export function isDiscordWebhookUrl(value) {
  return WEBHOOK_URL_PATTERN.test(String(value ?? "").trim());
}

export function truncateContent(text, max = MAX_CONTENT_LENGTH) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  return value.slice(0, max - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}

/**
 * Discord webhook へ 1 通投げる。通知は best-effort — 失敗 (非2xx / タイム
 * アウト / ネットワーク) は false を返すだけで、審査結果を変えない。
 * allowed_mentions は空に固定し、本文の @everyone / <@id> が実 mention に
 * ならないようにする (pr-lifecycle-notice の無害化と二重の防御)。
 */
export async function postDiscordWebhook({
  url,
  text,
  username = "Revisor",
  transport = fetch,
}) {
  if (!isDiscordWebhookUrl(url) || !text) return false;
  try {
    const response = await transport(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: truncateContent(text),
        username,
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
```

### 2. `src/config.mjs` — webhook URL secret

`workflowToken` の read/write/has パターンを踏襲する (encryptString /
readOrCreateMasterKey / isEncryptedBlob は既存 import 済みのものを使う):

- `writeDiscordWebhookUrl(url, env)` — `discord-webhook.mjs` の
  `isDiscordWebhookUrl` で検証し、`config.secrets.discordWebhookUrl` へ暗号化
  保存。空文字・不正 URL は `RevisorError` (「Discord webhook URL must be a
  https://discord.com/api/webhooks/... URL.」)。
- `removeDiscordWebhookUrl(env)` — secrets から削除。
- `optionalDiscordWebhookUrl(env)` — 未設定なら **null** (throw しない)。
  復号失敗も null ではなく throw (`readWorkflowToken` と同じ「設定されている
  のに読めないのは異常」の契約)。未設定判定は blob 不在。
- `hasDiscordWebhookUrl(env)` — optional が非 null かどうか。

注意: config.mjs から discord-webhook.mjs を import するのは検証関数
`isDiscordWebhookUrl` のみ (循環にならない: discord-webhook.mjs は
errors.mjs 以外 import しない)。

### 3. `src/pr-lifecycle-notice.mjs` — 直送関数

既存 `notifyPullRequestLifecycle` (Cc 経由) は残し、直送版を追加:

```js
/**
 * lifecycle 通知を Revisor 自身の Discord webhook へ直接送る。Cc egress の
 * 「提出セッションが active でないと配送しない」制約に依存しないため、
 * セッションを持たない CLI 提出 PR も通知される。
 */
export async function notifyPullRequestLifecycleWebhook({
  event,
  pullRequest,
  url,
  post,
}) {
  if (!url || !pullRequest) return false;
  return post({
    url,
    username: "Revisor",
    text: pullRequestLifecycleMessage(event, pullRequest),
  });
}
```

### 4. `src/review-context.mjs` — 配線 (webhook 設定時は Cc chat を使わない)

```js
import { optionalDiscordWebhookUrl } from "./config.mjs";
import { postDiscordWebhook } from "./discord-webhook.mjs";
import {
  notifyPullRequestLifecycle,
  notifyPullRequestLifecycleWebhook,
} from "./pr-lifecycle-notice.mjs";

// 差し替え: announceLifecycle
// webhook が設定されていれば直送し、Cc chat へは投げない (両方送ると、提出
// セッションが生きている間だけ Discord に二重投稿される)。未設定なら従来どおり
// Cc 経由 — 挙動を変えずに移行できる。
const announceLifecycle = (event, pullRequest) => {
  const webhookUrl = optionalDiscordWebhookUrl(env);
  if (webhookUrl) {
    return notifyPullRequestLifecycleWebhook({
      event,
      pullRequest,
      url: webhookUrl,
      post: postDiscordWebhook,
    });
  }
  return notifyPullRequestLifecycle({
    event,
    pullRequest,
    baseUrl: optionalConcordiaUrl(cwd, true),
    notify: notifyConcordiaChat,
  });
};
```

`optionalDiscordWebhookUrl` が throw した場合 (設定はあるが復号不能) も
通知経路を殺してはいけない — reporter 側 (`#announceReviewStatus`) の
try/catch が拾うので追加の防御は不要だが、`announceLifecycle` 自体は
async 関数にして throw を reject に変えること (同期 throw だと呼び出し元の
`await` 前に漏れる呼び方をされたとき落ちる)。

`announceCompletion` (提出セッション宛 inject) は変更しない。

### 5. `src/cli.mjs` — 設定コマンド

usage に追記し、`config github-app` と同じ場所に実装:

```
revisor config discord-webhook status
revisor config discord-webhook set --stdin
revisor config discord-webhook remove
```

- `status` — `hasDiscordWebhookUrl` で `configured` / `not configured`。
- `set --stdin` — stdin から URL を 1 行読む (シェル履歴・ps 出力に URL を
  残さない。`--stdin` 以外の渡し方は用意しない)。`writeDiscordWebhookUrl` へ。
- `remove` — `removeDiscordWebhookUrl`。

stdin 読みは既存 `config github-app set --private-key-stdin` の読み方を踏襲。

## テスト

### 新規 `test/discord-webhook.test.mjs`

- `isDiscordWebhookUrl`: discord.com / discordapp.com の webhook URL を許可、
  http・他ホスト・パス違いを拒否。
- `truncateContent`: 2000 ちょうどは素通し、2001 は 2000 文字になり省略記号
  で終わる。
- `postDiscordWebhook`:
  - transport が呼ばれる URL / body を検証 (content 切り詰め済み、
    `allowed_mentions: {parse: []}`、username)。
  - 非 2xx → false。transport が throw → false。url 不正 / text 空 →
    transport を呼ばず false。

### 新規 `test/discord-webhook-config.test.mjs` (または config.test.mjs へ追記)

- write → optional で復元 (roundtrip、REVISOR_CONFIG_PATH を一時 dir へ)。
- 不正 URL の write は RevisorError。
- 未設定の optional は null、has は false。remove 後も null。

### `test/pr-lifecycle-notice.test.mjs` へ追記

- `notifyPullRequestLifecycleWebhook`: post が message 本文と url を受け取る。
  url 無し → post を呼ばず false。

### review-context の配線テスト (既存の context/service テストの流儀に合わせる)

- webhook 設定あり: reporter 経由の lifecycle 通知で postDiscordWebhook 相当
  (transport 差し込み) が呼ばれ、Cc `/v1/chat` へは行かない。
- webhook 設定なし: 従来どおり Cc 経路。
  (review-context.mjs に transport/post を差し込む口が無ければ、
  `createReviewContext` にテスト用の `postWebhook` オプションを足してよい。
  既定は postDiscordWebhook。)

## 自己検証チェックリスト (PR 説明に結果を書くこと)

- [ ] `node --test test/*.test.mjs` — 追加分が全部 pass
  (workspace.test.mjs の LFS 1 件は環境依存の既存 fail、対象外)
- [ ] `node scripts/check-syntax.mjs` pass
- [ ] `grep -n "notifyConcordiaChat" src/review-context.mjs` → webhook 未設定
  fallback の 1 箇所のみ
- [ ] `grep -rn "discordWebhookUrl" src/` → config.mjs (secrets) と
  review-context.mjs (optional) のみ。ログ・エラーメッセージに URL 値を
  出す箇所が無いこと
- [ ] `grep -n "allowed_mentions" src/discord-webhook.mjs` → 1 件

## スコープ外 (やらない)

- UI 設定ページへの webhook 入力欄追加。
- 完了 inject (review-completion-notice / announceCompletion) の変更。
- Cc 側 egress の修正 (別リポ・別タスク)。
- リトライ・キューイング (通知は従来どおり best-effort 1 発)。
