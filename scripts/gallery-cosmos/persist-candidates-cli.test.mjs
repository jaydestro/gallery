import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { executeCandidatePersistence } from "./persist-candidates-cli.mjs";
import { InMemoryContainer } from "./testing/fake-container.mjs";

const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const environment = Object.freeze({
  AZURE_COSMOS_ENDPOINT: "https://gallery.documents.azure.com/",
  AZURE_COSMOS_DATABASE: "gallery",
  AZURE_COSMOS_CANDIDATE_CONTAINER: "review-candidates",
  AZURE_COSMOS_AUDIT_CONTAINER: "pipeline-records",
  AZURE_COSMOS_CREDENTIAL: "default",
});

function candidate() {
  return {
    schemaVersion: "1.0.0",
    sourceType: "learn-document",
    sourceId: "cosmos-example",
    identityKey: "learn-document:cosmos-example",
    canonicalUrl: "https://learn.microsoft.com/azure/cosmos-db/nosql/example",
    title: "Cosmos example",
    description: "An example candidate.",
    publisher: "Microsoft",
    publishedAt: null,
    modifiedAt: null,
    discoveredAt: "2026-08-28T11:00:00.000Z",
    evidence: [{ type: "learn-cosmos-section", value: "Azure Cosmos DB for NoSQL" }],
    metadata: {
      sourceRegistryId: "learn-cosmos-db",
      trustTier: "first-party",
      galleryId: "candidate-example",
      tags: ["documentation", "microsoft"],
      launchUrl: "https://learn.microsoft.com/azure/cosmos-db/nosql/example",
      website: "https://learn.microsoft.com/azure/cosmos-db",
      preview: "coming soon",
      author: "Microsoft",
      sourceOwner: "Microsoft",
      publishedAt: null,
    },
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gallery-candidate-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const value = candidate();
  const discovery = {
    schemaVersion: "1.0.0",
    mode: "dry-run",
    mutationPerformed: false,
    status: "complete",
    startedAt: value.discoveredAt,
    completedAt: value.discoveredAt,
    summary: { sources: 1, succeededSources: 1, skippedSources: 0, indeterminateSources: 0, candidates: 1, rejected: 0 },
    candidates: [value],
    rejected: [],
    sources: [{ id: "learn-cosmos-db", queried: true, status: "succeeded" }],
    evidence: [],
  };
  const gates = {
    schemaVersion: "2.0.0",
    mode: "dry-run",
    mutationPerformed: false,
    status: "complete",
    coverageStatus: "complete",
    startedAt: value.discoveredAt,
    completedAt: value.discoveredAt,
    summary: {
      candidates: 1,
      selectedCandidates: 1,
      executedCandidateChecks: 1,
      availabilityChecks: 1,
      executedAvailabilityChecks: 1,
      indeterminateAvailabilityChecks: 0,
      deadlineExceededAvailabilityChecks: 0,
      eligible: 1,
      rejected: 0,
    },
    eligible: [{
      candidate: value,
      deterministicGate: {
        candidateId: value.identityKey,
        provenance: { status: "passed", sourceRegistryId: "learn-cosmos-db", trusted: true },
        sourceAvailability: { status: "healthy" },
        cosmosRelevance: { status: "passed", strategy: "strong-signal", signalKinds: ["learn-cosmos-section"] },
        duplicateCheck: { status: "passed", outcome: "unique", identityKeyChecked: true, canonicalUrlChecked: true },
        normalization: { status: "passed", schemaVersion: "1.0.0" },
      },
      availability: { checkedAt: value.discoveredAt, classification: "healthy", statusCode: 200, reasonCode: null },
    }],
    rejected: [],
  };
  const discoveryBytes = Buffer.from(`${JSON.stringify(discovery, null, 2)}\n`);
  const gateBytes = Buffer.from(`${JSON.stringify(gates, null, 2)}\n`);
  const artifact = {
    repository: "jaydestro/gallery",
    workflowId: "123",
    workflowPath: ".github/workflows/discover-content.yml",
    runId: "456",
    runAttempt: 2,
    sourceRef: "refs/heads/main",
    sourceSha: "a".repeat(40),
    artifactId: "789",
    artifactName: "gallery-discovery-456-2",
    digest: `sha256:${"b".repeat(64)}`,
    members: [
      { path: "candidate-gates.json", sha256: sha256(gateBytes) },
      { path: "discovery.json", sha256: sha256(discoveryBytes) },
    ],
  };
  await Promise.all([
    writeFile(path.join(root, "artifact.json"), JSON.stringify(artifact)),
    writeFile(path.join(root, "discovery.json"), discoveryBytes),
    writeFile(path.join(root, "candidate-gates.json"), gateBytes),
  ]);
  return { root, gates };
}

test("persists only exact healthy candidates plus one compact receipt and verifies them", async (t) => {
  const { root } = await fixture(t);
  const candidates = new InMemoryContainer();
  const audit = new InMemoryContainer();
  const openContainers = () => ({ containers: { candidates, audit } });
  const args = ["--artifact", "artifact.json", "--discovery", "discovery.json", "--candidate-gates", "candidate-gates.json"];

  const written = await executeCandidatePersistence({ argv: args, environment, rootDirectory: root, openContainers });
  assert.deepEqual(written, {
    mode: "write",
    runKey: "discovery-456-2",
    candidateCount: 1,
    candidateSetHash: written.candidateSetHash,
    receiptHash: written.receiptHash,
  });
  assert.match(written.candidateSetHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(candidates.snapshot().length, 1);
  assert.equal(audit.snapshot().length, 1);
  assert.equal(audit.snapshot()[0].type, "pipeline-receipt");

  const verified = await executeCandidatePersistence({
    argv: [...args, "--verify"],
    environment,
    rootDirectory: root,
    openContainers,
  });
  assert.equal(verified.mode, "verify");
  assert.equal(verified.candidateSetHash, written.candidateSetHash);
});

test("dry-run opens no Cosmos client and rejects a tampered artifact member", async (t) => {
  const { root, gates } = await fixture(t);
  let opened = false;
  const args = ["--artifact", "artifact.json", "--discovery", "discovery.json", "--candidate-gates", "candidate-gates.json", "--dry-run"];
  const dryRun = await executeCandidatePersistence({
    argv: args,
    environment,
    rootDirectory: root,
    openContainers() { opened = true; },
  });
  assert.equal(opened, false);
  assert.equal(dryRun.mode, "dry-run");

  gates.eligible[0].availability.statusCode = 201;
  await writeFile(path.join(root, "candidate-gates.json"), `${JSON.stringify(gates, null, 2)}\n`);
  await assert.rejects(
    executeCandidatePersistence({ argv: args, environment, rootDirectory: root }),
    /SHA-256 verification/,
  );
});