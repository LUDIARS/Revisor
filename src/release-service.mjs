import {
  initializeLocalVersion,
  inspectLocalVersionState,
} from "./local-version.mjs";
import { publishManualRelease } from "./manual-release.mjs";
import { latestReleaseTag, nextManualReleaseTag } from "./release-version.mjs";
import { contract } from "./contract-runtime.mjs"; /* augur-inject:import:02a82258 */
import augurContract_02a82258 from "../contracts/manual-release-local-api.contract.mjs"; /* augur-inject:contract-predicate:02a82258 */
import { listLocalReleaseTags } from "./git-publication.mjs";
import { collectRepositoryChanges } from "./repository-changes.mjs";
import { git } from "./workspace.mjs";

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
      };
    }));
  }

  async initialize(repositoryName, version) {
    const repository = this.#repository(repositoryName);
    return this.publicationCoordinator.run(async () => {
      const registeredVersion = await this.initializeVersion(
        repository.rootPath,
        repository.baseRef,
        version,
      );
      return {
        repository: repository.repository,
        version: registeredVersion,
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
