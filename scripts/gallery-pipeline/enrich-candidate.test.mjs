import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CATALOG_PREVIEW_PLACEHOLDER,
  enrichCandidateMetadata,
} from "./enrich-candidate.mjs";
import { normalizeCandidate } from "./normalize.mjs";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/discovery/enrichment.json", import.meta.url), "utf8"),
);

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
  const metadata = enrichCandidateMetadata(fixture.valid);

  assert.deepEqual(metadata, {
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
  const metadata = enrichCandidateMetadata({
    ...fixture.valid,
    previewUrls: ["javascript:alert(1)", "http://example.com/preview.png"],
  });

  assert.equal(metadata.preview, CATALOG_PREVIEW_PLACEHOLDER);
});

test("rejects malicious required URLs and invalid source timestamps", () => {
  assert.throws(
    () => enrichCandidateMetadata(fixture.invalid),
    /metadata\.website requires|metadata\.launchUrl/,
  );
  assert.throws(
    () => enrichCandidateMetadata({ ...fixture.valid, websiteUrls: fixture.invalid.websiteUrls }),
    /metadata\.website requires/,
  );
  assert.throws(
    () => enrichCandidateMetadata({ ...fixture.valid, publishedAt: fixture.invalid.publishedAt }),
    /metadata\.publishedAt must be a valid date-time/,
  );
  assert.throws(
    () => enrichCandidateMetadata({ ...fixture.valid, publishedAt: 0 }),
    /metadata\.publishedAt must be a valid date-time string/,
  );
});

test("rejects literal, private, and local metadata destinations", () => {
  const validMetadata = enrichCandidateMetadata(fixture.valid);
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
      () => enrichCandidateMetadata({ ...fixture.valid, launchUrl: url }),
      /literal, private, or local destination/,
    );
    assert.throws(
      () => enrichCandidateMetadata({ ...fixture.valid, websiteUrls: [url] }),
      /metadata\.website requires/,
    );
    assert.equal(
      enrichCandidateMetadata({ ...fixture.valid, previewUrls: [url] }).preview,
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
    () => enrichCandidateMetadata({ ...fixture.valid, launchUrl: nonDefaultPortUrl }),
    /metadata\.launchUrl must not specify a non-default port/,
  );
  assert.throws(
    () => enrichCandidateMetadata({ ...fixture.valid, websiteUrls: [nonDefaultPortUrl] }),
    /metadata\.website must not specify a non-default port/,
  );
  assert.throws(
    () => enrichCandidateMetadata({ ...fixture.valid, previewUrls: [nonDefaultPortUrl] }),
    /metadata\.preview must not specify a non-default port/,
  );

  const defaultPortMetadata = enrichCandidateMetadata({
    ...fixture.valid,
    launchUrl: "https://Example.com:443/resource",
    websiteUrls: ["https://Publisher.Example:443/profile"],
    previewUrls: ["https://CDN.Example:443/preview.png"],
  });
  assert.equal(defaultPortMetadata.launchUrl, "https://Example.com:443/resource");
  assert.equal(defaultPortMetadata.website, "https://publisher.example/profile");
  assert.equal(defaultPortMetadata.preview, "https://cdn.example/preview.png");
});

test("bounds owner text and rejects unsafe or inconsistent normalized metadata", () => {
  const metadata = enrichCandidateMetadata({
    ...fixture.valid,
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