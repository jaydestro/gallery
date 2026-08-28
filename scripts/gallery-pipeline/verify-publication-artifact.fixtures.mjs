import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { makeProposalFixture } from "./propose-catalog-changes.fixtures.mjs";
import { main as runProposal } from "./propose-catalog-changes.mjs";

export const PUBLICATION_RUN_ID = "33148289100";
export const PUBLICATION_RUN_ATTEMPT = 1;
export const PUBLICATION_SHA = "0123456789abcdef0123456789abcdef01234567";
export const PUBLICATION_GENERATED_AT = "2026-08-27T12:00:00.000Z";
export const PUBLICATION_STARTED_AT = "2026-08-27T11:55:00Z";
export const PUBLICATION_UPDATED_AT = "2026-08-27T12:05:00Z";

export function sha256Digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function createPublicationVerificationFixture(rootDirectory, {
  candidateCount = 3,
  noOperations = false,
} = {}) {
  const artifactDirectory = path.join(rootDirectory, "artifact");
  const repositoryRoot = path.join(rootDirectory, "repository");
  const outputDirectory = path.join(rootDirectory, "publication");
  const artifactArchive = path.join(rootDirectory, "proposal.zip");
  const apiMetadataPath = path.join(rootDirectory, "api-metadata.json");
  const input = makeProposalFixture({ candidateCount });
  if (noOperations) {
    input.discovery.candidates = [];
    input.candidateGates.summary = {
      candidates: 0,
      selectedCandidates: 0,
      executedCandidateChecks: 0,
      availabilityChecks: 0,
      executedAvailabilityChecks: 0,
      indeterminateAvailabilityChecks: 0,
      deadlineExceededAvailabilityChecks: 0,
      eligible: 0,
      rejected: 0,
    };
    input.candidateGates.eligible = [];
    input.modelAnalysis.eligibleSet = {
      count: 0,
      candidateIds: [],
      hash: `sha256:${createHash("sha256").update("[]").digest("hex")}`,
    };
    input.modelAnalysis.analyses = [];
  }
  input.runId = `proposal-${PUBLICATION_RUN_ID}-${PUBLICATION_RUN_ATTEMPT}`;
  input.generatedAt = PUBLICATION_GENERATED_AT;
  input.workflowStartedAt = PUBLICATION_STARTED_AT;
  input.policy.automation.mutation.automaticMerge = true;

  const proposal = await runProposal([
    "--fixtures",
    "--report-directory", artifactDirectory,
    "--run-id", input.runId,
    "--generated-at", input.generatedAt,
    "--workflow-started-at", input.workflowStartedAt,
    "--trusted-repository", input.trustedRepository,
    "--trusted-ref", input.trustedRef,
    "--trusted-sha", input.trustedSha,
  ], {
    now: new Date("2026-08-27T12:01:00.000Z"),
    loadFixture: async () => input,
    stdout: { write() {} },
  });
  const { result } = proposal;
  await writeJson(path.join(artifactDirectory, "upstream-artifact-diagnostics.json"), {
    schemaVersion: "1.0.0",
    status: "verified",
    repository: input.trustedRepository,
    trustedRef: input.trustedRef,
    trustedSha: input.trustedSha,
    workflowRunId: PUBLICATION_RUN_ID,
    workflowStartedAt: PUBLICATION_STARTED_AT,
    checks: [
      { name: "proposal-context", status: "verified", message: "Fixture context is bound." },
      { name: "discovery", status: "verified", message: "Fixture discovery is bound." },
      { name: "health", status: "verified", message: "Fixture health is bound." },
      { name: "freshness", status: "verified", message: "Fixture freshness is bound." },
      { name: "modelAnalysis", status: "verified", message: "Fixture model analysis is bound." },
    ],
  });

  await Promise.all([
    writeJson(path.join(repositoryRoot, "static", "templates.json"), input.activeCatalog),
    writeJson(path.join(repositoryRoot, "static", "gallery-health.json"), input.health),
    writeJson(path.join(repositoryRoot, "static", "retired-templates.json"), input.retired),
    writeJson(path.join(repositoryRoot, "static", "catalog-audit.json"), input.audit),
    writeJson(path.join(repositoryRoot, ".github", "gallery-pipeline", "policy.json"), input.policy),
  ]);

  const archiveBytes = Buffer.from("publication-verification-fixture\n");
  await writeFile(artifactArchive, archiveBytes);
  const metadata = {
    schemaVersion: "1.0.0",
    repository: input.trustedRepository,
    defaultBranch: "main",
    defaultSha: PUBLICATION_SHA,
    producerWorkflow: {
      id: "901",
      name: "Propose gallery changes (report only)",
      path: ".github/workflows/propose-gallery-changes.yml",
    },
    producerRun: {
      id: PUBLICATION_RUN_ID,
      attempt: PUBLICATION_RUN_ATTEMPT,
      event: "schedule",
      status: "completed",
      conclusion: "success",
      workflowId: "901",
      workflowPath: ".github/workflows/propose-gallery-changes.yml",
      repository: input.trustedRepository,
      headRepository: input.trustedRepository,
      headBranch: "main",
      headSha: PUBLICATION_SHA,
      runStartedAt: PUBLICATION_STARTED_AT,
      updatedAt: PUBLICATION_UPDATED_AT,
    },
    artifact: {
      id: "7001",
      name: `gallery-proposal-${PUBLICATION_RUN_ID}-${PUBLICATION_RUN_ATTEMPT}`,
      digest: sha256Digest(archiveBytes),
      expired: false,
    },
  };
  await writeJson(apiMetadataPath, metadata);

  return {
    rootDirectory,
    artifactDirectory,
    artifactArchive,
    apiMetadataPath,
    repositoryRoot,
    outputDirectory,
    input,
    result,
    metadata,
  };
}