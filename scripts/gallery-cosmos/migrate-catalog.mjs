import {
  canonicalHash,
  gallerySnapshotFromDocuments,
  gallerySnapshotFromRecords,
} from "./canonical.mjs";
import {
  CATALOG_PARTITION,
  CosmosDomainError,
  collectQuery,
  createItemOrMatch,
  publicSnapshotQuery,
  readCanonicalCatalog,
} from "./container-operations.mjs";
import {
  createActiveSnapshot,
  createCatalogItem,
  createPublicCatalogItem,
} from "./documents.mjs";
import { assertDocument, assertGalleryCatalog } from "./schemas.mjs";

export async function migrateCatalogCreateOnly({
  records,
  catalogContainer,
  provenance,
  operationId,
  maxItemCount = 100,
}) {
  assertGalleryCatalog(records);
  const source = gallerySnapshotFromRecords(records);
  if (new Set(source.records.map((record) => record.id)).size !== source.count) {
    throw new CosmosDomainError("SOURCE_DUPLICATE_ID", "Source catalog contains duplicate IDs.");
  }
  const itemProvenance = { ...structuredClone(provenance), sourceHash: source.hash };
  const documents = source.records.map((record, displayOrder) => createCatalogItem({
    record,
    displayOrder,
    writeKind: "migration",
    operationId,
    catalogSnapshotHash: source.hash,
    provenance: itemProvenance,
  }));
  let created = 0;
  let matchedConflicts = 0;
  for (const document of documents) {
    const result = await createItemOrMatch(catalogContainer, document, {
      partitionKey: CATALOG_PARTITION,
    });
    if (result.created) created += 1;
    else matchedConflicts += 1;
  }

  const storedDocuments = await readCanonicalCatalog(catalogContainer, { maxItemCount });
  storedDocuments.forEach((document) => assertDocument("catalogItem", document));
  const stored = gallerySnapshotFromDocuments(storedDocuments);
  if (stored.count !== source.count || stored.hash !== source.hash) {
    throw new CosmosDomainError(
      "MIGRATION_PARITY_FAILED",
      `Migration parity failed: source ${source.count}/${source.hash}, stored ${stored.count}/${stored.hash}.`,
      { sourceCount: source.count, sourceHash: source.hash, storedCount: stored.count, storedHash: stored.hash },
    );
  }
  return Object.freeze({
    count: source.count,
    hash: source.hash,
    created,
    matchedConflicts,
  });
}

function migrationSnapshotId(sourceHash) {
  return `migration-${sourceHash.slice("sha256:".length, "sha256:".length + 32)}`;
}

function assertParity(actual, expected, code) {
  if (actual.count !== expected.count || actual.hash !== expected.hash) {
    throw new CosmosDomainError(
      code,
      `Parity failed: expected ${expected.count}/${expected.hash}, got ${actual.count}/${actual.hash}.`,
    );
  }
}

export async function verifyCatalogMigration({
  records,
  catalogContainer,
  publicContainer,
  snapshotId,
  maxItemCount = 100,
}) {
  assertGalleryCatalog(records);
  const source = gallerySnapshotFromRecords(records);
  const canonicalDocuments = await readCanonicalCatalog(catalogContainer, { maxItemCount });
  canonicalDocuments.forEach((document) => assertDocument("catalogItem", document));
  const canonical = gallerySnapshotFromDocuments(canonicalDocuments);
  assertParity(canonical, source, "MIGRATION_PARITY_FAILED");
  const expectedPublic = gallerySnapshotFromDocuments(canonicalDocuments, { publicOnly: true });
  assertParity(expectedPublic, source, "MIGRATION_PUBLIC_SOURCE_MISMATCH");

  const marker = await publicContainer.readItem("active-snapshot", {
    partitionKey: CATALOG_PARTITION,
  });
  assertDocument("publicCatalog", marker.resource);
  if (
    marker.resource.type !== "active-snapshot" ||
    marker.resource.snapshotId !== snapshotId ||
    marker.resource.itemCount !== expectedPublic.count ||
    marker.resource.catalogHash !== expectedPublic.hash
  ) {
    throw new CosmosDomainError("MIGRATION_MARKER_MISMATCH", "The active snapshot marker does not match migration input.");
  }
  const stagedDocuments = await collectQuery(publicContainer, {
    ...publicSnapshotQuery(snapshotId),
    partitionKey: CATALOG_PARTITION,
    maxItemCount,
  });
  stagedDocuments.forEach((document) => assertDocument("publicCatalog", document));
  const staged = gallerySnapshotFromDocuments(stagedDocuments);
  assertParity(staged, expectedPublic, "MIGRATION_PUBLIC_PARITY_FAILED");
  return Object.freeze({ count: source.count, hash: source.hash, snapshotId });
}

export async function migrateCatalogAndPublicCreateOnly({
  records,
  catalogContainer,
  publicContainer,
  provenance,
  operationId,
  snapshotId,
  publishedAt,
  maxItemCount = 100,
}) {
  const canonicalResult = await migrateCatalogCreateOnly({
    records,
    catalogContainer,
    provenance,
    operationId,
    maxItemCount,
  });
  const resolvedSnapshotId = snapshotId || migrationSnapshotId(canonicalResult.hash);
  const canonicalDocuments = await readCanonicalCatalog(catalogContainer, { maxItemCount });
  const publicSnapshot = gallerySnapshotFromDocuments(canonicalDocuments, { publicOnly: true });
  assertParity(publicSnapshot, {
    count: canonicalResult.count,
    hash: canonicalResult.hash,
  }, "MIGRATION_PUBLIC_SOURCE_MISMATCH");

  let stagedCreates = 0;
  for (const document of canonicalDocuments
    .filter((item) => item.publicationStatus === "published" && ["active", "needs-review"].includes(item.lifecycleStatus))
    .map((item) => createPublicCatalogItem(item, resolvedSnapshotId))) {
    const result = await createItemOrMatch(publicContainer, document, {
      partitionKey: CATALOG_PARTITION,
    });
    if (result.created) stagedCreates += 1;
  }
  const marker = createActiveSnapshot({
    snapshotId: resolvedSnapshotId,
    itemCount: publicSnapshot.count,
    catalogHash: publicSnapshot.hash,
    operationId,
    publishedAt,
  });
  const markerResult = await createItemOrMatch(publicContainer, marker, {
    partitionKey: CATALOG_PARTITION,
  });
  const verified = await verifyCatalogMigration({
    records,
    catalogContainer,
    publicContainer,
    snapshotId: resolvedSnapshotId,
    maxItemCount,
  });
  return Object.freeze({
    ...verified,
    canonicalCreates: canonicalResult.created,
    canonicalMatches: canonicalResult.matchedConflicts,
    stagedCreates,
    markerCreated: markerResult.created,
    operationHash: canonicalHash({ operationId, snapshotId: resolvedSnapshotId }),
  });
}