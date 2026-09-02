import { isDeepStrictEqual } from "node:util";

import { CosmosCliError } from "./cli-runtime.mjs";
import { assertGalleryCatalog } from "./schemas.mjs";
import { hashCanonicalValue, validateCatalogChangePlan } from "../gallery-pipeline/build-catalog-change.mjs";
import { normalizeCandidate } from "../gallery-pipeline/normalize.mjs";
import {
  validateCatalogProposalReceipt,
  validateCatalogProposalReport,
} from "../gallery-pipeline/propose-catalog-changes.mjs";

const DISCOVERY_KEYS = Object.freeze([
  "candidateGates",
  "candidates",
  "completedAt",
  "evidence",
  "mode",
  "mutationPerformed",
  "rejected",
  "schemaVersion",
  "sources",
  "startedAt",
  "status",
  "summary",
].filter((key) => key !== "candidateGates"));
const GATE_KEYS = Object.freeze([
  "completedAt",
  "coverageStatus",
  "eligible",
  "mode",
  "mutationPerformed",
  "rejected",
  "schemaVersion",
  "startedAt",
  "status",
  "summary",
]);
const PROPOSAL_INPUT_NAMES = Object.freeze([
  "activeCatalog",
  "analysisSchema",
  "audit",
  "candidateGates",
  "discovery",
  "exemptions",
  "freshness",
  "health",
  "modelAnalysis",
  "modelAnalysisReceipt",
  "modelAnalysisVerification",
  "policy",
  "retired",
  "retirementProvenance",
  "upstreamArtifacts",
]);

function fail(message) {
  throw new CosmosCliError("PIPELINE_INPUT_INVALID", message);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  return value;
}

function exactKeys(value, expected, label) {
  object(value, label);
  if (!isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort())) {
    fail(`${label} keys do not match the exact contract.`);
  }
}

function array(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  return value;
}

function candidateId(candidate, label) {
  let normalized;
  try {
    normalized = normalizeCandidate(candidate);
  } catch (error) {
    fail(`${label} is invalid: ${error.message}`);
  }
  if (!isDeepStrictEqual(normalized, candidate)) fail(`${label} is not canonically normalized.`);
  return candidate.identityKey;
}

function requireCompleteDiscovery(discovery) {
  exactKeys(discovery, DISCOVERY_KEYS, "discovery");
  if (
    discovery.schemaVersion !== "1.0.0" ||
    discovery.mode !== "dry-run" ||
    discovery.mutationPerformed !== false ||
    discovery.status !== "complete"
  ) {
    fail("Discovery must be a complete, non-mutating v1 report.");
  }
  const candidates = array(discovery.candidates, "discovery.candidates");
  const rejected = array(discovery.rejected, "discovery.rejected");
  const sources = array(discovery.sources, "discovery.sources");
  array(discovery.evidence, "discovery.evidence");
  object(discovery.summary, "discovery.summary");
  if (
    discovery.summary.sources !== sources.length ||
    discovery.summary.succeededSources !== sources.length ||
    discovery.summary.skippedSources !== 0 ||
    discovery.summary.indeterminateSources !== 0 ||
    discovery.summary.candidates !== candidates.length ||
    discovery.summary.rejected !== rejected.length ||
    sources.some((source) => source?.queried !== true || source?.status !== "succeeded")
  ) {
    fail("Discovery summary and successful source coverage are inconsistent.");
  }
  const byId = new Map();
  candidates.forEach((candidate, index) => {
    const id = candidateId(candidate, `discovery.candidates[${index}]`);
    if (byId.has(id)) fail(`Discovery candidate ${id} is duplicated.`);
    byId.set(id, candidate);
  });
  return byId;
}

function gateCandidateId(entry, label) {
  if (entry?.candidate && typeof entry.candidate.identityKey === "string") return entry.candidate.identityKey;
  if (typeof entry?.candidateId === "string" && entry.candidateId) return entry.candidateId;
  fail(`${label} has no candidate identity.`);
}

export function validateCandidateCollectionInput(discovery, candidateGates) {
  const discoveryById = requireCompleteDiscovery(discovery);
  exactKeys(candidateGates, GATE_KEYS, "candidate gates");
  if (
    candidateGates.schemaVersion !== "2.0.0" ||
    candidateGates.mode !== "dry-run" ||
    candidateGates.mutationPerformed !== false ||
    candidateGates.status !== "complete" ||
    !["complete", "partial"].includes(candidateGates.coverageStatus)
  ) {
    fail("Candidate gates must be a complete, non-mutating v2 report.");
  }
  const eligible = array(candidateGates.eligible, "candidateGates.eligible");
  const rejected = array(candidateGates.rejected, "candidateGates.rejected");
  const summary = object(candidateGates.summary, "candidateGates.summary");
  if (
    summary.candidates !== discoveryById.size ||
    summary.selectedCandidates !== summary.candidates ||
    summary.executedCandidateChecks !== summary.selectedCandidates ||
    summary.executedAvailabilityChecks !== summary.availabilityChecks ||
    summary.deadlineExceededAvailabilityChecks !== 0 ||
    summary.eligible !== eligible.length ||
    summary.rejected !== rejected.length ||
    summary.eligible + summary.rejected !== summary.candidates ||
    ((summary.indeterminateAvailabilityChecks === 0) !== (candidateGates.coverageStatus === "complete"))
  ) {
    fail("Candidate gate coverage or summary is inconsistent.");
  }

  const gatedIds = [];
  const trustedCandidates = eligible.map((entry, index) => {
    exactKeys(entry, ["availability", "candidate", "deterministicGate"], `candidateGates.eligible[${index}]`);
    const id = candidateId(entry.candidate, `candidateGates.eligible[${index}].candidate`);
    if (!isDeepStrictEqual(discoveryById.get(id), entry.candidate)) {
      fail(`Eligible candidate ${id} does not match discovery.`);
    }
    if (
      entry.availability?.classification !== "healthy" ||
      !Number.isSafeInteger(entry.availability?.statusCode) ||
      entry.availability.statusCode < 200 ||
      entry.availability.statusCode >= 300 ||
      entry.availability.statusCode === 206 ||
      entry.availability.reasonCode !== null ||
      entry.deterministicGate?.candidateId !== id ||
      entry.deterministicGate?.provenance?.status !== "passed" ||
      entry.deterministicGate?.provenance?.trusted !== true ||
      entry.deterministicGate?.sourceAvailability?.status !== "healthy" ||
      entry.deterministicGate?.cosmosRelevance?.status !== "passed" ||
      entry.deterministicGate?.duplicateCheck?.status !== "passed" ||
      entry.deterministicGate?.duplicateCheck?.outcome !== "unique" ||
      entry.deterministicGate?.normalization?.status !== "passed" ||
      entry.deterministicGate?.normalization?.schemaVersion !== "1.0.0"
    ) {
      fail(`Eligible candidate ${id} did not pass every deterministic gate.`);
    }
    gatedIds.push(id);
    return structuredClone(entry.candidate);
  });
  rejected.forEach((entry, index) => gatedIds.push(gateCandidateId(entry, `candidateGates.rejected[${index}]`)));
  const discoveryIds = [...discoveryById.keys()].sort();
  if (new Set(gatedIds).size !== gatedIds.length || !isDeepStrictEqual([...gatedIds].sort(), discoveryIds)) {
    fail("Candidate gates do not partition discovery candidates exactly once.");
  }
  return Object.freeze(trustedCandidates);
}

function receiptInput(receipt, name) {
  const matches = receipt.inputs.filter((entry) => entry.name === name);
  if (matches.length !== 1 || matches[0].provided !== true) {
    fail(`Proposal receipt must contain exactly one provided ${name} input.`);
  }
  return matches[0];
}

function receiptOutput(receipt, outputPath) {
  const matches = receipt.outputs.filter((entry) => entry.path === outputPath);
  if (matches.length !== 1) fail(`Proposal receipt must contain exactly one ${outputPath} output.`);
  return matches[0];
}

export function candidateIdForOperation(operation) {
  const analysisReferences = operation.evidenceReferences?.filter((entry) => entry.kind === "analysis") ?? [];
  const candidateReferences = operation.evidenceReferences?.filter((entry) => entry.kind === "candidate") ?? [];
  if (analysisReferences.length > 1 || candidateReferences.length > 1) {
    fail(`Operation ${operation.operationId} has ambiguous candidate provenance.`);
  }
  return analysisReferences[0]?.id ?? candidateReferences[0]?.id ?? operation.targetId;
}

export function validateProposalDecisionInput({ report, receipt, plan, proposedCatalog, artifact }) {
  validateCatalogProposalReport(report);
  validateCatalogProposalReceipt(receipt);
  assertGalleryCatalog(proposedCatalog);
  validateCatalogChangePlan(plan, { trustedRepository: artifact.repository });
  const expectedRunId = `proposal-${artifact.runId}-${artifact.runAttempt}`;
  if (
    report.status !== "complete" ||
    report.stage.status !== "completed" ||
    report.runId !== expectedRunId ||
    receipt.runId !== expectedRunId ||
    report.inputFingerprint !== receipt.inputFingerprint ||
    receipt.reportFingerprint !== hashCanonicalValue(report) ||
    receipt.trustedRepository !== artifact.repository ||
    receipt.trustedRef !== artifact.sourceRef ||
    receipt.trustedSha !== artifact.sourceSha
  ) {
    fail("Proposal report, receipt, and trusted producer context are not exactly bound.");
  }
  const manifest = report.plans[0];
  if (
    !manifest ||
    manifest.batchNumber !== 1 ||
    manifest.path !== "plans/catalog-change-plan-001.json" ||
    manifest.runId !== plan.runId ||
    plan.runId !== `${report.runId}-batch-001` ||
    manifest.inputFingerprint !== plan.inputFingerprint ||
    manifest.operationCount !== plan.operations.length ||
    !isDeepStrictEqual(manifest.operationIds, plan.operations.map((operation) => operation.operationId)) ||
    report.summary.plans !== report.plans.length ||
    report.summary.operations !== report.plans.reduce((count, entry) => count + entry.operationCount, 0)
  ) {
    fail("The first proposal plan does not match its exact report manifest.");
  }
  const inputNames = receipt.inputs.map((entry) => entry.name).sort();
  if (
    new Set(inputNames).size !== inputNames.length ||
    !isDeepStrictEqual(inputNames, [...PROPOSAL_INPUT_NAMES].sort())
  ) {
    fail("Proposal receipt input member set is not exact.");
  }
  const expectedOutputPaths = [
    "proposal-report.json",
    ...report.plans.map((entry) => entry.path),
    "proposed/templates.json",
    "proposed/gallery-health.json",
    "proposed/retired-templates.json",
    "proposed/catalog-audit.json",
  ].sort();
  const outputPaths = receipt.outputs.map((entry) => entry.path).sort();
  if (
    new Set(outputPaths).size !== outputPaths.length ||
    !isDeepStrictEqual(outputPaths, expectedOutputPaths)
  ) {
    fail("Proposal receipt output member set is not exact.");
  }
  const upstreamNames = receipt.upstreamArtifacts.map((entry) => entry.name).sort();
  if (!isDeepStrictEqual(upstreamNames, ["discovery", "freshness", "health", "modelAnalysis"])) {
    fail("Proposal receipt must bind the exact trusted model-analysis producer set.");
  }
  if (receiptOutput(receipt, manifest.path).fingerprint !== hashCanonicalValue(plan)) {
    fail("Proposal receipt does not bind the first plan content.");
  }
  if (receiptOutput(receipt, "proposed/templates.json").fingerprint !== hashCanonicalValue(proposedCatalog)) {
    fail("Proposal receipt does not bind the proposed catalog content.");
  }
  const policyInput = receiptInput(receipt, "policy");
  const modelInput = receiptInput(receipt, "modelAnalysis");
  receiptInput(receipt, "modelAnalysisReceipt");
  return Object.freeze({
    policyHash: `sha256:${policyInput.fingerprint}`,
    modelHash: `sha256:${modelInput.fingerprint}`,
  });
}