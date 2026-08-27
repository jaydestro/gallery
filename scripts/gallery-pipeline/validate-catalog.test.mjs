import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SOURCE_SHARING_POLICY,
  canonicalizeUrl,
  inferSourceType,
  loadValidationContext,
  validateCatalogData,
} from "./validation.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const context = await loadValidationContext(rootDir);
const clone = (value) => structuredClone(value);

function trimStrings(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(trimStrings);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, trimStrings(item)]));
}

function validCatalogCopy() {
  const catalog = trimStrings(clone(context.catalog));
  const titleCounts = new Map();
  catalog.forEach((record, index) => {
    const count = titleCounts.get(record.title) ?? 0;
    titleCounts.set(record.title, count + 1);
    if (count > 0) record.title = `${record.title} [validation baseline ${index}]`;
  });
  assert.deepEqual(validateCatalogData(context, { catalog }), []);
  return catalog;
}

function issueCodes(catalog, overrides = {}) {
  return new Set(validateCatalogData(context, { catalog, ...overrides }).map((issue) => issue.code));
}

test("validates a copy of the real legacy catalog and its three explicit source-sharing groups", () => {
  assert(context.catalog.length > 0);
  assert.equal(SOURCE_SHARING_POLICY.length, 3);
  validCatalogCopy();
});

test("the catalog schema accepts a v2 record and source type inference is deterministic", () => {
  const catalog = validCatalogCopy();
  catalog.push({
    id: "v2-example",
    title: "V2 example",
    summary: "A schema-valid v2 gallery record.",
    preview: "coming soon",
    canonicalSource: "https://github.com/example/repository",
    sourceType: "github-repository",
    author: "Example",
    sourceOwner: "Example",
    tags: ["example"],
    dateAdded: "2026-08-27",
    lastVerified: "2026-08-27T12:00:00.000Z",
    lifecycleStatus: "active",
  });

  assert.equal(inferSourceType("https://github.com/example/repository"), "github-repository");
  assert.equal(inferSourceType("https://github.com/example/repository/tree/main"), "github-path");
  assert.equal(inferSourceType("https://learn.microsoft.com/en-us/azure/cosmos-db/"), "learn-document");
  assert.deepEqual(validateCatalogData(context, { catalog }), []);
});

test("canonicalization preserves non-default HTTPS ports", () => {
  assert.equal(canonicalizeUrl("https://example.com:8443/path"), "https://example.com:8443/path");
});

test("rejects malformed and non-HTTPS URLs", () => {
  const catalog = validCatalogCopy();
  catalog[0].website = "not a URL";

  assert(issueCodes(catalog).has("HTTPS_URL_REQUIRED"));
});

test("rejects unknown tags and tag case aliases", () => {
  const catalog = validCatalogCopy();
  catalog[0].tags = ["unknown-tag"];
  catalog[1].tags = ["cqrs"];
  const codes = issueCodes(catalog);

  assert(codes.has("TAG_UNDECLARED"));
  assert(codes.has("TAG_CASE_ALIAS"));
});

test("rejects duplicate tags", () => {
  const catalog = validCatalogCopy();
  catalog[0].tags.push(catalog[0].tags[0]);

  assert(issueCodes(catalog).has("TAG_DUPLICATE"));
});

test("rejects duplicate exact titles", () => {
  const catalog = validCatalogCopy();
  catalog[1].title = catalog[0].title;

  assert(issueCodes(catalog).has("TITLE_DUPLICATE"));
});

test("rejects duplicate canonical sources outside the explicit policy", () => {
  const catalog = validCatalogCopy();
  catalog[1].source = catalog[0].source ?? catalog[0].website;

  assert(issueCodes(catalog).has("CANONICAL_SOURCE_DUPLICATE"));
});

test("rejects stale source-sharing policy allowances", () => {
  const catalog = validCatalogCopy();
  const removedTitle = SOURCE_SHARING_POLICY[0].members[0];
  const index = catalog.findIndex((record) => record.title === removedTitle);
  catalog.splice(index, 1);

  assert(issueCodes(catalog).has("SOURCE_SHARING_POLICY_STALE"));
});

test("rejects a declared source type that conflicts with the canonical URL", () => {
  const catalog = validCatalogCopy();
  catalog.push({
    id: "source-type-mismatch",
    title: "Source type mismatch",
    summary: "A record used to test source type inference.",
    preview: "coming soon",
    canonicalSource: "https://github.com/example/repository",
    sourceType: "video",
    author: "Example",
    sourceOwner: "Example",
    tags: ["example"],
    dateAdded: "2026-08-27",
    lastVerified: "2026-08-27T12:00:00.000Z",
    lifecycleStatus: "active",
  });

  assert(issueCodes(catalog).has("SOURCE_TYPE_MISMATCH"));
});

test("rejects untrimmed titles", () => {
  const catalog = validCatalogCopy();
  catalog[0].title = ` ${catalog[0].title}`;

  assert(issueCodes(catalog).has("STRING_NOT_TRIMMED"));
});

test("rejects active and retired v2 records with the same ID", () => {
  const record = {
    id: "shared-id",
    title: "Active v2 record",
    summary: "An active record used to test identity disjointness.",
    preview: "coming soon",
    canonicalSource: "https://github.com/example/active-record",
    sourceType: "github-repository",
    author: "Example",
    sourceOwner: "Example",
    tags: ["example"],
    dateAdded: "2026-08-27",
    lastVerified: "2026-08-27T12:00:00.000Z",
    lifecycleStatus: "active",
  };
  const retiredRecord = {
    ...record,
    title: "Retired v2 record",
    canonicalSource: "https://github.com/example/retired-record",
    lifecycleStatus: "retired",
  };
  const retired = clone(context.retired);
  retired.entries.push({
    record: retiredRecord,
    retiredAt: "2026-08-27T12:00:00.000Z",
    retentionUntil: "2027-08-27",
    reasonCodes: ["TEST_RETIREMENT"],
    evidence: [{
      observedAt: "2026-08-27T12:00:00.000Z",
      source: "https://github.com/example/retired-record",
      reason: "Validation test evidence.",
    }],
    supersededBy: null,
    decisionRunUrl: "https://github.com/example/repository/actions/runs/1",
    decisionPullRequestUrl: "https://github.com/example/repository/pull/1",
  });

  const catalog = validCatalogCopy();
  catalog.push(record);
  assert(issueCodes(catalog, { retired }).has("ACTIVE_RETIRED_ID_OVERLAP"));
});

test("reports malformed sidecars without throwing", () => {
  const catalog = validCatalogCopy();

  assert(issueCodes(catalog, { health: null }).has("SCHEMA_VALIDATION"));
  assert(issueCodes(catalog, { retired: null }).has("SCHEMA_VALIDATION"));
});

test("reports malformed catalog and sidecar members without throwing", () => {
  const catalog = validCatalogCopy();
  catalog.push(null);
  const retired = clone(context.retired);
  retired.entries = [null];

  assert(issueCodes(catalog).has("SCHEMA_VALIDATION"));
  assert(issueCodes(validCatalogCopy(), { retired }).has("SCHEMA_VALIDATION"));
});