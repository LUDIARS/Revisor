import {
  initializeLocalVersion,
  inspectLocalVersionState,
} from "./local-version.mjs";
import { publishManualRelease } from "./manual-release.mjs";
import { nextManualReleaseTag } from "./release-version.mjs";

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

  async release(repositoryName, release) {
    const repository = this.#repository(repositoryName);
    return this.publicationCoordinator.run(() => this.publish({
      repository,
      ...release,
      env: this.env,
    }));
  }

  #repository(repositoryName) {
    const repository = this.store.getRepository(repositoryName);
    if (!repository) throw new Error(`Repository '${repositoryName}' is not registered.`);
    return repository;
  }
}
