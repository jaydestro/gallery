import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { CosmosCliError } from "./cli-runtime.mjs";

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const POSITIVE_ID_PATTERN = /^[1-9][0-9]*$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ARTIFACT_KEYS = Object.freeze([
  "artifactId",
  "artifactName",
  "digest",
  "members",
  "repository",
  "runAttempt",
  "runId",
  "sourceRef",
  "sourceSha",
  "workflowId",
  "workflowPath",
]);
const MEMBER_KEYS = Object.freeze(["path", "sha256"]);
const EXECUTION_PROVENANCE_KEYS = Object.freeze([
  "artifactDigest",
  "repository",
  "runAttempt",
  "runId",
  "sourceRef",
  "sourceSha",
  "workflowPath",
]);

export const TRUSTED_PRODUCERS = Object.freeze({
  discovery: Object.freeze({
    workflowPath: ".github/workflows/discover-content.yml",
    artifactPrefix: "gallery-discovery-",
    members: Object.freeze(["candidate-gates.json", "discovery.json"]),
  }),
  health: Object.freeze({
    workflowPath: ".github/workflows/scan-gallery-health.yml",
    artifactPrefix: "gallery-health-",
    members: Object.freeze([
      "gallery-health-receipt.json",
      "gallery-health-report.json",
      "proposed-gallery-health.json",
    ]),
  }),
  freshness: Object.freeze({
    workflowPath: ".github/workflows/evaluate-repository-freshness.yml",
    artifactPrefix: "gallery-freshness-",
    members: Object.freeze(["gallery-freshness.json"]),
  }),
  modelEvaluation: Object.freeze({
    workflowPath: ".github/workflows/evaluate-pipeline-policy.yml",
    artifactPrefix: "gallery-model-evaluation-",
    members: Object.freeze(["report.json"]),
  }),
  candidateAnalysis: Object.freeze({
    workflowPath: ".github/workflows/analyze-gallery-candidates.yml",
    artifactPrefix: "gallery-candidate-analysis-",
    members: Object.freeze(["model-analysis-receipt.json", "model-analysis.json"]),
  }),
  proposal: Object.freeze({
    workflowPath: ".github/workflows/propose-gallery-changes.yml",
    artifactPrefix: "gallery-proposal-",
    memberPattern: /^(?:proposal-report\.json|proposal-receipt\.json|upstream-artifact-diagnostics\.json|proposed\/(?:templates|gallery-health|retired-templates|catalog-audit)\.json|plans\/catalog-change-plan-[0-9]{3}\.json)$/,
    requiredMembers: Object.freeze([
      "proposal-report.json",
      "proposal-receipt.json",
      "proposed/catalog-audit.json",
      "proposed/gallery-health.json",
      "proposed/retired-templates.json",
      "proposed/templates.json",
      "upstream-artifact-diagnostics.json",
    ]),
  }),
});

function fail(message) {
  throw new CosmosCliError("ARTIFACT_PROVENANCE_INVALID", message);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  if (!isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort())) {
    fail(`${label} keys do not match the exact contract.`);
  }
  return value;
}

function string(value, label, pattern) {
  if (typeof value !== "string" || value.trim() !== value || !value || (pattern && !pattern.test(value))) {
    fail(`${label} is invalid.`);
  }
  return value;
}

function validateMembers(members, specification) {
  if (!Array.isArray(members) || members.length === 0 || members.length > 40) {
    fail("Artifact members must be a non-empty bounded array.");
  }
  const paths = [];
  for (const [index, member] of members.entries()) {
    exactKeys(member, MEMBER_KEYS, `artifact.members[${index}]`);
    const memberPath = string(member.path, `artifact.members[${index}].path`);
    string(member.sha256, `artifact.members[${index}].sha256`, DIGEST_PATTERN);
    if (
      memberPath.startsWith("/") ||
      memberPath.includes("\\") ||
      memberPath.split("/").some((segment) => !segment || segment === "." || segment === "..")
    ) {
      fail(`Artifact member path ${memberPath} is unsafe.`);
    }
    paths.push(memberPath);
  }
  if (new Set(paths).size !== paths.length) fail("Artifact member paths must be unique.");
  const sortedPaths = [...paths].sort();
  if (specification.members && !isDeepStrictEqual(sortedPaths, [...specification.members].sort())) {
    fail("Artifact member allowlist is not exact.");
  }
  if (specification.memberPattern && sortedPaths.some((memberPath) => !specification.memberPattern.test(memberPath))) {
    fail("Artifact contains a member outside its allowlist.");
  }
  if (specification.requiredMembers) {
    const available = new Set(sortedPaths);
    if (specification.requiredMembers.some((memberPath) => !available.has(memberPath))) {
      fail("Artifact is missing a required member.");
    }
  }
  return sortedPaths;
}

export function validateArtifactProvenance(value, producerName) {
  const specification = TRUSTED_PRODUCERS[producerName];
  if (!specification) fail(`Unknown producer: ${producerName}.`);
  exactKeys(value, ARTIFACT_KEYS, "artifact provenance");
  string(value.repository, "artifact.repository", REPOSITORY_PATTERN);
  string(value.workflowId, "artifact.workflowId", POSITIVE_ID_PATTERN);
  string(value.runId, "artifact.runId", POSITIVE_ID_PATTERN);
  if (!Number.isSafeInteger(value.runAttempt) || value.runAttempt < 1) fail("artifact.runAttempt is invalid.");
  string(value.sourceRef, "artifact.sourceRef", /^refs\/heads\/\S+$/);
  string(value.sourceSha, "artifact.sourceSha", SHA_PATTERN);
  string(value.artifactId, "artifact.artifactId", POSITIVE_ID_PATTERN);
  string(value.digest, "artifact.digest", DIGEST_PATTERN);
  if (value.workflowPath !== specification.workflowPath) fail("Artifact workflowPath is not trusted.");
  if (value.artifactName !== `${specification.artifactPrefix}${value.runId}-${value.runAttempt}`) {
    fail("Artifact name does not bind its exact run and attempt.");
  }
  validateMembers(value.members, specification);
  return structuredClone(value);
}

export function artifactProvenanceForDocument(artifact) {
  return Object.freeze({
    repository: artifact.repository,
    workflowPath: artifact.workflowPath,
    sourceRef: artifact.sourceRef,
    sourceSha: artifact.sourceSha,
    runId: artifact.runId,
    runAttempt: artifact.runAttempt,
    artifactDigest: artifact.digest,
  });
}

export function verifyArtifactMember(artifact, memberPath, bytes) {
  const member = artifact.members.find((entry) => entry.path === memberPath);
  if (!member) fail(`Artifact member ${memberPath} is not declared.`);
  const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (actual !== member.sha256) fail(`Artifact member ${memberPath} failed SHA-256 verification.`);
  return actual;
}

export function assertSameTrustedContext(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) fail("At least one artifact is required.");
  const [first, ...rest] = artifacts;
  for (const artifact of rest) {
    if (
      artifact.repository !== first.repository ||
      artifact.sourceRef !== first.sourceRef ||
      artifact.sourceSha !== first.sourceSha
    ) {
      fail("Artifacts do not share the same trusted repository, ref, and SHA.");
    }
  }
  return Object.freeze({
    repository: first.repository,
    sourceRef: first.sourceRef,
    sourceSha: first.sourceSha,
  });
}

export function validateExecutionProvenance(value, { workflowPath } = {}) {
  exactKeys(value, EXECUTION_PROVENANCE_KEYS, "execution provenance");
  string(value.repository, "provenance.repository", REPOSITORY_PATTERN);
  string(value.workflowPath, "provenance.workflowPath");
  string(value.sourceRef, "provenance.sourceRef", /^refs\/heads\/\S+$/);
  string(value.sourceSha, "provenance.sourceSha", SHA_PATTERN);
  string(value.runId, "provenance.runId", POSITIVE_ID_PATTERN);
  if (!Number.isSafeInteger(value.runAttempt) || value.runAttempt < 1) {
    fail("provenance.runAttempt is invalid.");
  }
  string(value.artifactDigest, "provenance.artifactDigest", DIGEST_PATTERN);
  if (workflowPath && value.workflowPath !== workflowPath) {
    fail("Execution provenance workflowPath is not trusted.");
  }
  return structuredClone(value);
}