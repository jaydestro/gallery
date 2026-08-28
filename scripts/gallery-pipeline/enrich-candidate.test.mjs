import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CATALOG_PREVIEW_PLACEHOLDER,
  deterministicCandidateTags,
  enrichCandidateMetadata,
  generateCandidateGalleryId,
} from "./enrich-candidate.mjs";
import { normalizeCandidate } from "./normalize.mjs";
import { extractDeclaredTags } from "./validation.mjs";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/discovery/enrichment.json", import.meta.url), "utf8"),
);
const tagSource = await readFile(new URL("../../src/data/tags.tsx", import.meta.url), "utf8");
const BASE_IDENTITY = Object.freeze({
  sourceType: "blog-post",
  sourceId: "authoritative-entry-id",
  trustTier: "first-party",
});

function enrich(overrides = {}) {
  return enrichCandidateMetadata({ ...fixture.valid, ...BASE_IDENTITY, ...overrides });
}

function candidate(metadata, overrides = {}) {
  return {
    sourceType: "blog-post",
    sourceId: "authoritative-entry-id",
    canonicalUrl: metadata.launchUrl,
    title: "Authoritative entry",
    description: "Azure Cosmos DB guidance.",
    publisher: metadata.author,
    publishedAt: metadata.publishedAt,
    discoveredAt: "2026-08-27T12:00:00Z",
    evidence: [],
    metadata,
    ...overrides,
  };
}

test("preserves the exact authoritative launch URL while canonicalizing other metadata URLs", () => {
  const metadata = enrich();

  assert.deepEqual(metadata, {
    galleryId: generateCandidateGalleryId(BASE_IDENTITY),
    tags: ["blog", "microsoft"],
    trustTier: "first-party",
    launchUrl: "https://Example.com/Resource/Launch?view=Full&utm_source=fixture#Overview",
    website: "https://publisher.example/profile",
    author: "Example Publisher",
    sourceOwner: null,
    publishedAt: "2026-08-25T09:00:00.000Z",
    preview: "https://cdn.example/previews/resource.png",
  });
  const normalized = normalizeCandidate(candidate(metadata));
  assert.deepEqual(normalized.metadata, metadata);
  assert.equal(normalized.canonicalUrl, "https://example.com/Resource/Launch?view=Full");
});

test("uses only the established catalog placeholder when no authoritative preview is valid", () => {
  const metadata = enrich({
    previewUrls: ["javascript:alert(1)", "http://example.com/preview.png"],
  });

  assert.equal(metadata.preview, CATALOG_PREVIEW_PLACEHOLDER);
});

test("rejects malicious required URLs and invalid source timestamps", () => {
  assert.throws(
    () => enrich({ ...fixture.invalid }),
    /metadata\.website requires|metadata\.launchUrl/,
  );
  assert.throws(
    () => enrich({ websiteUrls: fixture.invalid.websiteUrls }),
    /metadata\.website requires/,
  );
  assert.throws(
    () => enrich({ publishedAt: fixture.invalid.publishedAt }),
    /metadata\.publishedAt must be a valid date-time/,
  );
  assert.throws(
    () => enrich({ publishedAt: 0 }),
    /metadata\.publishedAt must be a valid date-time string/,
  );
});

test("rejects literal, private, and local metadata destinations", () => {
  const validMetadata = enrich();
  const rejectedDestinations = [
    "https://127.0.0.1/resource",
    "https://[::1]/resource",
    "https://localhost/resource",
    "https://localhost./resource",
    "https://preview.internal/resource",
    "https://preview.internal./resource",
    "https://preview.local/resource",
    "https://intranet/resource",
  ];

  for (const url of rejectedDestinations) {
    assert.throws(
      () => enrich({ launchUrl: url }),
      /literal, private, or local destination/,
    );
    assert.throws(
      () => enrich({ websiteUrls: [url] }),
      /metadata\.website requires/,
    );
    assert.equal(
      enrich({ previewUrls: [url] }).preview,
      CATALOG_PREVIEW_PLACEHOLDER,
    );
    assert.throws(
      () => normalizeCandidate(candidate({ ...validMetadata, website: url })),
      /literal, private, or local destination/,
    );
    assert.throws(
      () => normalizeCandidate(candidate({ ...validMetadata, preview: url })),
      /literal, private, or local destination/,
    );
  }
});

test("rejects explicit non-default metadata ports before canonicalization", () => {
  const nonDefaultPortUrl = "https://example.com:8443/resource";

  assert.throws(
    () => enrich({ launchUrl: nonDefaultPortUrl }),
    /metadata\.launchUrl must not specify a non-default port/,
  );
  assert.throws(
    () => enrich({ websiteUrls: [nonDefaultPortUrl] }),
    /metadata\.website must not specify a non-default port/,
  );
  assert.throws(
    () => enrich({ previewUrls: [nonDefaultPortUrl] }),
    /metadata\.preview must not specify a non-default port/,
  );

  const defaultPortMetadata = enrich({
    launchUrl: "https://Example.com:443/resource",
    websiteUrls: ["https://Publisher.Example:443/profile"],
    previewUrls: ["https://CDN.Example:443/preview.png"],
  });
  assert.equal(defaultPortMetadata.launchUrl, "https://Example.com:443/resource");
  assert.equal(defaultPortMetadata.website, "https://publisher.example/profile");
  assert.equal(defaultPortMetadata.preview, "https://cdn.example/preview.png");
});

test("bounds owner text and rejects unsafe or inconsistent normalized metadata", () => {
  const metadata = enrich({
    author: `Publisher\u0000 ${"x".repeat(300)}`,
    sourceOwner: `Owner ${"y".repeat(300)}`,
  });
  assert.equal(metadata.author.includes("\u0000"), false);
  assert.equal([...metadata.author].length, 160);
  assert.equal([...metadata.sourceOwner].length, 160);

  assert.throws(
    () => normalizeCandidate(candidate({ ...metadata, preview: "javascript:alert(1)" })),
    /metadata\.preview must be an HTTPS URL/,
  );
  assert.throws(
    () => normalizeCandidate(candidate(metadata, { publishedAt: "2026-08-26T09:00:00Z" })),
    /metadata\.publishedAt must match candidate publishedAt/,
  );
});

test("generates stable schema-valid opaque IDs without collisions across distinct identities", () => {
  const identity = { sourceType: "github-path", sourceId: 42, repositoryPath: "samples/App.js" };
  const stableId = generateCandidateGalleryId(identity);
  assert.equal(generateCandidateGalleryId({ ...identity }), stableId);
  assert.match(stableId, /^candidate-[a-f0-9]{64}$/);
  assert.equal(stableId.includes("samples"), false);

  const ids = new Set(
    Array.from({ length: 2_048 }, (_, index) => generateCandidateGalleryId({
      sourceType: "github-repository",
      sourceId: index + 1,
    })),
  );
  assert.equal(ids.size, 2_048);
});

test("maps each source type only to declared deterministic tags", () => {
  const declaredTags = new Set(extractDeclaredTags(tagSource));
  const cases = [
    ["github-repository", "example"],
    ["github-path", "example"],
    ["learn-document", "documentation"],
    ["blog-post", "blog"],
    ["video", "video"],
  ];

  for (const [sourceType, resourceTag] of cases) {
    const firstPartyTags = deterministicCandidateTags({ sourceType, trustTier: "first-party" });
    assert.deepEqual(firstPartyTags, [resourceTag, "microsoft"]);
    assert.deepEqual(deterministicCandidateTags({ sourceType, trustTier: "community" }), [resourceTag]);
    assert.ok(firstPartyTags.every((tag) => declaredTags.has(tag)));
  }
});

test("normalization preserves schema-valid IDs and rejects invalid IDs and tags", () => {
  const metadata = enrich();
  const preassigned = normalizeCandidate(candidate({
    ...metadata,
    galleryId: "catalog-target",
    tags: ["example"],
  }));
  assert.equal(preassigned.metadata.galleryId, "catalog-target");
  assert.deepEqual(preassigned.metadata.tags, ["example"]);

  assert.throws(
    () => normalizeCandidate(candidate({ ...metadata, galleryId: "Candidate Forged" })),
    /schema-valid lowercase opaque identifier/,
  );
  assert.throws(
    () => normalizeCandidate(candidate({ ...metadata, tags: ["blog", "unknown"] })),
    /undeclared or case-aliased tag/,
  );
  assert.throws(
    () => normalizeCandidate(candidate({ ...metadata, tags: ["Blog", "microsoft"] })),
    /undeclared or case-aliased tag/,
  );
  assert.throws(
    () => normalizeCandidate(candidate({ ...metadata, tags: ["blog", "microsoft", "microsoft"] })),
    /must not contain duplicates/,
  );
});