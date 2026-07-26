import assert from "node:assert/strict";
import test from "node:test";
import {
  ConfiguredGitHubCheckReporter,
  GitHubCheckReporter,
} from "../src/check-reporter.mjs";

function job(reviewMode = "full") {
  return {
    id: "job-1",
    request: {
      repository: "LUDIARS/Revisor",
      number: 7,
      headSha: "a".repeat(40),
      pullRequestUrl: "https://github.com/LUDIARS/Revisor/pull/7",
      reviewMode,
    },
  };
}

test("creates, advances, and completes a check run", async () => {
  const calls = [];
  const client = {
    async request(repository, method, path, body) {
      calls.push({ repository, method, path, body });
      if (method === "POST") {
        return { id: 91, html_url: "https://github.com/LUDIARS/Revisor/runs/91" };
      }
      return { id: 91 };
    },
  };
  const reporter = new GitHubCheckReporter(client, {
    now: () => "2026-07-26T00:00:00Z",
  });
  const state = job("verification");
  await reporter.queued(state);
  await reporter.running(state);
  state.result = {
    conclusion: "success",
    reviewedHeadSha: state.request.headSha,
    complexityScoreDelta: 2,
    reasons: [],
  };
  await reporter.completed(state);
  assert.equal(state.checkRunId, 91);
  assert.equal(calls[0].body.status, "queued");
  assert.match(calls[0].body.output.summary, /autofix verification/);
  assert.equal(calls[1].body.status, "in_progress");
  assert.equal(calls[2].body.conclusion, "success");
  assert.match(calls[2].body.output.summary, /No blocking findings/);
});

test("shows leakage locations without values", async () => {
  const calls = [];
  const reporter = new GitHubCheckReporter({
    async request(_repository, method, _path, body) {
      calls.push({ method, body });
      return { id: 44 };
    },
  });
  const state = job();
  await reporter.queued(state);
  state.result = {
    conclusion: "action_required",
    reasons: ["1 potential information leakage finding(s) remain"],
    leakage: {
      findings: [{ rule: "github-token", path: "src/config.mjs", line: 9 }],
    },
  };
  await reporter.completed(state);
  const summary = calls.at(-1).body.output.summary;
  assert.match(summary, /github-token: `src\/config\.mjs:9`/);
  assert.doesNotMatch(summary, /secret-value/);
});

test("reports worker failures as a completed failed check", async () => {
  const calls = [];
  const reporter = new GitHubCheckReporter({
    async request(_repository, method, _path, body) {
      calls.push({ method, body });
      return method === "POST" ? { id: 12 } : { id: 12 };
    },
  });
  const state = job();
  await reporter.queued(state);
  state.error = "reviewer crashed";
  await reporter.failed(state);
  assert.equal(calls.at(-1).body.conclusion, "failure");
  assert.match(calls.at(-1).body.output.summary, /reviewer crashed/);
});

test("loads changed GitHub App credentials lazily", async () => {
  let credentials = { appId: "one", privateKey: "key-one" };
  const clients = [];
  const reporter = new ConfiguredGitHubCheckReporter({
    readCredentials: () => credentials,
    createClient(received) {
      clients.push(received);
      return {
        async request() {
          return { id: clients.length };
        },
      };
    },
  });
  await reporter.queued(job());
  await reporter.running({ ...job(), checkRunId: 1 });
  assert.equal(clients.length, 1);
  credentials = { appId: "two", privateKey: "key-two" };
  await reporter.queued(job());
  assert.equal(clients.length, 2);
});
