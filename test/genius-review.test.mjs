import assert from "node:assert/strict";
import test from "node:test";
import { geniusReviewQuery, queryGeniusReview } from "../src/genius-review.mjs";

const CLASSIFICATION = {
  kinds: ["code"],
  changedFiles: 2,
  changedLines: 24,
  docsOnly: false,
  docsOrConfigOnly: false,
  touchesSpec: false,
  touchesTests: false,
  runtimeSurfaces: ["ui"],
};

test("Genius review queries only derived change metadata", () => {
  const query = JSON.parse(geniusReviewQuery(CLASSIFICATION));
  assert.deepEqual(query.changeProfile, CLASSIFICATION);
  assert.equal(JSON.stringify(query).includes("diff"), false);
  assert.equal(JSON.stringify(query).includes("title"), false);
  assert.equal(JSON.stringify(query).includes("context"), false);
});

test("Genius review retains only public card fields", async () => {
  let request;
  const guidance = await queryGeniusReview({
    cwd: "E:/Document/Ars/Revisor",
    baseUrl: "http://genius.test",
    classification: CLASSIFICATION,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            tookMs: 18,
            cards: [{
              id: "internal-id",
              sourceRef: "private/source.md",
              visibility: "public",
              category: "review",
              situation: "UI component change",
              judgment: "Confirm the visible state manually.",
              rationale: "Static checks do not establish layout correctness.",
              tags: ["ui"],
              confidence: 0.8,
              score: 0.91,
            }],
          };
        },
      };
    },
  });
  assert.equal(request.url.pathname, "/api/clone/query");
  assert.equal(JSON.parse(request.options.body).visibility, "public");
  assert.deepEqual(guidance, {
    tookMs: 18,
    cards: [{
      category: "review",
      situation: "UI component change",
      judgment: "Confirm the visible state manually.",
      rationale: "Static checks do not establish layout correctness.",
      tags: ["ui"],
      confidence: 0.8,
      score: 0.91,
    }],
  });
  assert.equal(JSON.stringify(guidance).includes("sourceRef"), false);
});

test("Genius review rejects non-public cards", async () => {
  await assert.rejects(
    () => queryGeniusReview({
      cwd: "E:/Document/Ars/Revisor",
      baseUrl: "http://genius.test",
      classification: CLASSIFICATION,
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            tookMs: 1,
            cards: [{ visibility: "sensitive" }],
          };
        },
      }),
    }),
    /non-public judgment card/,
  );
});
