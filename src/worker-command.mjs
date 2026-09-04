import { tryAcquireLock } from "./file-lock.mjs";
import { createReviewContext } from "./review-context.mjs";
import { createPrReviewRunner } from "./runner.mjs";
import { ReviewStageWorkers } from "./review-stage-workers.mjs";
import { workerPresencePath } from "./worker-spawn.mjs";
import { clearWorkerState, writeWorkerState } from "./worker-state.mjs";
import { drainReviewJobs } from "./review-job-scheduler.mjs";

/**
 * 短命ワーカー。 キューが空になるまで審査を回して終わる。
 *
 * 常駐しないので「起動時に何を拾い直すか」が単純になる: running のまま保持プロセスが
 * 居ない job がそのまま中断の証拠で、時間しきい値も前回起動の記憶も要らない。
 *
 * 走っている間は presence lock を保持し、投入側はそれを見て多重起動を避ける。
 *
 * @implements SPEC-DAEMONLESS-WORKER-DRAIN
 * @implements SPEC-PR-NARRATIVE-RECONCILIATION
 */
export async function runReviewWorker({
  cwd = process.cwd(),
  env = process.env,
  createContext = createReviewContext,
  createStageWorkers = (options) => new ReviewStageWorkers(options),
  createRunner = createPrReviewRunner,
  log = (message) => process.stdout.write(`${message}\n`),
  signalReady = () => process.send?.({ type: "ready" }),
} = {}) {
  const context = createContext({ cwd, env });
  const presencePath = workerPresencePath(context.jobs.path);
  let release = tryAcquireLock(presencePath, { label: "review-worker" });
  if (!release) {
    // 既に走っているワーカーが同じキューを空にする。 二重に回す意味は無い。
    signalReady();
    return { ran: 0, skipped: true };
  }
  let stageWorkers;
  let ran = 0;
  try {
    // サーバは審査を実行しないので、 プールの状態はこのプロセスにしか無い。 UI が
    // 実際の稼働本数を出せるよう、 状態が動くたびにファイルへ書いて公開する。
    stageWorkers = createStageWorkers({
      size: context.settings.workerCount,
      fastLaneSlots: context.settings.fastLaneSlots,
      cwd,
      env,
      onStateChange: (state) => writeWorkerState(context.jobs.path, state),
    });
    writeWorkerState(context.jobs.path, stageWorkers.state());
    const runner = createRunner({
      cwd,
      env,
      scheduleWork: (work, options) => stageWorkers.run(work, options),
      // 短命ワーカーは審査の途中で落ちうる。 段階が通るたびにチェックポイントを
      // 書いておくと、 次のワーカーは残りの段階だけを実行でき、 通過済みの
      // モデルレビューや登録テストをやり直さずに済む (spec/feature/crash-recovery.md)。
      onReviewStageCompleted: (checkpoint) => context.reporter.reviewStageCompleted(checkpoint),
      onNarrativeReconciled: ({ localPrId, ...narrative }) =>
        context.reporter.narrativeReconciled(localPrId, narrative),
    });
    // 初期化と presence 取得が済んでから ready を返す。 spawn イベントだけでは、
    // 親が先に終わった Windows の子プロセスが実行可能になった証拠にならない。
    signalReady();

    const reclaimed = await context.jobs.reclaimAbandoned();
    if (reclaimed.requeued.length > 0 || reclaimed.exhausted.length > 0) {
      log(
        `Revisor worker reclaimed abandoned jobs: requeued=${reclaimed.requeued.length}`
        + ` exhausted=${reclaimed.exhausted.length}`,
      );
    }
    for (const job of reclaimed.exhausted) {
      await context.reporter.failed({ ...job, error: job.error });
    }
    const recovered = await context.localPrService.recoverInterruptedReviews();
    log(
      `Revisor worker recovered interrupted reviews: recovered=${recovered.recovered.length}`
      + ` failed=${recovered.failed.length}`,
    );
    for (;;) {
      const drained = await drainReviewJobs({
        jobs: context.jobs,
        concurrency: context.settings.workerCount,
        reservation: context.settings.fastLaneSlots,
        run: (job) => runOne({ job, context, runner }),
      });
      ran += drained.ran;
      // 60 秒周期のスイープの置き換え。 base が進んで squash が通るようになった Test OK は
      // 「誰かが審査を終えた直後」に拾えれば足りる。 常駐タイマーは要らない。
      const summary = await context.localPrService.sweepAutoMerge();
      if (summary.merged > 0 || summary.failed > 0) {
        log(`Revisor auto-merge sweep: merged=${summary.merged} failed=${summary.failed}`);
      }

      // 最後の claim と lock 解放の間に投入された job は、投入側からは worker が生存中に
      // 見えるため新しい子を起動しない。先に presence を解放してからキューを再確認すれば、
      // その窓の投入はこの worker が拾い、解放後の投入は投入側が新しい worker を起こす。
      release();
      release = null;
      const queuedState = context.jobs.state();
      if (queuedState.queued === 0) return { ran, skipped: false };
      const hasRunnableStandard = queuedState.jobs.some((job) =>
        job.status === "queued" && (job.reviewLane ?? job.request?.reviewLane) !== "fast");
      if (drained.heldFast > 0 && !hasRunnableStandard) {
        log(
          `Revisor worker held ${drained.heldFast} fast-lane job(s): no fast-lane slot is configured.`,
        );
        return { ran, skipped: false, heldFast: drained.heldFast };
      }
      release = tryAcquireLock(presencePath, { label: "review-worker" });
      if (!release) return { ran, skipped: false };
    }
  } finally {
    await stageWorkers?.close?.();
    clearWorkerState(context.jobs.path);
    release?.();
  }
}

async function runOne({ job, context, runner }) {
  try {
    await context.reporter.running(job);
    const result = await runner(job.request);
    await context.jobs.settle(job.id, { status: "completed" });
    await context.reporter.completed({ ...job, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await context.jobs.settle(job.id, { status: "failed", error: message });
    // reporter 側の失敗で残りの job まで落とさない。 この job の終局は既に記録済み。
    try {
      await context.reporter.failed({ ...job, error: message });
    } catch {
      // 通知と board 反映は best-effort。
    }
  }
}
