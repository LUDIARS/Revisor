import {
  initializeLocalVersion,
  inspectLocalVersionState,
} from "./local-version.mjs";
import { publishManualRelease } from "./manual-release.mjs";
import { resolveManualReleaseChannel } from "./manual-release-channel.mjs";
import { latestReleaseTag, nextManualReleaseTag } from "./release-version.mjs";
import { contract } from "./contract-runtime.mjs"; /* augur-inject:import:02a82258 */
import augurContract_02a82258 from "../contracts/manual-release-local-api.contract.mjs"; /* augur-inject:contract-predicate:02a82258 */
import { listLocalReleaseTags } from "./git-publication.mjs";
import { collectRepositoryChanges } from "./repository-changes.mjs";
import { git } from "./workspace.mjs";
import { advanceMergeBaseAfterBootstrap } from "./merge-repository.mjs";

function nextVersions(state) {
  if (state.status !== "ready") return { nextMajor: null, nextMinor: null };
  return {
    nextMajor: nextManualReleaseTag(state.version, "major").slice(1),
    nextMinor: nextManualReleaseTag(state.version, "minor").slice(1),
  };
}

export class ReleaseService {
  constructor({
    store,
    publicationCoordinator,
    env = process.env,
    initializeVersion = initializeLocalVersion,
    publish = publishManualRelease,
    inspectVersion = inspectLocalVersionState,
    listTags = listLocalReleaseTags,
    collectChanges = collectRepositoryChanges,
    runGit = git,
    advanceMergeBase = advanceMergeBaseAfterBootstrap,
  }) {
    if (!store || !publicationCoordinator) {
      throw new TypeError("Release service requires a store and publication coordinator.");
    }
    this.store = store;
    this.publicationCoordinator = publicationCoordinator;
    this.env = env;
    this.initializeVersion = initializeVersion;
    this.publish = publish;
    this.inspectVersion = inspectVersion;
    this.listTags = listTags;
    this.collectChanges = collectChanges;
    this.runGit = runGit;
    this.advanceMergeBase = advanceMergeBase;
  }

  async listProjects() {
    return Promise.all(this.store.listRepositories().map(async (repository) => {
      const version = await this.inspectVersion(repository.rootPath);
      return {
        repository: repository.repository,
        rootPath: repository.rootPath,
        baseRef: repository.baseRef,
        version,
        ...nextVersions(version),
        ...this.#releaseChannel(repository),
      };
    }));
  }

  // 画面と自動化が「GitHub Release を作れるか・既定で作るか」を公開前に知るため。
  #releaseChannel(repository) {
    const channel = resolveManualReleaseChannel({ repository, env: this.env });
    return {
      workflow: channel.workflow,
      githubReleaseAvailable: channel.githubReleaseAvailable,
    };
  }

  async initialize(repositoryName, version) {
    const repository = this.#repository(repositoryName);
    return this.publicationCoordinator.run(async () => {
      // 初期化コミットは登録 checkout の base に積まれる。 merge repository の base にも
      // 同じコミットを載せないと、 次のマージで 2 つの base が別系列になる。 publication と
      // 同じ coordinator の中で行うので、 マージが base を並行して動かすことはない。
      let mergeBase = null;
      const registeredVersion = await this.initializeVersion(
        repository.rootPath,
        repository.baseRef,
        version,
        {
          onBootstrapCommitted: async ({ parentSha, bootstrapSha }) => {
            mergeBase = await this.advanceMergeBase({
              repository,
              statePath: this.store.path,
              baseRef: repository.baseRef,
              parentSha,
              bootstrapSha,
            });
          },
        },
      );
      return {
        repository: repository.repository,
        version: registeredVersion,
        // 初期化コミットを作らなかった (既に追跡済みだった) ときは null。
        // not-in-step は merge repository が初期化前から揃っていなかったことを示す。
        ...(mergeBase ? { mergeBase } : {}),
      };
    });
  }

  async release(repositoryName, request) {
    const repository = this.#repository(repositoryName);
    return release(repository, request, {
      publicationCoordinator: this.publicationCoordinator,
      publish: this.publish,
      env: this.env,
    });
  }

  async releaseState(repositoryName) {
    const repository = this.#repository(repositoryName);
    const version = await this.inspectVersion(repository.rootPath);
    const latestTag = latestReleaseTag(await this.listTags(repository.rootPath, repository.baseRef));
    const changes = await this.collectChanges({
      repository,
      store: this.store,
      runGit: this.runGit,
      listTags: this.listTags,
    });
    return {
      repository: repository.repository,
      id: repository.id,
      version,
      latestReleaseTag: latestTag,
      nextMajor: version.status === "ready" ? nextManualReleaseTag(version.version, "major") : null,
      nextMinor: version.status === "ready" ? nextManualReleaseTag(version.version, "minor") : null,
      unreleasedCommitCount: changes.commits.length,
      ...this.#releaseChannel(repository),
    };
  }

  #repository(repositoryName) {
    const repository = this.store.getRepository(repositoryName);
    if (!repository) throw new Error(`Repository '${repositoryName}' is not registered.`);
    return repository;
  }
}

export async function release(repository, request, options) {
  return options.publicationCoordinator.run(() => options.publish({
    repository,
    ...request,
    env: options.env,
  }));
}

// @ts-expect-error augur-inject
release = contract(release, {
  ...augurContract_02a82258,
  contractId: "C-4",
  mode: "observe",
  sample: 1,
  where: "src/release-service.mjs:20",
  id: "02a82258",
}); /* augur-inject:contract-wrap:02a82258 */
