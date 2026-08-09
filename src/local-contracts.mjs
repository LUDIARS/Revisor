import { isAbsolute, relative, resolve } from "node:path";
import { CHANGE_KINDS } from "./change-classification.mjs";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_REF = /^(?!\/)(?!.*(?:\.\.|@\{|\/\/))[A-Za-z0-9._/-]+(?<!\/)$/;
const SAFE_COMMAND_PART = /^[^\0\r\n"&|<>^%!]*$/;
const JAPANESE_CHARACTER = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/;
const SENSITIVE_URL_PARAMETER =
  /^(?:access_?)?token$|^(?:api_?)?key$|^auth(?:orization)?$|^credential$|^password$|^secret$|^(?:sig|signature)$/i;

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function text(value, label, maximum = 255) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}

function gitRef(value, label) {
  const ref = text(value, label);
  if (!SAFE_REF.test(ref)) throw new Error(`${label} is not a safe Git ref.`);
  return ref;
}

function stringList(value, label) {
  if (value === undefined) return [];
  if (
    !Array.isArray(value)
    || value.length > 50
    || value.some((item) =>
      typeof item !== "string" || !item.trim() || item.length > 100)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function japaneseText(value, label, maximum = 255) {
  const normalized = text(value, label, maximum);
  if (!JAPANESE_CHARACTER.test(normalized)) {
    throw new Error(`${label} must be written in Japanese.`);
  }
  return normalized;
}

function prContent(value) {
  const body = text(value, "PR content", 65_536);
  for (const heading of ["実装内容", "受け入れ条件"]) {
    const content = sectionContent(body, heading);
    if (!content) {
      throw new Error(`PR content requires a non-empty '## ${heading}' section.`);
    }
    if (!JAPANESE_CHARACTER.test(content)) {
      throw new Error(`PR content section '## ${heading}' must be written in Japanese.`);
    }
  }
  return body;
}

function sectionContent(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const headingPattern = new RegExp(`^##\\s+${heading}\\s*$`);
  const start = lines.findIndex((line) => headingPattern.test(line.trim()));
  if (start < 0) return "";
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^#{1,2}\s+/.test(lines[index].trim())) {
      end = index;
      break;
    }
  }
  // 子見出しそのものだけでは内容にならない。本文または箇条書きで具体化を要求する。
  return lines.slice(start + 1, end)
    .filter((line) => !/^#{1,6}\s+/.test(line.trim()))
    .join("\n")
    .trim();
}

function sourceLink(value, index) {
  object(value, `source_links[${index}]`);
  const platform = text(value.platform, `source_links[${index}].platform`, 20);
  if (platform !== "discord" && platform !== "slack") {
    throw new Error(`source_links[${index}].platform is invalid.`);
  }
  const label = text(value.label, `source_links[${index}].label`, 100);
  const url = text(value.url, `source_links[${index}].url`, 2_048);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`source_links[${index}].url is invalid.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`source_links[${index}].url must not contain credentials.`);
  }
  const hasSensitiveParameter = [...parsed.searchParams.keys()]
    .some((key) => SENSITIVE_URL_PARAMETER.test(key));
  if (parsed.hash || hasSensitiveParameter) {
    throw new Error(`source_links[${index}].url must not contain credentials.`);
  }
  const host = parsed.hostname.toLowerCase();
  const isSourceMessage = platform === "discord"
    ? host === "discord.com" && /^\/channels\/(?:@me|\d+)\/\d+\/\d+$/.test(parsed.pathname)
    : host.endsWith(".slack.com") && /^\/archives\/[A-Z0-9]+\/p\d+$/.test(parsed.pathname);
  if (parsed.protocol !== "https:" || !isSourceMessage) {
    throw new Error(`source_links[${index}].url does not identify a source message.`);
  }
  return { platform, label, url: parsed.toString() };
}

function sourceLinks(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) {
    throw new Error("source_links is invalid.");
  }
  const links = value.map(sourceLink);
  return links.filter((link, index) =>
    links.findIndex((candidate) => candidate.url === link.url) === index);
}

function testCase(value, index) {
  object(value, `test_cases[${index}]`);
  const name = text(value.name, `test_cases[${index}].name`, 100);
  const command = text(value.command, `test_cases[${index}].command`, 260);
  const args = value.args ?? [];
  if (
    !Array.isArray(args)
    || args.length > 64
    || args.some((argument) =>
      typeof argument !== "string"
      || argument.length > 1_000
      || !SAFE_COMMAND_PART.test(argument))
  ) {
    throw new Error(`test_cases[${index}].args is invalid.`);
  }
  if (!SAFE_COMMAND_PART.test(command)) {
    throw new Error(`test_cases[${index}].command contains shell metacharacters.`);
  }
  const cwd = value.cwd === undefined ? "." : text(value.cwd, `test_cases[${index}].cwd`);
  if (isAbsolute(cwd) || relative(".", resolve(".", cwd)).startsWith("..")) {
    throw new Error(`test_cases[${index}].cwd must stay inside the repository.`);
  }
  const timeoutMs = value.timeout_ms === undefined ? 10 * 60_000 : Number(value.timeout_ms);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60 * 60_000) {
    throw new Error(`test_cases[${index}].timeout_ms is invalid.`);
  }
  return {
    name,
    command,
    args: [...args],
    cwd,
    timeoutMs,
    ...testCaseCoverage(value, index),
  };
}

// Coverage metadata lets the review plan run a documentation edit without paying
// for the whole suite. It is optional: a case that declares nothing keeps
// covering executable change only, which is what every existing registration
// meant when it was created.
function testCaseCoverage(value, index) {
  // `null` reads as "not declared" as well as omission, because that is exactly
  // what this function emits for an undeclared case: re-registering a repository
  // from the record this validator returned must not be rejected.
  const kinds = value.kinds === undefined || value.kinds === null
    ? null
    : changeKindList(value.kinds, index);
  if (value.runtime !== undefined && typeof value.runtime !== "boolean") {
    throw new Error(`test_cases[${index}].runtime must be a boolean.`);
  }
  if (value.always !== undefined && typeof value.always !== "boolean") {
    throw new Error(`test_cases[${index}].always must be a boolean.`);
  }
  return {
    kinds,
    runtime: value.runtime === true,
    always: value.always === true,
  };
}

function changeKindList(value, index) {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > CHANGE_KINDS.length
    || value.some((kind) => !CHANGE_KINDS.includes(kind))
  ) {
    throw new Error(
      `test_cases[${index}].kinds must be a non-empty subset of ${CHANGE_KINDS.join(", ")}.`,
    );
  }
  return [...new Set(value)];
}

export function validateRepositoryRegistration(body) {
  object(body, "Request body");
  const repository = text(body.repository, "repository");
  if (!REPOSITORY.test(repository)) throw new Error("repository is invalid.");
  const rootPath = text(body.root_path, "root_path", 1_000);
  if (!isAbsolute(rootPath)) throw new Error("root_path must be absolute.");
  const baseRef = gitRef(body.base_ref ?? "main", "base_ref");
  if (!Array.isArray(body.test_cases) || body.test_cases.length === 0) {
    throw new Error("At least one test case is required when registering a repository.");
  }
  if (body.test_cases.length > 32) throw new Error("Too many test cases.");
  const testCases = body.test_cases.map(testCase);
  if (new Set(testCases.map((candidate) => candidate.name)).size !== testCases.length) {
    throw new Error("Test case names must be unique.");
  }
  return { repository, rootPath, baseRef, testCases };
}

export function validatePullRequestSubmission(body) {
  object(body, "Request body");
  const repository = text(body.repository, "repository");
  if (!REPOSITORY.test(repository)) throw new Error("repository is invalid.");
  return {
    repository,
    title: japaneseText(body.title, "PR title", 256),
    body: prContent(body.body),
    sourceLinks: sourceLinks(body.source_links),
    author: text(body.author ?? "local", "author", 100),
    // `draft` is accepted for compatibility with older clients, but local PRs
    // no longer have a draft lifecycle state.
    draft: false,
    labels: stringList(body.labels, "labels"),
    assignees: stringList(body.assignees, "assignees"),
    reviewers: stringList(body.reviewers, "reviewers"),
    headRef: gitRef(body.head_ref, "head_ref"),
    baseRef: body.base_ref === undefined ? undefined : gitRef(body.base_ref, "base_ref"),
    // Concordia session that submitted the PR. Reviews run locally and take
    // minutes, so the submitter is told the verdict through Concordia instead of
    // polling for it. Optional: CLI and script submissions have no session, and
    // a client that fills the field in unconditionally sends a blank one, which
    // means the same thing — rejecting the whole submission over an optional
    // notification target would be worse than not notifying.
    sessionId: body.session_id === undefined
      || body.session_id === null
      || (typeof body.session_id === "string" && !body.session_id.trim())
      ? null
      : text(body.session_id, "session_id", 128),
  };
}
