# 設計書: リポジトリ別の公開ワークフロー選択 (GitHub Workflow / Revisor Workflow)

- 作成: 2026-08-12 / Claude Fable 5 (設計担当)
- 実装担当: Claude Opus 5 (delegation)。worktree `E:/Document/Ars/.wt-Revisor-defer-publish`
  (checkout branch `feat/workflow-selection`)。完了後は日本語 conventional commit。
  リモート送信・PR 提出は設計側。
- neco 指示 (2026-08-12): 「org ごとにルールはあるから、Revisor のパターンに
  GitHub Workflow と Revisor Workflow を選択できるようにしよう」
- 背景: LUDIARS org は GitHub App + Release 管理 (現行 Revisor Workflow)。
  MELPOT org は全 private で通常 push 可・App 不要。org ごとに公開経路が違うのに
  publisher が一本 (App 前提) のため、MELPOT が保留 (deferred) に落ちるしかない。

## 1. 仕様

### 1.1 workflow 属性

- リポ登録に `workflow: "revisor" | "github"` を追加 (既定 `"revisor"` = 現行不変)。
  - `revisor repo register --json-file` の JSON に `workflow` フィールド。
  - 既存登録の変更用に `revisor repo set-workflow <owner/name> <revisor|github>` を追加。
  - org 単位の既定: 設定 `REVISOR_ORG_WORKFLOWS` (例 `MELPOT=github`) を持ち、
    リポ個別指定 > org 既定 > グローバル既定 ("revisor") の優先順。
- `repo list` に workflow 列を表示。

### 1.2 マージ後の publish 分岐

- `workflow = "revisor"` (現行): GitHub App token → push + Release。App 未到達なら
  deferred (#467 の保留経路)。**挙動不変**。
- `workflow = "github"` (新設): GitHub App を使わず、登録 checkout のローカル git
  資格情報で `git push origin <baseRef>` する (fast-forward push。マージ結果を
  advanceLocalBranch した後の base ref をそのまま送る)。
  - 登録 checkout の `origin` を使うときは、対象リポジトリと一致する `github.com` の HTTPS
    または GitHub SSH URL に限定する。origin が無い場合は対象の HTTPS URL へフォールバックし、
    不一致や任意 transport は設定エラーにする。
  - Release 作成・remote tags 照会は行わない (ローカルタグは従来どおり作る)。
  - push 失敗 (資格情報・ネットワーク) は **deferred と同じ保留記録**に落として
    ローカルマージは完結させる (`publish-pending` が workflow に応じて後送)。
  - `.revisor-version` ゲート・審査ゲート・セキュリティスキャンは共通 (不変)。
- `publish-pending`: pending エントリごとにリポの workflow を見て経路を選ぶ
  (github workflow なら plain push の再試行)。

### 1.3 初期設定

シード/移行: `MELPOT` org の既存登録 (KuzuSurvivors 等) を `github` workflow へ
移行するための手順 (set-workflow コマンド実行例) を README か報告に明記。
自動移行はしない (明示コマンドで行う)。

## 2. テスト (既存流儀 node --test、fake git/fake client 注入)

1. workflow=github のマージ → App client が一切呼ばれず、fake push が
   `origin <baseRef>` で呼ばれる。ローカルタグは作られ Release は作られない。
2. workflow=github で push 失敗 → ローカルマージ完結 + pending 記録。
   `publish-pending` が push 再試行で解消。
3. workflow=revisor (既定) → 既存テスト挙動不変 (deferred-publish 5/5・local-merge 18/18 を含む)。
4. org 既定 (`REVISOR_ORG_WORKFLOWS=MELPOT=github`) が個別未指定リポに効き、
   個別指定が org 既定を上書きする。
5. `repo set-workflow` の入出力と validation (不正値拒否)。

## 3. 完了条件

- 上記テスト green (実行結果を報告)。既存テストも green。
- 変更ファイル一覧・コミット SHA。
- MELPOT 移行コマンド例と、KS で `pr merge` → plain push まで通る想定手順の記述
  (実 push の実行は設計側が行う)。

## 4. 禁止

リモート送信 / PR 作成 / 既存 revisor workflow の挙動変更 / ゲート・審査ロジック変更
