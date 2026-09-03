---
type: feature
title: "runtime-diagnostics — how the service ended, in its own log"
description: "サービスの開始・終了・例外・signal・RSS・event loop lag を Vestigium ログ配下に 1 行 1 レコードで残し、 再起動の原因を後から言い分けられるようにする境界。"
service: revisor
domain: runtime-diagnostics
tags:
  - observability
  - crash
  - lifecycle
status: implemented
related:
  - ./service-bootstrap.md
  - ../plan/problem_logs/2026-08-09-restart-storm-without-crash-evidence.md
updated: 2026-09-04
---

# runtime-diagnostics — how the service ended, in its own log

Revisor は 1 日に 20 回以上再起動していたが、 プロセスログには例外が 1 件も残って
いなかった。 「落ちた」 のか 「止められた」 のかが区別できない限り、 再起動ループの
原因は推測にしかならない。 この責務は、 終わり方そのものを記録することだけを担う。

`serve` は listener を作る前に診断を据える。 起動自体が失敗した回も記録に残す。

記録する event:

| event | 意味 |
| --- | --- |
| `service_started` | 起動。 node version と検証済み command と heartbeat 間隔 |
| `service_start_failed` | heartbeat 設定または listener 起動の失敗。秘密除去済みの原因付き |
| `heartbeat` | RSS / heap / external / event loop lag / uptime |
| `signal_received` | 監督者や端末からの停止要求 (signal と明示的な終了理由付き) |
| `uncaught_exception` | 自分で落ちた。 stack 付き。 記録後に終了する |
| `unhandled_rejection` | 握られなかった Promise。 stack 付き。 終了はしない |
| `process_exit` | 終了コードと、先行 signal を考慮した終了理由 |

マージ経路も同じ記録に乗せる。 これまで残っていたのは失敗した 1 行だけで、 「どの段で
止まったか」 も 「なぜマージされずに残り続けるのか」 も後から言えなかった。

| event | 意味 |
| --- | --- |
| `merge_refused` | Open / Test OK でない PR のマージ要求 |
| `merge_attempt_started` | base / head / 審査済み SHA |
| `merge_head_moved_since_review` | 審査時と head が違う (引き継ぎ判定に入る) |
| `merge_prepared_reused` | 中断した公開の再開 |
| `merge_conflict_detected` | コンフリクトしたファイル名 (最大 50) と git の出力 |
| `merge_squash_committed` | squash commit ができた |
| `merge_completed` | 公開まで終わった。 release tag 付き |
| `merge_base_reconcile_started` | GitHub 側だけ進んだ base の取り込み |
| `auto_merge_skipped` | 自動マージを見送った理由 (状態は書き換えない) |
| `review_worker_spawned` / `review_worker_exited` | ワーカーの生死。 worker pid / code / signal 付き |

自由文 (git の出力、 stack) は、配列や object の内側も含めてこの境界で秘密除去と
長さ制限をかける。 共有 redactor が見ない認証 header、URL userinfo、credential 名の
field もここで潰し、object の `toJSON` hook は実行しない。
個々の値・collection・nesting depth に加えて JSONL record 全体も 64 KiB に収め、巨大な
例外 object がログ I/O と event loop を占有しないようにする。
起動 command は検証済みの `serve` / `ui` だけを記録し、実行ファイルの絶対 path は
記録しない。マージ記録も repository 名と PR ID で識別し、local root path は重ねて残さない。

出力先は Excubitor が注入する `VESTIGIUM_LOGS_DIR` 配下の `revisor/YYYY-MM-DD.jsonl`
(`REVISOR_LOG_DIR` で上書き可)。 注入が無い環境では stderr だけに出す。 診断の書き込みが
失敗してもサービスは止めない。新規 directory / file は POSIX でそれぞれ `0700` / `0600`
として作り、redaction 後の運用 metadata も他 account へ既定公開しない。

`heartbeat` の 2 値は仮説の検証のためにある。 RSS が単調増加するなら memory-leak 警報の
裏が取れ、 event loop lag が伸びるなら health probe の失敗はプロセスの死ではなく無応答
である。 間隔は `REVISOR_HEARTBEAT_MS` (既定 30 秒)。 Node timer が 1ms に丸める 0 以下・
非整数・上限超過の値は起動時に拒否し、誤設定からログ storm を作らない。

signal の observer は記録後に自身を外す。`serve` の shutdown hook が既にあれば元の signal を
そのまま委ね、起動途中で observer しかいなければ同じ signal を再送して Node の既定終了へ
委ねる。診断を足したことで graceful shutdown や既定終了を抑止してはならない。

## SPEC-SERVE-EXIT-REASON: serve は終わる理由を残す

`revisor serve` は短い間隔で入れ替わることがある。審査から切り離した以上それ自体は
走行中の審査を巻き込まないが、終了理由を明示しなければ監督者による再起動と自身の異常終了を
区別できない。`signal_received` と `process_exit` の `reason` に、次の互いに異なる文言を残す。

| 経路 | 文言 | 読み方 |
|---|---|---|
| signal あり | `stopping on <signal> (external stop request)` | 外から止められた |
| signal 無し・code=0 | `exiting normally (code=0)` | 通常終了 |
| signal 無し・code≠0 | `exiting on its own with code=<n> (not an external stop)` | 自分で落ちた |

signal を受けた後の `process_exit` は終了コードだけで再分類せず、先に受けた signal を優先する。
signal 後の graceful shutdown が code 0 になっても通常終了と誤記録しないためである。

`uncaughtException` を握った Node は既定では走り続ける。 それは監督者から見て
「生きているが壊れている」 状態になるため、 記録した直後に終了して再起動へ委ねる。
