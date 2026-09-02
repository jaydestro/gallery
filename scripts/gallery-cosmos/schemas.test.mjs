import assert from "node:assert/strict";
import test from "node:test";

import {
  CosmosSchemaError,
  assertDocument,
  isDocument,
} from "./schemas.mjs";

const hash = (character) => `sha256:${character.repeat(64)}`;
const provenance = Object.freeze({
  repository: "jaydestro/gallery",
  workflowPath: ".github/workflows/publish-gallery.yml",
  sourceRef: "refs/heads/main",
  sourceSha: "a".repeat(40),
  runId: "12345",
  runAttempt: 1,
  artifactDigest: hash("b"),
});

function catalogFields() {
  return {
    title: "Example",
    summary: "Example summary.",
    preview: "coming soon",
    launchUrl: "https://example.com/item",
    canonicalSource: "https://example.com/item",
    sourceType: "other",
    author: "Example Author",
    sourceOwner: null,
    website: "https://example.com",
    tags: ["example"],
    publishedAt: "2026-08-28",
    dateAdded: null,
    lastVerified: null,
    lifecycleStatus: "active",
  };
}

function canonicalItem() {
  return {
    id: "example",
    type: "catalog-item",
    schemaVersion: "2.0.0",
    catalogPartition: "gallery",
    publicationStatus: "published",
    displayOrder: 0,
    ...catalogFields(),
    writeKind: "migration",
    operationId: "migration:example",
    catalogSnapshotHash: hash("c"),
    provenance: { ...provenance, sourceHash: hash("d") },
  };
}

test("accepts canonical catalog-item/2.0.0 documents and closes every object", () => {
  const item = canonicalItem();
  assert.equal(assertDocument("catalogItem", item), item);

  assert.throws(
    () => assertDocument("catalogItem", { ...item, unexpected: true }),
    (error) => error instanceof CosmosSchemaError && error.code === "COSMOS_SCHEMA_INVALID",
  );
  assert.equal(isDocument("catalogItem", {
    ...item,
    provenance: { ...item.provenance, secret: "not-allowed" },
  }), false);
  assert.equal(isDocument("catalogItem", { ...item, _etag: "\"cosmos-etag\"" }), true);
  assert.equal(isDocument("catalogItem", { ...item, _private: "not-allowed" }), false);
});

test("requires publication bindings only for publication writes", () => {
  const item = {
    ...canonicalItem(),
    writeKind: "publication",
    decisionHash: hash("e"),
    policyHash: hash("f"),
    modelHash: hash("0"),
  };
  assert.equal(isDocument("catalogItem", item), true);
  delete item.decisionHash;
  assert.equal(isDocument("catalogItem", item), false);
});

test("keeps candidates and decisions as distinct runKey-partitioned contracts", () => {
  const candidate = {
    id: "candidate:run-1:example",
    type: "review-candidate",
    schemaVersion: "1.0.0",
    runKey: "run-1",
    candidateId: "source:example",
    status: "pending",
    collectedAt: "2026-08-28T12:00:00.000Z",
    candidateHash: hash("1"),
    source: {
      schemaVersion: "1.0.0",
      sourceType: "other",
      sourceId: "example",
      identityKey: "source:example",
      canonicalUrl: "https://example.com/item",
      title: "Example",
      description: "Example source.",
      publisher: "Example Author",
      publishedAt: null,
      modifiedAt: null,
      discoveredAt: "2026-08-28T11:00:00.000Z",
      evidence: [{ type: "source", value: "Example evidence." }],
      metadata: {
        sourceRegistryId: "example-source",
        trustTier: "first-party",
      },
    },
    provenance,
  };
  const decision = {
    id: "decision:run-1:example",
    type: "review-decision",
    schemaVersion: "1.0.0",
    runKey: "run-1",
    candidateId: "source:example",
    operationId: "run-1:publish:example",
    status: "approved",
    recommendation: "publish",
    reasonCodes: ["APPROVED"],
    decidedAt: "2026-08-28T12:00:00.000Z",
    decisionHash: hash("2"),
    catalogItemHash: hash("3"),
    catalogSnapshotHash: hash("4"),
    policyHash: hash("5"),
    modelHash: hash("6"),
    expectedCatalogEtag: null,
    provenance,
  };

  assert.equal(isDocument("reviewCandidate", candidate), true);
  assert.equal(isDocument("reviewDecision", decision), true);
  assert.equal(isDocument("reviewDecision", candidate), false);
  assert.equal(isDocument("reviewCandidate", { ...candidate, runKey: "bad/run" }), false);
});

test("accepts compact receipts without arbitrary payloads", () => {
  const receipt = {
    id: "receipt:run-1:publish",
    type: "pipeline-receipt",
    schemaVersion: "1.0.0",
    runKey: "run-1",
    operationId: "run-1:publish",
    stage: "publish",
    status: "completed",
    recordedAt: "2026-08-28T12:00:00.000Z",
    inputHash: hash("7"),
    outputHash: hash("8"),
    policyHash: hash("9"),
    modelHash: null,
    provenance,
  };

  assert.equal(isDocument("pipelineReceipt", receipt), true);
  assert.equal(isDocument("pipelineReceipt", { ...receipt, rawArtifact: { bytes: "large" } }), false);
});

test("accepts public snapshot items and the sole active marker shape", () => {
  const publicItem = {
    id: "snapshot:run-1:example",
    catalogId: "example",
    type: "catalog-item",
    schemaVersion: "2.0.0",
    catalogPartition: "gallery",
    snapshotId: "snapshot-1",
    publicationStatus: "published",
    displayOrder: 0,
    ...catalogFields(),
    operationId: "run-1:publish:example",
    sourceItemHash: hash("a"),
  };
  const marker = {
    id: "active-snapshot",
    type: "active-snapshot",
    schemaVersion: "1.0.0",
    catalogPartition: "gallery",
    snapshotId: "snapshot-1",
    itemCount: 1,
    catalogHash: hash("b"),
    operationId: "run-1:commit",
    publishedAt: "2026-08-28T12:00:00.000Z",
  };

  assert.equal(isDocument("publicCatalog", publicItem), true);
  assert.equal(isDocument("publicCatalog", marker), true);
  assert.equal(isDocument("publicCatalog", { ...publicItem, lifecycleStatus: "retired" }), false);
});