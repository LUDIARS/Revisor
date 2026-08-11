---
type: feature
title: "review-diff-scope — 審査が見る差分の範囲と取り込み判定"
description: "審査対象の差分は merge repository の現在の base と head の merge-base から head までに限る。取り込み可否で見るのはコンフリクトの有無だけで、差分の大きさ・ヘッド SHA の変化・審査時との内容一致は取り込みを止める理由にしない。"
service: revisor
domain: review-diff-scope
tags:
  - review-scope
  - base-branch
  - conflict-only
  - merge-gate
status: specified
related:
  - ./local-workspace.md
  - ./checkout-publication.md
  - ./review-gate.md
  - ./merge-risk.md
updated: 2026-08-11
---

# review-diff-scope — 審査が見る差分の範囲と取り込み判定

Revisor が扱う「その PR の変更」は 2 つの場面で使われる。 審査に渡す差分と、
取り込んでよいかの判定である。 どちらも次の 2 規則に従う。

## 1. 差分の基準は base branch の現在の先端だけ

**審査に渡すのは、base branch の現在の先端と head の merge-base から head までの
head 側の差分に限る。** base branch の現在の先端は、この merge-base を解決する基準として
使う。単純な `base..head` 比較は、base だけで進んだ変更を逆向きの差分として含みうるため、
審査対象には使わない。

他の PR がマージされて base が進んだぶんを、その PR の変更として数えてはならない。
数えると次が起きる。

- レビュアーが他人の変更を読まされ、指摘の宛先が分からなくなる
- `merge-risk` の `diff_size` が実態より大きく出て、 自動マージが不要に止まる
- Anatomia の変更関数が他人の関数まで含み、 孤立判定や複雑度差分が濁る

**base branch の現在の先端とは、 Revisor が実際に squash 先とするリポジトリの
base ref である。** Revisor は自分が所有する merge repository の上でマージし、
登録元 checkout は `checkout-publication.md` の条件を満たしたときにだけ追随する
(常時追従はしない)。 したがって**登録元 checkout の base ref を差分の起点にしてはならない** —
それは追随前の古い位置に留まっていることがあり、 その差は全部その PR の変更として
数えられてしまう。

差分の起点は、 head を base に取り込むときに実際に基準となる位置と一致させる。
head が base の内容を先に取り込んでいる (branch へ base をマージ済み) 場合も、
取り込み済みのぶんは差分に出てはならない。

## 2. 取り込み可否で気にするのはコンフリクトだけ

**base へ載せられるかどうかの判定は、コンフリクトの有無だけで行う。**

次はいずれも取り込みを止める理由にしない。

- 差分が大きいこと
- 審査後にヘッド SHA が変わったこと (rebase / 再コミットで SHA だけ変わる)
- 審査時の差分内容と現在の差分内容が一致しないこと

SHA と内容の同一性を取り込みの条件にすると、 base が動くたびに rebase が必要な運用で
「審査は通ったのに永久に取り込めない」 PR が溜まる。 審査結果は head に付き、
取り込めるかどうかは base との関係だけで決まる — この 2 つを混ぜない。

審査そのものの合否 (`review-gate.md`) と、 人間の判断を要求するかどうか
(`human-decision-board.md`) はこの規則の対象外。 ここで定義するのは
「base へ載せられるか」の判定だけである。

## 3. base への載せ替えは Revisor が受け持つ

**base が進んで head がそのままでは載らないとき、 現在の base へ載せ替えるのは Revisor
の仕事である。** 提出したセッションに rebase をやり直させない。

他 PR が 1 本マージされるたびに残りの PR が `action_required` へ落ち、 セッションが
手で rebase して再提出する運用は、 マージ 1 回につき残り全部の再作業を生む。 載せ替えは
Revisor が merge repository の中で決定的に実行できる作業であり、 人間の判断を必要としない。

- 載せ替えは **Revisor 所有の merge repository の中だけ**で行う。 登録元 checkout の
  ref・index・worktree・stash には触れない (`local-workspace.md` の境界と同じ)。
- 載せ替えた結果が衝突しない限り、 PR は `action_required` にしない。 審査結果は head に
  付いたまま引き継ぐ (規則 2 — SHA が変わっただけでは取り込みを止めない)。
- **衝突したときだけ**提出元へ返す。 返す情報は衝突したファイルの一覧で、 Revisor は
  自動解決しない。
- 提出元ブランチの履歴を Revisor が書き換えてはならない。 載せ替えは取り込みのための
  一時的な結果であって、 セッションの作業ブランチに対する破壊的操作ではない。

この規則は規則 1 と同じ帰結を持つ。 載せ替えの起点も、 差分の起点も、 「実際に squash 先と
なるリポジトリの base ref」である。

## 検証

- base が進んだ後の PR について、 審査へ渡る差分に他 PR の変更が含まれないこと
- 登録元 checkout の base ref が古いままでも、 差分の起点が merge repository の
  base ref であること
- head の SHA だけが変わった PR が、 コンフリクトしない限り取り込めること
- コンフリクトする head が、 差分の大小に関わらず取り込みを拒否されること
- 他 PR のマージで base が進んだ後、 衝突しない PR が `action_required` に落ちず、
  セッションの再 rebase 無しに取り込めること
- 載せ替えの前後で、 登録元 checkout の ref・index・worktree・stash が変化しないこと
- 衝突した場合に、 衝突ファイルの一覧が提出元へ返ること
