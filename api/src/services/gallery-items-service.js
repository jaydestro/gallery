const { ApiError } = require("../domain/api-error");

const CATALOG_PARTITION = "gallery";
const MAX_CONTINUATION_TOKEN_LENGTH = 8192;
const PUBLIC_LIFECYCLE_STATUSES = new Set(["active", "needs-review"]);
const SOURCE_TYPES = new Set([
  "github-repository",
  "github-path",
  "learn-document",
  "blog-post",
  "video",
  "tool",
  "other",
]);
const COSMOS_SYSTEM_FIELDS = new Set(["_attachments", "_etag", "_lsn", "_rid", "_self", "_ts"]);
const PUBLIC_RECORD_FIELDS = Object.freeze([
  "id",
  "title",
  "summary",
  "preview",
  "launchUrl",
  "canonicalSource",
  "sourceType",
  "author",
  "sourceOwner",
  "website",
  "tags",
  "publishedAt",
  "dateAdded",
  "lastVerified",
  "lifecycleStatus",
  "supersededBy",
]);
const PUBLIC_ITEM_FIELDS = new Set([
  "id",
  "catalogId",
  "type",
  "schemaVersion",
  "catalogPartition",
  "snapshotId",
  "publicationStatus",
  "displayOrder",
  "title",
  "summary",
  "preview",
  "launchUrl",
  "canonicalSource",
  "sourceType",
  "author",
  "sourceOwner",
  "website",
  "tags",
  "publishedAt",
  "dateAdded",
  "lastVerified",
  "lifecycleStatus",
  "supersededBy",
  "operationId",
  "sourceItemHash",
]);
const ACTIVE_MARKER_FIELDS = new Set([
  "id",
  "type",
  "schemaVersion",
  "catalogPartition",
  "snapshotId",
  "itemCount",
  "catalogHash",
  "operationId",
  "publishedAt",
]);

function invalidRequest(code, message) {
  throw new ApiError(400, code, message);
}

function invalidUpstream(message) {
  throw new ApiError(502, "UPSTREAM_RESPONSE_INVALID", message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stripCosmosSystemFields(document) {
  if (!isPlainObject(document)) return document;
  return Object.fromEntries(
    Object.entries(document).filter(([key]) => !COSMOS_SYSTEM_FIELDS.has(key)),
  );
}

function hasOnlyFields(document, allowedFields) {
  return Object.keys(document).every((key) => allowedFields.has(key));
}

function isNonEmptyString(value, maximumLength = Number.MAX_SAFE_INTEGER) {
  return typeof value === "string" && value.trim() !== "" && value.length <= maximumLength;
}

function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function isIsoDateTime(value) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value));
}

function isValidUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isHash(value) {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function validatePageSize(pageSize) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    invalidRequest("PAGE_SIZE_INVALID", "pageSize must be an integer from 1 through 100.");
  }
  return pageSize;
}

function validateContinuationToken(token, { request = false } = {}) {
  if (token === null || token === undefined) return null;
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > MAX_CONTINUATION_TOKEN_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(token)
  ) {
    if (request) {
      invalidRequest("CONTINUATION_TOKEN_INVALID", "continuation must be a valid opaque token.");
    }
    invalidUpstream("Cosmos DB returned an invalid continuation token.");
  }
  return token;
}

function validateActiveSnapshot(response) {
  if (!isPlainObject(response) || !isPlainObject(response.resource)) {
    invalidUpstream("The active snapshot response is invalid.");
  }
  const marker = stripCosmosSystemFields(response.resource);
  if (
    !hasOnlyFields(marker, ACTIVE_MARKER_FIELDS) ||
    marker.id !== "active-snapshot" ||
    marker.type !== "active-snapshot" ||
    marker.schemaVersion !== "1.0.0" ||
    marker.catalogPartition !== CATALOG_PARTITION ||
    !isNonEmptyString(marker.snapshotId, 256) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(marker.snapshotId) ||
    !Number.isSafeInteger(marker.itemCount) ||
    marker.itemCount < 0 ||
    !isHash(marker.catalogHash) ||
    !isNonEmptyString(marker.operationId, 512) ||
    !isIsoDateTime(marker.publishedAt) ||
    !isNonEmptyString(response.etag, 1024)
  ) {
    invalidUpstream("The active snapshot marker is malformed.");
  }
  return { marker, etag: response.etag };
}

function validatePublicItem(document, snapshotId) {
  const item = stripCosmosSystemFields(document);
  const requiredStrings = [
    "id",
    "catalogId",
    "title",
    "summary",
    "preview",
    "author",
    "operationId",
  ];
  if (
    !isPlainObject(item) ||
    !hasOnlyFields(item, PUBLIC_ITEM_FIELDS) ||
    requiredStrings.some((field) => !isNonEmptyString(item[field])) ||
    item.id.length > 1023 ||
    /[/\\?#]/.test(item.id) ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(item.catalogId) ||
    item.type !== "catalog-item" ||
    item.schemaVersion !== "2.0.0" ||
    item.catalogPartition !== CATALOG_PARTITION ||
    item.snapshotId !== snapshotId ||
    item.publicationStatus !== "published" ||
    !Number.isSafeInteger(item.displayOrder) ||
    item.displayOrder < 0 ||
    !PUBLIC_LIFECYCLE_STATUSES.has(item.lifecycleStatus) ||
    !SOURCE_TYPES.has(item.sourceType) ||
    !isValidUrl(item.launchUrl) ||
    !isValidUrl(item.canonicalSource) ||
    !isValidUrl(item.website) ||
    !Array.isArray(item.tags) ||
    item.tags.length === 0 ||
    item.tags.some((tag) => !isNonEmptyString(tag)) ||
    new Set(item.tags).size !== item.tags.length ||
    (!isIsoDate(item.publishedAt) && !isIsoDateTime(item.publishedAt)) ||
    (item.dateAdded !== null && !isIsoDate(item.dateAdded)) ||
    (item.lastVerified !== null && !isIsoDateTime(item.lastVerified)) ||
    (item.sourceOwner !== null && !isNonEmptyString(item.sourceOwner)) ||
    (item.supersededBy !== undefined && item.supersededBy !== null && !isNonEmptyString(item.supersededBy)) ||
    item.operationId.length > 512 ||
    !isHash(item.sourceItemHash)
  ) {
    invalidUpstream("The public catalog query returned a malformed item.");
  }
  return item;
}

function compareDisplayOrder(left, right) {
  return left.displayOrder - right.displayOrder || left.catalogId.localeCompare(right.catalogId);
}

function toPublicRecord(item) {
  const record = {};
  for (const field of PUBLIC_RECORD_FIELDS) {
    const sourceField = field === "id" ? "catalogId" : field;
    if (Object.hasOwn(item, sourceField)) record[field] = structuredClone(item[sourceField]);
  }
  return record;
}

function weakEtag(value) {
  return value.trim().replace(/^W\//i, "");
}

function etagMatches(ifNoneMatch, etag) {
  if (!isNonEmptyString(ifNoneMatch, 8192)) return false;
  return ifNoneMatch.split(",").some((candidate) => {
    const normalized = candidate.trim();
    return normalized === "*" || weakEtag(normalized) === weakEtag(etag);
  });
}

function createGalleryItemsService({ publicCatalogRepository }) {
  if (
    typeof publicCatalogRepository?.readActiveSnapshot !== "function" ||
    typeof publicCatalogRepository?.querySnapshotPage !== "function"
  ) {
    throw new TypeError("publicCatalogRepository must implement active snapshot reads and queries.");
  }

  return Object.freeze({
    async getItems({ pageSize = 50, continuationToken = null, ifNoneMatch = null } = {}) {
      validatePageSize(pageSize);
      const validatedContinuation = validateContinuationToken(continuationToken, { request: true });
      const { marker, etag } = validateActiveSnapshot(
        await publicCatalogRepository.readActiveSnapshot(),
      );
      const metadata = Object.freeze({
        etag,
        snapshotId: marker.snapshotId,
        catalogHash: marker.catalogHash,
        totalItems: marker.itemCount,
      });

      if (etagMatches(ifNoneMatch, etag)) {
        return Object.freeze({ statusCode: 304, items: [], continuationToken: null, metadata });
      }

      const page = await publicCatalogRepository.querySnapshotPage({
        snapshotId: marker.snapshotId,
        pageSize,
        continuationToken: validatedContinuation,
      });
      if (!isPlainObject(page) || !Array.isArray(page.resources) || page.resources.length > pageSize) {
        invalidUpstream("The public catalog query response is invalid.");
      }
      const items = page.resources.map((document) => validatePublicItem(document, marker.snapshotId));
      for (let index = 1; index < items.length; index += 1) {
        if (compareDisplayOrder(items[index - 1], items[index]) > 0) {
          invalidUpstream("The public catalog query is not stably ordered.");
        }
      }
      return Object.freeze({
        statusCode: 200,
        items: items.map(toPublicRecord),
        continuationToken: validateContinuationToken(page.continuationToken),
        metadata,
      });
    },
  });
}

module.exports = {
  CATALOG_PARTITION,
  PUBLIC_RECORD_FIELDS,
  compareDisplayOrder,
  createGalleryItemsService,
  etagMatches,
  toPublicRecord,
  validateActiveSnapshot,
  validateContinuationToken,
  validatePageSize,
  validatePublicItem,
};