function compareUrl(repository, previousTag, tag) {
  const [owner, name, extra] = String(repository).split("/");
  if (!owner || !name || extra) {
    throw new TypeError(`Invalid GitHub repository '${repository}'.`);
  }
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
    + `/compare/${encodeURIComponent(previousTag)}...${encodeURIComponent(tag)}`;
}

function escapeMarkdown(value) {
  return String(value).replace(/([\\`*_[\]<>])/g, "\\$1");
}

export function composeReleaseNotes({ repository, tag, previousTag, kind, changes = [] }) {
  if (kind === "initial") return "";
  if (kind !== "major" && kind !== "minor") {
    throw new TypeError("Release Notes are created only for initial, major, or minor Releases.");
  }
  if (!repository || !tag || !previousTag) {
    throw new TypeError(`${kind} release notes require repository, tag, and previousTag.`);
  }
  const label = kind === "major" ? "Major" : "Minor";
  const notes = [
    `## ${label} version release`,
    "",
    `Version transition: \`${previousTag}\` → \`${tag}\`.`,
    "",
    `## Changes since ${previousTag}`,
    "",
    ...changes.map(({ sha, subject }) =>
      `- ${escapeMarkdown(subject)} (\`${String(sha).slice(0, 12)}\`)`),
  ];
  if (changes.length === 0) notes.push("- No commit differences.");
  notes.push(
    "",
    `[Compare ${previousTag}...${tag}](${compareUrl(repository, previousTag, tag)})`,
  );
  return notes.join("\n");
}
