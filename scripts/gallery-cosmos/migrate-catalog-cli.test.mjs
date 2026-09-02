import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { executeMigration } from "./migrate-catalog-cli.mjs";
import { InMemoryContainer } from "./testing/fake-container.mjs";

const rootEnvironment = Object.freeze({
  AZURE_COSMOS_ENDPOINT: "https://gallery.documents.azure.com/",
  AZURE_COSMOS_DATABASE: "gallery",
  AZURE_COSMOS_CATALOG_CONTAINER: "catalog-items",
  AZURE_COSMOS_PUBLIC_CONTAINER: "public-catalog",
  AZURE_COSMOS_CREDENTIAL: "default",
});
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gallery-migration-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceBytes = await readFile(path.resolve("static/templates.json"));
  await writeFile(path.join(root, "templates.json"), sourceBytes);
  await writeFile(path.join(root, "provenance.json"), JSON.stringify({
    repository: "jaydestro/gallery",
    workflowPath: ".github/workflows/migrate-gallery-catalog.yml",
    sourceRef: "refs/heads/main",
    sourceSha: "a".repeat(40),
    runId: "123",
    runAttempt: 1,
    artifactDigest: sha256(sourceBytes),
  }));
  return root;
}

test("dry-run validates exact input and provenance without opening Cosmos", async (t) => {
  const root = await fixture(t);
  let opened = false;
  const result = await executeMigration({
    argv: ["--input", "templates.json", "--provenance", "provenance.json", "--published-at", "2026-08-28T12:00:00.000Z", "--dry-run"],
    environment: rootEnvironment,
    rootDirectory: root,
    openContainers() {
      opened = true;
    },
  });
  assert.equal(opened, false);
  assert.equal(result.mode, "dry-run");
  assert.equal(result.count, 109);
  assert.match(result.provenanceHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes(rootEnvironment.AZURE_COSMOS_ENDPOINT), false);
});

test("write and verify modes use create-only canonical and public migration", async (t) => {
  const root = await fixture(t);
  const catalog = new InMemoryContainer();
  const publicContainer = new InMemoryContainer();
  const openContainers = () => ({ containers: { catalog, public: publicContainer } });
  const common = ["--input", "templates.json", "--provenance", "provenance.json", "--published-at", "2026-08-28T12:00:00.000Z"];
  const written = await executeMigration({
    argv: common,
    environment: rootEnvironment,
    rootDirectory: root,
    openContainers,
  });
  assert.equal(written.mode, "write");
  assert.equal(written.canonicalCreates, 109);
  assert.equal(written.markerCreated, true);

  const verified = await executeMigration({
    argv: [...common, "--verify"],
    environment: rootEnvironment,
    rootDirectory: root,
    openContainers,
  });
  assert.equal(verified.mode, "verify");
  assert.equal(verified.count, 109);
  assert.equal(verified.hash, written.hash);
});

test("rejects provenance that does not bind the exact source bytes", async (t) => {
  const root = await fixture(t);
  const provenance = JSON.parse(await readFile(path.join(root, "provenance.json"), "utf8"));
  provenance.artifactDigest = `sha256:${"0".repeat(64)}`;
  await writeFile(path.join(root, "provenance.json"), JSON.stringify(provenance));
  await assert.rejects(
    executeMigration({
      argv: ["--input", "templates.json", "--provenance", "provenance.json", "--published-at", "2026-08-28T12:00:00.000Z", "--dry-run"],
      environment: rootEnvironment,
      rootDirectory: root,
    }),
    /exact input bytes/,
  );
});