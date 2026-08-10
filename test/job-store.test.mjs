import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JobStore } from "../src/job-store.mjs";
import { withFileLock } from "../src/file-lock.mjs";

function storeFixture() {
  const directory = mkdtempSync(join(tmpdir(), "revisor-jobs-"));
  let sequence = 0;
  return {
    directory,
    store: new JobStore({
      path: join(directory, "jobs.json"),
      createId: () => `job-${++sequence}`,
      now: () => new Date(1_700_000_000_000 + sequence * 1_000).toISOString(),
    }),
  };
}

function request(overrides = {}) {
  return {
    localPrId: "pr-1",
    repository: "LUDIARS/Product",
    number: 1,
    headSha: "aaa",
    ...overrides,
  };
}

test("an unsettled job for the same head is the run the caller asked for", async () => {
  const fixture = storeFixture();
  try {
    const first = await fixture.store.enqueue(request());
    const second = await fixture.store.enqueue(request());
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.job.id, first.job.id);
    assert.equal(fixture.store.state().queued, 1);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("a forced re-review replaces a settled job for the same head", async () => {
  const fixture = storeFixture();
  try {
    const first = await fixture.store.enqueue(request());
    await fixture.store.claimNext();
    await fixture.store.settle(first.job.id, { status: "completed" });

    const unforced = await fixture.store.enqueue(request());
    assert.equal(unforced.created, false, "an unforced submit resolves to the settled run");

    const forced = await fixture.store.enqueue(request(), { force: true });
    assert.equal(forced.created, true);
    assert.notEqual(forced.job.id, first.job.id);
    assert.equal(fixture.store.state().queued, 1);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("claiming is exclusive and records the holding process", async () => {
  const fixture = storeFixture();
  try {
    await fixture.store.enqueue(request());
    const claimed = await fixture.store.claimNext();
    assert.equal(claimed.status, "running");
    assert.equal(claimed.claimedPid, process.pid);
    assert.equal(await fixture.store.claimNext(), null, "a claimed job is not handed out twice");
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

// ワーカーは短命なので「running なのに保持プロセスが居ない」がそのまま中断の証拠になる。
test("a job whose worker died is requeued until the attempt limit, then failed", async () => {
  const fixture = storeFixture();
  try {
    await fixture.store.enqueue(request());
    // 保持者を「存在しない pid」に差し替えて、死んだワーカーを再現する。
    const die = async () => {
      const claimed = await fixture.store.claimNext();
      await withFileLock(fixture.store.path, () => {
        const raw = JSON.parse(readFileSync(fixture.store.path, "utf8"));
        raw.jobs.find((job) => job.id === claimed.id).claimedPid = 0x7fff_fffe;
        writeFileSync(fixture.store.path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
      });
      return claimed;
    };
    await die();
    const first = await fixture.store.reclaimAbandoned();
    assert.equal(first.requeued.length, 1);
    assert.equal(first.exhausted.length, 0);

    await die();
    const second = await fixture.store.reclaimAbandoned();
    assert.equal(second.requeued.length, 0, "the attempt limit stops the queue from self-feeding");
    assert.equal(second.exhausted.length, 1);
    assert.equal(second.exhausted[0].status, "failed");
    assert.equal(fixture.store.state().queued, 0);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
