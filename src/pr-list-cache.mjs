export class PrListCache {
  #version = null;
  #settingsKey = null;
  #value = null;

  // Returned arrays and their records are shared. Callers that mutate them must copy first.
  /** @implements SPEC-PR-LIST-CACHE */
  read({ version, settingsKey, build }) {
    if (version !== null && version === this.#version && settingsKey === this.#settingsKey) {
      return this.#value;
    }
    const value = build();
    if (version !== null) {
      this.#version = version;
      this.#settingsKey = settingsKey;
      this.#value = value;
    }
    return value;
  }
}

/** @implements SPEC-PR-LIST-CACHE */
export function decisionSettingsKey(settings) {
  return JSON.stringify([
    settings?.autoMergeEnabled ?? false,
    settings?.autoMergeRiskThreshold ?? null,
    settings?.autoMergeRequiresRuntimeVerificationClear ?? null,
  ]);
}

export class SerializedListBody {
  #source = null;
  #body = null;

  /** @implements SPEC-PR-LIST-CACHE */
  render(source, build) {
    if (this.#source !== source || this.#body === null) {
      this.#body = build();
      this.#source = source;
    }
    return this.#body;
  }
}
