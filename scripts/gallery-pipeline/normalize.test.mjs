import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeCandidate } from "./normalize.mjs";
import {
  canonicalizeGitHubUrl,
  canonicalizeLearnUrl,
  canonicalizeYouTubeUrl,
  generateIdentityKey,
} from "./shared/canonicalize.mjs";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/discovery/urls.json", import.meta.url), "utf8"),
);

test("canonicalizes GitHub owner/repository casing without changing path casing", () => {
  assert.equal(canonicalizeGitHubUrl(fixture.github.input), fixture.github.expected);
  assert.notEqual(
    generateIdentityKey({ sourceType: "github-path", sourceId: 123, repositoryPath: "QuickStart/App.js" }),
    generateIdentityKey({ sourceType: "github-path", sourceId: 123, repositoryPath: "quickstart/App.js" }),
  );
});

test("canonicalizes Microsoft Learn locale and tracking parameters", () => {
  assert.equal(canonicalizeLearnUrl(fixture.learn.input), fixture.learn.expected);
});

test("canonicalizes YouTube variants to an immutable video URL", () => {
  assert.equal(canonicalizeYouTubeUrl(fixture.youtube.input), fixture.youtube.expected);
  assert.equal(
    canonicalizeYouTubeUrl("https://www.youtube.com/shorts/6IIUtEFKJec?feature=share"),
    fixture.youtube.expected,
  );
});

test("normalizes a candidate to the common schema with a stable identity", () => {
  const candidate = normalizeCandidate({
    sourceType: "learn-document",
    sourceId: "https://learn.microsoft.com/en-us/azure/cosmos-db/nosql/",
    canonicalUrl: fixture.learn.input,
    title: "Azure Cosmos DB for NoSQL",
    description: "Reference documentation.",
    publisher: "Microsoft Learn",
    discoveredAt: "2026-08-27T12:00:00Z",
    evidence: [{ type: "section", value: "Azure Cosmos DB for NoSQL" }],
  });

  assert.equal(candidate.schemaVersion, "1.0.0");
  assert.equal(candidate.canonicalUrl, fixture.learn.expected);
  assert.equal(
    candidate.identityKey,
    generateIdentityKey({
      sourceType: "learn-document",
      sourceId: "https://learn.microsoft.com/azure/cosmos-db/nosql",
    }),
  );
  assert.equal(candidate.discoveredAt, "2026-08-27T12:00:00.000Z");
});

test("does not invent source timestamps from metadata or numeric coercion", () => {
  const baseCandidate = {
    sourceType: "blog-post",
    sourceId: "timestamp-evidence",
    canonicalUrl: "https://example.com/article",
    title: "Azure Cosmos DB article",
    publisher: "Example Publisher",
    discoveredAt: "2026-08-27T12:00:00Z",
    evidence: [],
    metadata: {
      launchUrl: "https://Example.com/Article?view=Full#Evidence",
      website: "https://example.com/",
      author: "Example Publisher",
      publishedAt: "2026-08-20T09:00:00Z",
      preview: "coming soon",
    },
  };

  assert.throws(
    () => normalizeCandidate(baseCandidate),
    /metadata\.publishedAt must match candidate publishedAt/,
  );
  assert.throws(
    () => normalizeCandidate({ ...baseCandidate, publishedAt: 0 }),
    /publishedAt must be a valid date-time string/,
  );
});