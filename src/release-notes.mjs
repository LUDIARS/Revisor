function compareUrl(repository, previousTag, tag) {
  const [owner, name, extra] = String(repository).split("/");
  if (!owner || !name || extra) {
    throw new TypeError(`Invalid GitHub repository '${repository}'.`);
  }
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
    + `/compare/${encodeURIComponent(previousTag)}...${encodeURIComponent(tag)}`;
}

export function composeReleaseNotes(
  pullRequest,
  mergeCommitSha,
  { repository = null, tag = null, previousTag = null, kind = "patch" } = {},
) {
  const body = String(pullRequest.body ?? "").trim();
  const notes = [
    `# ${pullRequest.title}`,
    body || "No additional release notes were provided.",
    "",
    `Revisor local PR: #${pullRequest.number}`,
    `Commit: ${mergeCommitSha}`,
  ];
  if (kind === "major" || kind === "minor") {
    if (!repository || !tag || !previousTag) {
      throw new TypeError(`${kind} release notes require repository, tag, and previousTag.`);
    }
    const label = kind === "major" ? "Major" : "Minor";
    notes.push(
      "",
      `## ${label} version release`,
      `Version transition: \`${previousTag}\` → \`${tag}\`.`,
      `[Compare ${previousTag}...${tag}](${compareUrl(repository, previousTag, tag)})`,
    );
  }
  return notes.join("\n");
}
