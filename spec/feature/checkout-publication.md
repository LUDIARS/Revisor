---
type: feature
title: "checkout-publication — レビュー済み main を登録 checkout へ降ろす"
description: "マージ済みの base ref を、Concordia の許可と厳格な安全条件の下で登録 checkout に fast-forward する設計。"
service: revisor
domain: documentation
tags:
  - git
  - local-pr
  - publication
  - concordia
status: draft
related:
  - ./local-workspace.md
  - ./remote-publication.md
  - ./pr-lifecycle.md
  - ./pr-lifecycle-notice.md
updated: 2026-08-09
---

# checkout-publication — レビュー済み main を登録 checkout へ降ろす

status: draft (2026-08-09 neco 方針決定の反映)
関連: `spec/feature/local-workspace.md` §「登録 checkout と merge repository の分離」 /
`spec/feature/remote-publication.md` / `spec/feature/pr-lifecycle.md` /
`spec/feature/pr-lifecycle-notice.md`

## 0. 背景

`local-workspace.md` の分離により、merge は Revisor 所有の merge repository で完結し、
登録 checkout (`repository.rootPath`) は merge 処理中に変更されない。これは意図した境界で
あり、**この spec は merge 中に登録 checkout を触らないという境界を緩めない**。

しかし GitHub publication を通さない運用のリポジトリでは、マージ済みの変更が
どこからも登録 checkout へ降りてこない。典型的には次の状態になる:

- Revisor の local PR は `status=merged` で merge commit を記録している
- 登録 checkout の base ref はマージ前の commit を指し、merge commit object も持たない
- 稼働中サービスと次に切る worktree の基点には、マージ済みの変更が入らない

つまり「マージ済み」と「手元で動く」の間に、担当者のいない隙間がある。

### 0.1 自動追従はしない (neco 判断 2026-08-09)

登録 checkout を常に merge 結果へ追従させることは**しない**。分離された main は
`origin/main` 相当のものとして扱えばよく、本ブランチは開発テストに自由に使いたい。
テスト中に足元が動く方が困る。

したがって降ろす条件を 1 つに絞る:

> **登録 checkout の HEAD が base ref (通常 `main`) を指しているときだけ、
> fast-forward で前進させる。**

それ以外は何もしない。何もしなかったことは記録する (§4)。

## 1. 責務分担

| 担当 | 責務 | 理由 |
|---|---|---|
| **Revisor** | 登録 checkout への git 書き込み | merge commit を持つのは Revisor だけ。`publicationCoordinator` の直列化の中で実行でき、publication の一形態として `local-workspace.md` の「publish だけが base を前進させる」に収まる |
| **Concordia** | 実行可否の判断と、降りた後の deploy 連携 | どの session がどのリポの何を掴んでいるか、testing claim が出ているかを知っているのは Cc だけ。Revisor 単独では作業中セッションの足元を更新してしまう |

`local-workspace.md` の不変条件は **merge 処理中に** status/stash/checkout/reset を
実行しないことである。この公開経路は merge 完了後にだけ動く。登録 checkout へ書き込む
経路を増やす以上、未追跡ファイルも含む厳格なガード (§2) が必須である。

## 2. 実行条件 (すべて満たしたときだけ実行する)

1. PR の `status=merged` と merge commit を永続化した直後、同じ
   `publicationCoordinator` の中であること。
2. 登録 checkout の `HEAD` が PR の `baseRef` を指していること
   (detached HEAD、別 branch は対象外)。
3. `baseRef` から merge commit へ **fast-forward できる**こと。
   `git merge-base --is-ancestor <baseRef> <mergeCommitSha>` が真。
4. worktree が clean であること。**tracked の変更・untracked file・ignored でない
   生成物のいずれか 1 つでもあれば中止**する。
5. rebase / merge / cherry-pick / bisect が進行中でないこと
   (`.git/REBASE_HEAD` 等の存在で判定)。
6. Concordia への照会 (§3) が `allowed` を返すこと。
7. merge repository から merge commit object を取得できること。登録 checkout では
   `git fetch --no-tags --no-write-fetch-head <mergeRepository> <mergeCommitSha>` のように
   object だけを取得し、ref・worktree・設定を変更しない。

### 2.1 禁止事項

- **stash を取らない**。dirty を退避して強行するのは今日の埋没事故の再現になる。
- **非 fast-forward merge / rebase / reset / checkout / force update をしない**。
  `git merge --ff-only <mergeCommitSha>` だけを branch 前進に使う。
- 条件を満たさないときに「次善の策」を選ばない。**何もしないで記録する**。
- 登録 checkout に worktree が紐づいていても、それらの branch には触れない。

## 3. Concordia への照会

```
GET <cc>/v1/checkouts/lock?repo_origin=<canonicalOrigin>&repo_path=<rootPath>&branch=<baseRef>
→ 200 { "allowed": true }
   200 { "allowed": false, "reason": "session_active", "holders": [...] }
```

`allowed: false` を返す条件 (Cc 側の判断):

- その `repo_path` を claim している active session がある
- その repo のサービスに testing claim (`/v1/testing/claim`) が出ている
- 対象 branch を作業中として登録している session がある

`canonicalOrigin` は登録済み origin の識別子から userinfo を除いた値に限る。資格情報を
含む remote URL や任意の URL 文字列を Cc の要求・ログ・イベントに渡してはならない。

**Cc が応答しない・エラーを返す場合は `allowed: false` として扱う。** 判断材料が
無いまま書き込む方が危険である (無言フォールバック禁止)。

## 4. 結果の記録

「マージ済み」と「手元に降りた」を**別々に見えるように**する。降ろせなかったことが
merge の失敗に見えてはならないし、逆に握りつぶされてもならない。

- 実装時に local PR へ `checkoutPublishedAt` / `checkoutPublishError` を追加する。
  `mergeError` とは別のフィールドにする (merge は成功しているため)。
- 実装時に PR lifecycle event を 2 件追加する。
  - 成功: `checkout_published` — 「本体 checkout を `<sha>` へ前進させました」
  - 見送り: `checkout_publish_skipped` — 理由 (§2 のどれで落ちたか) を明示
- `spec/feature/pr-lifecycle-notice.md` のイベント一覧と通知テストも同時に更新する。
- 見送りは失敗ではないので、通知は 1 行で足りる。**理由を書かない通知は出さない**
  (「降りませんでした」だけでは次の手が決まらない)。

## 5. 降りた後 (Concordia 側)

main が進んでもサービスは古いプロセスのままである。build と再起動は既に
`cc-deploy` の領分なので、Revisor は**降ろすところまで**で終える。

- Cc は `checkout_published` を受けて、対象リポにサービスがあれば deploy フローへ繋ぐ。
- 起動・再起動は従来どおり Excubitor 経由・本体フォルダのみ・testing claim 付き。
  この spec はそのルールを一切変更しない。

## 6. この spec がやらないこと

- 登録 checkout の常時追従 (§0.1)。
- 非 fast-forward の解決。競合したら人が解決する。
- 本ブランチが `main` 以外のときの前進。
- GitHub publication の代替。`remote-publication.md` は独立して動く。

## 7. 検証観点

- HEAD が main / 別 branch / detached の 3 通りで、前進するのは 1 通りだけであること。
- dirty (tracked 変更のみ / untracked のみ / 両方) のいずれでも中止し、
  **stash が 1 件も増えていない**こと。
- Cc が `allowed:false`・到達不能・不正 JSON を返す 3 通りで、いずれも中止すること。
- fast-forward 不可 (base が別系統へ進んでいる) のとき、reset せず中止すること。
- 成功時に登録 checkout の `main` が merge commit を指し、reflog に
  fast-forward が 1 件だけ残ること。
- 見送り時に `checkoutPublishError` と lifecycle event の理由が一致すること。
