import { canonicalHash, toGalleryRecord } from "./canonical.mjs";
import { assertDocument } from "./schemas.mjs";

function clone(value) {
  return structuredClone(value);
}

function safeIdPart(value) {
  return canonicalHash(value).slice("sha256:".length, "sha256:".length + 32);
}

export function createCatalogItem({
  record,
  displayOrder,
  writeKind,
  operationId,
  catalogSnapshotHash,
  provenance,
  decisionHash,
  policyHash,
  modelHash,
  publicationStatus = "published",
}) {
  const document = {
    ...toGalleryRecord(record),
    type: "catalog-item",
    schemaVersion: "2.0.0",
    catalogPartition: "gallery",
    publicationStatus,
    displayOrder,
    writeKind,
    operationId,
    catalogSnapshotHash,
    provenance: clone(provenance),
  };
  if (decisionHash !== undefined) document.decisionHash = decisionHash;
  if (policyHash !== undefined) document.policyHash = policyHash;
  if (modelHash !== undefined) document.modelHash = modelHash;
  return assertDocument("catalogItem", document);
}

export function createReviewCandidate({ runKey, candidate, provenance, collectedAt }) {
  const document = {
    id: `candidate:${runKey}:${safeIdPart(candidate.identityKey)}`,
    type: "review-candidate",
    schemaVersion: "1.0.0",
    runKey,
    candidateId: candidate.identityKey,
    status: "pending",
    collectedAt,
    candidateHash: canonicalHash(candidate),
    source: clone(candidate),
    provenance: clone(provenance),
  };
  return assertDocument("reviewCandidate", document);
}

export function reviewDecisionHash(decision) {
  const { decisionHash, ...payload } = decision;
  return canonicalHash(payload);
}

export function reviewDecisionId({ runKey, candidateId, operationId }) {
  return `decision:${runKey}:${safeIdPart({ candidateId, operationId })}`;
}

export function createReviewDecision({
  runKey,
  candidateId,
  operationId,
  status,
  recommendation,
  reasonCodes,
  decidedAt,
  catalogItemHash,
  catalogSnapshotHash,
  policyHash,
  modelHash,
  expectedCatalogEtag,
  provenance,
}) {
  const payload = {
    id: reviewDecisionId({ runKey, candidateId, operationId }),
    type: "review-decision",
    schemaVersion: "1.0.0",
    runKey,
    candidateId,
    operationId,
    status,
    recommendation,
    reasonCodes: clone(reasonCodes),
    decidedAt,
    catalogItemHash,
    catalogSnapshotHash,
    policyHash,
    modelHash,
    expectedCatalogEtag,
    provenance: clone(provenance),
  };
  return assertDocument("reviewDecision", {
    ...payload,
    decisionHash: canonicalHash(payload),
  });
}

export function createPipelineReceipt({
  runKey,
  operationId,
  stage,
  status,
  recordedAt,
  inputHash,
  outputHash,
  policyHash = null,
  modelHash = null,
  provenance,
}) {
  return assertDocument("pipelineReceipt", {
    id: `receipt:${runKey}:${safeIdPart({ operationId, stage })}`,
    type: "pipeline-receipt",
    schemaVersion: "1.0.0",
    runKey,
    operationId,
    stage,
    status,
    recordedAt,
    inputHash,
    outputHash,
    policyHash,
    modelHash,
    provenance: clone(provenance),
  });
}

export function createPublicCatalogItem(catalogItem, snapshotId) {
  const record = toGalleryRecord(catalogItem);
  return assertDocument("publicCatalog", {
    ...record,
    id: `snapshot:${snapshotId}:${catalogItem.id}`,
    catalogId: catalogItem.id,
    type: "catalog-item",
    schemaVersion: "2.0.0",
    catalogPartition: "gallery",
    snapshotId,
    publicationStatus: "published",
    displayOrder: catalogItem.displayOrder,
    operationId: catalogItem.operationId,
    sourceItemHash: canonicalHash(catalogItem),
  });
}

export function createActiveSnapshot({
  snapshotId,
  itemCount,
  catalogHash,
  operationId,
  publishedAt,
}) {
  return assertDocument("publicCatalog", {
    id: "active-snapshot",
    type: "active-snapshot",
    schemaVersion: "1.0.0",
    catalogPartition: "gallery",
    snapshotId,
    itemCount,
    catalogHash,
    operationId,
    publishedAt,
  });
}