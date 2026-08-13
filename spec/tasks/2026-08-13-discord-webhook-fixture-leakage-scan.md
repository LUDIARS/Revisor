# Discord webhook テスト fixture の流出スキャン回避

## 目的

実在しない Discord webhook URL を使うテスト fixture が、トークン長だけを根拠にした
流出スキャンへ誤検知されないようにする。

## 完了条件

- 有効 URL を検証する6箇所の fixture のトークン部を10文字未満にする。
- URL 検証・通知・暗号化設定の各テストの意図を維持する。
- `src/leakage.mjs` と allowlist のルールは変更しない。
- 対象テスト、構文検査、および webhook 流出パターン検索が成功する。
