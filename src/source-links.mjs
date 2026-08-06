/** @implements SPEC-LOCAL-PR-SOURCE-LINKS */
function markdownLabel(value) {
  return String(value).replace(/[\\[\]]/g, "\\$&");
}

/** @implements SPEC-LOCAL-PR-SOURCE-LINKS */
export function appendSourceLinks(body, sourceLinks) {
  if (!Array.isArray(sourceLinks) || sourceLinks.length === 0) return body;
  const section = [
    "関連メッセージ:",
    // Angle-bracket destinations keep parentheses in valid chat permalinks from
    // ending the Markdown link early.
    ...sourceLinks.map((link) => `- [${markdownLabel(link.label)}](<${link.url}>)`),
  ].join("\n");
  return body ? `${body.trimEnd()}\n\n${section}` : section;
}
