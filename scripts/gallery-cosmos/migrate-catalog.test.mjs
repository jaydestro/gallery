import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalHash, canonicalSerialize, toGalleryRecord } from "./canonical.mjs";
import { CosmosDomainError } from "./container-operations.mjs";
import {
  migrateCatalogAndPublicCreateOnly,
  migrateCatalogCreateOnly,
} from "./migrate-catalog.mjs";
import { InMemoryContainer } from "./testing/fake-container.mjs";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const catalog = JSON.parse(await readFile(path.join(rootDirectory, "static", "templates.json"), "utf8"));
const provenance = Object.freeze({
  repository: "jaydestro/gallery",
  workflowPath: ".github/workflows/migrate-gallery-catalog.yml",
  sourceRef: "refs/heads/main",
  sourceSha: "a".repeat(40),
  runId: "12345",
  runAttempt: 1,
  artifactDigest: `sha256:${"b".repeat(64)}`,
});

test("canonical serialization is key-stable and excludes Cosmos system/internal fields", () => {
  const left = { b: 2, _etag: "ignored", nested: { z: 3, _rid: "ignored", a: 1 } };
  const right = { nested: { a: 1, z: 3 }, b: 2, _ts: 123 };

  assert.equal(canonicalSerialize(left), canonicalSerialize(right));
  assert.equal(canonicalHash(left), canonicalHash(right));
});

test("migrates all 109 records with create-only writes and proves canonical parity", async () => {
  const container = new InMemoryContainer();
  const first = await migrateCatalogCreateOnly({
    records: catalog,
    catalogContainer: container,
    provenance,
    operationId: "migration:static-templates-v2",
    maxItemCount: 17,
  });

  assert.deepEqual(first, {
    count: 109,
    hash: canonicalHash(catalog),
    created: 109,
    matchedConflicts: 0,
  });
  const creates = container.calls.filter((call) => call.method === "createItem");
  assert.equal(creates.length, 109);
  assert(creates.every((call) => call.options.ifNoneMatch === "*"));
  assert.deepEqual(
    container.snapshot()
      .sort((left, right) => left.displayOrder - right.displayOrder)
      .map(toGalleryRecord),
    catalog,
  );

  const second = await migrateCatalogCreateOnly({
    records: catalog,
    catalogContainer: container,
    provenance,
    operationId: "migration:static-templates-v2",
    maxItemCount: 19,
  });
  assert.equal(second.created, 0);
  assert.equal(second.matchedConflicts, 109);
  assert.equal(second.hash, first.hash);
});

test("rejects a 409 unless the stored document and operation ID exactly match", async () => {
  const container = new InMemoryContainer();
  await migrateCatalogCreateOnly({
    records: catalog.slice(0, 1),
    catalogContainer: container,
    provenance,
    operationId: "migration:static-templates-v2",
  });
  const stored = container.snapshot()[0];
  stored.title = "Conflicting title";
  const conflicting = new InMemoryContainer([stored]);

  await assert.rejects(
    migrateCatalogCreateOnly({
      records: catalog.slice(0, 1),
      catalogContainer: conflicting,
      provenance,
      operationId: "migration:static-templates-v2",
    }),
    (error) => error instanceof CosmosDomainError && error.code === "CREATE_CONFLICT",
  );
});

test("fails parity when canonical storage contains an extra catalog item", async () => {
  const container = new InMemoryContainer();
  await migrateCatalogCreateOnly({
    records: catalog.slice(0, 1),
    catalogContainer: container,
    provenance,
    operationId: "migration:static-templates-v2",
  });
  const extra = container.snapshot()[0];
  extra.id = "extra-item";
  extra.displayOrder = 1;
  extra.operationId = "other-operation";
  container.seed(extra);

  await assert.rejects(
    migrateCatalogCreateOnly({
      records: catalog.slice(0, 1),
      catalogContainer: container,
      provenance,
      operationId: "migration:static-templates-v2",
    }),
    (error) => error instanceof CosmosDomainError && error.code === "MIGRATION_PARITY_FAILED",
  );
});

test("rejects migration input that drifts from the existing catalog schema", async () => {
  await assert.rejects(
    migrateCatalogCreateOnly({
      records: [{ ...catalog[0], unknownCatalogField: true }],
      catalogContainer: new InMemoryContainer(),
      provenance,
      operationId: "migration:static-templates-v2",
    }),
    (error) => error?.code === "COSMOS_SCHEMA_INVALID" && error.documentType === "galleryCatalog",
  );
});

test("stages the initial public snapshot before a create-only marker and replays by exact match", async () => {
  const catalogContainer = new InMemoryContainer();
  const publicContainer = new InMemoryContainer();
  const input = {
    records: catalog,
    catalogContainer,
    publicContainer,
    provenance,
    operationId: "migration:static-templates-v2",
    snapshotId: "migration-initial",
    publishedAt: "2026-08-28T12:00:00.000Z",
    maxItemCount: 23,
  };

  const first = await migrateCatalogAndPublicCreateOnly(input);
  assert.equal(first.count, catalog.length);
  assert.equal(first.canonicalCreates, catalog.length);
  assert.equal(first.stagedCreates, catalog.length);
  assert.equal(first.markerCreated, true);
  const publicWrites = publicContainer.calls.filter(({ method }) => method === "createItem");
  assert.equal(publicWrites.at(-1).document.id, "active-snapshot");

  const second = await migrateCatalogAndPublicCreateOnly(input);
  assert.equal(second.canonicalCreates, 0);
  assert.equal(second.canonicalMatches, catalog.length);
  assert.equal(second.stagedCreates, 0);
  assert.equal(second.markerCreated, false);
  assert.equal(second.hash, first.hash);
});