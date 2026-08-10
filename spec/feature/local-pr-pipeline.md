---
type: feature
title: "local-pr-pipeline — 提出から本体反映までの 5 段"
description: "ローカル PR が提出されてから稼働中のサービスに反映されるまでを 5 段として通しで定義し、各段の正本 spec と「どこまで進んだか」の判定方法を示す地図。段 4 が後から入ったため、それ以前にマージされた変更は本体 checkout に降りておらず遅れて見える。"
service: revisor
domain: documentation
tags:
  - local-pr
  - pipeline
  - publication
  - checkout
  - deploy
status: draft
related:
  - ./pr-lifecycle.md
  - ./local-workspace.md
  - ./remote-publication.md
  - ./checkout-publication.md
  - ./daemonless-cli.md
updated: 2026-08-10
---

# local-pr-pipeline — 提出から本体反映までの 5 段

status: draft (2026-08-10 neco 指示による明文化)

この文書は**地図**であり、各段の規則そのものは持たない。段ごとの正本は §2 の表を参照する。

## 0. なぜ通しの地図が要るか

各段の spec は揃っているが、**通しで書いた資料が無かった**。そのため

- 「マージ済み」と言われた変更が、稼働中のサービスにはまだ入っていない
- ローカル main と GitHub main と本体 checkout の 3 つが食い違い、どれが正か判断できない
- 「遅れている」ように見えるものが、実際は**段 4 が存在しなかった時代の残り**である

という取り違えが繰り返し起きた。どの段まで到達したかを一意に言えるようにするのが目的。

## 1. 5 段

```
1. 提出      Concordia が session の branch を Revisor へ local PR として登録する
2. 審査/マージ Revisor が「自分の管理するローカルリポジトリ」で審査し、main へマージする
3. 公開      レビュー済みの base branch を GitHub へ push する
4. 本体反映   Revisor のローカルリポジトリの差分を、本体ディレクトリへ fast-forward する
5. 再起動     必要に応じてサービスを再起動し、新しいコードで動かす
```

段 2 の「ローカルリポジトリ」は本体ディレクトリではない。Revisor 所有の
merge repository (`local-workspace.md`) で、本体とは物理的に分かれている。
**この分離があるため、段 2 と段 4 は別の操作**になる。

## 2. 段ごとの正本と到達判定

| 段 | 正本 spec | 到達したかの判定 |
|---|---|---|
| 1 提出 | `pr-lifecycle.md` | PR が `status: open` で存在する |
| 2 審査/マージ | `pr-lifecycle.md` / `local-workspace.md` / `review-gate.md` | `status: merged` かつ `mergeCommitSha` がある |
| 3 公開 | `remote-publication.md` | `publishedAt` がある / `origin/main` が merge commit を含む |
| 4 本体反映 | `checkout-publication.md` | **本体 checkout の main が merge commit を含む** |
| 5 再起動 | `daemonless-cli.md` / Excubitor 側 | 稼働プロセスの起動時刻がマージ後である |

通常の local PR マージでは、段 2 と段 3 は同じ原子的なマージ処理で完了する。
Revisor は公開に成功してローカル base branch を前進させた後にだけ PR を `merged` にするため、
`status: merged` は段 3 到達も伴う。ここで段を分けるのは、審査・マージと GitHub 公開の
責務を区別するためであり、両者の間に利用者が観測できる永続状態があることを意味しない。

段 4 と段 5 は、他の段と違って**リポジトリの外を見ないと判定できない**。
PR のレコードには「本体へ降りたか」を表す欄が無い (`checkout-publication.md` §4 の範囲)。

判定コマンドの例:

```sh
# 段 3
git -C <本体> merge-base --is-ancestor <mergeCommitSha> origin/main
# 段 4
git -C <本体> merge-base --is-ancestor <mergeCommitSha> main
```

## 3. 段 4 は後から入った (重要)

段 4 は 2026-08-09 の neco 判断で追加された段で、それ以前は**存在しなかった**。
`checkout-publication.md` は現在 status: draft で、自動追従はしない方針も同時に決まっている。

その結果、段 4 導入以前にマージされた変更については

- Revisor の管理リポジトリと GitHub は正しく前進している
- **本体 checkout だけが古いまま取り残されている**

という状態が正常な履歴として残る。本体 checkout が origin より後ろにあること自体は、
**障害ではなく段 4 の未適用**である。手当ての順序を誤らないために、
「遅れている」と判断する前に段 3 と段 4 を分けて確認する。

### 3.1 本体 checkout が origin/main の祖先でない場合

段 4 は fast-forward である。ff できない、すなわち本体 checkout が origin/main の
祖先でない場合は、**段 4 では直せない**。本体 checkout が origin/main より古いだけなら
祖先なので fast-forward できる。この条件に当たる場合は履歴が分岐しており、対処が異なる。

| 状態 | 意味 | 対処 |
|---|---|---|
| 本体だけが持つコミットがある | 段 1〜3 を通さずローカルで直接マージした、または古い時点から独自に進んだ | そのコミットが審査を通っているか確認する。通っていなければ PR として出し直す |
| origin/main 側にも本体に無いコミットがある | 本体と公開済みの履歴が分岐している | 公開済み履歴を本体から push で上書きせず、競合を人が解決して審査済み PR として取り込む |

本体 checkout を GitHub へ push して正にする経路は**この 5 段に無い**。
GitHub main を動かせるのは段 3 だけである。

## 4. 実測例 (2026-08-10, Revisor#395)

段の分離を実際に確認した記録。

| 段 | 結果 |
|---|---|
| 1 提出 | ✅ `#395` open |
| 2 審査/マージ | ✅ auto-merge (マージリスク 34 ≤ 閾値 60) → `420065f` |
| 3 公開 | ✅ `origin/main` に `420065f` |
| 4 本体反映 | ❌ 本体 checkout の main は `bc5e235` のまま (2 コミット遅れ) |
| 5 再起動 | 未 |

このとき Revisor の管理リポジトリと GitHub は完全に一致しており、
**食い違っていたのは本体 checkout だけ**だった。

なお `#395` は Test OK 到達後に auto-merge が先に成立していたため、後から発行した
手動マージ要求は 0.2 秒で `local_pr_merge_failed` を返した。Concordia は Revisor 側の
理由を伏せるので、**マージ失敗を見たら PR の実状態を確認する**
(すでに merged のことがある)。

## 5. この spec がやらないこと

- 各段の実行規則 — それぞれの正本 spec が持つ
- 段 4 の自動化 — `checkout-publication.md` の範囲。本 spec は段の存在と判定だけを定義する
- 段 5 の再起動手順 — Excubitor 経由・本体フォルダのみという運用規則は Excubitor 側が持つ

## 6. 検証観点

- 段 3 到達済み・段 4 未到達の PR について、判定コマンドが正しく食い違いを示すこと
- 本体 checkout が origin/main の祖先でないとき、段 4 を実行しないこと
- すでに merged の PR に手動マージを要求したとき、PR の実状態を確認して再マージを試みないこと
