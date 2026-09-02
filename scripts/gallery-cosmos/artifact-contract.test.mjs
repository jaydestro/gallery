import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  artifactProvenanceForDocument,
  assertSameTrustedContext,
  validateArtifactProvenance,
  verifyArtifactMember,
} from "./artifact-contract.mjs";

const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function artifact(overrides = {}) {
  return {
    repository: "jaydestro/gallery",
    workflowId: "123",
    workflowPath: ".github/workflows/discover-content.yml",
    runId: "456",
    runAttempt: 2,
    sourceRef: "refs/heads/main",
    sourceSha: "a".repeat(40),
    artifactId: "789",
    artifactName: "gallery-discovery-456-2",
    digest: digest("archive"),
    members: [
      { path: "candidate-gates.json", sha256: digest("gates") },
      { path: "discovery.json", sha256: digest("discovery") },
    ],
    ...overrides,
  };
}

test("accepts exact attempt-bound artifacts and verifies declared member bytes", () => {
  const value = validateArtifactProvenance(artifact(), "discovery");
  assert.equal(verifyArtifactMember(value, "discovery.json", Buffer.from("discovery")), digest("discovery"));
  assert.deepEqual(artifactProvenanceForDocument(value), {
    repository: "jaydestro/gallery",
    workflowPath: ".github/workflows/discover-content.yml",
    sourceRef: "refs/heads/main",
    sourceSha: "a".repeat(40),
    runId: "456",
    runAttempt: 2,
    artifactDigest: digest("archive"),
  });
});

test("rejects unknown producers, extra fields, names, paths, hashes, and cross-SHA artifacts", () => {
  assert.throws(() => validateArtifactProvenance(artifact(), "unknown"), /Unknown producer/);
  assert.throws(() => validateArtifactProvenance({ ...artifact(), token: "secret" }, "discovery"), /exact contract/);
  assert.throws(() => validateArtifactProvenance(artifact({ artifactName: "gallery-discovery-456-1" }), "discovery"), /exact run/);
  assert.throws(() => validateArtifactProvenance(artifact({
    members: [...artifact().members, { path: "extra.json", sha256: digest("extra") }],
  }), "discovery"), /allowlist/);
  assert.throws(() => validateArtifactProvenance(artifact({
    members: [{ path: "../discovery.json", sha256: digest("discovery") }, artifact().members[0]],
  }), "discovery"), /unsafe/);
  assert.throws(() => verifyArtifactMember(
    validateArtifactProvenance(artifact(), "discovery"),
    "discovery.json",
    Buffer.from("tampered"),
  ), /SHA-256/);
  assert.throws(() => assertSameTrustedContext([
    artifact(),
    artifact({ sourceSha: "b".repeat(40) }),
  ]), /same trusted/);
});

test("proposal artifacts allow only bounded plan and proposal members", () => {
  const proposal = artifact({
    workflowPath: ".github/workflows/propose-gallery-changes.yml",
    artifactName: "gallery-proposal-456-2",
    members: [
      "proposal-report.json",
      "proposal-receipt.json",
      "upstream-artifact-diagnostics.json",
      "proposed/templates.json",
      "proposed/gallery-health.json",
      "proposed/retired-templates.json",
      "proposed/catalog-audit.json",
      "plans/catalog-change-plan-001.json",
    ].map((path) => ({ path, sha256: digest(path) })),
  });
  assert.equal(validateArtifactProvenance(proposal, "proposal").members.length, 8);
  assert.throws(() => validateArtifactProvenance({
    ...proposal,
    members: [...proposal.members, { path: "plans/notes.txt", sha256: digest("notes") }],
  }, "proposal"), /outside/);
});

test("accepts the exact artifact contract for all six approved producer workflows", () => {
  const cases = [
    ["discovery", ".github/workflows/discover-content.yml", "gallery-discovery-", ["candidate-gates.json", "discovery.json"]],
    ["health", ".github/workflows/scan-gallery-health.yml", "gallery-health-", ["gallery-health-receipt.json", "gallery-health-report.json", "proposed-gallery-health.json"]],
    ["freshness", ".github/workflows/evaluate-repository-freshness.yml", "gallery-freshness-", ["gallery-freshness.json"]],
    ["modelEvaluation", ".github/workflows/evaluate-pipeline-policy.yml", "gallery-model-evaluation-", ["report.json"]],
    ["candidateAnalysis", ".github/workflows/analyze-gallery-candidates.yml", "gallery-candidate-analysis-", ["model-analysis-receipt.json", "model-analysis.json"]],
  ];
  for (const [producer, workflowPath, prefix, paths] of cases) {
    const value = artifact({
      workflowPath,
      artifactName: `${prefix}456-2`,
      members: paths.map((memberPath) => ({ path: memberPath, sha256: digest(memberPath) })),
    });
    assert.equal(validateArtifactProvenance(value, producer).workflowPath, workflowPath);
  }
});