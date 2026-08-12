import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { JobStore } from "../src/job-store.mjs";

function storeFixture() {
  const directory = mkdtempSync(join(tmpdir(), "revisor-jobs-"));
  let sequence = 0;
  return {
    directory,
    store: new JobStore({
      path: join(directory, "revisor.jobs.db"),
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

test("a promoted queued job persists in the fast lane and is claimed before normal work", async () => {
  const fixture = storeFixture();
  try {
    await fixture.store.enqueue(request({ localPrId: "pr-normal", number: 1 }));
    await fixture.store.enqueue(request({ localPrId: "pr-fast", number: 2 }));
    const promoted = await fixture.store.promote("pr-fast");
    assert.equal(promoted.reviewLane, "fast");
    assert.equal(promoted.request.reviewLane, "fast");

    const reopened = new JobStore({ path: fixture.store.path });
    const claimed = await reopened.claimNext();
    assert.equal(claimed.localPrId, "pr-fast");
    assert.equal(claimed.reviewLane, "fast");
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("promotion joins the tail of the fast FIFO and is idempotent", async () => {
  const fixture = storeFixture();
  try {
    await fixture.store.enqueue(request({ localPrId: "pr-fast-first", number: 1, reviewLane: "fast" }));
    await fixture.store.enqueue(request({ localPrId: "pr-promoted", number: 2 }));
    const firstPromotion = await fixture.store.promote("pr-promoted");
    const secondPromotion = await fixture.store.promote("pr-promoted");
    assert.equal(secondPromotion.fastLaneEnteredAt, firstPromotion.fastLaneEnteredAt);
    assert.equal((await fixture.store.claimNext({ reviewLane: "fast" })).localPrId, "pr-fast-first");
    assert.equal((await fixture.store.claimNext({ reviewLane: "fast" })).localPrId, "pr-promoted");
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("promotion stays at the fast FIFO tail when every timestamp is identical", async () => {
  const directory = mkdtempSync(join(tmpdir(), "revisor-jobs-same-time-"));
  let id = 0;
  const store = new JobStore({
    path: join(directory, "jobs.json"),
    createId: () => `same-time-${++id}`,
    now: () => "2026-08-11T00:00:00.000Z",
  });
  try {
    const first = await store.enqueue(request({
      localPrId: "pr-fast-first",
      number: 1,
      reviewLane: "fast",
    }));
    await store.enqueue(request({ localPrId: "pr-promoted", number: 2 }));
    const promoted = await store.promote("pr-promoted");
    assert.ok(first.job.fastLaneSequence < promoted.fastLaneSequence);
    assert.equal((await store.claimNext({ reviewLane: "fast" })).localPrId, "pr-fast-first");
    assert.equal((await store.claimNext({ reviewLane: "fast" })).localPrId, "pr-promoted");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy v1 jobs migrate to the canonical standard lane on restart", () => {
  const fixture = storeFixture();
  try {
    writeFileSync(fixture.store.path, JSON.stringify({
      version: 1,
      jobs: [{
        id: "legacy",
        key: "LUDIARS/Product#1@aaa",
        localPrId: "pr-legacy",
        request: request({ localPrId: "pr-legacy" }),
        status: "queued",
        attempts: 0,
        claimedPid: null,
        error: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      }],
    }), "utf8");
    const [job] = new JobStore({ path: fixture.store.path }).list();
    assert.equal(job.reviewLane, "standard");
    assert.equal(job.request.reviewLane, "standard");
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("imports a separately stored legacy queue without replacing its prior archive", () => {
  const directory = mkdtempSync(join(tmpdir(), "revisor-jobs-legacy-archive-"));
  const path = join(directory, "revisor.db");
  const legacyPath = join(directory, "revisor.jobs.json");
  const previousArchive = `${legacyPath}.migrated`;
  const legacy = { version: 1, jobs: [] };
  try {
    writeFileSync(legacyPath, JSON.stringify(legacy), "utf8");
    writeFileSync(previousArchive, "older backup", "utf8");
    const store = new JobStore({ path, legacyPath });
    assert.deepEqual(store.list(), []);
    assert.equal(readFileSync(previousArchive, "utf8"), "older backup");
    assert.equal(existsSync(`${legacyPath}.migrated.1`), true);
    assert.deepEqual(JSON.parse(readFileSync(`${legacyPath}.migrated.1`, "utf8")), legacy);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// ワーカーは短命なので「running なのに保持プロセスが居ない」がそのまま中断の証拠になる。
test("a job whose worker died is requeued until the attempt limit, then failed", async () => {
  const fixture = storeFixture();
  try {
    await fixture.store.enqueue(request({ reviewLane: "fast" }));
    // 保持者を「存在しない pid」に差し替えて、死んだワーカーを再現する。
    const die = async () => {
      const claimed = await fixture.store.claimNext();
      const database = new DatabaseSync(fixture.store.path);
      try {
        const raw = JSON.parse(
          database.prepare("SELECT record FROM jobs WHERE id = ?").get(claimed.id).record,
        );
        raw.claimedPid = 0x7fff_fffe;
        database
          .prepare("UPDATE jobs SET record = ? WHERE id = ?")
          .run(JSON.stringify(raw), claimed.id);
      } finally {
        database.close();
      }
      return claimed;
    };
    await die();
    const first = await fixture.store.reclaimAbandoned();
    assert.equal(first.requeued.length, 1);
    assert.equal(first.requeued[0].reviewLane, "fast");
    assert.equal(first.requeued[0].request.reviewLane, "fast");
    assert.equal(first.exhausted.length, 0);

    await die();
    const second = await fixture.store.reclaimAbandoned();
    assert.equal(second.requeued.length, 0, "the attempt limit stops the queue from self-feeding");
    assert.equal(second.exhausted.length, 1);
    assert.equal(second.exhausted[0].status, "failed");
    assert.match(second.exhausted[0].error, /revisor\.jobs\.db\.worker\.log/);
    assert.equal(second.exhausted[0].error.includes(fixture.directory), false);
    assert.equal(fixture.store.state().queued, 0);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
