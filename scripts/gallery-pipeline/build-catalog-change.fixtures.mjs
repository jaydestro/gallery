import { normalizeCandidate } from "./normalize.mjs";
import { SOURCE_SHARING_POLICY } from "./validation.mjs";

export const FIXTURE_TIME = "2026-08-27T12:00:00.000Z";

export function makeRecord(id, canonicalSource, lifecycleStatus = "active") {
  return {
    id,
    title: `${id} title`,
    summary: `${id} summary`,
    preview: `https://example.com/previews/${id}.png`,
    launchUrl: canonicalSource,
    canonicalSource,
    sourceType: "learn-document",
    author: "Fixture Author",
    sourceOwner: null,
    website: "https://example.com/fixture-owner",
    tags: ["example"],
    publishedAt: "2026-01-15T00:00:00.000Z",
    dateAdded: null,
    lastVerified: null,
    lifecycleStatus,
  };
}

export function makeCandidate(id, sourceId, canonicalUrl) {
  return normalizeCandidate({
    sourceType: "learn-document",
    sourceId,
    canonicalUrl,
    title: `${id} candidate title`,
    description: `${id} candidate description`,
    publisher: "Fixture Publisher",
    publishedAt: "2026-01-15T00:00:00.000Z",
    modifiedAt: "2026-08-20T00:00:00.000Z",
    discoveredAt: FIXTURE_TIME,
    evidence: [{
      type: "learn-cosmos-section",
      value: `Evidence for ${id}`,
      url: canonicalUrl,
    }],
    metadata: {
      sourceRegistryId: "fixture-learn",
      galleryId: id,
      preview: `https://example.com/previews/${id}.png`,
      launchUrl: canonicalUrl,
      tags: ["example"],
      author: "Fixture Author",
      sourceOwner: null,
      website: "https://example.com/fixture-author",
    },
  });
}

export function makeAnalysis(candidate, recommendation, matchedEntryId = null) {
  const duplicate = matchedEntryId === null ? "unique" : "duplicate";
  return {
    version: "1.0.0",
    candidateId: candidate.identityKey,
    relevance: {
      score: 1,
      material: true,
      evidence: [{ url: candidate.canonicalUrl, excerpt: "Azure Cosmos DB is the central subject." }],
      rationale: "Fixture content is materially relevant.",
    },
    grounding: {
      score: 1,
      claims: [{
        claim: "The fixture covers Azure Cosmos DB.",
        entailed: true,
        evidence: [{ url: candidate.canonicalUrl, excerpt: "Azure Cosmos DB is the central subject." }],
      }],
    },
    duplicate: {
      score: duplicate === "duplicate" ? 0.99 : 0.01,
      classification: duplicate,
      matchedEntryId,
      evidence: duplicate === "duplicate"
        ? [{ url: candidate.canonicalUrl, excerpt: "The record identity matches." }]
        : [],
    },
    quality: { passes: true, flags: [] },
    recommendation,
    reasonCodes: [`AI_${recommendation.toUpperCase()}_APPROVED`],
    generatedSummary: `${candidate.metadata.galleryId} generated summary`,
  };
}

export function makeHealthEntry(id, canonicalSource, status = "healthy") {
  const healthy = status === "healthy";
  const components = healthy
    ? {
        availabilityIntegrity: 25,
        maintenanceFreshness: 25,
        sampleUsability: 20,
        productRelevance: 20,
        galleryValue: 10,
      }
    : {
        availabilityIntegrity: 0,
        maintenanceFreshness: 10,
        sampleUsability: 10,
        productRelevance: 10,
        galleryValue: 5,
      };
  return {
    galleryId: id,
    canonicalSource,
    checkedAt: FIXTURE_TIME,
    status,
    healthScore: Object.values(components).reduce((sum, score) => sum + score, 0),
    components,
    healthReasons: healthy ? [] : [status === "retired" ? "RETIREMENT_CONFIRMED" : "QUARANTINE_CONFIRMED"],
    consecutiveFindings: healthy ? 0 : 2,
    gracePeriodStartedAt: healthy ? null : "2026-07-01T00:00:00.000Z",
    sourceState: {
      availability: healthy ? "available" : "broken",
      archived: healthy ? false : true,
      disabled: false,
      lastMeaningfulChange: "2026-06-01T00:00:00.000Z",
    },
    evidence: [{
      kind: "fixture-check",
      observedAt: FIXTURE_TIME,
      source: canonicalSource,
      value: status,
    }],
  };
}

export function makeFreshnessEntry(healthEntry, recommendation = "keep") {
  return {
    galleryId: healthEntry.galleryId,
    canonicalSource: healthEntry.canonicalSource,
    applicability: "applicable",
    scoreBand: healthEntry.status === "retired" ? "retire" : healthEntry.status,
    recommendation,
    mutation: "none",
    health: structuredClone(healthEntry),
  };
}

export function makeEnabledPolicy() {
  return {
    version: "1.0.0",
    contractVersions: {
      policy: "1.0.0",
      catalog: "2.0.0",
      analysis: "1.0.0",
      health: "1.0.0",
      retiredEntries: "1.0.0",
      exemptions: "1.0.0",
    },
    http: { retryDelaySeconds: [0, 5, 30, 120], timeoutSeconds: 30 },
    thresholds: { materialRelevance: 0.95, summaryGrounding: 0.95 },
    batching: { maxEntriesPerPullRequest: 25 },
    lifecycle: { requiredConfirmations: 2, retirementGraceDays: 30 },
    exemptions: { maximumDurationDays: 90 },
    audit: { retentionDays: 365 },
    automation: {
      emergencyDisable: false,
      mutationMode: "dry-run",
      ai: {
        relevanceClassification: true,
        summaryGeneration: true,
        summaryGroundingVerification: true,
        semanticDuplicateDetection: true,
        freshnessAnalysis: true,
      },
      mutation: {
        catalogPublication: true,
        metadataUpdate: true,
        quarantine: true,
        retirement: true,
        restoration: true,
        automaticMerge: false,
      },
    },
  };
}

function makeSourceSharingRecords() {
  return SOURCE_SHARING_POLICY.flatMap((allowance, allowanceIndex) => (
    allowance.members.map((title, memberIndex) => ({
      ...makeRecord(
        `source-sharing-${allowanceIndex + 1}-${memberIndex + 1}`,
        allowance.canonicalSource,
      ),
      title,
    }))
  ));
}

export function makePlanInput() {
  const activeRecords = [
    makeRecord("update-item", "https://learn.microsoft.com/azure/cosmos-db/update-v1"),
    makeRecord("quarantine-item", "https://learn.microsoft.com/azure/cosmos-db/quarantine"),
    makeRecord("retire-item", "https://learn.microsoft.com/azure/cosmos-db/retire"),
    ...makeSourceSharingRecords(),
  ];
  const retiredRecords = [
    makeRecord("restore-item", "https://learn.microsoft.com/azure/cosmos-db/restore", "retired"),
  ];
  const candidates = [
    makeCandidate("publish-item", "publish-source", "https://learn.microsoft.com/azure/cosmos-db/publish"),
    makeCandidate("update-item", "update-source", "https://learn.microsoft.com/azure/cosmos-db/update-v2"),
    makeCandidate("restore-item", "restore-source", "https://learn.microsoft.com/azure/cosmos-db/restore"),
  ];
  const analyses = [
    makeAnalysis(candidates[0], "publish"),
    makeAnalysis(candidates[1], "update", "update-item"),
    makeAnalysis(candidates[2], "update", "restore-item"),
  ];
  const sourceById = new Map([
    ...activeRecords.map((record) => [record.id, record.canonicalSource]),
    ...retiredRecords.map((record) => [record.id, record.canonicalSource]),
    ...candidates.map((candidate) => [candidate.metadata.galleryId, candidate.canonicalUrl]),
  ]);
  const statuses = new Map([...sourceById.keys()].map((id) => [id, "healthy"]));
  statuses.set("quarantine-item", "quarantined");
  statuses.set("retire-item", "retired");
  const healthEntries = [...statuses].map(([id, status]) => (
    makeHealthEntry(id, sourceById.get(id), status)
  ));
  const freshnessEntries = healthEntries.map((entry) => makeFreshnessEntry(
    entry,
    entry.status === "quarantined" ? "quarantine" : entry.status === "retired" ? "retire" : "keep",
  ));
  return {
    runId: "gallery-run-20260827-120000",
    generatedAt: FIXTURE_TIME,
    trustedRepository: "example/gallery",
    decisionRunUrl: "https://github.com/example/gallery/actions/runs/123456789",
    decisionPullRequestUrl: "https://github.com/example/gallery/pull/42",
    decisionRepositoryOwner: "example",
    decisionRepositoryName: "gallery",
    decisionRunId: "123456789",
    decisionPullRequestNumber: "42",
    candidates,
    analyses,
    health: {
      $schema: "../.github/gallery-pipeline/health.schema.json",
      version: "1.0.0",
      entries: healthEntries,
    },
    freshness: {
      version: "1.0.0",
      generatedAt: FIXTURE_TIME,
      mode: "dry-run",
      entries: freshnessEntries,
      healthSnapshot: {
        $schema: "../.github/gallery-pipeline/health.schema.json",
        version: "1.0.0",
        entries: freshnessEntries.map((entry) => structuredClone(entry.health)),
      },
    },
    activeRecords,
    retiredRecords,
    policy: makeEnabledPolicy(),
    exemptions: {
      $schema: "./exemptions.schema.json",
      version: "1.0.0",
      exemptions: [],
    },
  };
}