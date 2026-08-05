export class PublicationCoordinator {
  #chain = Promise.resolve();

  run(operation) {
    if (typeof operation !== "function") {
      throw new TypeError("Publication operation must be a function.");
    }
    const result = this.#chain.then(operation, operation);
    // A failed publication must not prevent the next repository operation from
    // running. The chain owns ordering only; callers still receive the failure.
    this.#chain = result.then(() => undefined, () => undefined);
    return result;
  }
}
