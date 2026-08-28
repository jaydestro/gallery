import assert from "node:assert/strict";
import test from "node:test";

import {
  createHealthSnapshot,
  evaluateHealthFinding,
  groupCatalogSources,
  mapWithConcurrency,
} from "./health.mjs";

const policy = {
  contractVersions: { health: "1.0.0" },
  lifecycle: { requiredConfirmations: 2, retirementGraceDays: 30 },
};
const record = {
  id: "example",
  canonicalSource: "https://github.com/Example/Repo",
};
const deletion = {
  classification: "definitive-failure",
  reason: "SOURCE_HTTP_404",
  statusCode: 404,
};

function evaluate(result, checkedAt, previousEntry = null) {
  return evaluateHealthFinding({
    galleryId: record.id,
    canonicalSource: record.canonicalSource,
    result,
    previousHealth: previousEntry ? { entries: [previousEntry] } : null,
    policy,
    checkedAt,
  });
}

test("404 findings require a persisted confirmation and elapsed policy grace before quarantine", () => {
  const first = evaluate(deletion, "2026-01-01T00:00:00.000Z");
  assert.equal(first.status, "needs-review");
  assert.equal(first.consecutiveFindings, 1);

  const earlyConfirmation = evaluate(deletion, "2026-01-15T00:00:00.000Z", first);
  assert.equal(earlyConfirmation.status, "needs-review");
  assert.equal(earlyConfirmation.consecutiveFindings, 2);

  const elapsedConfirmation = evaluate(deletion, "2026-02-01T00:00:00.000Z", earlyConfirmation);
  assert.equal(elapsedConfirmation.status, "quarantined");
  assert.equal(elapsedConfirmation.consecutiveFindings, 3);
  assert.equal(elapsedConfirmation.gracePeriodStartedAt, "2026-01-01T00:00:00.000Z");
});

test("rerunning the same observation does not manufacture a confirmation", () => {
  const first = evaluate(deletion, "2026-01-01T00:00:00.000Z");
  const repeated = evaluate(deletion, "2026-01-01T00:00:00.000Z", first);
  assert.equal(repeated.consecutiveFindings, 1);
  assert.equal(repeated.status, "needs-review");
});

test("a changed canonical source starts a new confirmation sequence", () => {
  const first = evaluate(deletion, "2026-01-01T00:00:00.000Z");
  const changed = evaluateHealthFinding({
    galleryId: record.id,
    canonicalSource: "https://github.com/example/replacement",
    result: deletion,
    previousHealth: { entries: [first] },
    policy,
    checkedAt: "2026-02-01T00:00:00.000Z",
  });
  assert.equal(changed.consecutiveFindings, 1);
  assert.equal(changed.status, "needs-review");
});

test("indeterminate checks take no action and preserve prior confirmation state", () => {
  const first = evaluate(deletion, "2026-01-01T00:00:00.000Z");
  const partial = evaluate({
    classification: "indeterminate",
    reason: "SOURCE_HTTP_429",
    statusCode: 429,
  }, "2026-02-01T00:00:00.000Z", first);

  assert.equal(partial.status, "indeterminate");
  assert.equal(partial.consecutiveFindings, 1);
  assert.equal(partial.gracePeriodStartedAt, first.gracePeriodStartedAt);
  assert.equal(partial.sourceState.availability, "indeterminate");
});

test("authoritative archive state quarantines while deletion remains confirmation-gated", () => {
  const archived = evaluate({
    classification: "definitive-failure",
    reason: "GITHUB_REPOSITORY_ARCHIVED",
    archived: true,
    disabled: false,
  }, "2026-01-01T00:00:00.000Z");
  const deleted = evaluate(deletion, "2026-01-01T00:00:00.000Z");

  assert.equal(archived.status, "quarantined");
  assert.equal(archived.sourceState.archived, true);
  assert.equal(deleted.status, "needs-review");
});

test("a healthy check clears prior failure state", () => {
  const first = evaluate(deletion, "2026-01-01T00:00:00.000Z");
  const recovered = evaluate({ classification: "healthy" }, "2026-02-01T00:00:00.000Z", first);

  assert.equal(recovered.status, "healthy");
  assert.equal(recovered.healthScore, 100);
  assert.equal(recovered.consecutiveFindings, 0);
  assert.equal(recovered.gracePeriodStartedAt, null);
  assert.deepEqual(recovered.healthReasons, []);
});

test("shared canonical sources are grouped once but retain one health entry per record", () => {
  const records = [
    { id: "second", canonicalSource: "https://github.com/EXAMPLE/REPO/" },
    { id: "first", canonicalSource: "http://github.com/example/repo" },
  ];
  const groups = groupCatalogSources(records);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].records.map((item) => item.galleryId), ["first", "second"]);

  const results = new Map([[groups[0].canonicalSource, { classification: "healthy" }]]);
  const snapshot = createHealthSnapshot(records, results, {
    policy,
    checkedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.deepEqual(snapshot.entries.map((entry) => entry.galleryId), ["first", "second"]);
  assert.ok(snapshot.entries.every((entry) => entry.status === "healthy"));
});

test("bounded mapping preserves input order and never exceeds its concurrency", async () => {
  let active = 0;
  let maximumActive = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const work = mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await gate;
    active -= 1;
    return value * 2;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 2);
  release();
  assert.deepEqual(await work, [2, 4, 6, 8]);
  assert.equal(maximumActive, 2);
});