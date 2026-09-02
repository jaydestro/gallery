#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  artifactProvenanceForDocument,
  validateArtifactProvenance,
  verifyArtifactMember,
} from "./artifact-contract.mjs";
import { appendPipelineReceipt, appendReviewCandidate } from "./append-records.mjs";
import { canonicalEqual, canonicalHash } from "./canonical.mjs";
import {
  CosmosCliError,
  loadCosmosConfiguration,
  openCosmosContainers,
  parseCliArguments,
  readJsonFile,
  runCli,
} from "./cli-runtime.mjs";
import { createPipelineReceipt, createReviewCandidate } from "./documents.mjs";
import { validateCandidateCollectionInput } from "./pipeline-contracts.mjs";

const ROOT_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONTAINERS = Object.freeze({
  candidates: Object.freeze({
    environmentName: "AZURE_COSMOS_CANDIDATE_CONTAINER",
    expected: "review-candidates",
  }),
  audit: Object.freeze({
    environmentName: "AZURE_COSMOS_AUDIT_CONTAINER",
    expected: "pipeline-records",
  }),
});
const ALLOWED_ARGUMENTS = new Set(["artifact", "candidate-gates", "discovery", "dry-run", "verify"]);

function validateOptions(options) {
  for (const name of Object.keys(options)) {
    if (!ALLOWED_ARGUMENTS.has(name)) throw new CosmosCliError("CLI_ARGUMENT_INVALID", `Unknown argument: --${name}`);
  }
  for (const name of ["artifact", "candidate-gates", "discovery"]) {
    if (!options[name]) throw new CosmosCliError("CLI_ARGUMENT_INVALID", `--${name} is required.`);
  }
}

function preparedCollection({ artifact, discovery, candidateGates }) {
  const candidates = validateCandidateCollectionInput(discovery, candidateGates);
  const provenance = artifactProvenanceForDocument(artifact);
  const runKey = `discovery-${artifact.runId}-${artifact.runAttempt}`;
  const documents = candidates.map((candidate) => createReviewCandidate({
    runKey,
    candidate,
    provenance,
    collectedAt: discovery.completedAt,
  }));
  const operationId = `${runKey}:collect`;
  const receipt = createPipelineReceipt({
    runKey,
    operationId,
    stage: "collect",
    status: documents.length === 0 ? "no-op" : "completed",
    recordedAt: discovery.completedAt,
    inputHash: canonicalHash({ artifact, discovery, candidateGates }),
    outputHash: canonicalHash(documents),
    provenance,
  });
  return Object.freeze({ candidates, documents, operationId, provenance, receipt, runKey });
}

async function verifyStored(container, documents, partitionKey) {
  for (const document of documents) {
    const stored = await container.readItem(document.id, { partitionKey });
    if (!canonicalEqual(stored.resource, document)) {
      throw new CosmosCliError("COSMOS_VERIFY_FAILED", `Stored item ${document.id} does not match its trusted input.`);
    }
  }
}

export async function executeCandidatePersistence({
  argv,
  environment = process.env,
  rootDirectory = ROOT_DIRECTORY,
  openContainers = openCosmosContainers,
}) {
  const options = parseCliArguments(argv);
  validateOptions(options);
  const configuration = loadCosmosConfiguration({ environment, containers: CONTAINERS });
  const snapshots = await Promise.all([
    readJsonFile(path.resolve(rootDirectory, options.artifact), "discovery artifact provenance"),
    readJsonFile(path.resolve(rootDirectory, options.discovery), "discovery report"),
    readJsonFile(path.resolve(rootDirectory, options["candidate-gates"]), "candidate gate report"),
  ]);
  const artifact = validateArtifactProvenance(snapshots[0].value, "discovery");
  verifyArtifactMember(artifact, "discovery.json", snapshots[1].bytes);
  verifyArtifactMember(artifact, "candidate-gates.json", snapshots[2].bytes);
  const prepared = preparedCollection({
    artifact,
    discovery: snapshots[1].value,
    candidateGates: snapshots[2].value,
  });
  const summary = {
    mode: options["dry-run"] ? "dry-run" : options.verify ? "verify" : "write",
    runKey: prepared.runKey,
    candidateCount: prepared.documents.length,
    candidateSetHash: canonicalHash(prepared.documents),
    receiptHash: canonicalHash(prepared.receipt),
  };
  if (options["dry-run"]) return Object.freeze(summary);

  const { containers } = openContainers(configuration);
  if (options.verify) {
    await verifyStored(containers.candidates, prepared.documents, prepared.runKey);
    await verifyStored(containers.audit, [prepared.receipt], prepared.runKey);
    return Object.freeze(summary);
  }
  for (const candidate of prepared.candidates) {
    await appendReviewCandidate({
      candidateContainer: containers.candidates,
      runKey: prepared.runKey,
      candidate,
      provenance: prepared.provenance,
      collectedAt: snapshots[1].value.completedAt,
    });
  }
  await appendPipelineReceipt({
    receiptContainer: containers.audit,
    runKey: prepared.runKey,
    operationId: prepared.operationId,
    stage: "collect",
    status: prepared.documents.length === 0 ? "no-op" : "completed",
    recordedAt: snapshots[1].value.completedAt,
    inputHash: prepared.receipt.inputHash,
    outputHash: prepared.receipt.outputHash,
    provenance: prepared.provenance,
  });
  return Object.freeze(summary);
}

export async function main(argv = process.argv.slice(2)) {
  return runCli(() => executeCandidatePersistence({ argv }), {
    sensitiveValues: [process.env.AZURE_COSMOS_ENDPOINT],
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}