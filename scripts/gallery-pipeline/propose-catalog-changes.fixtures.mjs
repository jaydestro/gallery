import {
  FIXTURE_TIME,
  makeAnalysis,
  makeCandidate,
  makeEnabledPolicy,
  makeFreshnessEntry,
  makeHealthEntry,
  makePlanInput,
} from "./build-catalog-change.fixtures.mjs";
import { hashCanonicalValue } from "./build-catalog-change.mjs";
import { emptyAuditLog } from "./write-audit.mjs";

function clone(value) {
  return structuredClone(value);
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function proposalCandidate(number) {
  const suffix = String(number).padStart(3, "0");
  const id = `proposal-${suffix}`;
  const candidate = makeCandidate(
    id,
    `proposal-source-${suffix}`,
    `https://learn.microsoft.com/azure/cosmos-db/proposal-${suffix}`,
  );
  candidate.metadata.sourceOwner = "Fixture Source Owner";
  return candidate;
}

function modelAnalysisReceipt(modelAnalysis) {
  return {
    schemaVersion: "1.0.0",
    reportFingerprint: hashCanonicalValue(modelAnalysis),
    analysisCount: modelAnalysis.analyses.length,
  };
}

function deterministicGate(candidate) {
  return {
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
      outcome: "unique",
      identityKeyChecked: true,
      canonicalUrlChecked: true,
    },
    normalization: { status: "passed", schemaVersion: "1.0.0" },
  };
}

function sourceSharingBaseline() {
  return makePlanInput().activeRecords
    .filter((record) => record.id.startsWith("source-sharing-"))
    .map(clone);
}

function upstreamArtifact(name, workflowPath, runId, artifactId, digestCharacter) {
  const artifactPrefix = {
    discovery: "gallery-discovery-",
    health: "gallery-health-",
    freshness: "gallery-freshness-",
  }[name];
  return {
    name,
    repository: "example/gallery",
    workflowId: String(100 + Number(runId)),
    workflowPath,
    runId,
    runAttempt: 1,
    sourceRef: "refs/heads/main",
    sourceSha: "0123456789abcdef0123456789abcdef01234567",
    artifactId,
    artifactName: `${artifactPrefix}${runId}-1`,
    digest: `sha256:${digestCharacter.repeat(64)}`,
  };
}

export function makeProposalFixture({ candidateCount = 3 } = {}) {
  positiveInteger(candidateCount, "candidateCount");
  const candidates = Array.from({ length: candidateCount }, (_, index) => proposalCandidate(index + 1));
  const activeCatalog = sourceSharingBaseline();
  const healthEntries = activeCatalog.map((record) => (
    makeHealthEntry(record.id, record.canonicalSource)
  ));
  const freshnessEntries = healthEntries.map((entry) => makeFreshnessEntry(entry));
  const modelAnalysis = {
    schemaVersion: "1.0.0",
    mode: "precomputed",
    status: "complete",
    generatedAt: FIXTURE_TIME,
    analyses: candidates.map((candidate) => makeAnalysis(candidate, "publish")),
  };
  return {
    runId: `proposal-fixture-${candidateCount}`,
    generatedAt: FIXTURE_TIME,
    workflowStartedAt: "2026-08-27T11:55:00.000Z",
    trustedRepository: "example/gallery",
    trustedRef: "refs/heads/main",
    trustedSha: "0123456789abcdef0123456789abcdef01234567",
    upstreamArtifacts: [
      upstreamArtifact(
        "discovery",
        ".github/workflows/discover-content.yml",
        "1001",
        "2001",
        "a",
      ),
      upstreamArtifact(
        "health",
        ".github/workflows/scan-gallery-health.yml",
        "1002",
        "2002",
        "b",
      ),
      upstreamArtifact(
        "freshness",
        ".github/workflows/evaluate-repository-freshness.yml",
        "1003",
        "2003",
        "c",
      ),
    ],
    discovery: {
      schemaVersion: "1.0.0",
      mode: "dry-run",
      mutationPerformed: false,
      status: "complete",
      startedAt: FIXTURE_TIME,
      completedAt: FIXTURE_TIME,
      candidates: clone(candidates),
      sources: [],
      rejected: [],
    },
    candidateGates: {
      schemaVersion: "1.0.0",
      mode: "dry-run",
      mutationPerformed: false,
      status: "complete",
      startedAt: FIXTURE_TIME,
      completedAt: FIXTURE_TIME,
      summary: {
        candidates: candidateCount,
        availabilityChecks: candidateCount,
        indeterminateAvailabilityChecks: 0,
        eligible: candidateCount,
        rejected: 0,
      },
      eligible: candidates.map((candidate) => ({
        candidate: clone(candidate),
        deterministicGate: deterministicGate(candidate),
        availability: {
          checkedAt: FIXTURE_TIME,
          classification: "healthy",
          statusCode: 200,
          reasonCode: null,
        },
      })),
      rejected: [],
    },
    modelAnalysis,
    modelAnalysisReceipt: modelAnalysisReceipt(modelAnalysis),
    health: {
      $schema: "../.github/gallery-pipeline/health.schema.json",
      version: "1.0.0",
      entries: clone(healthEntries),
    },
    freshness: {
      version: "1.0.0",
      generatedAt: FIXTURE_TIME,
      mode: "dry-run",
      entries: clone(freshnessEntries),
      healthSnapshot: {
        $schema: "../.github/gallery-pipeline/health.schema.json",
        version: "1.0.0",
        entries: freshnessEntries.map((entry) => clone(entry.health)),
      },
    },
    activeCatalog,
    retired: {
      $schema: "../.github/gallery-pipeline/retired-entries.schema.json",
      version: "1.0.0",
      entries: [],
    },
    audit: emptyAuditLog(),
    exemptions: {
      $schema: "./exemptions.schema.json",
      version: "1.0.0",
      exemptions: [],
    },
    policy: makeEnabledPolicy(),
    retirementProvenance: null,
  };
}

export function makeDisabledProposalFixture(options) {
  const fixture = makeProposalFixture(options);
  fixture.policy.automation.emergencyDisable = true;
  for (const name of Object.keys(fixture.policy.automation.ai)) {
    fixture.policy.automation.ai[name] = false;
  }
  for (const name of Object.keys(fixture.policy.automation.mutation)) {
    fixture.policy.automation.mutation[name] = false;
  }
  fixture.modelAnalysis = null;
  fixture.modelAnalysisReceipt = null;
  return fixture;
}

export function makePartialProposalFixture(options) {
  const fixture = makeProposalFixture(options);
  fixture.discovery.status = "partial";
  return fixture;
}