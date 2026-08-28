import assert from "node:assert/strict";
import test from "node:test";

import {
  CatalogPlanApplyError,
  applyCatalogPlan,
  retentionUntilFor,
} from "./apply-catalog-plan.mjs";
import { makeCatalogReplayFixture } from "./apply-catalog-plan.fixtures.mjs";
import { emptyAuditLog } from "./write-audit.mjs";

function clone(value) {
  return structuredClone(value);
}

function expectCode(code) {
  return (error) => error instanceof CatalogPlanApplyError && error.code === code;
}

test("purely replays a plan into ordered catalog, health, retired, and audit state", () => {
  const fixture = makeCatalogReplayFixture();
  const untouched = clone(fixture);
  const replayed = applyCatalogPlan(fixture);

  assert.deepEqual(fixture, untouched);
  assert.deepEqual(
    replayed.activeCatalog.map((record) => record.id),
    [
      ...fixture.activeCatalog
        .filter((record) => record.id !== "retire-item")
        .map((record) => record.id),
      "publish-item",
      "restore-item",
    ],
  );
  assert.deepEqual(
    replayed.health.entries.map((entry) => entry.galleryId),
    [...fixture.health.entries.map((entry) => entry.galleryId), "publish-item"],
  );
  assert.deepEqual(replayed.retired.entries.map((entry) => entry.record.id), ["retire-item"]);

  const retirement = replayed.retired.entries[0];
  const retireOperation = fixture.plan.operations.find((operation) => operation.type === "retire");
  assert.equal(retirement.retiredAt, retireOperation.plannedAt);
  assert.equal(retirement.retentionUntil, "2027-08-27");
  assert.equal(retirement.decisionRunUrl, retireOperation.decisionRunUrl);
  assert.equal(retirement.decisionPullRequestUrl, retireOperation.decisionPullRequestUrl);
  assert.deepEqual(retirement.evidence.map((evidence) => evidence.reason), ["health", "freshness"]);
  assert.equal(replayed.audit.entries.length, 1);
  assert.deepEqual(replayed.audit.entries[0].operations, fixture.plan.operations);

  assert.deepEqual(applyCatalogPlan({ ...fixture, ...replayed }), replayed);
});

test("derives retention dates from the retirement instant and policy day count", () => {
  assert.equal(retentionUntilFor("2024-02-29T23:30:00.000Z", 365), "2025-02-28");
  assert.equal(retentionUntilFor("2026-08-27T12:00:00.000Z", 30), "2026-09-26");
});

test("fails closed on invalid retention and oversized plan batches", () => {
  const invalidRetention = makeCatalogReplayFixture();
  invalidRetention.policy.audit.retentionDays = 0;
  assert.throws(() => applyCatalogPlan(invalidRetention), expectCode("POLICY_INVALID"));

  const oversized = makeCatalogReplayFixture();
  oversized.policy.batching.maxEntriesPerPullRequest = oversized.plan.operations.length - 1;
  assert.throws(() => applyCatalogPlan(oversized), expectCode("BATCH_LIMIT_EXCEEDED"));
});

test("rejects duplicate health identities and conflicting retired provenance", () => {
  const duplicateHealth = makeCatalogReplayFixture();
  duplicateHealth.health.entries.push(clone(duplicateHealth.health.entries[0]));
  assert.throws(() => applyCatalogPlan(duplicateHealth), expectCode("HEALTH_IDENTITY_INVALID"));

  const conflictingRetired = makeCatalogReplayFixture();
  const retireOperation = conflictingRetired.plan.operations.find((operation) => operation.type === "retire");
  conflictingRetired.activeCatalog = conflictingRetired.activeCatalog.filter(
    (record) => record.id !== retireOperation.targetId,
  );
  conflictingRetired.retired.entries.push({
    ...clone(conflictingRetired.retired.entries[0]),
    record: clone(retireOperation.after),
  });
  assert.throws(() => applyCatalogPlan(conflictingRetired), expectCode("NON_IDEMPOTENT_REPLAY"));
});

test("revalidates emergency, exact mutation, confirmation, and grace policy during replay", () => {
  const cases = [
    ["POLICY_EMERGENCY_DISABLED", (fixture) => { fixture.policy.automation.emergencyDisable = true; }],
    ["MUTATION_DISABLED", (fixture) => { fixture.policy.automation.mutation.retirement = false; }],
    ["MISSING_GATE", (fixture) => { fixture.policy.lifecycle.requiredConfirmations = 3; }],
    ["MISSING_GATE", (fixture) => { fixture.policy.lifecycle.retirementGraceDays = 90; }],
  ];

  for (const [code, mutate] of cases) {
    const fixture = makeCatalogReplayFixture();
    mutate(fixture);
    assert.throws(() => applyCatalogPlan(fixture), expectCode(code));
  }
});

test("rejects an unaudited plan when all catalog transitions already equal the base", () => {
  const fixture = makeCatalogReplayFixture();
  const applied = applyCatalogPlan(fixture);

  assert.throws(
    () => applyCatalogPlan({ ...fixture, ...applied, audit: emptyAuditLog() }),
    expectCode("AUDIT_ONLY_DUPLICATION"),
  );
  assert.deepEqual(applyCatalogPlan({ ...fixture, ...applied }), applied);
});

test("rejects an unaudited mixed plan when any operation after-state is already present", () => {
  const fixture = makeCatalogReplayFixture();
  const update = fixture.plan.operations.find((operation) => operation.type === "update");
  fixture.activeCatalog = fixture.activeCatalog.map((record) => (
    record.id === update.targetId ? clone(update.after) : record
  ));

  assert.throws(() => applyCatalogPlan(fixture), expectCode("AUDIT_ONLY_DUPLICATION"));
});

test("rejects foreign trusted repository context even when plan provenance is self-consistent", () => {
  const fixture = makeCatalogReplayFixture();
  fixture.trustedRepository = "foreign-owner/foreign-gallery";

  assert.throws(() => applyCatalogPlan(fixture), expectCode("PROVENANCE_INVALID"));
});