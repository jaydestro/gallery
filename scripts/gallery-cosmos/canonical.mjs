import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const GALLERY_RECORD_FIELDS = Object.freeze([
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

const PUBLIC_LIFECYCLE_STATUSES = new Set(["active", "needs-review"]);

function canonicalValue(value, scope = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${scope} contains a non-finite number.`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (item === undefined) throw new TypeError(`${scope}[${index}] is undefined.`);
      return canonicalValue(item, `${scope}[${index}]`);
    });
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${scope} is not a JSON value.`);
  }
  return Object.fromEntries(Object.keys(value)
    .filter((key) => !key.startsWith("_") && value[key] !== undefined)
    .sort()
    .map((key) => [key, canonicalValue(value[key], `${scope}.${key}`)]));
}

export function withoutInternalFields(value) {
  return canonicalValue(value);
}

export function canonicalSerialize(value) {
  return JSON.stringify(canonicalValue(value));
}

export function canonicalHash(value) {
  return `sha256:${createHash("sha256").update(canonicalSerialize(value)).digest("hex")}`;
}

export function canonicalEqual(left, right) {
  return isDeepStrictEqual(canonicalValue(left), canonicalValue(right));
}

export function toGalleryRecord(document) {
  const clean = withoutInternalFields(document);
  const record = {};
  for (const field of GALLERY_RECORD_FIELDS) {
    if (field === "id" && Object.hasOwn(clean, "catalogId")) {
      record.id = clean.catalogId;
    } else if (Object.hasOwn(clean, field)) {
      record[field] = structuredClone(clean[field]);
    }
  }
  return record;
}

export function galleryRecordHash(record) {
  return canonicalHash(toGalleryRecord(record));
}

export function compareDisplayOrder(left, right) {
  return left.displayOrder - right.displayOrder ||
    String(left.catalogId ?? left.id).localeCompare(String(right.catalogId ?? right.id));
}

export function isPublicCatalogItem(document) {
  return document?.type === "catalog-item" &&
    document.publicationStatus === "published" &&
    PUBLIC_LIFECYCLE_STATUSES.has(document.lifecycleStatus);
}

export function gallerySnapshotFromDocuments(documents, { publicOnly = false } = {}) {
  if (!Array.isArray(documents)) throw new TypeError("documents must be an array.");
  const selected = publicOnly ? documents.filter(isPublicCatalogItem) : documents;
  const ordered = [...selected].sort(compareDisplayOrder);
  const records = ordered.map(toGalleryRecord);
  return Object.freeze({
    count: records.length,
    hash: canonicalHash(records),
    records,
  });
}

export function gallerySnapshotFromRecords(records) {
  if (!Array.isArray(records)) throw new TypeError("records must be an array.");
  const copied = records.map((record) => toGalleryRecord(record));
  return Object.freeze({
    count: copied.length,
    hash: canonicalHash(copied),
    records: copied,
  });
}