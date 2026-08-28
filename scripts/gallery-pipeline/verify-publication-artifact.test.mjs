import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { hashCanonicalValue } from "./build-catalog-change.mjs";
import {
  createPublicationVerificationFixture,
  PUBLICATION_RUN_ATTEMPT,
  PUBLICATION_RUN_ID,
  writeJson,
} from "./verify-publication-artifact.fixtures.mjs";
import {
  PublicationArtifactError,
  verifyPublicationArtifact,
} from "./verify-publication-artifact.mjs";

async function fixture(t, options) {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "gallery-publication-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  return createPublicationVerificationFixture(rootDirectory, options);
}

function verificationOptions(value) {
  return {
    artifactDirectory: value.artifactDirectory,
    artifactArchive: value.artifactArchive,
    apiMetadataPath: value.apiMetadataPath,
    repositoryRoot: value.repositoryRoot,
    outputDirectory: value.outputDirectory,
  };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function rejectsWithCode(action, code) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof PublicationArtifactError);
    assert.equal(error.code, code);
    return true;
  });
}

async function rebindReceiptOutput(value, artifactPath, replacement) {
  const receiptPath = path.join(value.artifactDirectory, "proposal-receipt.json");
  const receipt = await readJson(receiptPath);
  receipt.outputs.find((output) => output.path === artifactPath).fingerprint = hashCanonicalValue(replacement);
  await writeJson(receiptPath, receipt);
}

test("verifies the complete trust chain and emits only an exact first-batch PR payload", async (t) => {
  const value = await fixture(t);
  const manifest = await verifyPublicationArtifact(verificationOptions(value));

  assert.equal(manifest.repository, "example/gallery");
  assert.equal(manifest.publishable, true);
  assert.equal(manifest.baseSha, value.metadata.defaultSha);
  assert.equal(manifest.branch, `automation/gallery/${PUBLICATION_RUN_ID}-${PUBLICATION_RUN_ATTEMPT}`);
  assert.deepEqual(manifest.batch, {
    number: 1,
    total: 1,
    runId: `proposal-${PUBLICATION_RUN_ID}-${PUBLICATION_RUN_ATTEMPT}-batch-001`,
    operationCount: 3,
  });
  assert.ok(manifest.paths.some((entry) => entry.path === ".github/gallery-pipeline/catalog-change-plan.json"));
  assert.ok(manifest.paths.some((entry) => entry.path === "static/templates.json"));
  assert.ok(manifest.paths.every((entry) => /^sha256:[a-f0-9]{64}$/.test(entry.digest)));
  assert.deepEqual(
    await readJson(path.join(value.outputDirectory, "publication-manifest.json")),
    manifest,
  );
});

test("verifies every declared batch but emits one bounded batch for conflict-free publication", async (t) => {
  const value = await fixture(t, { candidateCount: 30 });
  const manifest = await verifyPublicationArtifact(verificationOptions(value));

  assert.equal(value.result.plans.length, 2);
  assert.equal(manifest.batch.total, 2);
  assert.equal(manifest.batch.operationCount, 25);
  const plan = await readJson(path.join(
    value.outputDirectory,
    ".github",
    "gallery-pipeline",
    "catalog-change-plan.json",
  ));
  assert.equal(plan.operations.length, 25);
});

test("accepts a repository whose initial audit file is absent", async (t) => {
  const value = await fixture(t);
  await unlink(path.join(value.repositoryRoot, "static", "catalog-audit.json"));

  const manifest = await verifyPublicationArtifact(verificationOptions(value));

  assert.ok(manifest.paths.some((entry) => entry.path === "static/catalog-audit.json"));
});

test("rejects a downloaded archive whose bytes do not match the API digest", async (t) => {
  const value = await fixture(t);
  await writeFile(value.artifactArchive, "tampered archive\n");

  await rejectsWithCode(
    () => verifyPublicationArtifact(verificationOptions(value)),
    "ARTIFACT_DIGEST_INVALID",
  );
});

test("rejects untrusted producer, repository, run, and artifact API identities", async (t) => {
  const cases = [
    ["workflow path", (metadata) => { metadata.producerWorkflow.path = ".github/workflows/lookalike.yml"; }, "WORKFLOW_IDENTITY_INVALID"],
    ["fork head", (metadata) => { metadata.producerRun.headRepository = "attacker/gallery"; }, "RUN_IDENTITY_INVALID"],
    ["stale SHA", (metadata) => { metadata.defaultSha = "f".repeat(40); }, "RUN_IDENTITY_INVALID"],
    ["pull request run", (metadata) => { metadata.producerRun.event = "pull_request"; }, "RUN_IDENTITY_INVALID"],
    ["failed run", (metadata) => { metadata.producerRun.conclusion = "failure"; }, "RUN_IDENTITY_INVALID"],
    ["expired artifact", (metadata) => { metadata.artifact.expired = true; }, "ARTIFACT_IDENTITY_INVALID"],
    ["lookalike artifact", (metadata) => { metadata.artifact.name += "-extra"; }, "ARTIFACT_IDENTITY_INVALID"],
  ];

  for (const [name, mutate, code] of cases) {
    await t.test(name, async (subtest) => {
      const value = await fixture(subtest);
      mutate(value.metadata);
      await writeJson(value.apiMetadataPath, value.metadata);
      await rejectsWithCode(
        () => verifyPublicationArtifact(verificationOptions(value)),
        code,
      );
    });
  }
});

test("rejects extra, missing, and symbolic-link artifact paths", async (t) => {
  await t.test("extra path", async (subtest) => {
    const value = await fixture(subtest);
    await writeFile(path.join(value.artifactDirectory, "unexpected.json"), "{}\n");
    await rejectsWithCode(
      () => verifyPublicationArtifact(verificationOptions(value)),
      "ARTIFACT_PATH_SET_INVALID",
    );
  });

  await t.test("missing batch", async (subtest) => {
    const value = await fixture(subtest);
    await unlink(path.join(value.artifactDirectory, "plans", "catalog-change-plan-001.json"));
    await rejectsWithCode(
      () => verifyPublicationArtifact(verificationOptions(value)),
      "ARTIFACT_PATH_SET_INVALID",
    );
  });

  await t.test("symbolic link", async (subtest) => {
    const value = await fixture(subtest);
    const reportPath = path.join(value.artifactDirectory, "proposal-report.json");
    const targetPath = path.join(value.rootDirectory, "report-target.json");
    await writeFile(targetPath, await readFile(reportPath));
    await unlink(reportPath);
    try {
      await symlink(targetPath, reportPath, "file");
    } catch (error) {
      if (error?.code === "EPERM") {
        subtest.skip("Creating symlinks is not permitted on this Windows host.");
        return;
      }
      throw error;
    }
    await rejectsWithCode(
      () => verifyPublicationArtifact(verificationOptions(value)),
      "ARTIFACT_SYMLINK",
    );
  });
});

test("rejects report, receipt, diagnostics, and batch contract tampering", async (t) => {
  const cases = [
    ["report status", "proposal-report.json", async (value, filePath) => {
      const report = await readJson(filePath);
      report.status = "blocked";
      await writeJson(filePath, report);
    }],
    ["receipt fingerprint", "proposal-receipt.json", async (_value, filePath) => {
      const receipt = await readJson(filePath);
      receipt.reportFingerprint = "f".repeat(64);
      await writeJson(filePath, receipt);
    }],
    ["unverified diagnostics", "upstream-artifact-diagnostics.json", async (_value, filePath) => {
      const diagnostics = await readJson(filePath);
      diagnostics.checks[0].status = "failed";
      await writeJson(filePath, diagnostics);
    }],
    ["batch operation", "plans/catalog-change-plan-001.json", async (_value, filePath) => {
      const plan = await readJson(filePath);
      plan.operations[0].operationId = "tampered-operation";
      await writeJson(filePath, plan);
    }],
  ];

  for (const [name, relativePath, mutate] of cases) {
    await t.test(name, async (subtest) => {
      const value = await fixture(subtest);
      await mutate(value, path.join(value.artifactDirectory, ...relativePath.split("/")));
      await assert.rejects(() => verifyPublicationArtifact(verificationOptions(value)));
    });
  }
});

test("rejects proposed bytes that are re-bound in the receipt but do not replay", async (t) => {
  const value = await fixture(t);
  const proposedPath = path.join(value.artifactDirectory, "proposed", "templates.json");
  const proposed = await readJson(proposedPath);
  proposed[0].title = "Receipt-bound tampering";
  await writeJson(proposedPath, proposed);
  await rebindReceiptOutput(value, "proposed/templates.json", proposed);

  await rejectsWithCode(
    () => verifyPublicationArtifact(verificationOptions(value)),
    "PROPOSAL_REPLAY_INVALID",
  );
});

test("rejects publication unless emergency disable is off and native auto-merge is enabled", async (t) => {
  for (const [name, mutate] of [
    ["emergency disabled", (policy) => { policy.automation.emergencyDisable = true; }],
    ["auto-merge disabled", (policy) => { policy.automation.mutation.automaticMerge = false; }],
  ]) {
    await t.test(name, async (subtest) => {
      const value = await fixture(subtest);
      const policyPath = path.join(value.repositoryRoot, ".github", "gallery-pipeline", "policy.json");
      const policy = await readJson(policyPath);
      mutate(policy);
      await writeJson(policyPath, policy);
      await rejectsWithCode(
        () => verifyPublicationArtifact(verificationOptions(value)),
        "PUBLICATION_DISABLED",
      );
    });
  }
});

test("rejects incomplete receipt inputs and upstream producer bindings", async (t) => {
  await t.test("missing input", async (subtest) => {
    const value = await fixture(subtest);
    const receiptPath = path.join(value.artifactDirectory, "proposal-receipt.json");
    const receipt = await readJson(receiptPath);
    receipt.inputs = receipt.inputs.filter((entry) => entry.name !== "analysisSchema");
    await writeJson(receiptPath, receipt);
    await rejectsWithCode(
      () => verifyPublicationArtifact(verificationOptions(value)),
      "RECEIPT_BINDING_INVALID",
    );
  });

  await t.test("foreign upstream ref", async (subtest) => {
    const value = await fixture(subtest);
    const receiptPath = path.join(value.artifactDirectory, "proposal-receipt.json");
    const receipt = await readJson(receiptPath);
    receipt.upstreamArtifacts[0].sourceRef = "refs/heads/lookalike";
    receipt.inputs.find((entry) => entry.name === "upstreamArtifacts").fingerprint =
      hashCanonicalValue(receipt.upstreamArtifacts);
    await writeJson(receiptPath, receipt);
    await rejectsWithCode(
      () => verifyPublicationArtifact(verificationOptions(value)),
      "RECEIPT_BINDING_INVALID",
    );
  });

  await t.test("missing diagnostic producer", async (subtest) => {
    const value = await fixture(subtest);
    const diagnosticsPath = path.join(value.artifactDirectory, "upstream-artifact-diagnostics.json");
    const diagnostics = await readJson(diagnosticsPath);
    diagnostics.checks = diagnostics.checks.filter((entry) => entry.name !== "freshness");
    await writeJson(diagnosticsPath, diagnostics);
    await rejectsWithCode(
      () => verifyPublicationArtifact(verificationOptions(value)),
      "UPSTREAM_DIAGNOSTICS_INVALID",
    );
  });
});

test("verifies a zero-operation proposal without producing a publishable payload", async (t) => {
  const value = await fixture(t, { noOperations: true });
  const manifest = await verifyPublicationArtifact(verificationOptions(value));

  assert.equal(value.result.report.status, "complete");
  assert.equal(value.result.report.summary.operations, 0);
  assert.equal(manifest.publishable, false);
  assert.equal(manifest.branch, null);
  assert.equal(manifest.batch, null);
  assert.deepEqual(manifest.paths, []);
});