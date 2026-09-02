import { canonicalEqual } from "./canonical.mjs";

export const CATALOG_PARTITION = "gallery";
export const MAX_COSMOS_ITEM_BYTES = 1_900_000;

export const CANONICAL_CATALOG_QUERY = Object.freeze({
  query: "SELECT * FROM c WHERE c.catalogPartition = @catalogPartition AND c.type = @type ORDER BY c.displayOrder ASC, c.id ASC",
  parameters: Object.freeze([
    Object.freeze({ name: "@catalogPartition", value: CATALOG_PARTITION }),
    Object.freeze({ name: "@type", value: "catalog-item" }),
  ]),
});

export const PUBLIC_SNAPSHOT_QUERY = "SELECT * FROM c WHERE c.catalogPartition = @catalogPartition AND c.type = @type AND c.snapshotId = @snapshotId AND c.publicationStatus = @publicationStatus AND (c.lifecycleStatus = @activeStatus OR c.lifecycleStatus = @reviewStatus) ORDER BY c.displayOrder ASC, c.catalogId ASC";

export class CosmosDomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CosmosDomainError";
    this.code = code;
    this.details = details;
  }
}

export function responseEtag(response) {
  return response?.etag ?? response?.headers?.etag ?? response?.resource?._etag ?? null;
}

export function cosmosStatus(error) {
  return error?.statusCode ?? error?.status ?? error?.code;
}

function requireContainer(container) {
  for (const method of ["createItem", "readItem", "replaceItem", "queryItems"]) {
    if (typeof container?.[method] !== "function") {
      throw new TypeError(`container.${method} must be a function.`);
    }
  }
  return container;
}

export async function createItemOrMatch(container, document, { partitionKey }) {
  requireContainer(container);
  const itemBytes = Buffer.byteLength(JSON.stringify(document), "utf8");
  if (itemBytes > MAX_COSMOS_ITEM_BYTES) {
    throw new CosmosDomainError(
      "COSMOS_ITEM_TOO_LARGE",
      `Item ${document.id} exceeds the ${MAX_COSMOS_ITEM_BYTES}-byte operational ceiling.`,
      { id: document.id, itemBytes, partitionKey },
    );
  }
  try {
    const response = await container.createItem(document, {
      partitionKey,
      ifNoneMatch: "*",
    });
    return { created: true, response };
  } catch (error) {
    if (Number(cosmosStatus(error)) !== 409) throw error;
    const existing = await container.readItem(document.id, { partitionKey });
    if (
      existing?.resource?.operationId !== document.operationId ||
      !canonicalEqual(existing?.resource, document)
    ) {
      throw new CosmosDomainError(
        "CREATE_CONFLICT",
        `Existing item ${document.id} does not exactly match operation ${document.operationId}.`,
        { id: document.id, partitionKey },
      );
    }
    return { created: false, response: existing };
  }
}

export async function collectQuery(container, request) {
  requireContainer(container);
  const resources = [];
  const seenTokens = new Set();
  let continuationToken = request.continuationToken || null;
  do {
    const page = await container.queryItems({ ...request, continuationToken });
    if (!page || !Array.isArray(page.resources)) {
      throw new CosmosDomainError("QUERY_RESPONSE_INVALID", "Container query must return a resources array.");
    }
    resources.push(...page.resources);
    continuationToken = page.continuationToken || null;
    if (continuationToken !== null) {
      if (seenTokens.has(continuationToken)) {
        throw new CosmosDomainError("QUERY_TOKEN_REPEATED", "Container query repeated a continuation token.");
      }
      seenTokens.add(continuationToken);
    }
  } while (continuationToken !== null);
  return resources;
}

export async function readCanonicalCatalog(container, { maxItemCount = 100 } = {}) {
  return collectQuery(container, {
    ...CANONICAL_CATALOG_QUERY,
    partitionKey: CATALOG_PARTITION,
    maxItemCount,
  });
}

export function publicSnapshotQuery(snapshotId) {
  return {
    query: PUBLIC_SNAPSHOT_QUERY,
    parameters: [
      { name: "@catalogPartition", value: CATALOG_PARTITION },
      { name: "@type", value: "catalog-item" },
      { name: "@snapshotId", value: snapshotId },
      { name: "@publicationStatus", value: "published" },
      { name: "@activeStatus", value: "active" },
      { name: "@reviewStatus", value: "needs-review" },
    ],
  };
}