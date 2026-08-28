import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyFreshnessScore,
  evaluateCatalogFreshness,
  evaluateRepositoryFreshness,
  findLastMeaningfulChange,
} from "./freshness.mjs";

const policy = {
  contractVersions: { health: "1.0.0" },
  healthThresholds: { healthyMinimum: 80, needsReviewMinimum: 60, quarantineMinimum: 40 },
  lifecycle: { requiredConfirmations: 2, retirementGraceDays: 30 },
  freshness: { reviewAfterDays: 365, highSeverityAfterDays: 730 },
};

const evaluatedAt = "2026-08-27T12:00:00.000Z";

function record(overrides = {}) {
  return {
    id: "cosmos-sample",
    title: "Azure Cosmos DB sample",
    canonicalSource: "https://github.com/Example/Cosmos-Sample",
    sourceType: "github-repository",
    tags: ["example"],
    ...overrides,
  };
}

function completeMetadata(overrides = {}) {
  return {
    repository: {
      full_name: "example/cosmos-sample",
      html_url: "https://github.com/example/cosmos-sample",
      archived: false,
      disabled: false,
      private: false,
      default_branch: "main",
      license: { spdx_id: "MIT" },
      topics: ["azure-cosmos-db"],
    },
    commits: [{ committedAt: "2026-08-20T12:00:00.000Z", author: { login: "maintainer", type: "User" }, files: ["src/app.js"] }],
    releases: [{ published_at: "2026-08-01T12:00:00.000Z" }],
    issues: [],
    pulls: [],
    readme: "# Sample\n## Prerequisites\n## Setup\n## Cleanup",
    signals: {
      defaultBranchExists: true,
      readmePresent: true,
      prerequisitesPresent: true,
      setupPresent: true,
      cleanupPresent: true,
      licensePresent: true,
      reproducible: true,
      supportedRuntime: true,
      supportedDependencies: true,
      cosmosDbMaterial: true,
      currentProductFeature: true,
      currentAuthAndDeploymentGuidance: true,
      uniqueCoverage: true,
      audienceDemand: true,
      strategicPriority: true,
      noBetterReplacement: true,
    },
    ...overrides,
  };
}

test("classifies every policy score boundary deterministically", () => {
  assert.equal(classifyFreshnessScore(100, policy), "healthy");
  assert.equal(classifyFreshnessScore(80, policy), "healthy");
  assert.equal(classifyFreshnessScore(79, policy), "needs-review");
  assert.equal(classifyFreshnessScore(60, policy), "needs-review");
  assert.equal(classifyFreshnessScore(59, policy), "quarantine");
  assert.equal(classifyFreshnessScore(40, policy), "quarantine");
  assert.equal(classifyFreshnessScore(39, policy), "retire");
  assert.equal(classifyFreshnessScore(0, policy), "retire");
});

test("scores a fully evidenced repository at 100 points", () => {
  const result = evaluateRepositoryFreshness(record(), completeMetadata(), { policy, evaluatedAt });
  assert.equal(result.health.healthScore, 100);
  assert.deepEqual(result.health.components, {
    availabilityIntegrity: 25,
    maintenanceFreshness: 25,
    sampleUsability: 20,
    productRelevance: 20,
    galleryValue: 10,
  });
  assert.equal(result.health.status, "healthy");
  assert.equal(result.recommendation, "keep");
});

test("does not count bot or dependency-only commits as meaningful freshness", () => {
  const activity = findLastMeaningfulChange({
    repository: { pushed_at: "2026-08-27T00:00:00.000Z" },
    commits: [
      { committedAt: "2026-08-26T00:00:00.000Z", author: { login: "dependabot[bot]", type: "Bot" }, files: ["src/app.js"] },
      { committedAt: "2026-08-25T00:00:00.000Z", author: { login: "maintainer", type: "User" }, files: ["package-lock.json"] },
      { committedAt: "2024-01-01T00:00:00.000Z", author: { login: "maintainer", type: "User" }, files: ["src/app.js"] },
    ],
  });
  assert.equal(activity.lastMeaningfulChange, "2024-01-01T00:00:00.000Z");
  assert.equal(activity.excludedCommitCount, 2);
});

test("keeps an inactive evergreen repository visible and only marks it for review", () => {
  const metadata = completeMetadata({
    commits: [
      { committedAt: "2026-08-26T00:00:00.000Z", author: { login: "renovate[bot]", type: "Bot" }, files: ["src/app.js"] },
      { committedAt: "2024-01-01T00:00:00.000Z", author: { login: "maintainer", type: "User" }, files: ["src/app.js"] },
    ],
  });
  const result = evaluateRepositoryFreshness(record(), metadata, { policy, evaluatedAt });
  assert.equal(result.health.healthScore, 85);
  assert.equal(result.health.status, "needs-review");
  assert.equal(result.recommendation, "keep-visible");
  assert.equal(result.health.sourceState.lastMeaningfulChange, "2024-01-01T00:00:00.000Z");
});

test("quarantines authoritative archived state immediately", () => {
  const metadata = completeMetadata({
    repository: { ...completeMetadata().repository, archived: true },
  });
  const result = evaluateRepositoryFreshness(record(), metadata, { policy, evaluatedAt });
  assert.equal(result.health.status, "quarantined");
  assert.equal(result.recommendation, "quarantine");
  assert.equal(result.health.sourceState.archived, true);
  assert.equal(result.health.consecutiveFindings, 1);
});

test("retires authoritative deletion only after confirmation and grace", () => {
  const currentHealth = {
    entries: [{
      galleryId: "cosmos-sample",
      canonicalSource: "https://github.com/example/cosmos-sample",
      status: "quarantined",
      healthReasons: ["REPOSITORY_DELETED"],
      consecutiveFindings: 1,
      gracePeriodStartedAt: "2026-07-01T12:00:00.000Z",
    }],
  };
  const result = evaluateRepositoryFreshness(
    record(),
    { availability: "deleted", authoritative: true },
    { policy, health: currentHealth, evaluatedAt },
  );
  assert.equal(result.health.status, "retired");
  assert.equal(result.recommendation, "retire");
  assert.equal(result.health.consecutiveFindings, 2);
});

test("fails closed for partial metadata", () => {
  const result = evaluateRepositoryFreshness(
    record(),
    { ...completeMetadata(), complete: false },
    { policy, evaluatedAt },
  );
  assert.equal(result.health.status, "indeterminate");
  assert.equal(result.recommendation, "no-action");
  assert.equal(result.mutation, "none");
});

test("marks non-GitHub records not applicable", () => {
  const report = evaluateCatalogFreshness([
    record(),
    record({ id: "learn", sourceType: "learn-document", canonicalSource: "https://learn.microsoft.com/azure/cosmos-db" }),
  ], {
    githubMetadata: [completeMetadata()],
    policy,
    health: { entries: [] },
    evaluatedAt,
  });
  assert.equal(report.entries[0].applicability, "applicable");
  assert.equal(report.entries[1].applicability, "not-applicable");
  assert.equal(report.entries[1].health, null);
  assert.equal(report.entries[1].mutation, "none");
});