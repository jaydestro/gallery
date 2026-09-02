import assert from "node:assert/strict";
import test from "node:test";

import {
  appendPipelineReceipt,
  appendReviewCandidate,
  appendReviewDecision,
} from "./append-records.mjs";
import { canonicalHash, galleryRecordHash } from "./canonical.mjs";
import { CosmosDomainError } from "./container-operations.mjs";
import { InMemoryContainer } from "./testing/fake-container.mjs";

const hash = (character) => `sha256:${character.repeat(64)}`;
const provenance = Object.freeze({
  repository: "jaydestro/gallery",
  workflowPath: ".github/workflows/analyze-gallery-candidates.yml",
  sourceRef: "refs/heads/main",
  sourceSha: "a".repeat(40),
  runId: "12345",
  runAttempt: 1,
  artifactDigest: hash("b"),
});
const candidate = Object.freeze({
  schemaVersion: "1.0.0",
  sourceType: "learn-document",
  sourceId: "cosmos-example",
  identityKey: "learn-document:cosmos-example",
  canonicalUrl: "https://learn.microsoft.com/azure/cosmos-db/nosql/example",
  title: "Cosmos example",
  description: "An example candidate.",
  publisher: "Microsoft",
  publishedAt: null,
  modifiedAt: null,
  discoveredAt: "2026-08-28T11:00:00.000Z",
  evidence: [{ type: "learn-cosmos-section", value: "Azure Cosmos DB for NoSQL" }],
  metadata: {
    sourceRegistryId: "learn-cosmos-db",
    trustTier: "first-party",
    galleryId: "candidate-example",
    tags: ["documentation", "microsoft"],
    launchUrl: "https://learn.microsoft.com/azure/cosmos-db/nosql/example",
    website: "https://learn.microsoft.com/azure/cosmos-db",
    preview: "coming soon",
    author: "Microsoft",
    sourceOwner: "Microsoft",
    publishedAt: null,
  },
});
const catalogRecord = Object.freeze({
  id: "candidate-example",
  title: "Cosmos example",
  summary: "An example candidate.",
  preview: "coming soon",
  launchUrl: candidate.metadata.launchUrl,
  canonicalSource: candidate.canonicalUrl,
  sourceType: candidate.sourceType,
  author: candidate.metadata.author,
  sourceOwner: candidate.metadata.sourceOwner,
  website: candidate.metadata.website,
  tags: candidate.metadata.tags,
  publishedAt: "2026-08-28",
  dateAdded: null,
  lastVerified: null,
  lifecycleStatus: "active",
});

test("appends candidates, decisions, and compact receipts to separate runKey partitions", async () => {
  const candidateContainer = new InMemoryContainer();
  const decisionContainer = new InMemoryContainer();
  const receiptContainer = new InMemoryContainer();
  const runKey = "run-12345-1";
  const operationId = `${runKey}:publish:${catalogRecord.id}`;

  const candidateResult = await appendReviewCandidate({
    candidateContainer,
    runKey,
    candidate,
    provenance,
    collectedAt: "2026-08-28T12:00:00.000Z",
  });
  const decisionResult = await appendReviewDecision({
    decisionContainer,
    runKey,
    candidateId: candidate.identityKey,
    operationId,
    status: "approved",
    recommendation: "publish",
    reasonCodes: ["APPROVED"],
    decidedAt: "2026-08-28T12:05:00.000Z",
    catalogItemHash: galleryRecordHash(catalogRecord),
    catalogSnapshotHash: hash("c"),
    policyHash: hash("d"),
    modelHash: hash("e"),
    expectedCatalogEtag: null,
    provenance,
  });
  const receiptResult = await appendPipelineReceipt({
    receiptContainer,
    runKey,
    operationId,
    stage: "review",
    status: "completed",
    recordedAt: "2026-08-28T12:05:00.000Z",
    inputHash: canonicalHash(candidateResult.document),
    outputHash: canonicalHash(decisionResult.document),
    policyHash: hash("d"),
    modelHash: hash("e"),
    provenance,
  });

  assert.equal(candidateResult.document.type, "review-candidate");
  assert.equal(decisionResult.document.type, "review-decision");
  assert.equal(receiptResult.document.type, "pipeline-receipt");
  assert.deepEqual(
    [candidateContainer, decisionContainer, receiptContainer].map((container) => (
      container.calls[0].options
    )),
    [
      { partitionKey: runKey, ifNoneMatch: "*" },
      { partitionKey: runKey, ifNoneMatch: "*" },
      { partitionKey: runKey, ifNoneMatch: "*" },
    ],
  );
  assert.deepEqual(
    Object.keys(receiptResult.document).sort(),
    [
      "id",
      "inputHash",
      "modelHash",
      "operationId",
      "outputHash",
      "policyHash",
      "provenance",
      "recordedAt",
      "runKey",
      "schemaVersion",
      "stage",
      "status",
      "type",
    ],
  );
});

test("fails closed on duplicate immutable records without requiring read access", async () => {
  const candidateContainer = new InMemoryContainer();
  const input = {
    candidateContainer,
    runKey: "run-12345-1",
    candidate,
    provenance,
    collectedAt: "2026-08-28T12:00:00.000Z",
  };
  await appendReviewCandidate(input);

  await assert.rejects(
    appendReviewCandidate(input),
    (error) => error instanceof CosmosDomainError && error.code === "IMMUTABLE_RECORD_CONFLICT",
  );
  assert.equal(candidateContainer.calls.some((call) => call.method === "readItem"), false);
});

test("rejects immutable records above the operational Cosmos item ceiling", async () => {
  await assert.rejects(
    appendReviewCandidate({
      candidateContainer: new InMemoryContainer(),
      runKey: "run-oversized-1",
      candidate: {
        ...candidate,
        evidence: [{ type: "learn-cosmos-section", value: "x".repeat(1_900_000) }],
      },
      provenance,
      collectedAt: "2026-08-28T12:00:00.000Z",
    }),
    (error) => error instanceof CosmosDomainError && error.code === "COSMOS_ITEM_TOO_LARGE",
  );
});