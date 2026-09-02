import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeCatalogReplayFixture } from "../gallery-pipeline/apply-catalog-plan.fixtures.mjs";
import {
  composeCatalogChangePlan,
  hashCanonicalValue,
  replayCatalogChangePlan,
} from "../gallery-pipeline/build-catalog-change.mjs";
import { canonicalHash, gallerySnapshotFromDocuments } from "./canonical.mjs";
import { createActiveSnapshot } from "./documents.mjs";
import { migrateCatalogCreateOnly } from "./migrate-catalog.mjs";
import { executeReviewPersistence } from "./persist-review-decisions-cli.mjs";
import { executeCatalogPublication } from "./publish-catalog-cli.mjs";
import { InMemoryContainer } from "./testing/fake-container.mjs";

const environment = Object.freeze({
  AZURE_COSMOS_ENDPOINT: "https://gallery.documents.azure.com/",
  AZURE_COSMOS_DATABASE: "gallery",
  AZURE_COSMOS_CATALOG_CONTAINER: "catalog-items",
  AZURE_COSMOS_DECISION_CONTAINER: "review-decisions",
  AZURE_COSMOS_AUDIT_CONTAINER: "pipeline-records",
  AZURE_COSMOS_CREDENTIAL: "default",
});
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const pretty = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const hex = (character) => character.repeat(64);
const TRUSTED_REPOSITORY = "example/gallery";

function upstreamArtifact(name, runId) {
  const specifications = {
    discovery: [".github/workflows/discover-content.yml", "gallery-discovery-"],
    health: [".github/workflows/scan-gallery-health.yml", "gallery-health-"],
    freshness: [".github/workflows/evaluate-repository-freshness.yml", "gallery-freshness-"],
    modelAnalysis: [".github/workflows/analyze-gallery-candidates.yml", "gallery-candidate-analysis-"],
  };
  const [workflowPath, prefix] = specifications[name];
  return {
    name,
    repository: TRUSTED_REPOSITORY,
    workflowId: String(100 + runId),
    workflowPath,
    runId: String(runId),
    runAttempt: 1,
    sourceRef: "refs/heads/main",
    sourceSha: "a".repeat(40),
    artifactId: String(200 + runId),
    artifactName: `${prefix}${runId}-1`,
    digest: `sha256:${String(runId).padStart(64, "0")}`,
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gallery-review-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const replayFixture = makeCatalogReplayFixture();
  const reportRunId = "proposal-900-1";
  const plan = composeCatalogChangePlan({
    runId: `${reportRunId}-batch-001`,
    generatedAt: replayFixture.plan.generatedAt,
    operations: replayFixture.plan.operations,
    fingerprintInput: { proposal: reportRunId, batch: 1 },
    trustedRepository: TRUSTED_REPOSITORY,
  });
  const replayed = replayCatalogChangePlan(plan, {
    activeRecords: replayFixture.activeCatalog,
    retiredRecords: replayFixture.retired.entries.map((entry) => entry.record),
  }, { trustedRepository: TRUSTED_REPOSITORY });
  const proposedCatalog = replayed.activeRecords;
  const report = {
    schemaVersion: "1.0.0",
    mode: "report-only",
    mutationPerformed: false,
    status: "complete",
    runId: reportRunId,
    generatedAt: plan.generatedAt,
    inputFingerprint: hex("1"),
    stage: { status: "completed", reasonCodes: [] },
    upstream: {
      discovery: "complete",
      candidateGates: "complete",
      modelAnalysis: "complete",
      health: "complete",
      freshness: "complete",
    },
    summary: {
      candidates: plan.operations.length,
      eligibleCandidates: plan.operations.length,
      plannedCandidates: plan.operations.length,
      rejectedCandidates: 0,
      noChangeCandidates: 0,
      rejectedCatalogTargets: 0,
      plans: 1,
      operations: plan.operations.length,
    },
    reasonLedger: plan.operations.map((operation) => ({
      subjectType: "catalog",
      subjectId: operation.targetId,
      disposition: "planned",
      reasonCodes: operation.reasonCodes,
    })),
    plans: [{
      batchNumber: 1,
      path: "plans/catalog-change-plan-001.json",
      runId: plan.runId,
      inputFingerprint: plan.inputFingerprint,
      operationCount: plan.operations.length,
      operationIds: plan.operations.map((operation) => operation.operationId),
    }],
    outputs: {
      report: "proposal-report.json",
      receipt: "proposal-receipt.json",
      activeCatalog: "proposed/templates.json",
      health: "proposed/gallery-health.json",
      retired: "proposed/retired-templates.json",
      audit: "proposed/catalog-audit.json",
    },
  };
  const inputNames = [
    "activeCatalog", "analysisSchema", "audit", "candidateGates", "discovery",
    "exemptions", "freshness", "health", "modelAnalysis", "modelAnalysisReceipt",
    "modelAnalysisVerification", "policy", "retired", "retirementProvenance",
    "upstreamArtifacts",
  ];
  const receipt = {
    schemaVersion: "1.0.0",
    mode: "report-only",
    mutationPerformed: false,
    runId: reportRunId,
    generatedAt: plan.generatedAt,
    workflowStartedAt: plan.generatedAt,
    trustedRepository: TRUSTED_REPOSITORY,
    trustedRef: "refs/heads/main",
    trustedSha: "a".repeat(40),
    upstreamArtifacts: [
      upstreamArtifact("discovery", 1),
      upstreamArtifact("health", 2),
      upstreamArtifact("freshness", 3),
      upstreamArtifact("modelAnalysis", 4),
    ],
    healthArtifact: null,
    inputFingerprint: report.inputFingerprint,
    reportFingerprint: hashCanonicalValue(report),
    inputs: inputNames.map((name, index) => ({
      name,
      provided: name !== "retirementProvenance",
      fingerprint: index.toString(16).padStart(64, "0"),
    })),
    outputs: [
      { path: "proposal-report.json", fingerprint: hashCanonicalValue(report) },
      { path: "plans/catalog-change-plan-001.json", fingerprint: hashCanonicalValue(plan) },
      { path: "proposed/templates.json", fingerprint: hashCanonicalValue(proposedCatalog) },
      { path: "proposed/gallery-health.json", fingerprint: hex("5") },
      { path: "proposed/retired-templates.json", fingerprint: hex("6") },
      { path: "proposed/catalog-audit.json", fingerprint: hex("7") },
    ],
  };
  const bytes = {
    report: pretty(report),
    receipt: pretty(receipt),
    plan: pretty(plan),
    proposedCatalog: pretty(proposedCatalog),
  };
  const members = [
    ["proposal-report.json", bytes.report],
    ["proposal-receipt.json", bytes.receipt],
    ["plans/catalog-change-plan-001.json", bytes.plan],
    ["proposed/templates.json", bytes.proposedCatalog],
    ["upstream-artifact-diagnostics.json", Buffer.from("diagnostics")],
    ["proposed/gallery-health.json", Buffer.from("health")],
    ["proposed/retired-templates.json", Buffer.from("retired")],
    ["proposed/catalog-audit.json", Buffer.from("audit")],
  ];
  const artifact = {
    repository: TRUSTED_REPOSITORY,
    workflowId: "999",
    workflowPath: ".github/workflows/propose-gallery-changes.yml",
    runId: "900",
    runAttempt: 1,
    sourceRef: "refs/heads/main",
    sourceSha: "a".repeat(40),
    artifactId: "901",
    artifactName: "gallery-proposal-900-1",
    digest: `sha256:${"b".repeat(64)}`,
    members: members.map(([memberPath, memberBytes]) => ({ path: memberPath, sha256: sha256(memberBytes) })),
  };
  await Promise.all([
    writeFile(path.join(root, "artifact.json"), JSON.stringify(artifact)),
    writeFile(path.join(root, "proposal-report.json"), bytes.report),
    writeFile(path.join(root, "proposal-receipt.json"), bytes.receipt),
    writeFile(path.join(root, "plan.json"), bytes.plan),
    writeFile(path.join(root, "templates.json"), bytes.proposedCatalog),
  ]);
  return { root, plan, replayFixture };
}

async function seededContainers(replayFixture) {
  const catalog = new InMemoryContainer();
  const initialRecords = [
    ...replayFixture.activeCatalog,
    ...replayFixture.retired.entries.map((entry) => entry.record),
  ];
  await migrateCatalogCreateOnly({
    records: initialRecords,
    catalogContainer: catalog,
    provenance: {
      repository: TRUSTED_REPOSITORY,
      workflowPath: ".github/workflows/migrate-gallery-catalog.yml",
      sourceRef: "refs/heads/main",
      sourceSha: "a".repeat(40),
      runId: "10",
      runAttempt: 1,
      artifactDigest: `sha256:${"c".repeat(64)}`,
    },
    operationId: "migration:fixture",
  });
  const current = gallerySnapshotFromDocuments(catalog.snapshot(), { publicOnly: true });
  const publicContainer = new InMemoryContainer();
  publicContainer.seed(createActiveSnapshot({
    snapshotId: "snapshot-before-proposal",
    itemCount: current.count,
    catalogHash: current.hash,
    operationId: "publication:before-proposal",
    publishedAt: "2026-08-27T00:00:00.000Z",
  }));
  return {
    catalog,
    public: publicContainer,
    decisions: new InMemoryContainer(),
    audit: new InMemoryContainer(),
  };
}

const args = [
  "--artifact", "artifact.json",
  "--proposal-report", "proposal-report.json",
  "--proposal-receipt", "proposal-receipt.json",
  "--plan", "plan.json",
  "--proposed-catalog", "templates.json",
];

test("writes exact operation-bound decisions and a compact receipt, then verifies them", async (t) => {
  const { root, plan, replayFixture } = await fixture(t);
  const containers = await seededContainers(replayFixture);
  const openContainers = () => ({ containers });
  const written = await executeReviewPersistence({ argv: args, environment, rootDirectory: root, openContainers });

  assert.equal(written.mode, "write");
  assert.equal(written.decisionCount, plan.operations.length);
  assert.match(written.decisionSetHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(written).includes("etag"), false);
  assert.equal(containers.decisions.snapshot().length, plan.operations.length);
  assert.equal(containers.audit.snapshot().length, 1);
  for (const decision of containers.decisions.snapshot()) {
    assert.equal(decision.status, "approved");
    assert.equal(decision.runKey, plan.runId);
    assert.match(decision.policyHash, /^sha256:[a-f0-9]{64}$/);
    assert.match(decision.modelHash, /^sha256:[a-f0-9]{64}$/);
    const operation = plan.operations.find((entry) => entry.operationId === decision.operationId);
    assert.equal(decision.expectedCatalogEtag === null, operation.type === "publish");
  }

  const verified = await executeReviewPersistence({
    argv: [...args, "--verify"],
    environment,
    rootDirectory: root,
    openContainers,
  });
  assert.equal(verified.mode, "verify");
  assert.equal(verified.decisionSetHash, written.decisionSetHash);

  const published = await executeCatalogPublication({
    argv: args,
    environment: {
      ...environment,
      AZURE_COSMOS_PUBLIC_CONTAINER: "public-catalog",
    },
    rootDirectory: root,
    openContainers,
  });
  assert.equal(published.mode, "write");
  assert.equal(published.replayed, false);
  assert.equal(JSON.stringify(published).includes("etag"), false);
  assert.equal(containers.audit.snapshot().length, 2);

  const replayed = await executeCatalogPublication({
    argv: args,
    environment: {
      ...environment,
      AZURE_COSMOS_PUBLIC_CONTAINER: "public-catalog",
    },
    rootDirectory: root,
    openContainers,
  });
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.snapshotId, published.snapshotId);
  assert.equal(containers.audit.snapshot().length, 2);

  const publicationVerified = await executeCatalogPublication({
    argv: [...args, "--verify"],
    environment: {
      ...environment,
      AZURE_COSMOS_PUBLIC_CONTAINER: "public-catalog",
    },
    rootDirectory: root,
    openContainers,
  });
  assert.equal(publicationVerified.mode, "verify");
  assert.equal(publicationVerified.replayed, true);
});

test("dry-run needs no Cosmos access and tampered proposal bytes fail member verification", async (t) => {
  const { root } = await fixture(t);
  let opened = false;
  const dryRun = await executeReviewPersistence({
    argv: [...args, "--dry-run"],
    environment,
    rootDirectory: root,
    openContainers() { opened = true; },
  });
  assert.equal(opened, false);
  assert.equal(dryRun.mode, "dry-run");

  await writeFile(path.join(root, "plan.json"), JSON.stringify({ tampered: true }));
  await assert.rejects(
    executeReviewPersistence({ argv: [...args, "--dry-run"], environment, rootDirectory: root }),
    /SHA-256 verification/,
  );
});