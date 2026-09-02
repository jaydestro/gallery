import { compareDisplayOrder, isPublicCatalogItem, toGalleryRecord } from "./canonical.mjs";
import {
  CATALOG_PARTITION,
  CosmosDomainError,
  publicSnapshotQuery,
  responseEtag,
} from "./container-operations.mjs";
import { assertDocument } from "./schemas.mjs";

export async function queryLivePublicCatalog({
  publicContainer,
  pageSize = 50,
  continuationToken = null,
  ifNoneMatch = null,
}) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new TypeError("pageSize must be an integer from 1 through 100.");
  }
  const markerResponse = await publicContainer.readItem("active-snapshot", {
    partitionKey: CATALOG_PARTITION,
  });
  assertDocument("publicCatalog", markerResponse.resource);
  const marker = markerResponse.resource;
  if (marker.type !== "active-snapshot") {
    throw new CosmosDomainError("ACTIVE_MARKER_INVALID", "The active-snapshot point read returned another document type.");
  }
  const etag = responseEtag(markerResponse);
  if (!etag) throw new CosmosDomainError("ACTIVE_MARKER_INVALID", "Active snapshot has no ETag.");
  const metadata = Object.freeze({
    etag,
    snapshotId: marker.snapshotId,
    catalogHash: marker.catalogHash,
    totalItems: marker.itemCount,
  });
  if (ifNoneMatch === etag) {
    return Object.freeze({ statusCode: 304, items: [], continuationToken: null, metadata });
  }

  const page = await publicContainer.queryItems({
    ...publicSnapshotQuery(marker.snapshotId),
    partitionKey: CATALOG_PARTITION,
    continuationToken: continuationToken || null,
    maxItemCount: pageSize,
  });
  if (!page || !Array.isArray(page.resources)) {
    throw new CosmosDomainError("QUERY_RESPONSE_INVALID", "Public query must return a resources array.");
  }
  page.resources.forEach((document) => {
    assertDocument("publicCatalog", document);
    if (document.snapshotId !== marker.snapshotId || !isPublicCatalogItem(document)) {
      throw new CosmosDomainError("PUBLIC_PROJECTION_INVALID", "Public query returned an item outside the active projection.");
    }
  });
  for (let index = 1; index < page.resources.length; index += 1) {
    if (compareDisplayOrder(page.resources[index - 1], page.resources[index]) > 0) {
      throw new CosmosDomainError("PUBLIC_ORDER_INVALID", "Public query results are not stably ordered.");
    }
  }
  return Object.freeze({
    statusCode: 200,
    items: page.resources.map(toGalleryRecord),
    continuationToken: page.continuationToken || null,
    metadata,
  });
}