---
task: hygiene-untracked-data
project: Revisor
kind: 実装
created: 2026-08-09
memory_links:
  - spec/feature/local-workspace.md
---

# checkout hygiene が運用データを stash に巻き込まないようにする

## 目的

2026-08-08 11:07 の `revisor-checkout-hygiene` stash が、Concordia の
`logs/channel-archives/*.md` を **585 件** (2026-05-26〜07-16、11.6MB) 丸ごと退避した。

この結果:

- Genius の Tier 1 ingest ソース `channel-archives` のディレクトリがディスク上から消えた
- ingest の未解決失敗 36 件が「元ファイルが存在しない」状態になり、
  復旧不能と判断して waiver を入れる寸前まで行った
- 誰も気付かないまま丸 1 日 ingest ソースが欠けていた

stash なので消えてはいなかったが、**別サービスの運用データを黙って持ち去る**経路が
あること自体が問題である。stash は「後で戻す前提」の置き場で、他プロセスが読んでいる
ログ出力先をここへ入れてよい根拠は無い。

## 完了条件

- hygiene が退避する対象から、**tracked でないファイル**を外す。最低でも
  ログ・データ出力ディレクトリ (gitignore 対象を含む) を巻き込まない。
- 退避が発生したときは、件数と代表パスを **1 行以上ログに残す**。
  今回は何を持って行ったのか事後に stash を掘るまで分からなかった。
- 退避せずに済ませられない場合は、hygiene を中止して理由を返す方を選ぶ
  (黙って持ち去るより、進まない方が安全)。
- 回帰テスト: untracked なログディレクトリを置いた checkout に対して hygiene を回し、
  **stash が増えず、ファイルが残っている**ことを確認する。

## スコープ (編集可ディレクトリ)

- `src/` (checkout hygiene の退避処理)
- `spec/feature/local-workspace.md`
- `test/`
