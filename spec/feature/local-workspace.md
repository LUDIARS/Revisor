---
type: feature
title: "local-workspace — 使い捨て worktree とローカル ref の境界"
description: "review 元と Revisor 所有 merge repository の上で使い捨て detached worktree を作り、使い終えたら外す境界。ref / SHA 文字列の安全性検証、LFS フィルタ境界、差分内容の指紋、compare-and-swap による branch 前進、cleanup の best-effort 範囲を所有する。"
service: revisor
domain: local-workspace
tags:
  - git-worktree
  - ref-validation
  - patch-id
  - cleanup
  - git-lfs
status: implemented
related:
  - ./security-scan.md
  - ./merge-risk.md
  - ../architecture.md
  - ../plan/problem_logs/2026-08-09-merge-repository-source-ownership.md
updated: 2026-08-10
---

# local-workspace — 使い捨て worktree とローカル ref の境界

`src/workspace.mjs` は Revisor のローカル repository 操作を実行する境界である。
`src/merge-repository.mjs` は登録 checkout から head の Git object だけを取得し、
state data 配下の独立 repository を merge 境界として用意する。
`workspace.mjs` の実行責務は次に限定する。

- 呼出側から来た ref 文字列を Git ref として安全な形だけに絞る
- 固定 SHA を detached で checkout した使い捨て worktree を temp dir 配下に作る
- worktree が tracked change を抱えていないかを判定する
- 2 つのコミットの差分内容が同一かを判定できる指紋を返す
- 期待 SHA との compare-and-swap でローカル branch を fast-forward する
- 使い終えた worktree と temp dir を外す

## ref の安全性

`head_ref` / `base_ref` / 前進対象 branch は、絶対パス化・`..`・`@{`・`//` を含まない
限定文字集合だけを通す (先頭の `-` も拒否する)。Revisor は ref を
`refs/heads/<ref>` に組み立てるか、監視 checkout を戻す際に `git checkout <ref>` の
argv として渡すため、ここを抜けた文字列は Git の revision 構文や option として
再解釈されうる。
検証は文字列を受け取った入口 (`inspectLocalPullRequest` / `advanceLocalBranch`) で行う。

SHA も同じ扱いをする (`assertSafeSha`)。出所は Git 自身の出力か state に記録済みの Git の
出力に限られるが、`a..b` の revision range へ組み立てて argv に渡す境界では 16 進の object
name であることを確かめる。`-` 始まりの値が option として解釈される経路を残さない。

## 差分内容の指紋

`diffPatchId` は `merge-base(sha, baseSha)` から `sha` までの差分を `git patch-id --stable` にかけ、その
identifier を返す。rebase で SHA だけが変わったヘッドは指紋が一致するので、「審査した内容
そのものか」を SHA の同一性より広く判定できる (`spec/feature/merge-risk.md` の
`StaleReviewError`)。

差分が空なら空文字を返す。**非空の差分から identifier が取れない場合は例外にする。** 空文字を
返すと、内容の違う 2 つのヘッドが「同じ指紋」として一致してしまい、未審査の内容が審査済みと
して通る。比較不能は不一致ではなく失敗として呼出側へ渡し、判断は呼出側に委ねる。

## 使い捨て worktree の生成

審査と squash merge はどちらも、対象コミットを detached で checkout した temp dir 配下の
worktree だけを読む。作業中のローカル worktree を触らないので、レビュー対象は投稿時点の
SHA に固定され、利用者の未コミット作業も壊さない。生成途中で失敗した場合も、その場で
cleanup してから例外を投げる。

### LFS フィルタの境界

使い捨て review / integration worktree は実 LFS blob を必要とせず、pointer file の
内容だけを扱う。そのため worktree 生成とその中の squash / commit は
`gitWithoutLfs` を明示的に使う。この無効化を共通の `git` へ混ぜない。共通境界で
無条件に clean filter を外すと、reviewer autofix の `git add` などが実 blob を
LFS pointer へ変換せず commit しうるため。

監視中の実 checkout の status / fast-forward は、設定済み LFS filter をまず使う。
filter 実行ファイルが無いことを示す失敗に限り、filter を外して 1 回再試行する。
既に実 blob が materialize された checkout では、filter 無しの status がそれを
tracked change と検出するので前進を拒否する。pointer file のみを持つ LFS 未導入環境では、
pointer のまま安全に fast-forward できる。

## cleanup の best-effort 範囲

cleanup は 3 段で、後段ほど失敗を許容する。

1. `git worktree remove --force` を各 worktree に対して試す。部分的な生成では
   片方しか登録されていないため、個別の失敗は無視する。
2. `git worktree prune` で登録の残骸を落とす。
3. temp dir 本体を削除する。

3 のみ Windows で外的要因により失敗しうる。on-access スキャンや終了しかけの子プロセスが
一時的にハンドルを保持し、`rmdir` が EBUSY / EPERM を返す。まずリトライで待ち、それでも
消せなければ握り潰す。**削除できなかった temp dir を理由に review job を失敗させない。**
worktree 登録を外した後の temp dir は Git 管理外の使い捨てコピーであり、残っても審査結果にも
ローカル repository にも影響しない。一方で失敗扱いのレビューは再投稿を要求する実害がある
(2026-08-02 に EBUSY が同一 PR の審査を 2 回落とした)。Revisor 側に残骸を後から掃除する
経路は無く、OS の temp 掃除か手動削除に委ねる。

この非対称性のため、cleanup は `finally` からも生成失敗時の巻き戻しからも呼べる。
呼出側で元の例外や戻り値が cleanup の失敗に置き換わることはない。

## worktree の清潔さと branch 前進

ローカル branch を前進させる前に、期待 SHA と現在値の一致 (compare-and-swap) と、
その branch を checkout している worktree が tracked change を持たないことを確認する。
untracked file は判定に入れない。審査は固定 SHA を別の worktree で読むため untracked file は
到達せず、fast-forward も衝突しない untracked file を無視する (衝突する場合は Git 自身が
中断する)。submodule の未コミット内容も同様に無視し、submodule pointer の変更だけを
tracked change として扱う。checkout 中の worktree が無い場合は `update-ref` の
compare-and-swap、ある場合は `merge --ff-only` で前進する。

## 登録 checkout と merge repository の分離 (2026-08-08 neco 指示)

登録 `rootPath` はレビュー対象 branch を提供する source であり、merge の作業場所ではない。
Revisor は `revisor.state.json` と同じ data directory の `merge-repositories/` に repository
ごとの永続 clone を所有する。clone は object store も独立させ、branch を checkout しない。

この分離の結果、GitHub publication を通さない運用ではマージ済みの変更が登録 checkout へ
降りてこない。降ろす条件と担当は `spec/feature/checkout-publication.md` で定義する
(常時追従はしない。本ブランチが base ref のときだけ fast-forward)。

merge の直前に source から対象 head ref だけを clone へ fetch する。base ref は clone 作成時
だけ source から初期化し、以後は Revisor の publish または GitHub reconcile だけが CAS で
前進させる。squash worktree、prepared ref、release version、tag、push はすべて clone 上で
処理する。したがって merge 準備と merge 処理では、登録 checkout に tracked edit、untracked
file、ignored build tree があっても、Revisor は status/stash/checkout/reset を実行せず、それらを
merge 成否の条件にしない。merge 完了後に登録 checkout を前進させる任意の publication は
`checkout-publication.md` の別の安全条件に従う。

local clone / fetch transport は process cwd の merge repository とは別に登録 source の object
database を開く。sandbox account が作った source を service account が読む場合も、登録時に
検証済みの source 絶対 path と Git がそこから解決した absolute git directory だけを
command-scoped `safe.directory` として clone / fetch に渡す。linked worktree の git directory も
推測で組み立てない。`safe.directory=*` と global Git config の変更は行わない。
