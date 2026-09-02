import {
  canonicalEqual,
  canonicalHash,
  compareDisplayOrder,
  galleryRecordHash,
  gallerySnapshotFromDocuments,
  isPublicCatalogItem,
  toGalleryRecord,
} from "./canonical.mjs";
import {
  CATALOG_PARTITION,
  CosmosDomainError,
  collectQuery,
  cosmosStatus,
  createItemOrMatch,
  publicSnapshotQuery,
  readCanonicalCatalog,
  responseEtag,
} from "./container-operations.mjs";
import {
  createActiveSnapshot,
  createCatalogItem,
  createPublicCatalogItem,
  reviewDecisionHash,
} from "./documents.mjs";
import { assertDocument } from "./schemas.mjs";
import { validateCatalogChangePlan } from "../gallery-pipeline/build-catalog-change.mjs";

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const BINDING_KEYS = Object.freeze([
  "catalogSnapshotHash",
  "decisionHash",
  "expectedActiveSnapshotEtag",
  "modelHash",
  "operationId",
  "policyHash",
  "publishedAt",
  "snapshotId",
]);

function fail(code, message, details = {}) {
  throw new CosmosDomainError(code, message, details);
}

function requireHash(value, name) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    fail("PUBLICATION_BINDING_INVALID", `${name} must be a sha256 digest.`);
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("PUBLICATION_BINDING_INVALID", `${name} must be a non-empty string.`);
  }
  return value;
}

export function publicationOperationId(plan, snapshotId) {
  return `${plan.runId}:publish-snapshot:${canonicalHash({ plan, snapshotId }).slice(-24)}`;
}

export function decisionSetHash(decisions) {
  return canonicalHash([...decisions]
    .sort((left, right) => left.operationId.localeCompare(right.operationId))
    .map((decision) => ({
      operationId: decision.operationId,
      decisionHash: decision.decisionHash,
    })));
}

function validateBinding(binding, plan, decisions) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    fail("PUBLICATION_BINDING_INVALID", "binding must be an object.");
  }
  const keys = Object.keys(binding).sort();
  if (!canonicalEqual(keys, [...BINDING_KEYS].sort())) {
    fail("PUBLICATION_BINDING_INVALID", "binding has missing or unknown fields.");
  }
  requireString(binding.snapshotId, "binding.snapshotId");
  requireString(binding.operationId, "binding.operationId");
  requireString(binding.expectedActiveSnapshotEtag, "binding.expectedActiveSnapshotEtag");
  requireString(binding.publishedAt, "binding.publishedAt");
  if (Number.isNaN(new Date(binding.publishedAt).valueOf())) {
    fail("PUBLICATION_BINDING_INVALID", "binding.publishedAt must be a date-time.");
  }
  for (const name of ["catalogSnapshotHash", "decisionHash", "modelHash", "policyHash"]) {
    requireHash(binding[name], `binding.${name}`);
  }
  if (binding.operationId !== publicationOperationId(plan, binding.snapshotId)) {
    fail("PUBLICATION_BINDING_INVALID", "binding.operationId is not bound to this plan and snapshot.");
  }
  if (binding.decisionHash !== decisionSetHash(decisions)) {
    fail("PUBLICATION_BINDING_INVALID", "binding.decisionHash does not match the approved decision set.");
  }
}

function validateDecisions(plan, decisions, binding) {
  if (!Array.isArray(decisions) || decisions.length !== plan.operations.length) {
    fail("DECISION_SET_INVALID", "Every plan operation must have exactly one review decision.");
  }
  const byOperation = new Map();
  for (const decision of decisions) {
    assertDocument("reviewDecision", decision);
    if (byOperation.has(decision.operationId)) {
      fail("DECISION_SET_INVALID", `Duplicate decision for ${decision.operationId}.`);
    }
    if (decision.decisionHash !== reviewDecisionHash(decision)) {
      fail("DECISION_HASH_MISMATCH", `Decision ${decision.id} has an invalid decisionHash.`);
    }
    byOperation.set(decision.operationId, decision);
  }
  for (const operation of plan.operations) {
    const decision = byOperation.get(operation.operationId);
    if (!decision) fail("DECISION_SET_INVALID", `Missing decision for ${operation.operationId}.`);
    if (
      decision.runKey !== plan.runId ||
      decision.status !== "approved" ||
      decision.recommendation !== operation.type ||
      decision.catalogItemHash !== galleryRecordHash(operation.after) ||
      decision.catalogSnapshotHash !== binding.catalogSnapshotHash ||
      decision.policyHash !== binding.policyHash ||
      decision.modelHash !== binding.modelHash
    ) {
      fail("DECISION_BINDING_MISMATCH", `Decision ${decision.id} is not bound to its plan operation.`);
    }
    if (operation.type === "publish" && decision.expectedCatalogEtag !== null) {
      fail("DECISION_BINDING_MISMATCH", `Create decision ${decision.id} must not carry an ETag.`);
    }
    if (operation.type !== "publish" && !decision.expectedCatalogEtag) {
      fail("DECISION_BINDING_MISMATCH", `Replace decision ${decision.id} requires an ETag.`);
    }
  }
  return byOperation;
}

function targetDocuments({ currentDocuments, plan, decisions, binding, provenance }) {
  const currentById = new Map(currentDocuments.map((document) => [document.id, document]));
  if (currentById.size !== currentDocuments.length) {
    fail("CANONICAL_STATE_INVALID", "Canonical catalog contains duplicate IDs.");
  }
  const appendTargetIds = new Set(plan.operations
    .filter((operation) => ["publish", "restore"].includes(operation.type))
    .map((operation) => operation.targetId));
  let nextDisplayOrder = currentDocuments
    .filter((document) => !appendTargetIds.has(document.id))
    .reduce(
    (maximum, document) => Math.max(maximum, document.displayOrder),
    -1,
  );
  const targets = [];
  for (const operation of plan.operations) {
    const current = currentById.get(operation.targetId);
    if (operation.type !== "publish" && (
      !current || !canonicalEqual(toGalleryRecord(current), operation.before)
    )) {
      fail("CANONICAL_STATE_INVALID", `Before state for ${operation.targetId} does not match the plan.`);
    }
    const decision = decisions.get(operation.operationId);
    const displayOrder = ["publish", "restore"].includes(operation.type)
      ? ++nextDisplayOrder
      : current.displayOrder;
    const target = createCatalogItem({
      record: operation.after,
      displayOrder,
      writeKind: "publication",
      operationId: operation.operationId,
      catalogSnapshotHash: binding.catalogSnapshotHash,
      decisionHash: decision.decisionHash,
      policyHash: binding.policyHash,
      modelHash: binding.modelHash,
      provenance,
    });
    currentById.set(target.id, target);
    targets.push({ operation, decision, target });
  }
  return { targets, finalDocuments: [...currentById.values()] };
}

async function replaceOrFail(container, id, document, { partitionKey, ifMatch, scope }) {
  try {
    return await container.replaceItem(id, document, { partitionKey, ifMatch });
  } catch (error) {
    if (Number(cosmosStatus(error)) === 412) {
      fail("STALE_ETAG", `${scope} ${id} changed after approval.`, { id, partitionKey });
    }
    throw error;
  }
}

function verifySnapshot(actualDocuments, expected, code) {
  const actual = gallerySnapshotFromDocuments(actualDocuments);
  if (actual.count !== expected.count || actual.hash !== expected.hash) {
    fail(code, `Snapshot parity failed: expected ${expected.count}/${expected.hash}, got ${actual.count}/${actual.hash}.`);
  }
  return actual;
}

export async function publishApprovedPlan({
  plan,
  decisions,
  binding,
  catalogContainer,
  publicContainer,
  provenance,
  trustedRepository,
  maxItemCount = 100,
}) {
  validateCatalogChangePlan(plan, { trustedRepository });
  validateBinding(binding, plan, decisions);
  const decisionsByOperation = validateDecisions(plan, decisions, binding);
  const markerResponse = await publicContainer.readItem("active-snapshot", {
    partitionKey: CATALOG_PARTITION,
  });
  assertDocument("publicCatalog", markerResponse.resource);
  if (markerResponse.resource.type !== "active-snapshot") {
    fail("ACTIVE_MARKER_INVALID", "The active-snapshot point read returned another document type.");
  }
  const markerEtag = responseEtag(markerResponse);
  if (!markerEtag || markerEtag !== binding.expectedActiveSnapshotEtag) {
    fail("ACTIVE_MARKER_STALE", "The active snapshot ETag does not match the approved publication binding.");
  }

  if (markerResponse.resource.snapshotId === binding.snapshotId) {
    if (
      markerResponse.resource.operationId !== binding.operationId ||
      markerResponse.resource.catalogHash !== binding.catalogSnapshotHash
    ) {
      fail("ACTIVE_MARKER_INVALID", "The committed snapshot ID is bound to different publication content.");
    }
    const committedCanonical = await readCanonicalCatalog(catalogContainer, { maxItemCount });
    committedCanonical.forEach((document) => assertDocument("catalogItem", document));
    const committedPublic = verifySnapshot(committedCanonical.filter(isPublicCatalogItem), {
      count: markerResponse.resource.itemCount,
      hash: binding.catalogSnapshotHash,
    }, "CANONICAL_PARITY_FAILED");
    const stagedDocuments = await collectQuery(publicContainer, {
      ...publicSnapshotQuery(binding.snapshotId),
      partitionKey: CATALOG_PARTITION,
      maxItemCount,
    });
    stagedDocuments.forEach((document) => assertDocument("publicCatalog", document));
    verifySnapshot(stagedDocuments, committedPublic, "PUBLIC_PROJECTION_PARITY_FAILED");
    return Object.freeze({
      snapshotId: binding.snapshotId,
      count: committedPublic.count,
      hash: committedPublic.hash,
      canonicalCreates: 0,
      canonicalReplaces: 0,
      stagedCreates: 0,
      replayed: true,
      etag: markerEtag,
    });
  }

  const currentDocuments = await readCanonicalCatalog(catalogContainer, { maxItemCount });
  currentDocuments.forEach((document) => assertDocument("catalogItem", document));
  const publicationProvenance = {
    ...structuredClone(provenance),
    sourceHash: canonicalHash(plan),
  };
  const prepared = targetDocuments({
    currentDocuments,
    plan,
    decisions: decisionsByOperation,
    binding,
    provenance: publicationProvenance,
  });
  const expectedPublic = gallerySnapshotFromDocuments(prepared.finalDocuments, { publicOnly: true });
  if (expectedPublic.hash !== binding.catalogSnapshotHash) {
    fail("CATALOG_SNAPSHOT_MISMATCH", "The approved catalogSnapshotHash does not match plan replay.");
  }

  let canonicalCreates = 0;
  let canonicalReplaces = 0;
  for (const { operation, decision, target } of prepared.targets) {
    if (operation.type === "publish") {
      const result = await createItemOrMatch(catalogContainer, target, { partitionKey: CATALOG_PARTITION });
      if (result.created) canonicalCreates += 1;
    } else {
      await replaceOrFail(catalogContainer, target.id, target, {
        partitionKey: CATALOG_PARTITION,
        ifMatch: decision.expectedCatalogEtag,
        scope: "Canonical item",
      });
      canonicalReplaces += 1;
    }
  }

  const storedCanonical = await readCanonicalCatalog(catalogContainer, { maxItemCount });
  storedCanonical.forEach((document) => assertDocument("catalogItem", document));
  for (const { target } of prepared.targets) {
    const actual = storedCanonical.find((document) => document.id === target.id);
    if (!actual || !canonicalEqual(actual, target)) {
      fail("CANONICAL_WRITE_MISMATCH", `Canonical item ${target.id} does not match its approved target.`);
    }
  }
  const publicCanonical = storedCanonical.filter(isPublicCatalogItem).sort(compareDisplayOrder);
  verifySnapshot(publicCanonical, expectedPublic, "CANONICAL_PARITY_FAILED");

  let stagedCreates = 0;
  for (const document of publicCanonical.map((item) => createPublicCatalogItem(item, binding.snapshotId))) {
    const result = await createItemOrMatch(publicContainer, document, { partitionKey: CATALOG_PARTITION });
    if (result.created) stagedCreates += 1;
  }
  const stagedDocuments = await collectQuery(publicContainer, {
    ...publicSnapshotQuery(binding.snapshotId),
    partitionKey: CATALOG_PARTITION,
    maxItemCount,
  });
  stagedDocuments.forEach((document) => assertDocument("publicCatalog", document));
  verifySnapshot(stagedDocuments, expectedPublic, "PUBLIC_PROJECTION_PARITY_FAILED");

  const marker = createActiveSnapshot({
    snapshotId: binding.snapshotId,
    itemCount: expectedPublic.count,
    catalogHash: expectedPublic.hash,
    operationId: binding.operationId,
    publishedAt: binding.publishedAt,
  });
  const committed = await replaceOrFail(publicContainer, marker.id, marker, {
    partitionKey: CATALOG_PARTITION,
    ifMatch: markerEtag,
    scope: "Active snapshot",
  });
  return Object.freeze({
    snapshotId: binding.snapshotId,
    count: expectedPublic.count,
    hash: expectedPublic.hash,
    canonicalCreates,
    canonicalReplaces,
    stagedCreates,
    replayed: false,
    etag: responseEtag(committed),
  });
}