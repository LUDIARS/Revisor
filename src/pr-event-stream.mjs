// Process-local fan-out for state changes. The state file remains the source of
// truth; events are only an invalidation signal telling connected UIs to fetch a
// fresh, fully projected PR. This keeps review output and secrets out of the
// WebSocket payload.
export class PrEventStream {
  #listeners = new Set();

  publish = (event) => {
    const message = Object.freeze(structuredClone(event));
    for (const listener of this.#listeners) {
      try {
        listener(message);
      } catch {
        // A disconnected UI must never make a successful state write fail.
      }
    }
  };

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
