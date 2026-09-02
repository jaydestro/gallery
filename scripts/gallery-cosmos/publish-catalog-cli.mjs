#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  artifactProvenanceForDocument,
  validateArtifactProvenance,
  verifyArtifactMember,
} from "./artifact-contract.mjs";
import { canonicalEqual, canonicalHash } from "./canonical.mjs";
import {
  CATALOG_PARTITION,
  CosmosDomainError,
  createItemOrMatch,
  responseEtag,
} from "./container-operations.mjs";
import {
  CosmosCliError,
  loadCosmosConfiguration,
  openCosmosContainers,
  parseCliArguments,
  readJsonFile,
  runCli,
} from "./cli-runtime.mjs";
import {
  createPipelineReceipt,
  reviewDecisionId,
} from "./documents.mjs";
import {
  candidateIdForOperation,
  validateProposalDecisionInput,
} from "./pipeline-contracts.mjs";
import {
  decisionSetHash,
  publicationOperationId,
  publishApprovedPlan,
} from "./publish-catalog.mjs";
import { assertDocument } from "./schemas.mjs";

const ROOT_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONTAINERS = Object.freeze({
  catalog: Object.freeze({
    environmentName: "AZURE_COSMOS_CATALOG_CONTAINER",
    expected: "catalog-items",
  }),
  public: Object.freeze({
    environmentName: "AZURE_COSMOS_PUBLIC_CONTAINER",
    expected: "public-catalog",
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

async function readDecisions(decisionContainer, plan) {
  const decisions = [];
  for (const operation of plan.operations) {
    const candidateId = candidateIdForOperation(operation);
    const id = reviewDecisionId({ runKey: plan.runId, candidateId, operationId: operation.operationId });
    const response = await decisionContainer.readItem(id, { partitionKey: plan.runId });
    assertDocument("reviewDecision", response.resource);
    decisions.push(response.resource);
  }
  return decisions;
}

function publicationBinding(plan, decisions, marker) {
  const snapshotHashes = new Set(decisions.map((decision) => decision.catalogSnapshotHash));
  const policyHashes = new Set(decisions.map((decision) => decision.policyHash));
  const modelHashes = new Set(decisions.map((decision) => decision.modelHash));
  if (snapshotHashes.size !== 1 || policyHashes.size !== 1 || modelHashes.size !== 1) {
    throw new CosmosCliError("DECISION_SET_INVALID", "Review decisions do not share one catalog, policy, and model binding.");
  }
  const decisionHash = decisionSetHash(decisions);
  const snapshotId = `snapshot-${plan.runId}-${decisionHash.slice(7, 23)}`;
  return Object.freeze({
    snapshotId,
    decisionHash,
    catalogSnapshotHash: [...snapshotHashes][0],
    policyHash: [...policyHashes][0],
    modelHash: [...modelHashes][0],
    operationId: publicationOperationId(plan, snapshotId),
    expectedActiveSnapshotEtag: responseEtag(marker),
    publishedAt: plan.generatedAt,
  });
}

function publicationReceipt({ plan, decisions, binding, provenance, result }) {
  return createPipelineReceipt({
    runKey: plan.runId,
    operationId: binding.operationId,
    stage: "publish",
    status: "completed",
    recordedAt: plan.generatedAt,
    inputHash: canonicalHash({
      plan,
      decisionSetHash: binding.decisionHash,
      artifactDigest: provenance.artifactDigest,
    }),
    outputHash: canonicalHash({
      snapshotId: result.snapshotId,
      count: result.count,
      hash: result.hash,
    }),
    policyHash: binding.policyHash,
    modelHash: binding.modelHash,
    provenance,
  });
}

export async function executeCatalogPublication({
  argv,
  environment = process.env,
  rootDirectory = ROOT_DIRECTORY,
  openContainers = openCosmosContainers,
  publishPlan = publishApprovedPlan,
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
  const plan = snapshots.plan.value;
  const provenance = artifactProvenanceForDocument(artifact);
  const baseSummary = {
    mode: options["dry-run"] ? "dry-run" : options.verify ? "verify" : "write",
    runKey: plan.runId,
    operationCount: plan.operations.length,
    planHash: canonicalHash(plan),
    policyHash: hashes.policyHash,
    modelHash: hashes.modelHash,
  };
  if (options["dry-run"]) return Object.freeze(baseSummary);

  const { containers } = openContainers(configuration);
  const decisions = await readDecisions(containers.decisions, plan);
  const marker = await containers.public.readItem("active-snapshot", { partitionKey: CATALOG_PARTITION });
  assertDocument("publicCatalog", marker.resource);
  if (!responseEtag(marker)) throw new CosmosDomainError("ACTIVE_MARKER_INVALID", "The active snapshot marker has no ETag.");
  const binding = publicationBinding(plan, decisions, marker);
  if (options.verify && (
    marker.resource.type !== "active-snapshot" ||
    marker.resource.snapshotId !== binding.snapshotId ||
    marker.resource.operationId !== binding.operationId
  )) {
    throw new CosmosCliError("COSMOS_VERIFY_FAILED", "The approved publication snapshot is not active.");
  }
  const result = await publishPlan({
    plan,
    decisions,
    binding,
    catalogContainer: containers.catalog,
    publicContainer: containers.public,
    provenance,
    trustedRepository: artifact.repository,
  });
  const receipt = publicationReceipt({ plan, decisions, binding, provenance, result });
  if (options.verify) {
    const storedReceipt = await containers.audit.readItem(receipt.id, { partitionKey: plan.runId });
    if (!canonicalEqual(storedReceipt.resource, receipt)) {
      throw new CosmosCliError("COSMOS_VERIFY_FAILED", "Stored publication receipt does not match the approved publication.");
    }
  } else {
    await createItemOrMatch(containers.audit, receipt, { partitionKey: plan.runId });
  }
  return Object.freeze({
    ...baseSummary,
    snapshotId: result.snapshotId,
    count: result.count,
    hash: result.hash,
    replayed: result.replayed,
    decisionSetHash: binding.decisionHash,
    receiptHash: canonicalHash(receipt),
  });
}

export async function main(argv = process.argv.slice(2)) {
  return runCli(() => executeCatalogPublication({ argv }), {
    sensitiveValues: [process.env.AZURE_COSMOS_ENDPOINT],
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}