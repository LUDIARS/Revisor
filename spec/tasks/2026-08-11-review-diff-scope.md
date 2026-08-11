---
task: review-diff-scope
project: Revisor
kind: 実装
status: pending
created: 2026-08-11
memoria_task_id: null
actio_task_id: null
memory_links: []
---

# 審査差分を base branch との差分に揃え、取り込み判定をコンフリクトのみにする

`spec/feature/review-diff-scope.md` を実装へ反映する。 規則は 2 つだけ。

1. 審査に渡す差分は、base branch の**現在の先端**と head の merge-base から head までの
   head 側の差分だけ
2. 取り込み可否で見るのは**コンフリクトの有無だけ**

## 実装との乖離 (2026-08-11 実測)

### 乖離 1 — 審査の差分起点が登録元 checkout になっている

- `src/local-pr-service.mjs` の `reviewRequest` が `rootPath: repository.rootPath`
  (登録元 checkout) を審査要求に載せる。
- `src/runner.mjs` が `prepareLocalWorktrees(repoPath, request)` をその `rootPath` で呼ぶ。
- `src/workspace.mjs` の `inspectLocalPullRequest` が `baseSha` を**その repoPath の**
  `refs/heads/<baseRef>` から読み、 `mergeBase = merge-base(headSha, baseSha)` を返す。
  審査の差分はこの `mergeBase` を起点にする。
- 一方マージは `prepareMergeRepository` が用意する **merge repository** の上で行う
  (`src/local-pr-service.mjs` / `src/local-merge.mjs`)。

登録元 checkout は `spec/feature/checkout-publication.md` の条件を満たすまで追随しない
ため、**審査の base だけが古い位置に取り残される**。 実測 (2026-08-11):

| リポ | 登録元 checkout | merge repository |
|---|---|---|
| Concordia | `f4c3aecd` | `cfec8bbb` |
| Revisor | `bf53afd` | `7965da9` |
| Lictor | `55d02e1` | `14aea8b` |

結果として、 base が進んだぶんが全部その PR の変更として審査へ渡る。 実害:

- Cc #358 の審査差分が `39 ファイル / 1162 行` と報告された。 真の base との差分は
  その一部でしかない。
- `merge-risk` の `diff_size` に 18 点が乗り、 合計 62 点で閾値 60 を超え、
  自動マージが止まって人間判断へ回った (#358 / #341 の 2 本)。

**直し方**: 実際に squash 先となるリポジトリの現在の base ref を基準に
`merge-base(base, head)..head` を作る。 `base..head` の単純比較にすると、base だけで進んだ
変更が逆向きの差分として混ざるため使わない。
登録元 checkout の ref を差分の起点にしない。

### 乖離 2 — 取り込みがコンフリクト以外の理由で止まる

`src/local-merge.mjs` の `assertReviewedContentUnchanged` が、 審査済みヘッドと現在ヘッドの
patch-id 不一致で `StaleReviewError` を投げ、取り込みを拒否する。 これは規則 2 に反する
(「審査時と内容が違う」はコンフリクトではない)。

**直し方**: 取り込み可否の判定を「現在の base への rebase が衝突しないか」だけにする。
既に `feat/rebase-squash-local-merge` (Rv #384) がこの置き換えを実装済みで、 現在の base に
対して衝突ゼロで投入待ちなので、**新規に書き直さず #384 を先に通す**こと。

### 乖離 3 — base が進むたびにセッションが手で rebase させられている

現状、 他 PR が 1 本マージされると残りの PR は
`The head conflicts with the current 'main'; rebase the branch and submit a new review.`
で `action_required` に落ちる。 実際には衝突していない PR も含めて、 提出元セッションが
手で載せ替えて再提出している。 2026-08-11 の 23 本整理では、 1 本マージするたびに
残りが落ちる再作業が繰り返し発生した。

載せ替えは merge repository の中で決定的に実行できる作業で、 人間の判断を必要としない。
**Revisor がこれを受け持つこと。**

手で回したときの手順は次と等価だった (これをサービス側で行う):

```sh
# merge repository の中で、 現在の base の上にそのブランチの正味の変更だけを載せる
git reset --hard <現在の base>
git merge --squash <head>
# 衝突しなければ取り込める。 衝突したファイル一覧だけを提出元へ返す。
```

制約:

- 登録元 checkout の ref・index・worktree・stash に触れないこと
- 提出元ブランチの履歴を Revisor が書き換えないこと
- 衝突しない限り `action_required` にしないこと。 審査結果は head に付いたまま引き継ぐ
- 自動解決はしないこと

## 完了条件

- 審査へ渡る差分に、他 PR がマージしたぶんの変更が含まれない
- 登録元 checkout の base ref が古いままでも、 審査の差分起点が merge repository の
  base ref になっている
- ヘッド SHA だけが変わった PR が、 コンフリクトしない限り取り込める
- コンフリクトする head は、 差分の大小に関わらず取り込みを拒否される
- 他 PR のマージで base が進んだ後、 衝突しない PR がセッションの再 rebase 無しに
  取り込める (`action_required` に落ちない)
- 載せ替えの前後で登録元 checkout の状態が変化しない
- 上記を覆う `test/` の回帰テストがある

## 関連

- `spec/feature/review-diff-scope.md` (本タスクの正本)
- `spec/feature/checkout-publication.md` (登録元 checkout が追随する条件)
- Rv #384 `feat/rebase-squash-local-merge` (乖離 2 の実装)
- Rv #428 / #430 (マージ後に登録元 checkout の base を追随させる。 これが入れば乖離 1 の
  症状は緩和するが、 **審査が merge repository を見るべきという規則そのものは別途必要**)
