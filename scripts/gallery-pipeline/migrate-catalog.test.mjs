import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  migrateCatalog,
  serializeCatalog,
  stableLegacyId,
} from "./migrate-catalog.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const catalogText = await readFile(path.join(rootDir, "static", "templates.json"), "utf8");
const catalog = JSON.parse(catalogText);

function legacyRecord(overrides = {}) {
  return {
    title: "Example resource",
    description: "An existing gallery summary.",
    preview: "coming soon",
    website: "https://github.com/ExampleOwner",
    author: "Example Owner",
    source: "https://github.com/ExampleOwner/ExampleRepo/",
    date: "2024-09-27",
    tags: ["example"],
    ...overrides,
  };
}

test("maps every legacy field to v2 without changing record order", () => {
  const first = legacyRecord();
  const second = legacyRecord({
    title: "Second resource",
    source: "https://learn.microsoft.com/en-us/azure/cosmos-db/",
    date: "2025-01-15",
    tags: ["documentation"],
  });
  const migrated = migrateCatalog([first, second]);

  assert.deepEqual(migrated.map((record) => record.title), [first.title, second.title]);
  assert.deepEqual(migrated[0], {
    id: stableLegacyId("https://github.com/exampleowner/examplerepo", first.title),
    title: first.title,
    summary: first.description,
    preview: first.preview,
    launchUrl: first.source,
    canonicalSource: "https://github.com/exampleowner/examplerepo",
    sourceType: "github-repository",
    author: first.author,
    sourceOwner: null,
    website: first.website,
    tags: first.tags,
    publishedAt: first.date,
    dateAdded: null,
    lastVerified: null,
    lifecycleStatus: "active",
  });
  assert.equal(migrated[1].sourceType, "learn-document");
});

test("preserves the legacy publication date without inventing acceptance or verification dates", () => {
  const migrated = migrateCatalog([legacyRecord({ date: "2019-10-31" })])[0];

  assert.equal(migrated.publishedAt, "2019-10-31");
  assert.equal(migrated.dateAdded, null);
  assert.equal(migrated.lastVerified, null);
  assert.throws(
    () => migrateCatalog([legacyRecord({ date: undefined })]),
    /requires legacy field date/,
  );
});

test("preserves exact launch and website URLs while canonicalizing only source identity", () => {
  const source = "https://GitHub.com/ExampleOwner/ExampleRepo/?utm_source=gallery#read-me";
  const website = "https://example.com/Owner/?ref=gallery#profile";
  const migrated = migrateCatalog([legacyRecord({ source, website })])[0];

  assert.equal(migrated.launchUrl, source);
  assert.equal(migrated.canonicalSource, "https://github.com/exampleowner/examplerepo");
  assert.equal(migrated.website, website);
});

test("normalizes a legacy-empty preview to the catalog's established placeholder", () => {
  assert.equal(migrateCatalog([legacyRecord({ preview: "" })])[0].preview, "coming soon");
});

test("derives stable unique IDs from canonical source and title, including shared sources", () => {
  const records = [
    legacyRecord({ title: "First view" }),
    legacyRecord({ title: "Second view" }),
  ];
  const firstPass = migrateCatalog(records);
  const secondPass = migrateCatalog(records);

  assert.deepEqual(firstPass, secondPass);
  assert.equal(new Set(firstPass.map((record) => record.id)).size, records.length);
});

test("leaves corrected v2 records unchanged", () => {
  const corrected = migrateCatalog([legacyRecord()]);

  assert.deepEqual(migrateCatalog(corrected), corrected);
  assert.equal(serializeCatalog(migrateCatalog(corrected)), serializeCatalog(corrected));
});

test("migrates all 109 checked-in records idempotently without retiring content", () => {
  const migrated = migrateCatalog(catalog);

  assert.equal(migrated.length, 109);
  assert.deepEqual(migrated.map((record) => record.title), catalog.map((record) => record.title));
  assert.equal(new Set(migrated.map((record) => record.id)).size, 109);
  assert(migrated.every((record) => record.lifecycleStatus === "active"));
  assert(migrated.every((record) => record.sourceOwner === null));
  assert(migrated.every((record) => record.dateAdded === null));
  assert(migrated.every((record) => record.lastVerified === null));
  assert(migrated.every((record) => /^https?:\/\//i.test(record.website)));
  assert.deepEqual(migrateCatalog(migrated), migrated);

  if (catalog.every((record) => typeof record.id === "string")) {
    assert.equal(serializeCatalog(migrated), catalogText);
  }
});