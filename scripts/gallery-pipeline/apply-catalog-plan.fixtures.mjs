import { buildCatalogChangePlan } from "./build-catalog-change.mjs";
import {
  FIXTURE_TIME,
  makeHealthEntry,
  makePlanInput,
} from "./build-catalog-change.fixtures.mjs";
import { emptyAuditLog } from "./write-audit.mjs";

function retiredEntry(record) {
  return {
    record: structuredClone(record),
    retiredAt: "2026-01-15T00:00:00.000Z",
    retentionUntil: "2027-01-15",
    reasonCodes: ["PREVIOUS_RETIREMENT"],
    evidence: [{
      observedAt: "2026-01-15T00:00:00.000Z",
      source: record.canonicalSource,
      reason: "health",
    }],
    supersededBy: null,
    decisionRunUrl: "https://github.com/example/gallery/actions/runs/100",
    decisionPullRequestUrl: "https://github.com/example/gallery/pull/10",
  };
}

export function makeCatalogReplayFixture() {
  const planningInput = makePlanInput();
  const previouslyRetired = planningInput.retiredRecords[0];
  const retired = {
    $schema: "../.github/gallery-pipeline/retired-entries.schema.json",
    version: "1.0.0",
    entries: [retiredEntry(previouslyRetired)],
  };
  planningInput.retiredRecords = retired;
  const plan = buildCatalogChangePlan(planningInput);
  const priorHealthEntries = [
    ...planningInput.activeRecords.map((record) => makeHealthEntry(
      record.id,
      record.canonicalSource,
      "healthy",
    )),
    makeHealthEntry(previouslyRetired.id, previouslyRetired.canonicalSource, "retired"),
  ];
  priorHealthEntries.forEach((entry) => {
    entry.checkedAt = FIXTURE_TIME;
    entry.evidence.forEach((evidence) => {
      evidence.observedAt = FIXTURE_TIME;
    });
  });

  return {
    plan,
    trustedRepository: planningInput.trustedRepository,
    policy: structuredClone(planningInput.policy),
    activeCatalog: structuredClone(planningInput.activeRecords),
    health: {
      $schema: "../.github/gallery-pipeline/health.schema.json",
      version: "1.0.0",
      entries: priorHealthEntries,
    },
    retired,
    audit: emptyAuditLog(),
  };
}