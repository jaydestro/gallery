/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import type {
  CatalogUser,
  LifecycleStatus,
  SourceType,
  TagType,
  User,
} from "./tags";

const PAGE_SIZE = 100;
const MAX_CONTINUATION_TOKEN_LENGTH = 8192;
const CATALOG_USER_FIELDS = new Set([
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
const REQUIRED_CATALOG_USER_FIELDS = [
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
];
const RESPONSE_FIELDS = new Set(["items", "continuationToken", "metadata"]);
const METADATA_FIELDS = new Set(["etag", "snapshotId", "catalogHash", "totalItems"]);
const SOURCE_TYPES = new Set<SourceType>([
  "github-repository",
  "github-path",
  "learn-document",
  "blog-post",
  "video",
  "tool",
  "other",
]);
const PUBLIC_LIFECYCLE_STATUSES = new Set<LifecycleStatus>(["active", "needs-review"]);

export const GALLERY_SORT_OPTIONS = [
  "New to old",
  "Old to new",
  "Alphabetical (A - Z)",
  "Alphabetical (Z - A)",
] as const;

export type GallerySortChoice = (typeof GALLERY_SORT_OPTIONS)[number];

type GalleryMetadata = {
  etag: string;
  snapshotId: string;
  catalogHash: string;
  totalItems: number;
};

type GalleryPage = {
  items: CatalogUser[];
  continuationToken: string | null;
  metadata: GalleryMetadata;
};

type GalleryFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type LoadGalleryUsersOptions = {
  apiBaseUrl?: unknown;
  useStaticCatalog: boolean;
  staticCatalog: readonly unknown[];
  validTags: readonly TagType[];
  fetchImpl?: GalleryFetch;
  signal?: AbortSignal;
};

export class GalleryDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GalleryDataError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactFields(
  value: Record<string, unknown>,
  allowedFields: ReadonlySet<string>,
  requiredFields: readonly string[],
): boolean {
  return Object.keys(value).every((field) => allowedFields.has(field)) &&
    requiredFields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function isIsoDateTime(value: unknown): value is string {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value));
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function validateContinuationToken(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CONTINUATION_TOKEN_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new GalleryDataError("The gallery API returned an invalid continuation token.");
  }
  return value;
}

function validateMetadata(value: unknown): GalleryMetadata {
  if (
    !isRecord(value) ||
    !hasExactFields(value, METADATA_FIELDS, ["etag", "snapshotId", "catalogHash", "totalItems"]) ||
    !isNonEmptyString(value.etag) ||
    !isNonEmptyString(value.snapshotId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value.snapshotId) ||
    typeof value.catalogHash !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value.catalogHash) ||
    !Number.isSafeInteger(value.totalItems) ||
    (value.totalItems as number) < 0
  ) {
    throw new GalleryDataError("The gallery API returned invalid metadata.");
  }

  return value as GalleryMetadata;
}

function validateCatalogUser(
  value: unknown,
  validTags: ReadonlySet<string>,
  itemIndex: number,
): CatalogUser {
  const invalid = () => {
    throw new GalleryDataError(`The gallery API returned an invalid item at index ${itemIndex}.`);
  };

  if (
    !isRecord(value) ||
    !hasExactFields(value, CATALOG_USER_FIELDS, REQUIRED_CATALOG_USER_FIELDS) ||
    !isNonEmptyString(value.id) ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(value.id) ||
    !isNonEmptyString(value.title) ||
    !isNonEmptyString(value.summary) ||
    !isNonEmptyString(value.preview) ||
    !isHttpUrl(value.launchUrl) ||
    !isHttpUrl(value.canonicalSource) ||
    !SOURCE_TYPES.has(value.sourceType as SourceType) ||
    !isNonEmptyString(value.author) ||
    (value.sourceOwner !== null && !isNonEmptyString(value.sourceOwner)) ||
    !isHttpUrl(value.website) ||
    !Array.isArray(value.tags) ||
    value.tags.length === 0 ||
    value.tags.some((tag) => typeof tag !== "string" || !validTags.has(tag)) ||
    new Set(value.tags).size !== value.tags.length ||
    (!isIsoDate(value.publishedAt) && !isIsoDateTime(value.publishedAt)) ||
    (value.dateAdded !== null && !isIsoDate(value.dateAdded)) ||
    (value.lastVerified !== null && !isIsoDateTime(value.lastVerified)) ||
    !PUBLIC_LIFECYCLE_STATUSES.has(value.lifecycleStatus as LifecycleStatus) ||
    (value.supersededBy !== undefined &&
      value.supersededBy !== null &&
      !isNonEmptyString(value.supersededBy))
  ) {
    invalid();
  }

  return value as CatalogUser;
}

function validatePage(value: unknown, validTags: ReadonlySet<string>): GalleryPage {
  if (
    !isRecord(value) ||
    !hasExactFields(value, RESPONSE_FIELDS, ["items", "continuationToken", "metadata"]) ||
    !Array.isArray(value.items) ||
    value.items.length > PAGE_SIZE
  ) {
    throw new GalleryDataError("The gallery API returned an invalid response.");
  }

  return {
    items: value.items.map((item, index) => validateCatalogUser(item, validTags, index)),
    continuationToken: validateContinuationToken(value.continuationToken),
    metadata: validateMetadata(value.metadata),
  };
}

function normalizeApiBaseUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const normalized = value.trim().replace(/\/+$/, "");
  if (!isHttpUrl(normalized)) {
    throw new GalleryDataError("The gallery API URL is invalid.");
  }
  const url = new URL(normalized);
  if (url.search || url.hash) {
    throw new GalleryDataError("The gallery API URL must not contain a query string or fragment.");
  }
  return normalized;
}

function metadataMatches(left: GalleryMetadata, right: GalleryMetadata): boolean {
  return left.etag === right.etag &&
    left.snapshotId === right.snapshotId &&
    left.catalogHash === right.catalogHash &&
    left.totalItems === right.totalItems;
}

function toUsers(items: readonly CatalogUser[]): User[] {
  return items.map((item) => ({
    ...item,
    description: item.summary,
    source: item.launchUrl,
  }));
}

async function readResponseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new GalleryDataError("The gallery API returned invalid JSON.");
  }
}

async function fetchCatalog(
  apiBaseUrl: string,
  validTags: ReadonlySet<string>,
  fetchImpl: GalleryFetch,
  signal?: AbortSignal,
): Promise<CatalogUser[]> {
  const items: CatalogUser[] = [];
  const itemIds = new Set<string>();
  const continuationTokens = new Set<string>();
  let continuationToken: string | null = null;
  let expectedMetadata: GalleryMetadata | null = null;
  let pageCount = 0;

  do {
    const url = new URL(`${apiBaseUrl}/gallery/items`);
    url.searchParams.set("pageSize", String(PAGE_SIZE));
    if (continuationToken !== null) {
      url.searchParams.set("continuationToken", continuationToken);
    }

    const response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
    });
    if (!response.ok) {
      throw new GalleryDataError(`The gallery API request failed with status ${response.status}.`);
    }

    const page = validatePage(await readResponseJson(response), validTags);
    if (expectedMetadata === null) {
      expectedMetadata = page.metadata;
    } else if (!metadataMatches(expectedMetadata, page.metadata)) {
      throw new GalleryDataError("The gallery API snapshot changed during pagination.");
    }

    for (const item of page.items) {
      if (itemIds.has(item.id)) {
        throw new GalleryDataError(`The gallery API returned duplicate item id "${item.id}".`);
      }
      itemIds.add(item.id);
      items.push(item);
    }

    if (items.length > page.metadata.totalItems) {
      throw new GalleryDataError("The gallery API returned more items than its metadata declared.");
    }

    if (page.continuationToken !== null) {
      if (continuationTokens.has(page.continuationToken)) {
        throw new GalleryDataError("The gallery API returned a repeated continuation token.");
      }
      continuationTokens.add(page.continuationToken);
    }

    continuationToken = page.continuationToken;
    pageCount += 1;
    if (expectedMetadata && pageCount > Math.max(expectedMetadata.totalItems + 1, 2)) {
      throw new GalleryDataError("The gallery API returned too many continuation pages.");
    }
  } while (continuationToken !== null);

  if (expectedMetadata === null || items.length !== expectedMetadata.totalItems) {
    throw new GalleryDataError("The gallery API item count does not match its metadata.");
  }

  return items;
}

export async function loadGalleryUsers({
  apiBaseUrl,
  useStaticCatalog,
  staticCatalog,
  validTags,
  fetchImpl = fetch,
  signal,
}: LoadGalleryUsersOptions): Promise<User[]> {
  const normalizedApiBaseUrl = normalizeApiBaseUrl(apiBaseUrl);
  const validTagSet = new Set(validTags);

  if (normalizedApiBaseUrl !== null) {
    return toUsers(await fetchCatalog(normalizedApiBaseUrl, validTagSet, fetchImpl, signal));
  }

  if (!useStaticCatalog) {
    throw new GalleryDataError(
      "The gallery API is not configured. Set GALLERY_API_BASE_URL or explicitly enable the static catalog in development.",
    );
  }

  return toUsers(staticCatalog.map((item, index) => validateCatalogUser(item, validTagSet, index)));
}

function alphabeticalUsers(users: readonly User[]): User[] {
  return [...users].sort((left, right) => {
    const leftTitle = left.title.toLowerCase();
    const rightTitle = right.title.toLowerCase();
    return leftTitle > rightTitle ? 1 : rightTitle > leftTitle ? -1 : 0;
  });
}

export function sortGalleryUsers(users: readonly User[], rule?: string): User[] {
  if (rule === GALLERY_SORT_OPTIONS[0]) return [...users].reverse();
  if (rule === GALLERY_SORT_OPTIONS[1]) return [...users];

  const alphabetical = alphabeticalUsers(users);
  if (rule === GALLERY_SORT_OPTIONS[3]) return alphabetical.reverse();
  return alphabetical;
}