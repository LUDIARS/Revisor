# Revisor PR #179 のドメイン自動修正が同一審査へ反映されない

## 概要

- 発生日: 2026-08-04
- 対象: Revisor local PR #179
- 症状: 登録テストは成功し、レビュアーが `ui-http-boundary` の定義とspecを自動追加したが、判定は対象ドメイン未定義のまま `action_required` になった。

## 原因

対象ドメインの解析はレビュアー自動修正より前に行われる。同じ審査runでは、自動修正コミットで追加された `.anatomia/domains/ui-http-boundary.*.json` を使った再解析が行われないため、次の審査runまで旧解析結果が残る。

## 対応

自動修正headを保持したまま同じlocal PRを再審査へ戻し、新しいrunで `ui-http-boundary` のmembershipを解析させる。

## 検証

- 自動修正headにドメイン定義、責務spec、対象path membershipが存在することを静的に確認した。
- セッション方針に従い、ローカルテストは実行しない。Revisorの登録済みunit/checkと再審査で確認する。

## 再発防止

対象ドメイン未定義をレビュアーが自動修正した場合は、そのrunの旧判定だけで再修正せず、新しいheadで再解析する再審査を一度行う。
