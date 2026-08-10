import { withFileLock } from "./file-lock.mjs";

/** @implements SPEC-DAEMONLESS-PROCESS-LOCKS */
export class PublicationCoordinator {
  #chain = Promise.resolve();

  constructor({ lockPath = null } = {}) {
    this.lockPath = lockPath;
  }

  run(operation) {
    if (typeof operation !== "function") {
      throw new TypeError("Publication operation must be a function.");
    }
    const execute = () => this.lockPath
      ? withFileLock(this.lockPath, operation, { label: "publication" })
      : operation();
    const result = this.#chain.then(execute, execute);
    // A failed publication must not prevent the next repository operation from
    // running. The chain owns ordering only; callers still receive the failure.
    this.#chain = result.then(() => undefined, () => undefined);
    return result;
  }
}
