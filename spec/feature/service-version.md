---
type: feature
title: "service-version — 版は 1 か所になく、食い違いが答えになる"
description: "名指しされた LUDIARS サービスの版を、Revisor 所有の版ファイル・公開済みリリースタグ・走っているプロセスが health で名乗る版・ディスクの package.json の 4 つから集め、代表値を 1 つ決めて食い違いを名前で残す読み取り専用の境界。"
service: revisor
domain: service-version
tags:
  - version
  - observability
  - catalog
status: implemented
related:
  - ./service-bootstrap.md
  - ./remote-publication.md
updated: 2026-09-12
---

# service-version — 版は 1 か所になく、食い違いが答えになる

「Concordia は今どの版か」に答えようとして 0.1.0 と答えた。実際には **v2.4.0 を公開済み**
だった。`package.json` は 0.1.0 のまま、Revisor の版ファイルは `uninitialized`、走っている
プロセスは Excubitor が `package.json` から注入した 0.1.0 を名乗っていた。3 つとも同じ値
だったので、誰も間違いに気付けなかった。

版は 1 か所にない。そして**どれか 1 つに丸めた瞬間に、いちばん知りたかった情報が消える**。

| 情報源 | 何を表すか |
| --- | --- |
| 版ファイル (`.revisor-version`) | Revisor が所有する、いまこのリポジトリが名乗る版 |
| リリースタグ (`v2.4.0`) | 最後に公開した版 |
| health の `version` | 走っているプロセスが読み込んでいる版 (AIFormat `RULE_SRE.md` §2) |
| `package.json` | ディスクに置かれている版 |

食い違いはそれ自体が証拠になる。走行版とディスク版が違えば**ビルドしたが再起動して
いない**。ディスク版と公開済み版が違えば**公開に追随していない**。未公開コミットが
あれば**マージしたが公開していない**。だから 4 つとも返し、代表値は別に 1 つ決める。

### SPEC-SERVICE-VERSION-SOURCES: 4 つの情報源をすべて返す

1 サービスにつき、上記 4 欄と未公開コミット数を返す。取れなかった欄は `null` にし、
取れなかった理由 (health に届かない、catalog に health 宣言が無い) を添える。
欄を落として代わりに別の値を入れない — 空欄は「分からない」であって「同じ」ではない。

食い違いは `drift` に種類の名前として残す。表示側が「どれとどれが違うか」を毎回
組み立て直さずに済ませるためで、数値そのものは各欄に残したままにする。

| `drift` | 意味 |
| --- | --- |
| `running_differs_from_release` | 公開済み版と違うものが走っている |
| `package_differs_from_release` | `package.json` が公開済み版に追随していない |
| `running_differs_from_package` | ビルドしたが再起動していない |
| `unreleased_commits` | マージ済みだが公開していないコミットがある |

### SPEC-SERVICE-VERSION-REPRESENTATIVE: 代表値の正本は版ファイル

代表値は **版ファイル → リリースタグ → 走行版 → `package.json`** の順で決める。

版ファイルをタグより先に見るのは、タグが「最後に公開した版」なのに対し、版ファイルは
「いまこのリポジトリが名乗る版」だから。Concordia を `2.4.335` に初期化した直後に
タグ優先のままだと `2.4.0` と答え、初期化した値がどこにも出なかった。

`package.json` は正本にしない。`package.json` を持たないサービス (Unity / Rust など) が
あり、版を持つ前提を敷けない。最後の手段としてだけ使い、欄としては返し続ける
(追従だけはする)。走行版を代表にしないのも同じ理由で、版管理を初期化していない
リポジトリでは置き去りの `package.json` 由来の値がそのまま答えになってしまう。

公開する版への `package.json` の追従は Revisor が公開の直前に行う
(`remote-publication` 側の責務)。この境界は書き換えず、ズレを報告するだけに留める。

### SPEC-SERVICE-VERSION-SELECTOR: 名指しは code / repository / project code のどれでもよい

呼び出し側が持っている名前はまちまちなので、Excubitor catalog の `code`
(`concordia-cost`)、`repo` (`LUDIARS/Concordia`)、`project_code`、リポジトリのディレクトリ名の
どれで来ても同じサービスへ着地させる。

別名は強い順に段を分ける。`code` が最優先で、次が `project_code`、最後がリポジトリ名。
リポジトリ名を `code` と同列に見ると、1 リポジトリが複数サービスを持つ構成で catalog の
並び順しだいに別サービスへ着地する — 実際に `excubitor` が `excubitor-viewer-dmz` に
解決された。

リポジトリで名指しされたときは、そのリポジトリが走らせる**全サービス**を返す。
Concordia のように `concordia` / `concordia-control` / `concordia-cost` を持つ構成で 1 つだけ
答えると、残りが古いまま走っていても見えない。

解決できなかった名前は応答に `found: false` として残す。黙って落とすと、聞いたサービスが
答えに無いことに呼び出し側が気付けない。

### SPEC-SERVICE-VERSION-EXPLICIT-TARGET: 名指しの無い照会は受け付けない

サービスを 1 つも名指ししない照会は拒否する。「全サービス」を既定に据えると、93 サービス
分の health を叩く呼び出しが打ち間違いから生まれる。何を聞きたいかは呼び出し側が言う。

現在地からの解決 (Concordia の `?cwd=`) は呼び出し側の責務で、この境界には持ち込まない。
Revisor は catalog しか知らず、どのプロジェクトが「いまの関連プロジェクト」かを判断する
材料を持たないため。

## 状態を変えない

この境界は読み取りだけで、起動も再起動も公開もしない。health は「動いているか」を見る
ためのもので、版を読むためだけに長く待たない。catalog の解決に失敗した断片 1 枚や、
release state を読めないリポジトリ 1 件で、他サービスの答えまで落とさない。
