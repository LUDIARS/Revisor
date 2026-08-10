# バックエンド非依存の CLI 運用

Revisor の審査・マージ・PR 提出を、常駐バックエンド無しで完結させる。

## なぜ

Revisor 自身や Concordia が落ちている状況で、Revisor でしか入れられない変更 (Revisor や
Concordia の復旧 PR そのもの) が詰まる。 常駐プロセスが「審査キューの記憶」を持っていたため、
サービスの生死が作業の可否を決めていた。

## 形

| 面 | 所有者 |
|----|--------|
| PR 記録 | `revisor.state.json` (既存) |
| 審査キュー | `revisor.jobs.json` (`src/job-store.mjs`) |
| 審査の実行 | 短命ワーカー `revisor run-worker` (`src/worker-command.mjs`) |
| 投入・参照・マージ | CLI (`src/local-pr-commands.mjs`) |
| Web UI | `revisor serve` — **任意**。審査の進行には関与しない |

キューは記憶ではなく記録にした。 投入した CLI プロセスは job を書いてワーカーの起動を
確かめたら終わってよく、審査の完了まで生き続ける必要が無い。

### SPEC-DAEMONLESS-PERSISTENT-QUEUE: 永続審査キュー

`PersistentPrReviewQueue` は job の投入・参照だけを担当し、同じヘッドの未終了 job を再利用する。
投入完了後に短命ワーカーを起こすが、起動失敗で記録済み job を失敗扱いにはしない。
同じヘッドの同時提出は state の lock 内で 1 PR にまとめる。PR 作成後、jobId の state 反映前に
投入プロセスが落ちた場合は、次の提出が既存 queued job の reporter を再実行して対応を補修する。

### SPEC-DAEMONLESS-WORKER-DRAIN: 短命ワーカー

`revisor run-worker` はキューが空になるまで審査を回して終わる。 走っている間は presence lock
(`revisor.jobs.json.worker`) を保持し、投入側はそれを見て多重起動を避ける。 取りこぼして
2 本起動しても、claim は排他なので同じ job は二重実行されない。

起動は「子が ready を名乗るまで親が待つ」。 spawn イベントは起動完了ではなく、親が先に
終了すると Windows では子ごと消える。

最後の空確認から presence lock の解放までに投入された job も取り残さない。ワーカーは
presence を解放した後でキューを再確認し、積み残しがあれば lock を取り直して drain を続ける。
解放後に投入された側は presence が無いことを見て、新しいワーカーを起動する。

### 中断の拾い直し

常駐しないので判定が単純になる: `running` なのに保持プロセスが居ない job が、そのまま中断の
証拠になる。 時間しきい値も前回起動の記憶も要らない。 試行上限 (2) を超えたものは queued に
戻さず `failed` で終局させる — 無条件に戻すと落ち続ける job がキューに永住する。

サーバ起動時の一括再投入と 60 秒周期の auto-merge sweep タイマーは、どちらもサーバの生存に
依存する仕掛けなので撤去した。 sweep はワーカーが自分の周回の最後に 1 回行い、`revisor sweep`
から手動でも回せる。

### SPEC-DAEMONLESS-PROCESS-LOCKS: プロセス間の相互排他

state と job の read-modify-write、および base ref を進める publication は、別プロセスから
同時に走りうる。 `src/file-lock.mjs` のディレクトリ作成ロックで直列化し、保持者が死んだ
ロックは pid 生存判定で奪う。 待ちは有限 — 無期限に待つと、詰まった 1 プロセスがすべての
コマンドを黙って積み上げ、常駐を捨てた意味が無くなる。

正常な pid の lock は処理時間だけで stale にしない。解放時は取得時の token が一致する lock
だけを消し、古い保持者の後始末が後から取得した保持者の lock を消さない。

## バイパスマージ

サービス停止中に最小限の対応で動作状況を確保するための、**CLI 限定**経路。

```
revisor pr merge <number> --bypass --reason "<なぜ審査を通せないか>"
```

- 外すのは審査「状態」のゲートだけ: `Test OK` であること、審査済みヘッドと現在ヘッドの
  内容一致。 どちらも審査基盤が動いていることを前提にした条件で、止まっている間は満たせない。
- **実 finding を出したセキュリティスキャンは通常どおり止める。** 外れるのはスキャン基盤の
  system failure だけで、これはスキャンごと落ちている状況こそがバイパスを使う場面だから。
- `--reason` は必須。 後追いレビューの対象を記録から特定できることが、この経路を許す条件。
- マージ結果には `bypassMerge` (理由・実行者・マージ時点の checkStatus・審査済みヘッド・時刻・
  後追いレビュー済みか) が付く。 通知も `bypass_merged` として通常のマージと区別する。
- HTTP 経路はこの引数を渡さない。 Web UI からバイパスマージはできない。

復旧後の後追い:

```
revisor pr bypassed                      # 後追いレビュー待ち一覧
revisor pr bypass-reviewed <number> --note "<確認結果>"
```

## 入力の形

`pr submit` と `repo register` は HTTP API と同じ JSON 本文を第一級の入力にしている
(`--json-file` / `--json-stdin`)。 検証器 (`local-contracts.mjs`) を共有しないと「API では通るが
CLI では通らない」差が必ず生まれる。 日本語の title / body をシェル引数に直書きすると環境に
よって壊れるため、本文はファイル経由を正とする。

## 残っているもの

- `src/queue.mjs` (`PrReviewQueue`) は production 経路から外れ、テストが審査を同期実行する
  ための実行体としてのみ残っている。 テスト側の置き換えは別途。
- Web UI の実行状況パネルは、サーバが段階ワーカーを持たなくなったため空の queues を表示する。
  ワーカー側の状態を UI へ出すなら、job 記録に stage 情報を持たせる必要がある。
