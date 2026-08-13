import { optionalDiscordWebhookUrl, readSettings } from "./config.mjs";
import {
  notifyConcordia,
  notifyConcordiaChat,
  optionalConcordiaUrl,
} from "./concordia-context.mjs";
import { JobStore, resolveJobsPath } from "./job-store.mjs";
import { LocalPrReporter } from "./local-reporter.mjs";
import { LocalPrService } from "./local-pr-service.mjs";
import { PersistentPrReviewQueue } from "./persistent-queue.mjs";
import {
  notifyPullRequestLifecycle,
  notifyPullRequestLifecycleWebhook,
} from "./pr-lifecycle-notice.mjs";
import { postDiscordWebhook } from "./discord-webhook.mjs";
import { PublicationCoordinator } from "./publication-coordinator.mjs";
import { notifyReviewCompletion } from "./review-completion-notice.mjs";
import { resolveDbPath } from "./revisor-db.mjs";
import { LocalPrStore } from "./state-store.mjs";

/**
 * PR 記録 / キュー / 審査サービスの組み立て。
 *
 * 常駐サーバもワーカーも 1 回きりの CLI も、必要とするのは同じこの組。 唯一の違いは
 * イベント配信 (UI 用) を持つかどうかで、そこだけ呼び出し側から挿す。 組み立てを 1 か所に
 * 集めておかないと、「バックエンド経由なら通るが CLI からは通らない」経路が生まれる。
 */
export function createReviewContext({
  cwd = process.cwd(),
  env = process.env,
  onEvent = () => {},
  onWorkerError = () => {},
  stateStore,
  jobStore,
  startWorker,
  postWebhook = postDiscordWebhook,
} = {}) {
  const settings = readSettings(env);
  const statePath = stateStore?.path ?? resolveDbPath(env);
  const store = stateStore ?? new LocalPrStore({ path: statePath, onEvent });
  const jobs = jobStore ?? new JobStore({ path: resolveJobsPath(env) });
  // Promise chain だけでは別プロセスの CLI / worker / server を直列化できない。
  // state と同じ設定領域に publication lock を置き、base ref を進める全経路で共有する。
  const publicationCoordinator = new PublicationCoordinator({
    lockPath: `${statePath}.publication`,
  });
  // 後付けで束ねる: reporter はマージを持つサービスより先に組み上がるが、審査が着地した
  // 瞬間に自動マージへ進む必要がある。
  let localPrService;
  const announceCompletion = (pullRequest) => notifyReviewCompletion({
    pullRequest,
    baseUrl: optionalConcordiaUrl(cwd, readSettings(env).concordiaContextEnabled),
    notify: notifyConcordia,
  });
  const announceLifecycle = async (event, pullRequest) => {
    const webhookUrl = optionalDiscordWebhookUrl(env);
    if (webhookUrl) {
      return notifyPullRequestLifecycleWebhook({
        event,
        pullRequest,
        url: webhookUrl,
        post: postWebhook,
      });
    }
    return notifyPullRequestLifecycle({
      event,
      pullRequest,
      baseUrl: optionalConcordiaUrl(cwd, true),
      notify: notifyConcordiaChat,
    });
  };
  const reporter = new LocalPrReporter(store, {
    afterCompleted: (id) => localPrService?.autoMergeIfEligible(id),
    notifyCompletion: announceCompletion,
    notifyReviewStatus: announceLifecycle,
  });
  const queue = new PersistentPrReviewQueue({
    jobs,
    reporter,
    cwd,
    env,
    onWorkerError,
    ...(startWorker ? { startWorker } : {}),
  });
  localPrService = createLocalPrService();

  function createLocalPrService() {
    // `env` はサービスまで届ける必要がある: マージ前セキュリティスキャンも自動マージの
    // リスク閾値もここから設定を解決するので、process.env のままだと UI が読み書きする
    // 設定と違う条件で判断してしまう。
    return new LocalPrService({
      store,
      queue,
      jobs,
      env,
      notifyLifecycle: announceLifecycle,
      publicationCoordinator,
    });
  }

  return { settings, store, jobs, queue, reporter, localPrService, publicationCoordinator };
}
