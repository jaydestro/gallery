#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import { ANALYSIS_SYSTEM_INSTRUCTIONS, AiAnalysisError } from "./analyze-content.mjs";
import {
  azureEndpointOrigin,
  createAzureOpenAIClient,
  runAiAnalysis,
} from "./ai-analysis.mjs";
import { hashCanonicalValue } from "./build-catalog-change.mjs";
import { GROUNDING_SYSTEM_INSTRUCTIONS } from "./verify-summary.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "../..");
const REPORT_VERSION = "2.0.0";
const CANDIDATE_GATE_SCHEMA_VERSION = "2.0.0";
const WORKFLOW_PATH = ".github/workflows/analyze-gallery-candidates.yml";
const DISCOVERY_WORKFLOW_PATH = ".github/workflows/discover-content.yml";
const RESPONSES_API_VERSION = "v1";
const CHAT_API_VERSION = "2024-10-21";
const MAI_CHAT_API_VERSION = "v1";
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const POSITIVE_ID_PATTERN = /^[1-9][0-9]*$/;
const DEFAULT_PATHS = Object.freeze({
  discovery: path.join("gallery-reports", "discovery.json"),
  candidateGates: path.join("gallery-reports", "candidate-gates.json"),
  activeCatalog: path.join("static", "templates.json"),
  retiredCatalog: path.join("static", "retired-templates.json"),
  policy: path.join(".github", "gallery-pipeline", "policy.json"),
  analysisSchema: path.join(".github", "gallery-pipeline", "analysis.schema.json"),
  outputDirectory: path.join("artifacts", "candidate-analysis"),
});

export class CandidateAnalysisError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CandidateAnalysisError";
    this.code = code;
    this.details = details;
  }
}

function inputError(message, details = {}) {
  return new CandidateAnalysisError("CANDIDATE_ANALYSIS_INPUT_INVALID", message, details);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalHash(value) {
  return `sha256:${hashCanonicalValue(value)}`;
}

function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw inputError(`${name} must be an object.`);
  }
  return value;
}

function requireString(value, name, pattern) {
  if (typeof value !== "string" || value.trim() === "") {
    throw inputError(`${name} must be a non-empty string.`);
  }
  const normalized = value.trim();
  if (pattern && !pattern.test(normalized)) throw inputError(`${name} has an invalid format.`);
  return normalized;
}

function requireInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw inputError(`${name} must be a positive integer.`);
  return value;
}

function requireNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw inputError(`${name} must be a non-negative integer.`);
  }
  return value;
}

function exactKeys(value, name, keys) {
  requireObject(value, name);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (!isDeepStrictEqual(actual, expected)) {
    throw inputError(`${name} must contain exactly: ${expected.join(", ")}.`);
  }
}

function requireCompleteReport(value, name) {
  requireObject(value, name);
  if (value.status !== "complete") throw inputError(`${name}.status must be complete.`);
  if (value.mode !== "dry-run" || value.mutationPerformed !== false) {
    throw inputError(`${name} must be a non-mutating dry-run report.`);
  }
  return value;
}

function requireCompleteCandidateGates(value) {
  requireCompleteReport(value, "candidate gates");
  if (value.schemaVersion !== CANDIDATE_GATE_SCHEMA_VERSION) {
    throw inputError(`candidate gates.schemaVersion must be ${CANDIDATE_GATE_SCHEMA_VERSION}.`);
  }
  if (!["complete", "partial"].includes(value.coverageStatus)) {
    throw inputError("candidate gates.coverageStatus must be complete or partial.");
  }
  const summary = requireObject(value.summary, "candidate gates.summary");
  const candidates = requireNonNegativeInteger(summary.candidates, "candidate gates.summary.candidates");
  const selectedCandidates = requireNonNegativeInteger(
    summary.selectedCandidates,
    "candidate gates.summary.selectedCandidates",
  );
  const executedCandidateChecks = requireNonNegativeInteger(
    summary.executedCandidateChecks,
    "candidate gates.summary.executedCandidateChecks",
  );
  const availabilityChecks = requireNonNegativeInteger(
    summary.availabilityChecks,
    "candidate gates.summary.availabilityChecks",
  );
  const executedAvailabilityChecks = requireNonNegativeInteger(
    summary.executedAvailabilityChecks,
    "candidate gates.summary.executedAvailabilityChecks",
  );
  const indeterminateAvailabilityChecks = requireNonNegativeInteger(
    summary.indeterminateAvailabilityChecks,
    "candidate gates.summary.indeterminateAvailabilityChecks",
  );
  const deadlineExceededAvailabilityChecks = requireNonNegativeInteger(
    summary.deadlineExceededAvailabilityChecks,
    "candidate gates.summary.deadlineExceededAvailabilityChecks",
  );
  if (
    selectedCandidates > candidates ||
    executedCandidateChecks !== selectedCandidates ||
    executedAvailabilityChecks !== availabilityChecks ||
    indeterminateAvailabilityChecks > availabilityChecks ||
    deadlineExceededAvailabilityChecks !== 0
  ) {
    throw inputError("candidate gates execution summary is incomplete or inconsistent.");
  }
  const expectedCoverageStatus = (
    selectedCandidates === candidates && indeterminateAvailabilityChecks === 0
  ) ? "complete" : "partial";
  if (value.coverageStatus !== expectedCoverageStatus) {
    throw inputError("candidate gates coverageStatus is inconsistent with its summary.");
  }
  return value;
}

function catalogRecords(activeCatalog, retiredCatalog) {
  if (!Array.isArray(activeCatalog)) throw inputError("active catalog must be an array.");
  requireObject(retiredCatalog, "retired catalog");
  if (!Array.isArray(retiredCatalog.entries)) {
    throw inputError("retired catalog must contain an entries array.");
  }
  return [
    ...activeCatalog,
    ...retiredCatalog.entries.map((entry) => entry?.record ?? entry),
  ];
}

function requireEnabledPolicy(policy) {
  requireObject(policy, "policy");
  const flags = policy.automation?.ai;
  if (!flags || Object.keys(flags).length === 0 || Object.values(flags).some((value) => value !== true)) {
    throw new CandidateAnalysisError(
      "AI_POLICY_DISABLED",
      "Every AI automation policy flag must be enabled for live candidate analysis.",
    );
  }
}

function discoveryCandidates(discovery) {
  if (!Array.isArray(discovery.candidates)) throw inputError("discovery.candidates must be an array.");
  const byId = new Map();
  for (const candidate of discovery.candidates) {
    const candidateId = requireString(candidate?.identityKey, "discovery candidate identityKey");
    if (byId.has(candidateId)) throw inputError(`discovery contains duplicate candidate ${candidateId}.`);
    byId.set(candidateId, candidate);
  }
  return byId;
}

function eligibleCandidates(discovery, candidateGates) {
  const discoveryById = discoveryCandidates(discovery);
  if (!Array.isArray(candidateGates.eligible)) {
    throw inputError("candidateGates.eligible must be an array.");
  }
  if (!Array.isArray(candidateGates.rejected)) {
    throw inputError("candidateGates.rejected must be an array.");
  }
  const entries = candidateGates.eligible.map((entry, index) => {
    exactKeys(
      entry,
      `candidateGates.eligible[${index}]`,
      ["availability", "candidate", "deterministicGate"],
    );
    const candidateId = requireString(
      entry.candidate?.identityKey,
      `candidateGates.eligible[${index}].candidate.identityKey`,
    );
    if (!isDeepStrictEqual(entry.candidate, discoveryById.get(candidateId))) {
      throw inputError(`Eligible candidate ${candidateId} is not byte-for-byte bound to discovery.`);
    }
    if (
      entry.availability?.classification !== "healthy" ||
      !Number.isInteger(entry.availability?.statusCode) ||
      entry.availability.statusCode < 200 ||
      entry.availability.statusCode >= 300 ||
      entry.availability.statusCode === 206 ||
      entry.availability.reasonCode !== null
    ) {
      throw inputError(`Eligible candidate ${candidateId} must have complete healthy availability.`);
    }
    return { candidateId, ...entry };
  }).sort((left, right) => left.candidateId.localeCompare(right.candidateId));

  const eligibleIds = entries.map((entry) => entry.candidateId);
  if (new Set(eligibleIds).size !== eligibleIds.length) {
    throw inputError("candidateGates.eligible contains duplicate candidate IDs.");
  }
  if (candidateGates.summary?.eligible !== entries.length) {
    throw inputError("candidate gate eligible summary does not match the eligible set.");
  }
  const rejectedIds = candidateGates.rejected.map((entry, index) => requireString(
    entry?.candidateId,
    `candidateGates.rejected[${index}].candidateId`,
  ));
  if (
    new Set(rejectedIds).size !== rejectedIds.length ||
    candidateGates.summary?.rejected !== rejectedIds.length ||
    candidateGates.summary?.candidates !== discoveryById.size
  ) {
    throw inputError("candidate gate rejected summary or candidate IDs are inconsistent.");
  }
  const gatedIds = [...eligibleIds, ...rejectedIds].sort((left, right) => left.localeCompare(right));
  const discoveryIds = [...discoveryById.keys()].sort((left, right) => left.localeCompare(right));
  if (!isDeepStrictEqual(gatedIds, discoveryIds)) {
    throw inputError("candidate gates must partition the discovery candidates exactly once.");
  }
  return entries;
}

function rejectedLedger(candidateGates) {
  const entries = structuredClone(candidateGates.rejected);
  return {
    count: entries.length,
    entries,
    hash: canonicalHash(entries),
  };
}

function validateDiscoveryArtifact(value, provenance) {
  exactKeys(value, "source discovery artifact", [
    "artifactId",
    "artifactName",
    "digest",
    "name",
    "repository",
    "runAttempt",
    "runId",
    "sourceRef",
    "sourceSha",
    "workflowId",
    "workflowPath",
  ]);
  if (value.name !== "discovery") throw inputError("source discovery artifact name must be discovery.");
  requireString(value.repository, "source discovery artifact repository");
  requireString(value.workflowId, "source discovery artifact workflowId", POSITIVE_ID_PATTERN);
  if (value.workflowPath !== DISCOVERY_WORKFLOW_PATH) {
    throw inputError("source discovery artifact workflowPath is invalid.");
  }
  requireString(value.runId, "source discovery artifact runId", POSITIVE_ID_PATTERN);
  requireInteger(value.runAttempt, "source discovery artifact runAttempt");
  requireString(value.sourceRef, "source discovery artifact sourceRef", /^refs\/heads\/\S+$/);
  requireString(value.sourceSha, "source discovery artifact sourceSha", GIT_SHA_PATTERN);
  requireString(value.artifactId, "source discovery artifact artifactId", POSITIVE_ID_PATTERN);
  requireString(value.artifactName, "source discovery artifact artifactName");
  requireString(value.digest, "source discovery artifact digest", SHA256_PATTERN);
  if (
    value.repository !== provenance.repository ||
    value.sourceRef !== provenance.sourceRef ||
    value.sourceSha !== provenance.sourceSha
  ) {
    throw inputError("source discovery artifact does not match the trusted analysis context.");
  }
  const expectedName = `gallery-discovery-${value.runId}-${value.runAttempt}`;
  if (value.artifactName !== expectedName) {
    throw inputError("source discovery artifact name does not bind its run and attempt.");
  }
  return structuredClone(value);
}

function validateProvenance(value) {
  exactKeys(value, "analysis provenance", [
    "repository",
    "runAttempt",
    "runId",
    "sourceRef",
    "sourceSha",
    "workflowId",
    "workflowPath",
  ]);
  const provenance = {
    repository: requireString(value.repository, "analysis repository"),
    workflowId: requireString(value.workflowId, "analysis workflowId", POSITIVE_ID_PATTERN),
    workflowPath: requireString(value.workflowPath, "analysis workflowPath"),
    runId: requireString(value.runId, "analysis runId", POSITIVE_ID_PATTERN),
    runAttempt: requireInteger(value.runAttempt, "analysis runAttempt"),
    sourceRef: requireString(value.sourceRef, "analysis sourceRef", /^refs\/heads\/\S+$/),
    sourceSha: requireString(value.sourceSha, "analysis sourceSha", GIT_SHA_PATTERN),
  };
  if (provenance.workflowPath !== WORKFLOW_PATH) {
    throw inputError("analysis workflowPath is invalid.");
  }
  return provenance;
}

function apiConfiguration(environment, mode) {
  if (!["responses", "chat", "mai-chat"].includes(mode)) {
    throw inputError("API mode must be responses, chat, or mai-chat.");
  }
  return {
    endpointOriginHash: sha256(azureEndpointOrigin(environment)),
    deploymentId: requireString(environment.AZURE_OPENAI_DEPLOYMENT, "AZURE_OPENAI_DEPLOYMENT"),
    apiMode: mode,
    apiVersion: mode === "responses"
      ? RESPONSES_API_VERSION
      : mode === "chat"
        ? CHAT_API_VERSION
        : MAI_CHAT_API_VERSION,
  };
}

function promptHash() {
  return canonicalHash({
    analysis: ANALYSIS_SYSTEM_INSTRUCTIONS,
    grounding: GROUNDING_SYSTEM_INSTRUCTIONS,
  });
}

function safeError(error, secrets = []) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret) message = message.replaceAll(secret, "[REDACTED]");
  }
  return {
    code: typeof error?.code === "string" ? error.code : "CANDIDATE_ANALYSIS_FAILED",
    message,
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export async function analyzeCandidates({
  discovery,
  candidateGates,
  activeCatalog,
  retiredCatalog,
  policy,
  analysisSchema,
  sourceDiscoveryArtifact,
  provenance: provenanceInput,
  environment = process.env,
  mode = "responses",
  client,
  clientFactory,
  createInvocationId,
  generatedAt = new Date().toISOString(),
  fileHashes = {},
}) {
  requireCompleteReport(discovery, "discovery");
  requireCompleteCandidateGates(candidateGates);
  requireEnabledPolicy(policy);
  requireObject(analysisSchema, "analysis schema");
  const provenance = validateProvenance(provenanceInput);
  const discoveryArtifact = validateDiscoveryArtifact(sourceDiscoveryArtifact, provenance);
  requireString(environment.AZURE_OPENAI_BEARER_TOKEN, "AZURE_OPENAI_BEARER_TOKEN");
  const catalog = catalogRecords(activeCatalog, retiredCatalog);
  const entries = eligibleCandidates(discovery, candidateGates);
  const eligibleIds = entries.map((entry) => entry.candidateId);
  const configuration = {
    ...apiConfiguration(environment, mode),
    promptHash: promptHash(),
    schemaHash: canonicalHash(analysisSchema),
    policyHash: canonicalHash(policy),
    catalogHash: canonicalHash({ active: activeCatalog, retired: retiredCatalog }),
  };
  const eligibleSet = {
    count: eligibleIds.length,
    candidateIds: eligibleIds,
    hash: canonicalHash(eligibleIds),
  };
  const rejectedCandidateLedger = rejectedLedger(candidateGates);
  const analyses = [];
  const errors = [];
  const bearerToken = environment.AZURE_OPENAI_BEARER_TOKEN;
  const sharedClient = client ?? (clientFactory ? null : createAzureOpenAIClient({ environment, mode }));

  for (const entry of entries) {
    try {
      const result = await runAiAnalysis({
        candidate: entry.candidate,
        catalog,
        client: clientFactory ? clientFactory(entry) : sharedClient,
        createInvocationId: () => (
          createInvocationId ? createInvocationId(entry.candidateId) : randomUUID()
        ),
        deterministicGate: entry.deterministicGate,
      });
      if (result.analysis.candidateId !== entry.candidateId) {
        throw new AiAnalysisError("CANDIDATE_BINDING_INVALID", "Analysis candidate ID does not match its input.");
      }
      analyses.push({
        candidateId: entry.candidateId,
        analysis: result.analysis,
        invocations: result.invocations,
        evaluationState: result.evaluationState,
        deterministic: result.deterministic,
      });
    } catch (error) {
      errors.push({ candidateId: entry.candidateId, error: safeError(error, [bearerToken]) });
    }
  }

  if (errors.length > 0 || analyses.length !== entries.length) {
    throw new CandidateAnalysisError(
      "CANDIDATE_ANALYSIS_INCOMPLETE",
      "Every eligible candidate must complete analysis successfully.",
      { errors },
    );
  }
  const analyzedIds = analyses.map((entry) => entry.candidateId);
  if (!isDeepStrictEqual(analyzedIds, eligibleIds)) {
    throw new CandidateAnalysisError("CANDIDATE_ANALYSIS_INCOMPLETE", "Analyzed IDs differ from the eligible set.");
  }

  const report = {
    schemaVersion: REPORT_VERSION,
    mode: "live-candidate-analysis",
    mutationPerformed: false,
    status: "complete",
    generatedAt,
    provenance: {
      ...provenance,
      sourceDiscoveryArtifact: discoveryArtifact,
    },
    configuration,
    fileHashes: structuredClone(fileHashes),
    eligibleSet,
    rejectedLedger: rejectedCandidateLedger,
    analyses,
  };
  return deepFreeze(report);
}

async function readJsonSnapshot(filePath, name) {
  const bytes = await readFile(filePath);
  let data;
  try {
    data = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw inputError(`${name} must contain valid JSON.`);
  }
  return { data, hash: sha256(bytes) };
}

export function createCandidateAnalysisReceipt(report, reportBytes) {
  return deepFreeze({
    schemaVersion: REPORT_VERSION,
    reportFile: "model-analysis.json",
    reportFileHash: sha256(reportBytes),
    reportFingerprint: canonicalHash(report),
    analysisCount: report.analyses.length,
    eligibleSet: structuredClone(report.eligibleSet),
    rejectedLedger: structuredClone(report.rejectedLedger),
    provenance: structuredClone(report.provenance),
    configuration: structuredClone(report.configuration),
    fileHashes: structuredClone(report.fileHashes),
  });
}

async function writeOutputs(outputDirectory, report) {
  const temporaryDirectory = `${outputDirectory}.tmp-${process.pid}-${Date.now()}`;
  await rm(temporaryDirectory, { recursive: true, force: true });
  await mkdir(temporaryDirectory, { recursive: true });
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
  const receipt = createCandidateAnalysisReceipt(report, reportBytes);
  await writeFile(path.join(temporaryDirectory, "model-analysis.json"), reportBytes);
  await writeFile(
    path.join(temporaryDirectory, "model-analysis-receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8",
  );
  await rm(outputDirectory, { recursive: true, force: true });
  await rename(temporaryDirectory, outputDirectory);
  return receipt;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw inputError(`Unexpected argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw inputError(`${argument} requires a value.`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  return options;
}

function resolvePath(rootDirectory, value, fallback) {
  return path.resolve(rootDirectory, value ?? fallback);
}

function provenanceFromEnvironment(environment) {
  return {
    repository: environment.GITHUB_REPOSITORY,
    workflowId: environment.GITHUB_WORKFLOW_ID,
    workflowPath: environment.GITHUB_WORKFLOW_PATH ?? WORKFLOW_PATH,
    runId: environment.GITHUB_RUN_ID,
    runAttempt: Number(environment.GITHUB_RUN_ATTEMPT),
    sourceRef: environment.TRUSTED_REF ?? environment.GITHUB_REF,
    sourceSha: environment.TRUSTED_SHA ?? environment.GITHUB_SHA,
  };
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const args = parseArguments(argv);
  const rootDirectory = path.resolve(options.rootDirectory ?? REPOSITORY_ROOT);
  const environment = options.environment ?? process.env;
  const paths = {
    discovery: resolvePath(rootDirectory, args.discovery, DEFAULT_PATHS.discovery),
    candidateGates: resolvePath(rootDirectory, args["candidate-gates"], DEFAULT_PATHS.candidateGates),
    activeCatalog: resolvePath(rootDirectory, args["active-catalog"], DEFAULT_PATHS.activeCatalog),
    retiredCatalog: resolvePath(rootDirectory, args["retired-catalog"], DEFAULT_PATHS.retiredCatalog),
    policy: resolvePath(rootDirectory, args.policy, DEFAULT_PATHS.policy),
    analysisSchema: resolvePath(rootDirectory, args["analysis-schema"], DEFAULT_PATHS.analysisSchema),
    sourceDiscoveryArtifact: resolvePath(rootDirectory, args["source-discovery-artifact"], ""),
    outputDirectory: resolvePath(rootDirectory, args["output-directory"], DEFAULT_PATHS.outputDirectory),
  };
  if (!args["source-discovery-artifact"]) {
    throw inputError("--source-discovery-artifact is required.");
  }
  await rm(paths.outputDirectory, { recursive: true, force: true });
  const snapshots = Object.fromEntries(await Promise.all(
    Object.entries(paths)
      .filter(([name]) => !["outputDirectory", "sourceDiscoveryArtifact"].includes(name))
      .map(async ([name, filePath]) => [name, await readJsonSnapshot(filePath, name)]),
  ));
  const sourceDiscoveryArtifact = await readJsonSnapshot(
    paths.sourceDiscoveryArtifact,
    "source discovery artifact",
  );
  const fileHashes = Object.fromEntries(
    Object.entries(snapshots).map(([name, snapshot]) => [name, snapshot.hash]),
  );
  fileHashes.sourceDiscoveryArtifact = sourceDiscoveryArtifact.hash;
  const report = await analyzeCandidates({
    discovery: snapshots.discovery.data,
    candidateGates: snapshots.candidateGates.data,
    activeCatalog: snapshots.activeCatalog.data,
    retiredCatalog: snapshots.retiredCatalog.data,
    policy: snapshots.policy.data,
    analysisSchema: snapshots.analysisSchema.data,
    sourceDiscoveryArtifact: sourceDiscoveryArtifact.data,
    provenance: options.provenance ?? provenanceFromEnvironment(environment),
    environment,
    mode: args.mode ?? environment.AZURE_OPENAI_API_MODE ?? "responses",
    client: options.client,
    clientFactory: options.clientFactory,
    createInvocationId: options.createInvocationId,
    generatedAt: options.generatedAt,
    fileHashes,
  });
  const receipt = await writeOutputs(paths.outputDirectory, report);
  return { report, receipt, outputDirectory: paths.outputDirectory };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const safe = safeError(error, [process.env.AZURE_OPENAI_BEARER_TOKEN]);
    process.stderr.write(`${safe.code}: ${safe.message}\n`);
    process.exitCode = 1;
  });
}