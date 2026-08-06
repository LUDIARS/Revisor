---
type: feature
title: "pr-lifecycle — ローカル PR の終局 (マージ / 取り下げ)"
description: "ローカル PR の status は open → merged / closed の一方向。マージせずに終わる PR (別経路で main へ入った / 案を破棄した) を closed にして board・test workflow・オートマージから外し、終局済みの PR に対する merge / retry / close をすべて拒否する。"
service: revisor
domain: local-pr-lifecycle
tags:
  - lifecycle
  - close
  - merge
status: implemented
related:
  - ../architecture.md
  - ./human-decision-board.md
  - ./crash-recovery.md
  - ./review-gate.md
updated: 2026-08-06
---

# pr-lifecycle — ローカル PR の終局 (マージ / 取り下げ)

## 1. status は 3 つ、遷移は一方向

| status | 意味 | 入り方 |
|---|---|---|
| `open` | 審査中 / 判断待ち | 投稿時 (`createPullRequest`) |
| `merged` | squash merge 済み | `LocalPrService.mergePullRequest` |
| `closed` | マージせずに終局 (取り下げ) | `LocalPrService.closePullRequest` |

`merged` / `closed` は**終局**で、そこから `open` へ戻す経路は無い。戻す必要が
出たときは同じ head を投稿し直す — `findExactPullRequest` は `open` だけを見るので、
終局済みの PR に相乗りせず新しい PR として審査が回る。

## 2. 取り下げが要る理由

レビューを通した変更のすべてがマージされるわけではない。別経路で main へ入った
PR や、案ごと捨てた PR が `open` のまま残ると:

- board の「判断待ち」に永久に居座り、本当に人を待っている 1 件を埋める
- `test_ok` なら test workflow に「動作確認してください」と出続ける
- オートマージの対象に残り続ける

`closed` はこの 3 つから同時に外すための終局状態。

## 3. `closePullRequest(id, { reason })`

`src/local-pr-service.mjs`。

- `open` 以外は拒否する (`Only an open local PR can be closed (it is '<status>').`)
- `checkStatus` が `queued` / `running` の間は拒否する
  (`A local PR under review cannot be closed; ...`)。走っているワーカーは完了時に
  自分の結果を書き戻すので、先に `closed` にしても上書きされて `open` へ戻った
  ように見えるだけになる。取り下げたいなら審査の完了を待つ
- squash マージが走っている間も拒否する
  (`A local PR being merged cannot be closed; ...`)。同じ理由の別の形で、こちらは
  被害が重い: squash はマージ前セキュリティスキャンを含んで数分かかる一方
  `closePullRequest` は同期で status を書くので、その最中に取り下げを通すと、
  完了した merge が `status: "merged"` を書き戻して取り下げを踏み潰し、
  取り下げたはずの変更が board から消えないまま main へ入る。締め出す区間は
  squash 開始から status 書き込み完了まで
- 理由は**任意**。文字列で中身があるものだけ `closeReason` に trim して記録し、
  それ以外は `null`。終局の可否を理由の有無で左右しない
- `closedAt` に ISO 時刻を書く

`mergePullRequest` も同じ理由で `open` 以外を拒否する
(`Only an open local PR can be merged (it is '<status>').`)。`closed` を通すと、
取り下げた変更が board に出ないまま main へ入る。`retryPullRequest` は従来どおり
`open` 以外を拒否するので、終局済みの PR は merge も retry も close もできない。

## 4. Genius の判断保留は明示操作でだけ解ける (2026-08-04)

Genius 階層のレビューは意図的に `action_required` で止まる。自動マージを禁じ、
公開された判断カードを人が読んでから決めさせるための保留であり、その保留自体は
`reasons` に 1 件 (`GENIUS_HUMAN_DECISION_REASON`) として記録される。

`src/human-decision.mjs` が保留の判定と解除を持つ。

- `isSoleGeniusHumanDecisionHold` — `open` かつ `action_required` かつ
  `reviewer: "genius"`、`reasons` が**その 1 件だけ**で、公開された
  判断カード (`geniusGuidance.cards`) が 1 枚以上あるときだけ true。他のブロッカーが
  1 つでも残っていれば false (fail-closed)
- `approvedPullRequestForManualMerge` — 上が true のときに限り `test_ok` /
  `reasons: []` の形へ変換して `local-merge` の前提 (`Only an Open / Test OK ...`) を
  満たす。false なら記録をそのまま渡し、マージは従来どおり拒否される

適用先はボードの明示操作 (`mergePullRequest`、既定 `humanApproved: true`) だけ。
`sweepAutoMerge` と `autoMergeIfEligible` は `humanApproved: false` を渡すので、
自動マージが Genius の保留を解くことはない。判定を呼び出し側の引数にしているのは、
「自動経路は `test_ok` しか選ばない」という現在の絞り込みに安全性を預けないため。

ボードのマージボタンは `decision.humanDecisionMergeable` (同じ述語を
`pr-disposition` が読み取り時に導出したもの) で出す。表示条件をクライアント側で
書き直すと、マージ経路の前提とずれた瞬間に「押せるのに必ず失敗するボタン」に戻る
— それが 2026-08-04 の
[問題ログ](../plan/problem_logs/2026-08-04-genius-human-merge-unreachable.md) の原因。

マージ成功時は `reasons: []` も書く。解けた保留の文言をマージ済みカードに残さない。

## 5. 終局が波及する先

| 参照元 | 効果 |
|---|---|
| `LocalPrStore.testWorkflowProducts` (`status === "open"`) | 取り下げた PR は動作確認の依頼として出ない |
| `pr-disposition.classifyDecision` | `closed` → 判定状態 `closed` (取り下げ / idle) |
| `pr-disposition.decidePullRequest` | `closed` は settled 扱いにせず blockers を空にする — 誰も判断しなくてよい PR に理由を並べない |
| `auto-merge.autoMergeDecision` (`status !== "open"`) | オートマージ対象外 |
| ダッシュボード (`status === 'open'` で board を作る) | カードごと消える |

## 6. HTTP 面

```
POST /v1/local-prs/:id/close   workflow token
POST /api/local-prs/:id/close  UI セッション
```

どちらも merge / retry と同じ認可 (破壊的操作なので token / セッション必須) で、
本文の `{"reason": "..."}` は任意。ダッシュボードの「取り下げ」ボタンは本文を
送らないため、本文が読めない要求でも取り下げ自体は通し、理由だけ `null` になる。
ボタンは merge と違い `test_ok` を要求せず、審査が終わっている open な PR
(`queued` / `running` 以外) に出る — 落ちた審査こそ取り下げたい。

## 7. テスト

`test/local-pr-service.test.mjs`:

- `test_ok` の PR を取り下げると `closed` + `closeReason` (trim 済み) + `closedAt`
  になり、`testWorkflowProducts()` から消えること
- 取り下げ済みは merge も retry も 2 度目の close も拒否されること
- 審査中 (`queued`) の close が拒否されること
- squash マージ中の close が拒否され、マージが踏み潰されずに `merged` になること
- 唯一の保留が Genius の判断カード確認であれば明示マージが通り、`merged` /
  `test_ok` / `reasons: []` になること
- 別のブロッカーが残っていれば同じ明示マージが拒否され、`open` のままであること
- `humanApproved: false` (自動マージ経路) では同じ保留を解けないこと

`test/pr-disposition.test.mjs`: `closed` は判定状態 `closed`・blockers 空・
オートマージ対象外であること (審査が `action_required` で終わっていても同じ)。
`humanDecisionMergeable` が唯一の Genius 保留でだけ true になり、追加のブロッカー・
カード無し・別 reviewer・終局済みでは false になること。旧 `draft` メタデータは
判定に影響しないこと。

`test/server.test.mjs`: close が token / セッションを要求すること、両 API が id を
デコードして理由を渡すこと、本文なしでも取り下げられること。

`test/ui.test.mjs`: board のカードに「取り下げ」ボタンが出て `close` を叩くこと。
UI は生成した client script の文字列でしか検証できないので、ボタンの表示条件
(`open` かつ `queued` / `running` 以外) は本体の分岐と合わせて読む必要がある。
