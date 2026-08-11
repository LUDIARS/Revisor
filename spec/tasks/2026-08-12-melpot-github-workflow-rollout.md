---
task: melpot-github-workflow-rollout
project: Revisor
kind: テスト
created: 2026-08-12
memory_links:
  - spec/plan/workflow-selection-design.md
  - spec/tasks/2026-08-12-workflow-selection.md
---

# MELPOT の github workflow 移行と実 push の疎通確認

## 目的

`workflow-selection` の実装はテストまで green だが、 **実際の GitHub へ push した確認は
まだ無い**。 設計書 §3 で実 push は設計側が行うと決めてあり、 fake push を注入した検証
しか通っていない。 MELPOT/KuzuSurvivors を `github` workflow へ移行し、
`pr merge` から plain push までが実環境の資格情報で通ることを確認する。

あわせて、 実装時に設計文面から判断で外した 3 点の可否を確定させる。 fake push で
検証したのは実装した挙動であって、 設計意図との一致ではない。

## 完了条件

- `revisor repo set-workflow MELPOT/KuzuSurvivors github` を実行し、 `repo list` の
  workflow 列が `github` になる。
- KS で `revisor pr merge <n>` → plain push が実際の GitHub へ通り、 `publication` が
  `published` になる (保留に落ちない)。 落ちた場合は
  `revisor publish-pending --repository MELPOT/KuzuSurvivors` で解消できることまで確認。
- push guard (`REVISOR_PUBLISHING` / `ALLOW_MAIN_PUSH`) が実環境の hook 構成でも
  plain push を通すことを確認する。 authenticated 経路と違い extraheader を張らないため、
  資格情報は credential helper 頼りになる。
- 以下 3 点について設計側の可否を確定し、 相違があれば修正する:
  1. push の実行場所。 マージコミットのオブジェクトは隔離マージリポジトリにしか無く
     (登録 checkout へ届くのは publish 後の syncCheckout)、 そのリポジトリの `origin` は
     GitHub ではなく登録 checkout を指す `revisor-source`。 このため隔離リポジトリから
     push し、 送り先 URL だけを登録 checkout の `origin` から読む形にした。
     設計文面の「`git push origin <baseRef>`」とは remote 指定の形が違う。
  2. リリースタグを push するかどうか。 設計が明示的に除外しているのは Release 作成と
     remote tags 照会だけなので、 タグがある回はコミットと `--atomic` で一緒に送っている。
     除外すべきなら `plain-git-publication.mjs` の refspec 1 行で戻せる。
  3. `repo list --json` に解決後の workflow を含めるか。 現状は登録レコードをそのまま
     返すため、 `workflow` 未指定のリポにはキーが現れない (解決値はプレーンテキスト列のみ)。

## スコープ (編集可ディレクトリ)

- `src/plain-git-publication.mjs` / `src/local-pr-commands.mjs` (上記 1〜3 の修正が要る場合)
- `spec/feature/daemonless-cli.md`
- 実行は MELPOT/KuzuSurvivors の登録 checkout に対して行う (Revisor 側のコード変更は伴わない)
