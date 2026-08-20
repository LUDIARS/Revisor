# 設計書: 作業ブランチの GitHub 送出 (revisor push)

- 作成: 2026-08-21 / Claude Opus 5
- neco 指示 (2026-08-21): 「Cc で push を指示されたとき、GitHub App の認証を使って
  push をしてほしい。いま Rv のマージ経路しか push する導線が無い。スキル化して
  Cc 側で push できるようにしたい」
- 方式決定 (neco): Cc は Revisor CLI を子プロセスで叩く。GitHub App の秘密鍵は
  Revisor に据え置き、複製しない。

## 1. 背景

GitHub へ届く push は publication 一本しか無い。`push-guard.mjs` は
`refs/heads/<baseRef>` 以外の refs/heads を**認可の有無より先に**無条件で落とし
(`branch_push_blocked`)、base とタグは `REVISOR_PUBLISHING=1` を要求する。
Revisor 自身の送出も `<mergeCommitSha>:refs/heads/<base>` とタグしか送らない
(`plain-git-publication.mjs`)。結果として、マージを伴わずにブランチだけを
GitHub へ出す手段が存在しない。

一方でその要求は実在する — 作業のバックアップ、別ホストとの共有、GitHub 上での
レビュー。いずれもマージではないので、publication へ相乗りさせる筋合いが無い。

## 2. 仕様

### 2.1 CLI

```
revisor push [--repo <path>] [--branch <name>] [--remote-branch <name>]
             [--force-with-lease] [--actor <label>]
```

- `--repo` 既定は cwd。worktree から呼ばれても `--git-common-dir` の親を見て
  登録リポジトリへ解決する (task 専用 worktree が常用のため)。
- `--branch` 既定は HEAD。detached HEAD は明示を要求する。
- `--remote-branch` 既定は同名。
- `--actor` は記録用。誰の指示で GitHub へ出たかを残す。

### 2.2 送出経路

`workflow` 属性 (`repository-workflow.mjs`) に従う。

- `revisor` (LUDIARS 既定): GitHub App の installation token。
  App 未インストールは publication では保留 (deferred) だが、ここでは**保留にせず
  失敗として返す**。人間が「今送れ」と指示した操作で、黙って送らないのが最悪。
- `github` (MELPOT 等): 登録 checkout の `origin` へ、その環境の git 資格情報で送る。
  送り先 URL は publication と同じ `assertGitHubPublishRemoteUrl` で検証する。

### 2.3 拒む対象

- 未登録リポジトリ。
- `--remote-branch` が base ref。publication と役割が競合する。版数・Release・
  remote 分岐の保護は publication 側の不変条件で、それを迂回する第二の経路を作らない。
- ブランチ名として不正な値 (`--force` のような option への化けを含む)。

### 2.4 push guard の緩和

- 認可の旗は `REVISOR_BRANCH_PUBLISHING=1` (`branch-push-flag.mjs`)。
  publication の `REVISOR_PUBLISHING` とは**別に切る**。同じ旗を使い回すと、
  ブランチ送出の認可がそのまま base 送出の認可になる。
- 旗が立っているときだけ base 以外の refs/heads を通す。素の `git push` は
  これまでどおり `branch_push_blocked` で落ちる。
- 認可されたブランチ送出も漏洩走査を通す。新規 ref は base との分岐点まで遡り、
  送出される各コミットの patch を走査する。tip だけや最終 tree の差分だけを見ると、
  途中のコミットで入れて後で削除した秘密を見逃すため
  (publication は常に squash 1 コミットなので従来は問題にならなかった)。

### 2.5 記録

`service-log` へ `branch_push_started` / `branch_push_completed` /
`branch_push_refused` を出す。repository・branch・remoteBranch・headSha・
workflow・forceWithLease・actor を含む。

## 3. 呼び出し側 (Cc / セッション)

Castra の skill `cc-push` が `revisor push` の呼び方を持つ。セッションは
`git push` ではなくこの CLI を使う。Discord のボタン化は今回の範囲外。
