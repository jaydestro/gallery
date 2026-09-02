import assert from "node:assert/strict";
import test from "node:test";

import { makeCatalogReplayFixture } from "../gallery-pipeline/apply-catalog-plan.fixtures.mjs";
import { replayCatalogChangePlan } from "../gallery-pipeline/build-catalog-change.mjs";
import {
  canonicalHash,
  galleryRecordHash,
  gallerySnapshotFromDocuments,
} from "./canonical.mjs";
import { CosmosDomainError, PUBLIC_SNAPSHOT_QUERY } from "./container-operations.mjs";
import {
  createActiveSnapshot,
  createCatalogItem,
  createReviewDecision,
} from "./documents.mjs";
import { migrateCatalogCreateOnly } from "./migrate-catalog.mjs";
import {
  decisionSetHash,
  publicationOperationId,
  publishApprovedPlan,
} from "./publish-catalog.mjs";
import { queryLivePublicCatalog } from "./public-query.mjs";
import { InMemoryContainer } from "./testing/fake-container.mjs";

const policyHash = `sha256:${"c".repeat(64)}`;
const modelHash = `sha256:${"d".repeat(64)}`;
const migrationProvenance = Object.freeze({
  repository: "example/gallery",
  workflowPath: ".github/workflows/migrate-gallery-catalog.yml",
  sourceRef: "refs/heads/main",
  sourceSha: "a".repeat(40),
  runId: "100",
  runAttempt: 1,
  artifactDigest: `sha256:${"b".repeat(64)}`,
});
const publicationProvenance = Object.freeze({
  repository: "example/gallery",
  workflowPath: ".github/workflows/publish-gallery-catalog.yml",
  sourceRef: "refs/heads/main",
  sourceSha: "e".repeat(40),
  runId: "200",
  runAttempt: 1,
  artifactDigest: `sha256:${"f".repeat(64)}`,
});

class TamperingPublicContainer extends InMemoryContainer {
  async queryItems(request) {
    const page = await super.queryItems(request);
    if (
      request.parameters?.some(({ name }) => name === "@snapshotId") &&
      page.resources.length > 0
    ) {
      page.resources[0].title = "Tampered after staging";
    }
    return page;
  }
}

async function publicationFixture({ staleOperationType = null, PublicContainer = InMemoryContainer } = {}) {
  const fixture = makeCatalogReplayFixture();
  const initialRecords = [
    ...fixture.activeCatalog,
    ...fixture.retired.entries.map((entry) => entry.record),
  ];
  const catalogContainer = new InMemoryContainer();
  await migrateCatalogCreateOnly({
    records: initialRecords,
    catalogContainer,
    provenance: migrationProvenance,
    operationId: "migration:fixture",
  });
  const currentById = new Map(catalogContainer.snapshot().map((document) => [document.id, document]));
  const replayed = replayCatalogChangePlan(fixture.plan, {
    activeRecords: fixture.activeCatalog,
    retiredRecords: fixture.retired.entries.map((entry) => entry.record),
  }, { trustedRepository: fixture.trustedRepository });
  const publicRecords = replayed.activeRecords.filter((record) => (
    ["active", "needs-review"].includes(record.lifecycleStatus)
  ));
  const catalogSnapshotHash = canonicalHash(publicRecords);
  const decisions = fixture.plan.operations.map((operation) => createReviewDecision({
    runKey: fixture.plan.runId,
    candidateId: operation.targetId,
    operationId: operation.operationId,
    status: "approved",
    recommendation: operation.type,
    reasonCodes: operation.reasonCodes,
    decidedAt: fixture.plan.generatedAt,
    catalogItemHash: galleryRecordHash(operation.after),
    catalogSnapshotHash,
    policyHash,
    modelHash,
    expectedCatalogEtag: operation.type === "publish"
      ? null
      : operation.type === staleOperationType
        ? "\"stale-etag\""
        : currentById.get(operation.targetId)._etag,
    provenance: publicationProvenance,
  }));
  const previous = gallerySnapshotFromDocuments(catalogContainer.snapshot(), { publicOnly: true });
  const publicContainer = new PublicContainer();
  publicContainer.seed(createActiveSnapshot({
    snapshotId: "snapshot-previous",
    itemCount: previous.count,
    catalogHash: previous.hash,
    operationId: "publication:previous",
    publishedAt: "2026-08-27T00:00:00.000Z",
  }));
  const activeMarker = publicContainer.snapshot().find((document) => document.id === "active-snapshot");
  const snapshotId = `snapshot-${fixture.plan.runId}`;
  const binding = {
    snapshotId,
    decisionHash: decisionSetHash(decisions),
    catalogSnapshotHash,
    policyHash,
    modelHash,
    operationId: publicationOperationId(fixture.plan, snapshotId),
    expectedActiveSnapshotEtag: activeMarker._etag,
    publishedAt: fixture.plan.generatedAt,
  };
  return {
    ...fixture,
    binding,
    catalogContainer,
    decisions,
    publicContainer,
    publicRecords,
  };
}

function publishTarget(fixture) {
  const operation = fixture.plan.operations.find(({ type }) => type === "publish");
  const decision = fixture.decisions.find(({ operationId }) => operationId === operation.operationId);
  const appendTargetIds = new Set(fixture.plan.operations
    .filter(({ type }) => ["publish", "restore"].includes(type))
    .map(({ targetId }) => targetId));
  const displayOrder = fixture.catalogContainer.snapshot()
    .filter((document) => !appendTargetIds.has(document.id))
    .reduce((maximum, document) => Math.max(maximum, document.displayOrder), -1) + 1;
  return createCatalogItem({
    record: operation.after,
    displayOrder,
    writeKind: "publication",
    operationId: operation.operationId,
    catalogSnapshotHash: fixture.binding.catalogSnapshotHash,
    decisionHash: decision.decisionHash,
    policyHash,
    modelHash,
    provenance: {
      ...publicationProvenance,
      sourceHash: canonicalHash(fixture.plan),
    },
  });
}

test("publishes an approved plan and commits visibility only with the final marker replace", async () => {
  const fixture = await publicationFixture();
  const result = await publishApprovedPlan({
    plan: fixture.plan,
    decisions: fixture.decisions,
    binding: fixture.binding,
    catalogContainer: fixture.catalogContainer,
    publicContainer: fixture.publicContainer,
    provenance: publicationProvenance,
    trustedRepository: fixture.trustedRepository,
    maxItemCount: 3,
  });

  assert.equal(result.count, fixture.publicRecords.length);
  assert.equal(result.hash, fixture.binding.catalogSnapshotHash);
  assert.equal(result.canonicalCreates, 1);
  assert.equal(result.canonicalReplaces, 4);
  assert.equal(result.stagedCreates, fixture.publicRecords.length);
  const publicWrites = fixture.publicContainer.calls.filter((call) => (
    call.method === "createItem" || call.method === "replaceItem"
  ));
  assert.equal(publicWrites.at(-1).method, "replaceItem");
  assert.equal(publicWrites.at(-1).id, "active-snapshot");
  assert.equal(publicWrites.at(-1).options.ifMatch, fixture.binding.expectedActiveSnapshotEtag);
  assert(publicWrites.slice(0, -1).every((call) => call.method === "createItem"));
  assert.equal(result.replayed, false);
});

test("replays an already committed exact snapshot by verification without writes", async () => {
  const fixture = await publicationFixture();
  const first = await publishApprovedPlan({
    plan: fixture.plan,
    decisions: fixture.decisions,
    binding: fixture.binding,
    catalogContainer: fixture.catalogContainer,
    publicContainer: fixture.publicContainer,
    provenance: publicationProvenance,
    trustedRepository: fixture.trustedRepository,
  });
  fixture.catalogContainer.calls.length = 0;
  fixture.publicContainer.calls.length = 0;
  const marker = fixture.publicContainer.snapshot().find((document) => document.id === "active-snapshot");

  const replayed = await publishApprovedPlan({
    plan: fixture.plan,
    decisions: fixture.decisions,
    binding: { ...fixture.binding, expectedActiveSnapshotEtag: marker._etag },
    catalogContainer: fixture.catalogContainer,
    publicContainer: fixture.publicContainer,
    provenance: publicationProvenance,
    trustedRepository: fixture.trustedRepository,
  });

  assert.equal(replayed.replayed, true);
  assert.equal(replayed.hash, first.hash);
  assert.equal(replayed.canonicalCreates, 0);
  assert.equal(replayed.canonicalReplaces, 0);
  assert.equal(replayed.stagedCreates, 0);
  assert.equal(
    [...fixture.catalogContainer.calls, ...fixture.publicContainer.calls]
      .some((call) => call.method === "createItem" || call.method === "replaceItem"),
    false,
  );
});

test("accepts a publication create 409 only when the stored target is exactly equal", async () => {
  const fixture = await publicationFixture();
  fixture.catalogContainer.seed(publishTarget(fixture));
  fixture.catalogContainer.calls.length = 0;

  const result = await publishApprovedPlan({
    plan: fixture.plan,
    decisions: fixture.decisions,
    binding: fixture.binding,
    catalogContainer: fixture.catalogContainer,
    publicContainer: fixture.publicContainer,
    provenance: publicationProvenance,
    trustedRepository: fixture.trustedRepository,
  });

  assert.equal(result.canonicalCreates, 0);
  const publishCreateIndex = fixture.catalogContainer.calls.findIndex((call) => (
    call.method === "createItem" && call.document.id === "publish-item"
  ));
  assert.equal(fixture.catalogContainer.calls[publishCreateIndex + 1].method, "readItem");
});

test("rejects a publication create 409 when any stored target field differs", async () => {
  const fixture = await publicationFixture();
  fixture.catalogContainer.seed({
    ...publishTarget(fixture),
    title: "Conflicting publication",
  });

  await assert.rejects(
    publishApprovedPlan({
      plan: fixture.plan,
      decisions: fixture.decisions,
      binding: fixture.binding,
      catalogContainer: fixture.catalogContainer,
      publicContainer: fixture.publicContainer,
      provenance: publicationProvenance,
      trustedRepository: fixture.trustedRepository,
    }),
    (error) => error instanceof CosmosDomainError && error.code === "CREATE_CONFLICT",
  );
  assert.equal(
    fixture.publicContainer.calls.some((call) => call.method === "replaceItem"),
    false,
  );
});

test("rejects every stale canonical replace and leaves the active marker untouched", async () => {
  const fixture = await publicationFixture({ staleOperationType: "update" });

  await assert.rejects(
    publishApprovedPlan({
      plan: fixture.plan,
      decisions: fixture.decisions,
      binding: fixture.binding,
      catalogContainer: fixture.catalogContainer,
      publicContainer: fixture.publicContainer,
      provenance: publicationProvenance,
      trustedRepository: fixture.trustedRepository,
    }),
    (error) => error instanceof CosmosDomainError && error.code === "STALE_ETAG",
  );
  assert.equal(
    fixture.publicContainer.calls.some((call) => call.method === "replaceItem"),
    false,
  );
});

test("does not replace the marker when staged public count/hash verification fails", async () => {
  const fixture = await publicationFixture({ PublicContainer: TamperingPublicContainer });

  await assert.rejects(
    publishApprovedPlan({
      plan: fixture.plan,
      decisions: fixture.decisions,
      binding: fixture.binding,
      catalogContainer: fixture.catalogContainer,
      publicContainer: fixture.publicContainer,
      provenance: publicationProvenance,
      trustedRepository: fixture.trustedRepository,
    }),
    (error) => error instanceof CosmosDomainError && error.code === "PUBLIC_PROJECTION_PARITY_FAILED",
  );
  assert.equal(
    fixture.publicContainer.calls.some((call) => call.method === "replaceItem"),
    false,
  );
});

test("rejects a 412 from the active-marker commit", async () => {
  const fixture = await publicationFixture();
  fixture.publicContainer.failNext("replaceItem", 412);

  await assert.rejects(
    publishApprovedPlan({
      plan: fixture.plan,
      decisions: fixture.decisions,
      binding: fixture.binding,
      catalogContainer: fixture.catalogContainer,
      publicContainer: fixture.publicContainer,
      provenance: publicationProvenance,
      trustedRepository: fixture.trustedRepository,
    }),
    (error) => error instanceof CosmosDomainError && error.code === "STALE_ETAG",
  );
});

test("rejects a publication binding that is not tied to the exact decision set", async () => {
  const fixture = await publicationFixture();
  fixture.catalogContainer.calls.length = 0;

  await assert.rejects(
    publishApprovedPlan({
      plan: fixture.plan,
      decisions: fixture.decisions,
      binding: { ...fixture.binding, decisionHash: `sha256:${"0".repeat(64)}` },
      catalogContainer: fixture.catalogContainer,
      publicContainer: fixture.publicContainer,
      provenance: publicationProvenance,
      trustedRepository: fixture.trustedRepository,
    }),
    (error) => error instanceof CosmosDomainError && error.code === "PUBLICATION_BINDING_INVALID",
  );
  assert.equal(fixture.catalogContainer.calls.filter((call) => call.method !== "queryItems").length, 0);
});

test("live reads point-read the marker, query its exact snapshot, paginate stably, and expose marker ETag", async () => {
  const fixture = await publicationFixture();
  await publishApprovedPlan({
    plan: fixture.plan,
    decisions: fixture.decisions,
    binding: fixture.binding,
    catalogContainer: fixture.catalogContainer,
    publicContainer: fixture.publicContainer,
    provenance: publicationProvenance,
    trustedRepository: fixture.trustedRepository,
  });
  const staged = fixture.publicContainer.snapshot().find((document) => (
    document.type === "catalog-item" && document.snapshotId === fixture.binding.snapshotId
  ));
  fixture.publicContainer.seed({
    ...staged,
    id: `${staged.id}:retired`,
    catalogId: "hidden-retired",
    lifecycleStatus: "retired",
  });
  fixture.publicContainer.seed({
    ...staged,
    id: `${staged.id}:unpublished`,
    catalogId: "hidden-unpublished",
    publicationStatus: "unpublished",
  });
  fixture.publicContainer.seed({
    ...staged,
    id: `${staged.id}:other-snapshot`,
    catalogId: "hidden-other-snapshot",
    snapshotId: "snapshot-not-active",
  });
  fixture.publicContainer.calls.length = 0;

  const first = await queryLivePublicCatalog({
    publicContainer: fixture.publicContainer,
    pageSize: 3,
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.items.length, 3);
  assert(first.continuationToken);
  assert.equal(first.metadata.snapshotId, fixture.binding.snapshotId);
  assert.equal(first.metadata.catalogHash, fixture.binding.catalogSnapshotHash);
  assert.match(first.metadata.etag, /^"etag-[0-9]+"$/);
  assert.deepEqual(
    fixture.publicContainer.calls.slice(0, 2).map((call) => call.method),
    ["readItem", "queryItems"],
  );
  const queryCall = fixture.publicContainer.calls[1];
  assert.equal(queryCall.request.query, PUBLIC_SNAPSHOT_QUERY);
  assert.equal(
    queryCall.request.parameters.find(({ name }) => name === "@snapshotId").value,
    fixture.binding.snapshotId,
  );

  const second = await queryLivePublicCatalog({
    publicContainer: fixture.publicContainer,
    pageSize: 100,
    continuationToken: first.continuationToken,
  });
  assert.deepEqual(
    [...first.items, ...second.items].map((item) => item.id),
    fixture.publicRecords.map((item) => item.id),
  );
  assert([...first.items, ...second.items].every((item) => (
    !Object.keys(item).some((key) => key.startsWith("_")) &&
    !Object.hasOwn(item, "snapshotId") &&
    !Object.hasOwn(item, "operationId")
  )));

  const callsBeforeConditional = fixture.publicContainer.calls.length;
  const notModified = await queryLivePublicCatalog({
    publicContainer: fixture.publicContainer,
    ifNoneMatch: first.metadata.etag,
  });
  assert.equal(notModified.statusCode, 304);
  assert.deepEqual(notModified.items, []);
  assert.equal(fixture.publicContainer.calls.length, callsBeforeConditional + 1);
  assert.equal(fixture.publicContainer.calls.at(-1).method, "readItem");
});