const CHECK_NAME = "Revisor review";

function repositoryApiPath(repository) {
  return repository
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function reviewLabel(request) {
  return request.reviewMode === "verification" ? "autofix verification" : "full review";
}

function resultSummary(job) {
  const result = job.result;
  const reasons = Array.isArray(result?.reasons) && result.reasons.length > 0
    ? result.reasons.map((reason) => `- ${reason}`).join("\n")
    : "- No blocking findings.";
  const leakageFindings = Array.isArray(result?.leakage?.findings)
    ? result.leakage.findings.slice(0, 20)
    : [];
  const leakage = leakageFindings.length > 0
    ? [
        "",
        "Potential information leakage (values withheld):",
        ...leakageFindings.map((finding) => {
          const path = String(finding.path).replace(/[\r\n`]/g, "?");
          return `- ${finding.rule}: \`${path}:${finding.line}\``;
        }),
      ]
    : [];
  return [
    `Mode: ${reviewLabel(job.request)}`,
    `Original head: \`${job.request.headSha}\``,
    result?.reviewedHeadSha && result.reviewedHeadSha !== job.request.headSha
      ? `Autofix head: \`${result.reviewedHeadSha}\``
      : null,
    result?.complexityScoreDelta === undefined
      ? null
      : `Complexity score delta: ${result.complexityScoreDelta}`,
    "",
    "Gate findings:",
    reasons,
    ...leakage,
  ].filter((line) => line !== null).join("\n");
}

export class GitHubCheckReporter {
  constructor(client, { now = () => new Date().toISOString() } = {}) {
    if (!client || typeof client.request !== "function") {
      throw new TypeError("GitHub check reporter requires an API client.");
    }
    this.client = client;
    this.now = now;
  }

  async queued(job) {
    const path = `/repos/${repositoryApiPath(job.request.repository)}/check-runs`;
    const check = await this.client.request(job.request.repository, "POST", path, {
      name: CHECK_NAME,
      head_sha: job.request.headSha,
      status: "queued",
      external_id: job.id,
      details_url: job.request.pullRequestUrl,
      output: {
        title: "Revisor review queued",
        summary: `Waiting for a local ${reviewLabel(job.request)} worker.`,
      },
    });
    if (!Number.isInteger(check.id)) throw new Error("GitHub returned an invalid check run ID.");
    job.checkRunId = check.id;
    job.checkUrl = typeof check.html_url === "string" ? check.html_url : undefined;
  }

  async running(job) {
    await this.#update(job, {
      status: "in_progress",
      started_at: this.now(),
      output: {
        title: "Revisor review in progress",
        summary: `A local worker is running the ${reviewLabel(job.request)}.`,
      },
    });
  }

  async completed(job) {
    await this.#update(job, {
      status: "completed",
      conclusion: job.result?.conclusion === "success" ? "success" : "action_required",
      completed_at: this.now(),
      output: {
        title: job.result?.conclusion === "success"
          ? "Revisor review passed"
          : "Revisor review needs action",
        summary: resultSummary(job),
      },
    });
  }

  async failed(job) {
    await this.#update(job, {
      status: "completed",
      conclusion: "failure",
      completed_at: this.now(),
      output: {
        title: "Revisor review failed",
        summary: job.error || "The local review worker failed.",
      },
    });
  }

  async #update(job, body) {
    if (!Number.isInteger(job.checkRunId)) {
      throw new Error(`Job ${job.id} has no GitHub check run ID.`);
    }
    const path = `/repos/${repositoryApiPath(job.request.repository)}/check-runs/${
      job.checkRunId
    }`;
    await this.client.request(job.request.repository, "PATCH", path, body);
  }
}

export class ConfiguredGitHubCheckReporter {
  #credentials;
  #reporter;
  #reportersByJob = new Map();

  constructor({
    readCredentials,
    createClient,
    now = () => new Date().toISOString(),
  }) {
    if (typeof readCredentials !== "function" || typeof createClient !== "function") {
      throw new TypeError("Configured check reporter requires credential and client factories.");
    }
    this.readCredentials = readCredentials;
    this.createClient = createClient;
    this.now = now;
  }

  async queued(job) {
    const reporter = this.#current();
    await reporter.queued(job);
    this.#reportersByJob.set(job.id, reporter);
  }

  async running(job) {
    return this.#forJob(job).running(job);
  }

  async completed(job) {
    const result = await this.#forJob(job).completed(job);
    this.#reportersByJob.delete(job.id);
    return result;
  }

  async failed(job) {
    try {
      return await this.#forJob(job).failed(job);
    } finally {
      this.#reportersByJob.delete(job.id);
    }
  }

  #forJob(job) {
    const reporter = this.#reportersByJob.get(job.id);
    if (!reporter) throw new Error(`Job ${job.id} has no configured check reporter.`);
    return reporter;
  }

  #current() {
    const credentials = this.readCredentials();
    if (
      !this.#reporter
      || credentials.appId !== this.#credentials.appId
      || credentials.privateKey !== this.#credentials.privateKey
    ) {
      this.#credentials = credentials;
      this.#reporter = new GitHubCheckReporter(this.createClient(credentials), {
        now: this.now,
      });
    }
    return this.#reporter;
  }
}
