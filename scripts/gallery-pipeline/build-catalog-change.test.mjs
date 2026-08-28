import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  CATALOG_CHANGE_PLAN_SCHEMA,
  CatalogChangePlanError,
  buildCatalogChangePlan,
  buildCatalogChangePlanForTargets,
  catalogChangeOperationId,
  hashCanonicalValue,
  replayCatalogChangePlan,
} from "./build-catalog-change.mjs";
import {
  makeCandidate,
  makeHealthEntry,
  makePlanInput,
  makeRecord,
} from "./build-catalog-change.fixtures.mjs";
import { SOURCE_SHARING_POLICY } from "./validation.mjs";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const catalogSchema = JSON.parse(await readFile(
  path.join(rootDirectory, ".github", "gallery-pipeline", "catalog.schema.json"),
  "utf8",
));
const healthSchema = JSON.parse(await readFile(
  path.join(rootDirectory, ".github", "gallery-pipeline", "health.schema.json"),
  "utf8",
));
const realCatalog = JSON.parse(await readFile(path.join(rootDirectory, "static", "templates.json"), "utf8"));
const repositoryPolicy = JSON.parse(await readFile(
  path.join(rootDirectory, ".github", "gallery-pipeline", "policy.json"),
  "utf8",
));
const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
addFormats(ajv);
ajv.addSchema(catalogSchema);
ajv.addSchema({ ...healthSchema, $id: "urn:gallery-pipeline:schema:health:1.0.0" });
const validatePlanSchema = ajv.compile(CATALOG_CHANGE_PLAN_SCHEMA);

function clone(value) {
  return structuredClone(value);
}

function expectCode(code) {
  return (error) => error instanceof CatalogChangePlanError && error.code === code;
}

function operationIdFor(operation) {
  return catalogChangeOperationId(operation);
}

function refreshOperationId(operation) {
  operation.operationId = operationIdFor(operation);
}

function setObservationTime(healthEntry, observedAt) {
  healthEntry.checkedAt = observedAt;
  healthEntry.evidence.forEach((evidence) => {
    evidence.observedAt = observedAt;
  });
}

function candidateGateFor(candidate, duplicateOutcome = "unique") {
  return {
    candidate: clone(candidate),
    deterministicGate: {
      candidateId: candidate.identityKey,
      provenance: {
        status: "passed",
        sourceRegistryId: candidate.metadata.sourceRegistryId,
        trusted: true,
      },
      sourceAvailability: { status: "healthy" },
      cosmosRelevance: {
        status: "passed",
        strategy: "strong-signal",
        signalKinds: ["learn-cosmos-section"],
      },
      duplicateCheck: {
        status: "passed",
        outcome: duplicateOutcome,
        identityKeyChecked: true,
        canonicalUrlChecked: true,
      },
      normalization: { status: "passed", schemaVersion: "1.0.0" },
    },
    availability: {
      checkedAt: "2026-08-27T12:00:00.000Z",
      classification: "healthy",
      statusCode: 200,
      reasonCode: null,
    },
  };
}

function removeDecision(input, targetId, kind) {
  if (kind === "health") {
    input.health.entries = input.health.entries.filter((entry) => entry.galleryId !== targetId);
    return;
  }
  input.freshness.entries = input.freshness.entries.filter((entry) => entry.galleryId !== targetId);
  input.freshness.healthSnapshot.entries = input.freshness.healthSnapshot.entries
    .filter((entry) => entry.galleryId !== targetId);
}

function setDecisionSource(input, targetId, source) {
  const entries = [
    input.health.entries.find((entry) => entry.galleryId === targetId),
    input.freshness.entries.find((entry) => entry.galleryId === targetId)?.health,
    input.freshness.healthSnapshot.entries.find((entry) => entry.galleryId === targetId),
  ].filter(Boolean);
  for (const entry of entries) {
    entry.canonicalSource = source;
    entry.evidence.forEach((evidence) => {
      evidence.source = source;
    });
  }
  const freshness = input.freshness.entries.find((entry) => entry.galleryId === targetId);
  if (freshness) freshness.canonicalSource = source;
}

function explicitGateInputFor(targetId) {
  const input = makePlanInput();
  removeDecision(input, "publish-item", "health");
  removeDecision(input, "publish-item", "freshness");
  const updateRecord = input.activeRecords.find((record) => record.id === "update-item");
  setDecisionSource(input, updateRecord.id, updateRecord.canonicalSource);
  if (["update-item", "restore-item"].includes(targetId)) {
    input.candidates = input.candidates.filter((candidate) => candidate.metadata.galleryId === targetId);
    input.analyses = input.analyses.filter((analysis) => analysis.candidateId === input.candidates[0].identityKey);
    input.candidateGates = [candidateGateFor(
      input.candidates[0],
      targetId === "restore-item" ? "duplicate-fast-path" : "unique",
    )];
  } else {
    input.candidates = [];
    input.analyses = [];
    input.candidateGates = [];
  }
  return input;
}

test("builds a deterministic schema-valid plan for all catalog mutation types", () => {
  const input = makePlanInput();
  const untouched = clone(input);
  const plan = buildCatalogChangePlan(input);

  assert.equal(validatePlanSchema(plan), true, JSON.stringify(validatePlanSchema.errors));
  assert.equal(plan.mode, "plan-only");
  assert.deepEqual(plan.summary, {
    publish: 1,
    update: 1,
    quarantine: 1,
    retire: 1,
    restore: 1,
    total: 5,
  });
  assert.deepEqual(plan.operations.map((operation) => operation.type), [
    "publish",
    "update",
    "quarantine",
    "retire",
    "restore",
  ]);
  assert(plan.operations.every((operation) => (
    operation.runId === input.runId &&
    operation.operationId.startsWith(`${input.runId}:`) &&
    operation.plannedAt === input.generatedAt &&
    operation.reasonCodes.length > 0 &&
    operation.evidenceReferences.length > 0
  )));
  assert.deepEqual(input, untouched);

  const replayed = replayCatalogChangePlan(plan, input);
  assert.deepEqual(
    replayCatalogChangePlan(plan, replayed, { trustedRepository: input.trustedRepository }),
    replayed,
  );
  assert.equal(replayed.activeRecords.find((record) => record.id === "quarantine-item").lifecycleStatus, "quarantined");
  assert.equal(replayed.retiredRecords.find((record) => record.id === "retire-item").lifecycleStatus, "retired");
  assert.equal(replayed.activeRecords.find((record) => record.id === "restore-item").lifecycleStatus, "active");
  assert(plan.operations.find((operation) => operation.type === "restore").reasonCodes.includes("RESTORE_PLANNED"));

  const publish = plan.operations.find((operation) => operation.type === "publish");
  const publishCandidate = input.candidates.find((candidate) => candidate.metadata.galleryId === "publish-item");
  const publishHealth = input.health.entries.find((entry) => entry.galleryId === "publish-item");
  assert.equal(publish.after.launchUrl, publishCandidate.metadata.launchUrl);
  assert.equal(publish.after.website, publishCandidate.metadata.website);
  assert.equal(publish.after.publishedAt, publishCandidate.publishedAt);
  assert.equal(publish.after.sourceOwner, null);
  assert.equal(publish.after.dateAdded, "2026-08-27");
  assert.equal(publish.after.lastVerified, publishHealth.checkedAt);

  const update = plan.operations.find((operation) => operation.type === "update");
  assert.equal(update.before.dateAdded, null);
  assert.equal(update.after.dateAdded, null);
  assert.equal(update.after.lastVerified, input.health.entries.find((entry) => entry.galleryId === "update-item").checkedAt);
});

test("publishes from explicit candidate-gate evidence without candidate health or freshness", () => {
  const input = explicitGateInputFor("publish-item");
  const candidate = makeCandidate(
    "publish-item",
    "publish-source",
    "https://learn.microsoft.com/azure/cosmos-db/publish",
  );
  input.candidates = [candidate];
  input.analyses = [makePlanInput().analyses.find((analysis) => analysis.recommendation === "publish")];
  input.candidateGates = [candidateGateFor(candidate)];

  const plan = buildCatalogChangePlanForTargets(input, ["publish-item"]);
  const operation = plan.operations[0];

  assert.equal(validatePlanSchema(plan), true, JSON.stringify(validatePlanSchema.errors));
  assert.equal(operation.type, "publish");
  assert.equal(operation.healthAfter, null);
  assert.equal(operation.after.lastVerified, input.candidateGates[0].availability.checkedAt);
  assert.equal(operation.evidenceReferences.some((entry) => entry.kind === "health"), false);
  assert.equal(operation.evidenceReferences.some((entry) => entry.kind === "freshness"), false);
  assert(operation.evidenceReferences.some((entry) => entry.kind === "candidate-availability"));
  assert(operation.evidenceReferences.some((entry) => entry.kind === "candidate-deterministic-gate"));
  assert.equal(
    Object.keys(operation.candidateAvailability).some((name) => /score|components/i.test(name)),
    false,
  );
  const replayed = replayCatalogChangePlan(plan, input);
  assert.deepEqual(replayCatalogChangePlan(plan, replayed), replayed);

  const tampered = clone(plan);
  const tamperedOperation = tampered.operations[0];
  tamperedOperation.evidenceReferences = tamperedOperation.evidenceReferences
    .filter((entry) => entry.kind !== "candidate-deterministic-gate");
  refreshOperationId(tamperedOperation);
  assert.throws(() => replayCatalogChangePlan(tampered, input), expectCode("NON_IDEMPOTENT_REPLAY"));
});

test("explicit candidate-gate mode requires original scheduled evidence for every existing action", () => {
  for (const targetId of ["update-item", "restore-item", "quarantine-item", "retire-item"]) {
    const complete = explicitGateInputFor(targetId);
    assert.doesNotThrow(
      () => buildCatalogChangePlanForTargets(complete, [targetId]),
      `${targetId} should accept complete original evidence`,
    );

    for (const kind of ["health", "freshness"]) {
      const missing = explicitGateInputFor(targetId);
      removeDecision(missing, targetId, kind);
      assert.throws(
        () => buildCatalogChangePlanForTargets(missing, [targetId]),
        expectCode("MISSING_GATE"),
        `${targetId} should require ${kind}`,
      );
    }
  }
});

test("accepts the real 109-record catalog only with its exact source-sharing policy groups", () => {
  assert.equal(realCatalog.length, 109);
  assert.equal(SOURCE_SHARING_POLICY.length, 3);
  const emptyPlan = {
    version: "1.0.0",
    mode: "plan-only",
    runId: "real-catalog-validation",
    generatedAt: "2026-08-27T12:00:00.000Z",
    inputFingerprint: "a".repeat(64),
    summary: { publish: 0, update: 0, quarantine: 0, retire: 0, restore: 0, total: 0 },
    operations: [],
  };

  const replayed = replayCatalogChangePlan(emptyPlan, { activeRecords: realCatalog, retiredRecords: [] });
  assert.equal(replayed.activeRecords.length, 109);
  for (const allowance of SOURCE_SHARING_POLICY) {
    assert.deepEqual(
      realCatalog
        .filter((record) => record.canonicalSource === allowance.canonicalSource)
        .map((record) => record.title)
        .sort(),
      [...allowance.members].sort(),
    );
  }

  const allowance = SOURCE_SHARING_POLICY[0];
  const missingAllowanceMember = clone(realCatalog).filter(
    (record) => record.title !== allowance.members[0],
  );
  assert.throws(
    () => replayCatalogChangePlan(emptyPlan, { activeRecords: missingAllowanceMember, retiredRecords: [] }),
    expectCode("SOURCE_SHARING_POLICY_STALE"),
  );

  const extraAllowanceMember = clone(realCatalog);
  extraAllowanceMember.push({
    ...clone(realCatalog.find((record) => record.title === allowance.members[0])),
    id: "unexpected-shared-source-member",
    title: "Unexpected shared source member",
  });
  assert.throws(
    () => replayCatalogChangePlan(emptyPlan, { activeRecords: extraAllowanceMember, retiredRecords: [] }),
    expectCode("SOURCE_SHARING_POLICY_STALE"),
  );

  const retiringMember = clone(realCatalog.find((record) => record.title === allowance.members[0]));
  const retirement = {
    operationId: "",
    type: "retire",
    targetId: retiringMember.id,
    runId: emptyPlan.runId,
    plannedAt: emptyPlan.generatedAt,
    before: retiringMember,
    after: { ...retiringMember, lifecycleStatus: "retired" },
    healthAfter: makeHealthEntry(retiringMember.id, retiringMember.canonicalSource, "retired"),
    reasonCodes: ["RETIRE_PLANNED"],
    evidenceReferences: [{
      kind: "health",
      id: retiringMember.id,
      observedAt: "2026-08-27T12:00:00.000Z",
      source: retiringMember.canonicalSource,
    }],
    decisionRunUrl: "https://github.com/example/gallery/actions/runs/123456789",
    decisionPullRequestUrl: "https://github.com/example/gallery/pull/42",
    decisionRepositoryOwner: "example",
    decisionRepositoryName: "gallery",
    decisionRunId: "123456789",
    decisionPullRequestNumber: "42",
  };
  refreshOperationId(retirement);
  assert.throws(
    () => replayCatalogChangePlan({
      ...emptyPlan,
      summary: { ...emptyPlan.summary, retire: 1, total: 1 },
      operations: [retirement],
    }, { activeRecords: realCatalog, retiredRecords: [] }, { trustedRepository: "example/gallery" }),
    expectCode("SOURCE_SHARING_POLICY_STALE"),
  );

  const allowedSources = new Set(SOURCE_SHARING_POLICY.map((entry) => entry.canonicalSource));
  const unrelatedRecord = clone(realCatalog.find((record) => !allowedSources.has(record.canonicalSource)));
  const addMember = {
    operationId: "",
    type: "update",
    targetId: unrelatedRecord.id,
    runId: emptyPlan.runId,
    plannedAt: emptyPlan.generatedAt,
    before: unrelatedRecord,
    after: { ...unrelatedRecord, canonicalSource: allowance.canonicalSource },
    healthAfter: makeHealthEntry(unrelatedRecord.id, allowance.canonicalSource),
    reasonCodes: ["UPDATE_PLANNED"],
    evidenceReferences: [{ kind: "policy", id: "1.0.0" }],
  };
  refreshOperationId(addMember);
  assert.throws(
    () => replayCatalogChangePlan({
      ...emptyPlan,
      summary: { ...emptyPlan.summary, update: 1, total: 1 },
      operations: [addMember],
    }, { activeRecords: realCatalog, retiredRecords: [] }),
    expectCode("SOURCE_SHARING_POLICY_STALE"),
  );
});

test("is deterministic when independently ordered input collections are reversed", () => {
  const input = makePlanInput();
  const reordered = clone(input);
  for (const name of ["candidates", "analyses", "activeRecords", "retiredRecords"]) reordered[name].reverse();
  reordered.health.entries.reverse();
  reordered.freshness.entries.reverse();
  reordered.freshness.healthSnapshot.entries.reverse();

  assert.deepEqual(buildCatalogChangePlan(reordered), buildCatalogChangePlan(input));
});

test("binds retirement URLs to supplied GitHub repository, run, and pull request metadata", () => {
  const missingTrustedRepository = makePlanInput();
  delete missingTrustedRepository.trustedRepository;
  assert.throws(() => buildCatalogChangePlan(missingTrustedRepository), expectCode("MISSING_GATE"));

  const foreignRepository = makePlanInput();
  foreignRepository.decisionRepositoryOwner = "foreign-owner";
  foreignRepository.decisionRepositoryName = "foreign-gallery";
  foreignRepository.decisionRunUrl = "https://github.com/foreign-owner/foreign-gallery/actions/runs/123456789";
  foreignRepository.decisionPullRequestUrl = "https://github.com/foreign-owner/foreign-gallery/pull/42";
  assert.throws(() => buildCatalogChangePlan(foreignRepository), expectCode("PROVENANCE_INVALID"));

  const malformedTrustedRepository = makePlanInput();
  malformedTrustedRepository.trustedRepository = "example/gallery/extra";
  assert.throws(() => buildCatalogChangePlan(malformedTrustedRepository), expectCode("PROVENANCE_INVALID"));

  const caseMismatchedRepository = makePlanInput();
  caseMismatchedRepository.trustedRepository = "Example/gallery";
  assert.throws(() => buildCatalogChangePlan(caseMismatchedRepository), expectCode("PROVENANCE_INVALID"));

  const missingRunUrl = makePlanInput();
  delete missingRunUrl.decisionRunUrl;
  assert.throws(() => buildCatalogChangePlan(missingRunUrl), expectCode("MISSING_GATE"));

  const missingRunMetadata = makePlanInput();
  delete missingRunMetadata.decisionRunId;
  assert.throws(() => buildCatalogChangePlan(missingRunMetadata), expectCode("MISSING_GATE"));

  const invalidPullRequestUrl = makePlanInput();
  invalidPullRequestUrl.decisionPullRequestUrl = "http://github.com/example/gallery/pull/42";
  assert.throws(() => buildCatalogChangePlan(invalidPullRequestUrl), expectCode("SCHEMA_INVALID"));

  const mismatchedRepository = makePlanInput();
  mismatchedRepository.decisionRepositoryName = "different-gallery";
  assert.throws(() => buildCatalogChangePlan(mismatchedRepository), expectCode("PROVENANCE_INVALID"));

  const disguisedRunUrl = makePlanInput();
  disguisedRunUrl.decisionRunUrl = `${disguisedRunUrl.decisionRunUrl}/attempts/1`;
  assert.throws(() => buildCatalogChangePlan(disguisedRunUrl), expectCode("PROVENANCE_INVALID"));

  const queryBearingPullUrl = makePlanInput();
  queryBearingPullUrl.decisionPullRequestUrl = `${queryBearingPullUrl.decisionPullRequestUrl}?diff=split`;
  assert.throws(() => buildCatalogChangePlan(queryBearingPullUrl), expectCode("PROVENANCE_INVALID"));

  const input = makePlanInput();
  const plan = buildCatalogChangePlan(input);
  const retire = plan.operations.find((operation) => operation.type === "retire");
  assert.equal(retire.decisionRunUrl, input.decisionRunUrl);
  assert.equal(retire.decisionPullRequestUrl, input.decisionPullRequestUrl);
  assert.equal(retire.decisionRepositoryOwner, input.decisionRepositoryOwner);
  assert.equal(retire.decisionRepositoryName, input.decisionRepositoryName);
  assert.equal(retire.decisionRunId, input.decisionRunId);
  assert.equal(retire.decisionPullRequestNumber, input.decisionPullRequestNumber);
  assert(plan.operations.filter((operation) => operation.type !== "retire").every((operation) => (
    operation.decisionRunUrl === undefined && operation.decisionPullRequestUrl === undefined
  )));

  const missingReplayUrl = clone(plan);
  delete missingReplayUrl.operations.find((operation) => operation.type === "retire").decisionRunUrl;
  assert.equal(validatePlanSchema(missingReplayUrl), false);
  assert.throws(() => replayCatalogChangePlan(missingReplayUrl, input), expectCode("PLAN_SCHEMA_INVALID"));

  const alteredReplayUrl = clone(plan);
  alteredReplayUrl.operations.find((operation) => operation.type === "retire").decisionRunUrl =
    "https://github.com/example/gallery/actions/runs/987654321";
  assert.throws(() => replayCatalogChangePlan(alteredReplayUrl, input), expectCode("PROVENANCE_INVALID"));
});

test("preserves untouched active order and appends records moved into each envelope deterministically", () => {
  const input = makePlanInput();
  const plan = buildCatalogChangePlan(input);
  const replayed = replayCatalogChangePlan(plan, input);

  assert.deepEqual(
    replayed.activeRecords.map((record) => record.id),
    [
      ...input.activeRecords
        .filter((record) => record.id !== "retire-item")
        .map((record) => record.id),
      "publish-item",
      "restore-item",
    ],
  );
  assert.deepEqual(replayed.retiredRecords.map((record) => record.id), ["retire-item"]);
});

test("fails closed when a candidate is missing an AI or freshness gate", () => {
  const missingAnalysis = makePlanInput();
  missingAnalysis.analyses.pop();
  assert.throws(() => buildCatalogChangePlan(missingAnalysis), expectCode("MISSING_GATE"));

  const missingFreshness = makePlanInput();
  missingFreshness.freshness.entries = missingFreshness.freshness.entries.filter(
    (entry) => entry.galleryId !== "publish-item",
  );
  assert.throws(() => buildCatalogChangePlan(missingFreshness), expectCode("MISSING_GATE"));
});

test("rejects missing policy thresholds and incompatible gate versions", () => {
  const missingThreshold = makePlanInput();
  delete missingThreshold.policy.thresholds.materialRelevance;
  assert.throws(() => buildCatalogChangePlan(missingThreshold), expectCode("MISSING_GATE"));

  const analysisVersion = makePlanInput();
  analysisVersion.analyses[0].version = "2.0.0";
  assert.throws(() => buildCatalogChangePlan(analysisVersion), expectCode("MISSING_GATE"));

  const freshnessVersion = makePlanInput();
  freshnessVersion.freshness.version = "2.0.0";
  assert.throws(() => buildCatalogChangePlan(freshnessVersion), expectCode("MISSING_GATE"));

  const policyVersion = makePlanInput();
  policyVersion.policy.contractVersions.policy = "2.0.0";
  assert.throws(() => buildCatalogChangePlan(policyVersion), expectCode("MISSING_GATE"));

  const retiredVersion = makePlanInput();
  retiredVersion.policy.contractVersions.retiredEntries = "2.0.0";
  assert.throws(() => buildCatalogChangePlan(retiredVersion), expectCode("MISSING_GATE"));
});

test("rejects missing, stale, mismatched, or mutating decision evidence", () => {
  const missingSnapshot = makePlanInput();
  delete missingSnapshot.freshness.healthSnapshot;
  assert.throws(() => buildCatalogChangePlan(missingSnapshot), expectCode("MISSING_GATE"));

  const staleSnapshot = makePlanInput();
  staleSnapshot.freshness.entries[0].health.healthReasons = ["STALE_DECISION"];
  assert.throws(() => buildCatalogChangePlan(staleSnapshot), expectCode("MISSING_GATE"));

  const staleHealth = makePlanInput();
  staleHealth.health.entries[0].checkedAt = "2026-07-27T11:59:59.000Z";
  assert.throws(() => buildCatalogChangePlan(staleHealth), expectCode("MISSING_GATE"));

  const staleFreshness = makePlanInput();
  staleFreshness.freshness.generatedAt = "2026-07-27T11:59:59.000Z";
  assert.throws(() => buildCatalogChangePlan(staleFreshness), expectCode("MISSING_GATE"));

  const mismatchedEvidence = makePlanInput();
  mismatchedEvidence.health.entries[0].evidence[0].source = "https://example.com/unrelated";
  assert.throws(() => buildCatalogChangePlan(mismatchedEvidence), expectCode("CONFLICTING_OPERATIONS"));

  const mutatingReport = makePlanInput();
  mutatingReport.freshness.entries[0].mutation = "retire";
  assert.throws(() => buildCatalogChangePlan(mutatingReport), expectCode("MISSING_GATE"));

  const contradictory = makePlanInput();
  contradictory.freshness.entries[0].recommendation = "retire";
  assert.throws(() => buildCatalogChangePlan(contradictory), expectCode("CONFLICTING_OPERATIONS"));
});

test("rejects embedded observations after their envelope or plan generation time", () => {
  const healthAfterFreshnessEnvelope = makePlanInput();
  healthAfterFreshnessEnvelope.freshness.generatedAt = "2026-08-27T11:59:59.000Z";
  assert.throws(
    () => buildCatalogChangePlan(healthAfterFreshnessEnvelope),
    expectCode("MISSING_GATE"),
  );

  const evidenceAfterFreshnessEnvelope = makePlanInput();
  evidenceAfterFreshnessEnvelope.freshness.generatedAt = "2026-08-27T11:59:59.000Z";
  const freshnessHealth = evidenceAfterFreshnessEnvelope.freshness.entries[0].health;
  const snapshotHealth = evidenceAfterFreshnessEnvelope.freshness.healthSnapshot.entries.find(
    (entry) => entry.galleryId === freshnessHealth.galleryId,
  );
  freshnessHealth.checkedAt = "2026-08-27T11:59:58.000Z";
  snapshotHealth.checkedAt = freshnessHealth.checkedAt;
  assert.throws(
    () => buildCatalogChangePlan(evidenceAfterFreshnessEnvelope),
    expectCode("MISSING_GATE"),
  );

  const healthEvidenceAfterPlan = makePlanInput();
  healthEvidenceAfterPlan.health.entries[0].evidence[0].observedAt = "2026-08-27T12:00:01.000Z";
  assert.throws(() => buildCatalogChangePlan(healthEvidenceAfterPlan), expectCode("MISSING_GATE"));
});

test("uses one HTTP retry envelope when the lifecycle grace window is zero", () => {
  const withinEnvelope = makePlanInput();
  withinEnvelope.policy.lifecycle.retirementGraceDays = 0;
  setObservationTime(withinEnvelope.health.entries[0], "2026-08-27T11:55:25.000Z");
  assert.doesNotThrow(() => buildCatalogChangePlan(withinEnvelope));

  const outsideEnvelope = makePlanInput();
  outsideEnvelope.policy.lifecycle.retirementGraceDays = 0;
  setObservationTime(outsideEnvelope.health.entries[0], "2026-08-27T11:55:24.000Z");
  assert.throws(() => buildCatalogChangePlan(outsideEnvelope), expectCode("MISSING_GATE"));
});

test("requires candidate launch, website, and publication metadata without inventing values", () => {
  const missingLaunchUrl = makePlanInput();
  delete missingLaunchUrl.candidates[0].metadata.launchUrl;
  assert.throws(() => buildCatalogChangePlan(missingLaunchUrl), expectCode("MISSING_GATE"));

  const missingWebsite = makePlanInput();
  delete missingWebsite.candidates[0].metadata.website;
  assert.throws(() => buildCatalogChangePlan(missingWebsite), expectCode("MISSING_GATE"));

  const missingPublishedAt = makePlanInput();
  missingPublishedAt.candidates[0].publishedAt = null;
  assert.throws(() => buildCatalogChangePlan(missingPublishedAt), expectCode("MISSING_GATE"));

  const unverifiedLaunchUrl = makePlanInput();
  unverifiedLaunchUrl.candidates[0].metadata.launchUrl = "https://example.com/unverified";
  assert.throws(() => buildCatalogChangePlan(unverifiedLaunchUrl), expectCode("GATE_REJECTED"));
});

test("requires positive AI evidence to be non-empty and candidate-bound", () => {
  const emptyEvidence = makePlanInput();
  emptyEvidence.analyses[0].relevance.evidence = [];
  assert.throws(() => buildCatalogChangePlan(emptyEvidence), expectCode("GATE_REJECTED"));

  const unrelatedEvidence = makePlanInput();
  unrelatedEvidence.analyses[0].grounding.claims[0].evidence[0].url = "https://example.com/unrelated";
  assert.throws(() => buildCatalogChangePlan(unrelatedEvidence), expectCode("GATE_REJECTED"));
});

test("rejects unknown IDs in AI, health, and freshness decisions", () => {
  const unknownAnalysis = makePlanInput();
  unknownAnalysis.analyses[1].duplicate.matchedEntryId = "unknown-item";
  assert.throws(() => buildCatalogChangePlan(unknownAnalysis), expectCode("UNKNOWN_ID"));

  const unknownHealth = makePlanInput();
  unknownHealth.health.entries[0].galleryId = "unknown-item";
  assert.throws(() => buildCatalogChangePlan(unknownHealth), expectCode("UNKNOWN_ID"));

  const unknownFreshness = makePlanInput();
  unknownFreshness.freshness.entries[0].galleryId = "unknown-item";
  assert.throws(() => buildCatalogChangePlan(unknownFreshness), expectCode("UNKNOWN_ID"));
});

test("rejects duplicate incoming identities, gallery IDs, and canonical URLs", () => {
  const duplicateIdentity = makePlanInput();
  duplicateIdentity.candidates.push(clone(duplicateIdentity.candidates[0]));
  assert.throws(() => buildCatalogChangePlan(duplicateIdentity), expectCode("DUPLICATE_IDENTITY"));

  const duplicateUrl = makePlanInput();
  duplicateUrl.candidates.push(makeCandidate(
    "another-item",
    "another-source",
    duplicateUrl.candidates[0].canonicalUrl,
  ));
  assert.throws(() => buildCatalogChangePlan(duplicateUrl), expectCode("DUPLICATE_CANONICAL_URL"));

  const duplicateGalleryId = makePlanInput();
  const candidate = makeCandidate("publish-item", "different-source", "https://example.com/different-source");
  duplicateGalleryId.candidates.push(candidate);
  assert.throws(() => buildCatalogChangePlan(duplicateGalleryId), expectCode("DUPLICATE_IDENTITY"));
});

test("rejects duplicate IDs and canonical URLs across active and retired state", () => {
  const duplicateId = makePlanInput();
  duplicateId.retiredRecords.push(makeRecord(
    "update-item",
    "https://learn.microsoft.com/azure/cosmos-db/other-retired",
    "retired",
  ));
  assert.throws(() => buildCatalogChangePlan(duplicateId), expectCode("DUPLICATE_IDENTITY"));

  const duplicateUrl = makePlanInput();
  duplicateUrl.retiredRecords.push(makeRecord(
    "other-retired",
    duplicateUrl.activeRecords[0].canonicalSource,
    "retired",
  ));
  assert.throws(() => buildCatalogChangePlan(duplicateUrl), expectCode("DUPLICATE_CANONICAL_URL"));
});

test("rejects conflicting quarantine and retirement decisions", () => {
  const input = makePlanInput();
  const freshness = input.freshness.entries.find((entry) => entry.galleryId === "quarantine-item");
  freshness.recommendation = "retire";
  freshness.health.status = "retired";
  input.freshness.healthSnapshot.entries.find(
    (entry) => entry.galleryId === "quarantine-item",
  ).status = "retired";

  assert.throws(() => buildCatalogChangePlan(input), expectCode("CONFLICTING_OPERATIONS"));

  const incompatibleSnapshots = makePlanInput();
  incompatibleSnapshots.health.entries.find(
    (entry) => entry.galleryId === "quarantine-item",
  ).status = "retired";
  assert.throws(() => buildCatalogChangePlan(incompatibleSnapshots), expectCode("CONFLICTING_OPERATIONS"));
});

test("validates exemptions and suppresses only matching lifecycle mutations", () => {
  const input = makePlanInput();
  input.exemptions.exemptions = [
    {
      id: "keep-quarantine-item",
      galleryId: "quarantine-item",
      ruleIds: ["lifecycle.quarantine"],
      owner: "Fixture Owner",
      rationale: "The owner is correcting the source.",
      startsAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-09-01T00:00:00.000Z",
      status: "active",
    },
    {
      id: "keep-retire-item",
      galleryId: "retire-item",
      ruleIds: ["lifecycle.retire"],
      owner: "Fixture Owner",
      rationale: "The replacement is not ready.",
      startsAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-09-01T00:00:00.000Z",
      status: "active",
    },
  ];

  const plan = buildCatalogChangePlan(input);
  assert.equal(plan.summary.quarantine, 0);
  assert.equal(plan.summary.retire, 0);
  assert.equal(plan.summary.total, 3);
  assert(!plan.operations.some((operation) => ["quarantine-item", "retire-item"].includes(operation.targetId)));

  const crossedRules = makePlanInput();
  crossedRules.exemptions.exemptions = [
    {
      ...input.exemptions.exemptions[0],
      id: "quarantine-rule-cannot-waive-retirement",
      galleryId: "retire-item",
    },
    {
      ...input.exemptions.exemptions[1],
      id: "retirement-rule-cannot-waive-quarantine",
      galleryId: "quarantine-item",
    },
  ];
  const crossedPlan = buildCatalogChangePlan(crossedRules);
  assert.equal(crossedPlan.summary.quarantine, 1);
  assert.equal(crossedPlan.summary.retire, 1);

  const nearMatch = makePlanInput();
  nearMatch.exemptions.exemptions = [{
    ...input.exemptions.exemptions[0],
    id: "near-match-does-not-waive",
    ruleIds: ["lifecycle.quarantine.extra"],
  }];
  assert.equal(buildCatalogChangePlan(nearMatch).summary.quarantine, 1);

  const changedExpiry = clone(input);
  changedExpiry.exemptions.exemptions[0].expiresAt = "2026-09-02T00:00:00.000Z";
  assert.notEqual(buildCatalogChangePlan(changedExpiry).inputFingerprint, plan.inputFingerprint);

  const expired = makePlanInput();
  expired.exemptions.exemptions = [{
    ...input.exemptions.exemptions[0],
    expiresAt: input.generatedAt,
  }];
  assert.throws(() => buildCatalogChangePlan(expired), expectCode("MISSING_GATE"));

  const malformed = makePlanInput();
  malformed.exemptions.exemptions = [{ ...input.exemptions.exemptions[0] }];
  delete malformed.exemptions.exemptions[0].owner;
  assert.throws(() => buildCatalogChangePlan(malformed), expectCode("SCHEMA_INVALID"));

  const deterministicRule = makePlanInput();
  deterministicRule.exemptions.exemptions = [{
    ...input.exemptions.exemptions[0],
    ruleIds: ["catalog.schema"],
  }];
  assert.throws(() => buildCatalogChangePlan(deterministicRule), expectCode("MISSING_GATE"));
});

test("never applies lifecycle exemptions to schema, identity, or relevance gates", () => {
  const schemaFailure = makePlanInput();
  schemaFailure.exemptions.exemptions = [{
    id: "schema-cannot-be-waived",
    galleryId: "quarantine-item",
    ruleIds: ["lifecycle.quarantine"],
    owner: "Fixture Owner",
    rationale: "Lifecycle pause only.",
    startsAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-09-01T00:00:00.000Z",
    status: "active",
  }];
  delete schemaFailure.activeRecords.find((record) => record.id === "quarantine-item").launchUrl;
  assert.throws(() => buildCatalogChangePlan(schemaFailure), expectCode("SCHEMA_INVALID"));

  const relevanceFailure = makePlanInput();
  relevanceFailure.exemptions.exemptions = [{
    ...schemaFailure.exemptions.exemptions[0],
    id: "relevance-cannot-be-waived",
    galleryId: "publish-item",
    ruleIds: ["analysis.relevance"],
  }];
  relevanceFailure.analyses[0].relevance.material = false;
  assert.throws(() => buildCatalogChangePlan(relevanceFailure), expectCode("GATE_REJECTED"));
});

test("does not use a rejected candidate source to retire a different active source", () => {
  const input = makePlanInput();
  const analysis = input.analyses.find((item) => item.candidateId.includes("update-source"));
  analysis.recommendation = "reject";
  analysis.reasonCodes = ["AI_REJECTED"];
  const health = input.health.entries.find((entry) => entry.galleryId === "update-item");
  health.status = "retired";
  const freshness = input.freshness.entries.find((entry) => entry.galleryId === "update-item");
  freshness.recommendation = "retire";
  freshness.health.status = "retired";
  input.freshness.healthSnapshot.entries.find((entry) => entry.galleryId === "update-item").status = "retired";

  assert.throws(() => buildCatalogChangePlan(input), expectCode("CONFLICTING_OPERATIONS"));
});

test("rejects indeterminate health and freshness instead of proposing a mutation", () => {
  const healthInput = makePlanInput();
  const health = healthInput.health.entries.find((entry) => entry.galleryId === "publish-item");
  health.status = "indeterminate";
  health.sourceState.availability = "indeterminate";
  assert.throws(() => buildCatalogChangePlan(healthInput), expectCode("INDETERMINATE_HEALTH"));

  const freshnessInput = makePlanInput();
  const freshness = freshnessInput.freshness.entries.find((entry) => entry.galleryId === "publish-item");
  freshness.health.status = "indeterminate";
  freshness.health.sourceState.availability = "indeterminate";
  assert.throws(() => buildCatalogChangePlan(freshnessInput), expectCode("INDETERMINATE_HEALTH"));
});

test("rejects emergency and operation-specific policy disables", () => {
  const emergency = makePlanInput();
  emergency.policy.automation.emergencyDisable = true;
  assert.throws(() => buildCatalogChangePlan(emergency), expectCode("POLICY_EMERGENCY_DISABLED"));

  const disabled = makePlanInput();
  disabled.policy.automation.mutation.catalogPublication = false;
  assert.throws(() => buildCatalogChangePlan(disabled), expectCode("MUTATION_DISABLED"));

  const aiDisabled = makePlanInput();
  aiDisabled.policy.automation.ai.summaryGroundingVerification = false;
  assert.throws(() => buildCatalogChangePlan(aiDisabled), expectCode("AI_GATE_DISABLED"));

  const freshnessAiDisabled = makePlanInput();
  freshnessAiDisabled.policy.automation.ai.freshnessAnalysis = false;
  assert.throws(() => buildCatalogChangePlan(freshnessAiDisabled), expectCode("AI_GATE_DISABLED"));
});

test("keeps the repository mutation policy disabled by default", () => {
  assert.equal(repositoryPolicy.automation.emergencyDisable, true);
  assert(Object.values(repositoryPolicy.automation.ai).every((enabled) => enabled === false));
  assert(Object.values(repositoryPolicy.automation.mutation).every((enabled) => enabled === false));

  const input = makePlanInput();
  input.policy = repositoryPolicy;
  assert.throws(() => buildCatalogChangePlan(input), expectCode("POLICY_EMERGENCY_DISABLED"));
});

test("enforces retirement confirmation and grace policy independently", () => {
  const insufficientConfirmations = makePlanInput();
  for (const entry of [
    insufficientConfirmations.health.entries.find((item) => item.galleryId === "retire-item"),
    insufficientConfirmations.freshness.entries.find((item) => item.galleryId === "retire-item").health,
    insufficientConfirmations.freshness.healthSnapshot.entries.find((item) => item.galleryId === "retire-item"),
  ]) entry.consecutiveFindings = 1;
  assert.throws(() => buildCatalogChangePlan(insufficientConfirmations), expectCode("MISSING_GATE"));

  const graceNotElapsed = makePlanInput();
  for (const entry of [
    graceNotElapsed.health.entries.find((item) => item.galleryId === "retire-item"),
    graceNotElapsed.freshness.entries.find((item) => item.galleryId === "retire-item").health,
    graceNotElapsed.freshness.healthSnapshot.entries.find((item) => item.galleryId === "retire-item"),
  ]) entry.gracePeriodStartedAt = "2026-08-20T00:00:00.000Z";
  assert.throws(() => buildCatalogChangePlan(graceNotElapsed), expectCode("MISSING_GATE"));
});

test("fails closed when a replay transition changes identity", () => {
  const input = makePlanInput();
  const plan = buildCatalogChangePlan(input);
  const tampered = clone(plan);
  tampered.operations[0].after.id = "changed-target";

  assert.throws(
    () => replayCatalogChangePlan(tampered, input),
    expectCode("NON_IDEMPOTENT_REPLAY"),
  );
});

test("rejects noncanonical operation ordering and no-op transitions", () => {
  const input = makePlanInput();
  const reversed = buildCatalogChangePlan(input);
  reversed.operations.reverse();
  assert.throws(
    () => replayCatalogChangePlan(reversed, input),
    expectCode("PLAN_SCHEMA_INVALID"),
  );

  const noOp = buildCatalogChangePlan(input);
  const update = noOp.operations.find((operation) => operation.type === "update");
  update.after = clone(update.before);
  refreshOperationId(update);
  assert.throws(
    () => replayCatalogChangePlan(noOp, input),
    expectCode("NON_IDEMPOTENT_REPLAY"),
  );
});

test("rejects illegal lifecycle labels and missing operation reason codes", () => {
  const input = makePlanInput();
  const plan = buildCatalogChangePlan(input);
  const illegalRestore = clone(plan);
  const restore = illegalRestore.operations.find((operation) => operation.type === "restore");
  restore.before.lifecycleStatus = "active";
  refreshOperationId(restore);
  assert.throws(
    () => replayCatalogChangePlan(illegalRestore, input),
    expectCode("NON_IDEMPOTENT_REPLAY"),
  );

  const missingReason = clone(plan);
  missingReason.operations[0].reasonCodes = ["MATERIAL_RELEVANCE"];
  assert.throws(
    () => replayCatalogChangePlan(missingReason, input),
    expectCode("NON_IDEMPOTENT_REPLAY"),
  );

  const metadataRewrite = clone(plan);
  const retire = metadataRewrite.operations.find((operation) => operation.type === "retire");
  retire.after.title = "Rewritten while retiring";
  refreshOperationId(retire);
  assert.throws(
    () => replayCatalogChangePlan(metadataRewrite, input),
    expectCode("NON_IDEMPOTENT_REPLAY"),
  );
});

test("rejects malformed retired envelopes and noncanonical external plan records", () => {
  const malformedEnvelope = makePlanInput();
  malformedEnvelope.retiredRecords = { version: "1.0.0", entries: [] };
  assert.throws(() => buildCatalogChangePlan(malformedEnvelope), expectCode("SCHEMA_INVALID"));

  const input = makePlanInput();
  const plan = buildCatalogChangePlan(input);
  const noncanonical = clone(plan);
  const publish = noncanonical.operations.find((operation) => operation.type === "publish");
  publish.after.canonicalSource = `${publish.after.canonicalSource}/`;
  refreshOperationId(publish);
  assert.throws(() => replayCatalogChangePlan(noncanonical, input), expectCode("SCHEMA_INVALID"));
});

test("rejects unknown superseding IDs in planned output", () => {
  const input = makePlanInput();
  input.candidates.find((candidate) => candidate.metadata.galleryId === "publish-item")
    .metadata.supersededBy = "missing-replacement";

  assert.throws(() => buildCatalogChangePlan(input), expectCode("UNKNOWN_ID"));
});

test("rejects cyclic and non-active superseding targets", () => {
  const cycle = makePlanInput();
  cycle.activeRecords[0].supersededBy = "quarantine-item";
  cycle.activeRecords[1].supersededBy = "update-item";
  assert.throws(() => buildCatalogChangePlan(cycle), expectCode("CONFLICTING_OPERATIONS"));

  const retiredTarget = makePlanInput();
  retiredTarget.activeRecords[0].supersededBy = "restore-item";
  assert.throws(() => buildCatalogChangePlan(retiredTarget), expectCode("CONFLICTING_OPERATIONS"));
});

test("rejects replay output that would create a duplicate canonical URL", () => {
  const input = makePlanInput();
  const plan = buildCatalogChangePlan(input);
  const tampered = clone(plan);
  const operation = tampered.operations.find((item) => item.type === "update");
  operation.after.canonicalSource = input.activeRecords.find(
    (record) => record.id === "quarantine-item",
  ).canonicalSource;
  operation.healthAfter.canonicalSource = operation.after.canonicalSource;
  refreshOperationId(operation);

  assert.throws(
    () => replayCatalogChangePlan(tampered, input),
    expectCode("DUPLICATE_CANONICAL_URL"),
  );
});