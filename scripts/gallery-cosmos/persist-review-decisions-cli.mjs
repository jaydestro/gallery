#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  artifactProvenanceForDocument,
  validateArtifactProvenance,
  verifyArtifactMember,
} from "./artifact-contract.mjs";
import { appendPipelineReceipt, appendReviewDecision } from "./append-records.mjs";
import {
  canonicalEqual,
  canonicalHash,
  galleryRecordHash,
  gallerySnapshotFromDocuments,
  toGalleryRecord,
} from "./canonical.mjs";
import { CATALOG_PARTITION, readCanonicalCatalog } from "./container-operations.mjs";
import {
  CosmosCliError,
  loadCosmosConfiguration,
  openCosmosContainers,
  parseCliArguments,
  readJsonFile,
  runCli,
} from "./cli-runtime.mjs";
import { createPipelineReceipt, createReviewDecision } from "./documents.mjs";
import {
  candidateIdForOperation,
  validateProposalDecisionInput,
} from "./pipeline-contracts.mjs";
import { assertDocument } from "./schemas.mjs";

const ROOT_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONTAINERS = Object.freeze({
  catalog: Object.freeze({
    environmentName: "AZURE_COSMOS_CATALOG_CONTAINER",
    expected: "catalog-items",
  }),
  decisions: Object.freeze({
    environmentName: "AZURE_COSMOS_DECISION_CONTAINER",
    expected: "review-decisions",
  }),
  audit: Object.freeze({
    environmentName: "AZURE_COSMOS_AUDIT_CONTAINER",
    expected: "pipeline-records",
  }),
});
const ALLOWED_ARGUMENTS = new Set([
  "artifact",
  "dry-run",
  "plan",
  "proposal-receipt",
  "proposal-report",
  "proposed-catalog",
  "verify",
]);

function validateOptions(options) {
  for (const name of Object.keys(options)) {
    if (!ALLOWED_ARGUMENTS.has(name)) throw new CosmosCliError("CLI_ARGUMENT_INVALID", `Unknown argument: --${name}`);
  }
  for (const name of ["artifact", "plan", "proposal-receipt", "proposal-report", "proposed-catalog"]) {
    if (!options[name]) throw new CosmosCliError("CLI_ARGUMENT_INVALID", `--${name} is required.`);
  }
}

function projectCatalog(currentDocuments, plan) {
  const byId = new Map(currentDocuments.map((document) => [document.id, document]));
  const appendIds = new Set(plan.operations
    .filter((operation) => ["publish", "restore"].includes(operation.type))
    .map((operation) => operation.targetId));
  let nextDisplayOrder = currentDocuments
    .filter((document) => !appendIds.has(document.id))
    .reduce((maximum, document) => Math.max(maximum, document.displayOrder), -1);
  for (const operation of plan.operations) {
    const current = byId.get(operation.targetId);
    if (operation.type !== "publish" && (!current || !canonicalEqual(toGalleryRecord(current), operation.before))) {
      throw new CosmosCliError("CANONICAL_STATE_INVALID", `Before state for ${operation.targetId} does not match the proposal.`);
    }
    const displayOrder = ["publish", "restore"].includes(operation.type)
      ? ++nextDisplayOrder
      : current.displayOrder;
    byId.set(operation.targetId, {
      ...operation.after,
      type: "catalog-item",
      catalogPartition: CATALOG_PARTITION,
      publicationStatus: "published",
      displayOrder,
    });
  }
  return gallerySnapshotFromDocuments([...byId.values()], { publicOnly: true });
}

function prepareDecisions({ plan, currentDocuments, policyHash, modelHash, provenance }) {
  const currentById = new Map(currentDocuments.map((document) => [document.id, document]));
  const snapshot = projectCatalog(currentDocuments, plan);
  const decisions = plan.operations.map((operation) => {
    const current = currentById.get(operation.targetId);
    const expectedCatalogEtag = operation.type === "publish" ? null : current?._etag;
    if (operation.type !== "publish" && !expectedCatalogEtag) {
      throw new CosmosCliError("CANONICAL_STATE_INVALID", `Canonical item ${operation.targetId} has no ETag.`);
    }
    return createReviewDecision({
      runKey: plan.runId,
      candidateId: candidateIdForOperation(operation),
      operationId: operation.operationId,
      status: "approved",
      recommendation: operation.type,
      reasonCodes: operation.reasonCodes,
      decidedAt: plan.generatedAt,
      catalogItemHash: galleryRecordHash(operation.after),
      catalogSnapshotHash: snapshot.hash,
      policyHash,
      modelHash,
      expectedCatalogEtag,
      provenance,
    });
  });
  const receipt = createPipelineReceipt({
    runKey: plan.runId,
    operationId: `${plan.runId}:review`,
    stage: "review",
    status: decisions.length === 0 ? "no-op" : "completed",
    recordedAt: plan.generatedAt,
    inputHash: canonicalHash({ plan, policyHash, modelHash, provenance }),
    outputHash: canonicalHash(decisions),
    policyHash,
    modelHash,
    provenance,
  });
  return Object.freeze({ decisions, receipt, snapshot });
}

async function verifyStored(container, documents, partitionKey) {
  for (const document of documents) {
    const stored = await container.readItem(document.id, { partitionKey });
    if (!canonicalEqual(stored.resource, document)) {
      throw new CosmosCliError("COSMOS_VERIFY_FAILED", `Stored item ${document.id} does not match its approved input.`);
    }
  }
}

export async function executeReviewPersistence({
  argv,
  environment = process.env,
  rootDirectory = ROOT_DIRECTORY,
  openContainers = openCosmosContainers,
}) {
  const options = parseCliArguments(argv);
  validateOptions(options);
  const configuration = loadCosmosConfiguration({ environment, containers: CONTAINERS });
  const files = Object.freeze({
    artifact: options.artifact,
    report: options["proposal-report"],
    receipt: options["proposal-receipt"],
    plan: options.plan,
    proposedCatalog: options["proposed-catalog"],
  });
  const snapshots = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, filePath]) => [
    name,
    await readJsonFile(path.resolve(rootDirectory, filePath), name),
  ])));
  const artifact = validateArtifactProvenance(snapshots.artifact.value, "proposal");
  for (const [name, memberPath] of [
    ["report", "proposal-report.json"],
    ["receipt", "proposal-receipt.json"],
    ["plan", "plans/catalog-change-plan-001.json"],
    ["proposedCatalog", "proposed/templates.json"],
  ]) verifyArtifactMember(artifact, memberPath, snapshots[name].bytes);
  const hashes = validateProposalDecisionInput({
    artifact,
    report: snapshots.report.value,
    receipt: snapshots.receipt.value,
    plan: snapshots.plan.value,
    proposedCatalog: snapshots.proposedCatalog.value,
  });
  const provenance = artifactProvenanceForDocument(artifact);
  const baseSummary = {
    mode: options["dry-run"] ? "dry-run" : options.verify ? "verify" : "write",
    runKey: snapshots.plan.value.runId,
    operationCount: snapshots.plan.value.operations.length,
    planHash: canonicalHash(snapshots.plan.value),
    policyHash: hashes.policyHash,
    modelHash: hashes.modelHash,
  };
  if (options["dry-run"]) return Object.freeze(baseSummary);

  const { containers } = openContainers(configuration);
  const currentDocuments = await readCanonicalCatalog(containers.catalog);
  currentDocuments.forEach((document) => assertDocument("catalogItem", document));
  const prepared = prepareDecisions({
    plan: snapshots.plan.value,
    currentDocuments,
    policyHash: hashes.policyHash,
    modelHash: hashes.modelHash,
    provenance,
  });
  const summary = Object.freeze({
    ...baseSummary,
    decisionCount: prepared.decisions.length,
    decisionSetHash: canonicalHash(prepared.decisions),
    catalogSnapshotHash: prepared.snapshot.hash,
    receiptHash: canonicalHash(prepared.receipt),
  });
  if (options.verify) {
    await verifyStored(containers.decisions, prepared.decisions, snapshots.plan.value.runId);
    await verifyStored(containers.audit, [prepared.receipt], snapshots.plan.value.runId);
    return summary;
  }
  for (const decision of prepared.decisions) {
    await appendReviewDecision({
      decisionContainer: containers.decisions,
      runKey: decision.runKey,
      candidateId: decision.candidateId,
      operationId: decision.operationId,
      status: decision.status,
      recommendation: decision.recommendation,
      reasonCodes: decision.reasonCodes,
      decidedAt: decision.decidedAt,
      catalogItemHash: decision.catalogItemHash,
      catalogSnapshotHash: decision.catalogSnapshotHash,
      policyHash: decision.policyHash,
      modelHash: decision.modelHash,
      expectedCatalogEtag: decision.expectedCatalogEtag,
      provenance: decision.provenance,
    });
  }
  await appendPipelineReceipt({
    receiptContainer: containers.audit,
    runKey: prepared.receipt.runKey,
    operationId: prepared.receipt.operationId,
    stage: prepared.receipt.stage,
    status: prepared.receipt.status,
    recordedAt: prepared.receipt.recordedAt,
    inputHash: prepared.receipt.inputHash,
    outputHash: prepared.receipt.outputHash,
    policyHash: prepared.receipt.policyHash,
    modelHash: prepared.receipt.modelHash,
    provenance: prepared.receipt.provenance,
  });
  return summary;
}

export async function main(argv = process.argv.slice(2)) {
  return runCli(() => executeReviewPersistence({ argv }), {
    sensitiveValues: [process.env.AZURE_COSMOS_ENDPOINT],
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}