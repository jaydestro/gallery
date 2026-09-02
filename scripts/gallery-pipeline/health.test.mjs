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

test("a same-observation replay preserves an already confirmed count", () => {
  const first = evaluate(deletion, "2026-01-01T00:00:00.000Z");
  const confirmed = evaluate(deletion, "2026-02-01T00:00:00.000Z", first);
  const repeated = evaluate(deletion, "2026-02-01T00:00:00.000Z", confirmed);
  assert.equal(confirmed.consecutiveFindings, 2);
  assert.equal(repeated.consecutiveFindings, 2);
  assert.equal(repeated.gracePeriodStartedAt, first.gracePeriodStartedAt);
});

test("two distinct runs confirm after the grace period", () => {
  const first = evaluate(deletion, "2026-01-01T00:00:00.000Z");
  const second = evaluate(deletion, "2026-02-01T00:00:00.000Z", first);
  assert.equal(second.consecutiveFindings, 2);
  assert.equal(second.status, "quarantined");
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

test("a source change does not preserve confirmation state through an indeterminate check", () => {
  const first = evaluate(deletion, "2026-01-01T00:00:00.000Z");
  const changed = evaluateHealthFinding({
    galleryId: record.id,
    canonicalSource: "https://github.com/example/replacement",
    result: { classification: "indeterminate", reason: "SOURCE_HTTP_429" },
    previousHealth: { entries: [first] },
    policy,
    checkedAt: "2026-02-01T00:00:00.000Z",
  });
  assert.equal(changed.consecutiveFindings, 0);
  assert.equal(changed.gracePeriodStartedAt, null);
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
  assert.deepEqual(partial.healthReasons, [deletion.reason]);
  assert.equal(partial.sourceState.availability, "indeterminate");
  assert.equal(partial.evidence[0].value, "SOURCE_HTTP_429");
});

test("a matching definitive failure continues across an indeterminate observation", () => {
  const first = evaluate(deletion, "2026-01-01T00:00:00.000Z");
  const partial = evaluate({
    classification: "indeterminate",
    reason: "SOURCE_HTTP_429",
    statusCode: 429,
  }, "2026-01-15T00:00:00.000Z", first);
  const confirmed = evaluate(deletion, "2026-02-01T00:00:00.000Z", partial);

  assert.equal(confirmed.consecutiveFindings, 2);
  assert.equal(confirmed.gracePeriodStartedAt, first.gracePeriodStartedAt);
  assert.equal(confirmed.status, "quarantined");
});

test("a different definitive reason starts a new chain after an indeterminate observation", () => {
  const first = evaluate(deletion, "2026-01-01T00:00:00.000Z");
  const partial = evaluate({
    classification: "indeterminate",
    reason: "SOURCE_HTTP_429",
  }, "2026-01-15T00:00:00.000Z", first);
  const changed = evaluate({
    classification: "definitive-failure",
    reason: "SOURCE_HTTP_410",
    statusCode: 410,
  }, "2026-02-01T00:00:00.000Z", partial);

  assert.equal(changed.consecutiveFindings, 1);
  assert.equal(changed.gracePeriodStartedAt, "2026-02-01T00:00:00.000Z");
  assert.equal(changed.status, "needs-review");
});

test("a different canonical source starts a new chain after an indeterminate observation", () => {
  const first = evaluate(deletion, "2026-01-01T00:00:00.000Z");
  const partial = evaluate({
    classification: "indeterminate",
    reason: "SOURCE_HTTP_429",
  }, "2026-01-15T00:00:00.000Z", first);
  const changed = evaluateHealthFinding({
    galleryId: record.id,
    canonicalSource: "https://github.com/example/replacement",
    result: deletion,
    previousHealth: { entries: [partial] },
    policy,
    checkedAt: "2026-02-01T00:00:00.000Z",
  });

  assert.equal(changed.consecutiveFindings, 1);
  assert.equal(changed.gracePeriodStartedAt, "2026-02-01T00:00:00.000Z");
  assert.equal(changed.status, "needs-review");
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

test("a healthy check clears failure state preserved through an indeterminate observation", () => {
  const first = evaluate(deletion, "2026-01-01T00:00:00.000Z");
  const partial = evaluate({
    classification: "indeterminate",
    reason: "SOURCE_HTTP_429",
  }, "2026-01-15T00:00:00.000Z", first);
  const recovered = evaluate({ classification: "healthy" }, "2026-02-01T00:00:00.000Z", partial);

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

test("new gallery identities do not inherit findings from another record sharing a source", () => {
  const first = evaluate(deletion, "2026-01-01T00:00:00.000Z");
  const next = evaluateHealthFinding({
    galleryId: "replacement-id",
    canonicalSource: record.canonicalSource,
    result: deletion,
    previousHealth: { entries: [first] },
    policy,
    checkedAt: "2026-02-01T00:00:00.000Z",
  });
  assert.equal(next.consecutiveFindings, 1);
  assert.equal(next.gracePeriodStartedAt, "2026-02-01T00:00:00.000Z");
});

test("snapshot creation rejects duplicate observations and stale source identities", () => {
  const records = [{ id: "example", canonicalSource: "https://example.com/source" }];
  assert.throws(() => createHealthSnapshot(records, new Map([
    ["https://example.com/source", { classification: "healthy" }],
    ["https://EXAMPLE.com/source/", { classification: "healthy" }],
  ]), {
    policy,
    checkedAt: "2026-01-01T00:00:00.000Z",
  }), /Duplicate health observation/);
  assert.throws(() => createHealthSnapshot(records, new Map([
    ["https://example.com/source", { classification: "healthy" }],
    ["https://example.com/stale", { classification: "healthy" }],
  ]), {
    policy,
    checkedAt: "2026-01-01T00:00:00.000Z",
  }), /Stale health source identity/);
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