import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runProcess } from "./process.mjs";
import { applyAdvisedPlan, STAGE_IDS } from "./review-plan.mjs";

// The deterministic plan is the floor. An optional control planner may widen or
// narrow it within the safety limits `applyAdvisedPlan` enforces. Every advisor
// fails soft: a planner that is missing, slow, or returns nonsense leaves the
// deterministic plan in place and records why, because a broken planner must
// never be able to stop reviews.

export const PLAN_ADVISORS = ["none", "augur", "reviewer"];

// The command contract a daemon-less Augur has to satisfy to act as Revisor's
// control planner. Augur owns purpose-driven test planning already, so the plan
// is asked for, not reimplemented here.
const AUGUR_CLI_RELATIVE_PATH = ["bin", "augur.mjs"];
const AUGUR_SUBCOMMAND = "review-plan";
const ADVISOR_TIMEOUT_MS = 90_000;

export async function resolveAugurCli(augurFolder) {
  if (typeof augurFolder !== "string" || !augurFolder.trim()) {
    throw new Error("Augur folder is not configured");
  }
  const cliPath = join(resolve(augurFolder), ...AUGUR_CLI_RELATIVE_PATH);
  await access(cliPath);
  return cliPath;
}

export function advisorRequest({ request, plan, testCases }) {
  return {
    version: 1,
    repository: request.repository,
    pullRequest: { number: request.number, title: request.title ?? null },
    changeProfile: plan.changeProfile,
    stages: plan.stages.map((stage) => ({ id: stage.id, run: stage.run, reason: stage.reason })),
    testCases: testCases.map((testCase) => ({
      name: testCase.name,
      kinds: Array.isArray(testCase.kinds) ? testCase.kinds : null,
      runtime: testCase.runtime === true,
      always: testCase.always === true,
    })),
    stageIds: STAGE_IDS,
  };
}

// Advisors answer with prose around the JSON often enough that requiring a bare
// document would fail most real responses. Balanced top-level objects are located
// by a single brace-depth scan that skips string contents and escapes, so a
// preamble is tolerated and a `}` inside a reason string cannot end the object
// early. The last complete object wins; an unterminated tail is never used.
export function parseAdvisorObjects(text) {
  const source = String(text ?? "");
  const documents = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0) documents.push(source.slice(start, index + 1));
    }
  }
  return documents;
}

export function parseAdvisorResponse(text) {
  for (const document of parseAdvisorObjects(text).reverse()) {
    try {
      const value = JSON.parse(document);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // A balanced but invalid document; an earlier one may still be the answer.
    }
  }
  throw new Error("advisor response contained no JSON object");
}

function advisorPrompt(payload) {
  return [
    "You are the control planner for a local pull-request review.",
    "Decide which review stages and which registered test cases this specific change needs.",
    "Do not run anything. Answer with one JSON object and nothing else.",
    'Schema: {"stages":[{"id":"<stage id>","run":true|false,"reason":"<why, Japanese>"}],"testCases":["<test case name>"]}',
    "Only the listed stage ids and test case names are valid.",
    "leakage_scan, anatomia_domain_review, spec_requirements and reviewer_autofix always run and cannot be turned off.",
    "A change with no executable content needs neither anatomia_code_analysis nor security_review.",
    "A change that touches executable content always keeps its test coverage.",
    `Change under review:\n${JSON.stringify(payload, null, 2)}`,
  ].join("\n\n");
}

async function askAugur({ cliPath, cwd, payload, execute }) {
  const result = await execute({
    command: process.execPath,
    args: [cliPath, AUGUR_SUBCOMMAND, "--json"],
    cwd,
    stdin: JSON.stringify(payload),
    timeoutMs: ADVISOR_TIMEOUT_MS,
  });
  if (!result.ok) {
    throw new Error(`Augur ${AUGUR_SUBCOMMAND} failed: ${
      result.stderr.trim() || result.stdout.trim() || "no output"
    }`);
  }
  return parseAdvisorResponse(result.stdout);
}

async function askReviewerModel({ reviewer, cwd, payload, runReview }) {
  const result = await runReview({
    reviewer,
    cwd,
    prompt: advisorPrompt(payload),
    timeoutMs: ADVISOR_TIMEOUT_MS,
    // Planning is a question, not an edit. The answer is consumed as JSON and the
    // worktree is committed afterwards, so the planner runs without write access
    // rather than being asked in prose not to use it.
    readOnly: true,
  });
  if (!result.ok) throw new Error("control planner model did not answer");
  return parseAdvisorResponse(result.stdout);
}

// `augur` is a local, offline CLI and receives only the change profile, so it may
// plan before the leakage gate. `reviewer` drives an external model, which must
// never be invoked while a high-confidence leakage match is outstanding — the same
// boundary the review itself obeys.
const EXTERNAL_MODEL_ADVISORS = new Set(["reviewer"]);

export async function advisePlan({
  advisor = "none",
  plan,
  request,
  testCases,
  cwd,
  augurFolder = "",
  reviewer,
  runReview,
  leakageClear = true,
  execute = runProcess,
}) {
  if (advisor === "none" || !PLAN_ADVISORS.includes(advisor)) return plan;
  if (EXTERNAL_MODEL_ADVISORS.has(advisor) && !leakageClear) {
    return {
      ...plan,
      advisor,
      advisorError:
        "情報流出候補が残るため、外部モデルの管制プランナーは起動しませんでした",
    };
  }
  const payload = advisorRequest({ request, plan, testCases });
  try {
    const advice = advisor === "augur"
      ? await askAugur({
          cliPath: await resolveAugurCli(augurFolder),
          cwd,
          payload,
          execute,
        })
      : await askReviewerModel({ reviewer, cwd, payload, runReview });
    return applyAdvisedPlan(plan, { ...advice, advisor });
  } catch (error) {
    return {
      ...plan,
      advisor,
      advisorError: error instanceof Error ? error.message : String(error),
    };
  }
}
