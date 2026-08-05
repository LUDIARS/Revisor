const VERSION_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parse(tag) {
  const match = VERSION_TAG.exec(tag);
  if (!match) return null;
  const version = match.slice(1).map(Number);
  return version.every(Number.isSafeInteger) ? version : null;
}

function compare(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function latestReleaseTag(tags) {
  const versions = [...new Set(tags)].map(parse).filter(Boolean).sort(compare);
  if (versions.length === 0) return null;
  const [major, minor, patch] = versions.at(-1);
  return `v${major}.${minor}.${patch}`;
}

export function nextManualReleaseTag(currentVersion, kind) {
  if (kind !== "major" && kind !== "minor") {
    throw new Error("Manual release kind must be 'major' or 'minor'.");
  }
  const currentTag = String(currentVersion).startsWith("v")
    ? String(currentVersion)
    : `v${currentVersion}`;
  const current = parse(currentTag);
  if (!current) throw new Error(`Current version '${currentVersion}' is not canonical.`);
  const nextMajor = kind === "major" ? current[0] + 1 : current[0];
  const nextMinor = kind === "major" ? 0 : current[1] + 1;
  if (!Number.isSafeInteger(nextMajor) || !Number.isSafeInteger(nextMinor)) {
    throw new Error(`Version cannot advance beyond '${currentTag}'.`);
  }
  return `v${nextMajor}.${nextMinor}.0`;
}
export function classifyReleaseKind(previousTag, nextTag) {
  const next = parse(nextTag);
  if (!next) throw new Error(`Release tag '${nextTag}' is not canonical.`);
  if (previousTag === null) return "initial";
  const previous = parse(previousTag);
  if (!previous) throw new Error(`Release tag '${previousTag}' is not canonical.`);
  if (
    next[0] === previous[0] + 1
    && next[1] === 0
    && next[2] === 0
  ) {
    return "major";
  }
  if (
    next[0] === previous[0]
    && next[1] === previous[1] + 1
    && next[2] === 0
  ) {
    return "minor";
  }
  if (
    next[0] === previous[0]
    && next[1] === previous[1]
    && next[2] === previous[2] + 1
  ) {
    return "patch";
  }
  throw new Error(`Release transition '${previousTag}' -> '${nextTag}' is not sequential.`);
}

export function selectReleaseTag({ releasedTags, localVersion }) {
  if (localVersion === "uninitialized") {
    return { tag: null, kind: "none" };
  }
  const requestedTag = `v${localVersion}`;
  const requested = parse(requestedTag);
  if (!requested) throw new Error(`Local version '${localVersion}' is not canonical.`);
  const currentTag = latestReleaseTag(releasedTags);
  if (!currentTag) return { tag: requestedTag, kind: "initial" };
  if (requestedTag === currentTag) {
    return { tag: null, kind: "none" };
  }
  const current = parse(currentTag);
  const isMajor = requested[0] === current[0] + 1
    && requested[1] === 0
    && requested[2] === 0;
  const isMinor = requested[0] === current[0]
    && requested[1] === current[1] + 1
    && requested[2] === 0;
  if (!isMajor && !isMinor) {
    throw new Error(
      `Local version '${localVersion}' must equal '${currentTag}' or declare its next human-selected major/minor version. Patch Releases are not created.`,
    );
  }
  return { tag: requestedTag, kind: isMajor ? "major" : "minor" };
}

export function isReleaseTag(tag) {
  return VERSION_TAG.test(tag);
}
