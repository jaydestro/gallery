import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  analyzeCandidates,
  CandidateAnalysisError,
  createCandidateAnalysisReceipt,
  main,
} from "./analyze-candidates.mjs";
import {
  makeCandidateAnalysisFixture as makeUnboundCandidateAnalysisFixture,
  makeSuccessfulClient,
} from "./analyze-candidates.fixtures.mjs";

const ANALYSIS_WORKFLOW_PATH = fileURLToPath(new URL(
  "../../.github/workflows/analyze-gallery-candidates.yml",
  import.meta.url,
));

function makeCandidateAnalysisFixture(candidateCount = 2) {
  const input = makeUnboundCandidateAnalysisFixture(candidateCount);
  Object.assign(input.candidateGates, {
    schemaVersion: "2.0.0",
    coverageStatus: "complete",
  });
  Object.assign(input.candidateGates.summary, {
    selectedCandidates: candidateCount,
    executedCandidateChecks: candidateCount,
    executedAvailabilityChecks: candidateCount,
    deadlineExceededAvailabilityChecks: 0,
  });
  return input;
}

function rejectCandidateAsIndeterminate(input, index) {
  const [entry] = input.candidateGates.eligible.splice(index, 1);
  input.candidateGates.rejected.push({
    candidateId: entry.candidate.identityKey,
    reasonCodes: ["SOURCE_TIMEOUT"],
    availability: {
      checkedAt: input.candidateGates.completedAt,
      classification: "indeterminate",
      statusCode: null,
      reasonCode: "SOURCE_TIMEOUT",
      retryAttempts: 1,
      retryReasons: ["SOURCE_TIMEOUT"],
    },
  });
  input.candidateGates.coverageStatus = "partial";
  input.candidateGates.summary.indeterminateAvailabilityChecks += 1;
  input.candidateGates.summary.eligible -= 1;
  input.candidateGates.summary.rejected += 1;
}

test("workflow verifies trust before exact checkout, install, and Azure OIDC", async () => {
  const workflow = (await readFile(ANALYSIS_WORKFLOW_PATH, "utf8")).replaceAll("\r\n", "\n");
  const verification = workflow.indexOf(
    "      - name: Verify trusted default-branch SHA and discovery artifact",
  );
  const checkout = workflow.indexOf("      - name: Check out exact verified default-branch SHA");
  const setup = workflow.indexOf("      - name: Set up Node.js");
  const install = workflow.indexOf("      - name: Install dependencies");
  const oidc = workflow.indexOf("      - name: Sign in to Azure with OIDC");
  const analysis = workflow.indexOf("      - name: Analyze every eligible candidate");

  for (const [name, index] of Object.entries({ verification, checkout, setup, install, oidc, analysis })) {
    assert.notEqual(index, -1, `Missing ${name} workflow step`);
  }
  assert(verification < checkout);
  assert(checkout < setup);
  assert(setup < install);
  assert(install < oidc);
  assert(oidc < analysis);
  const trustedShell = workflow.slice(verification, checkout);
  assert.match(trustedShell, /gh api "repos\/\$\{GH_REPO\}"/);
  assert.match(trustedShell, /branches\/\$\{encoded_branch\}/);
  assert.match(trustedShell, /actions\/artifacts\/\$\{artifact_id\}\/zip/);
  assert.doesNotMatch(trustedShell, /^\s*(?:node|npm|git)\s/m);
  assert.match(
    workflow.slice(checkout, setup),
    /ref: \$\{\{ steps\.trust\.outputs\.trusted_sha \}\}/,
  );
  assert.doesNotMatch(
    workflow.slice(checkout, setup),
    /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/,
  );
  assert.match(workflow, /\.schemaVersion == "2\.0\.0"/);
  assert.match(workflow, /\.summary\.selectedCandidates == \.summary\.candidates/);
  assert.match(workflow, /\.summary\.executedCandidateChecks == \.summary\.selectedCandidates/);
  assert.match(workflow, /\.summary\.executedAvailabilityChecks == \.summary\.availabilityChecks/);
  assert.match(workflow, /\.summary\.deadlineExceededAvailabilityChecks == 0/);
  assert.match(workflow, /\(\$candidateIds \| unique \| length\) == \.summary\.candidates/);
  assert.match(workflow, /\(\$candidateIds \| sort\) == \(\[\$source\.candidates\[\]\.identityKey\] \| sort\)/);
});

test("analyzes every eligible candidate in sorted order and emits token-free bound hashes", async () => {
  const input = makeCandidateAnalysisFixture(2);
  input.candidateGates.eligible.reverse();
  const observedCatalogSizes = [];
  const report = await analyzeCandidates({
    ...input,
    generatedAt: "2026-08-28T12:00:00.000Z",
    fileHashes: { discovery: `sha256:${"a".repeat(64)}` },
    clientFactory: (entry) => {
      const client = makeSuccessfulClient(entry.candidate);
      return {
        async invoke(request) {
          if (request.operation === "content-analysis") {
            observedCatalogSizes.push(JSON.parse(request.input).catalogCoverage.totalEntries);
          }
          return client.invoke(request);
        },
      };
    },
    createInvocationId: (candidateId) => `${candidateId}-invocation`,
  });

  const expectedIds = input.candidateGates.eligible
    .map((entry) => entry.candidate.identityKey)
    .sort((left, right) => left.localeCompare(right));
  assert.equal(report.status, "complete");
  assert.equal(report.mutationPerformed, false);
  assert.deepEqual(report.eligibleSet.candidateIds, expectedIds);
  assert.deepEqual(report.analyses.map((entry) => entry.candidateId), expectedIds);
  assert.deepEqual(
    observedCatalogSizes,
    expectedIds.map(() => input.activeCatalog.length + input.retiredCatalog.entries.length),
  );
  assert.deepEqual(report.provenance.sourceDiscoveryArtifact, input.sourceDiscoveryArtifact);
  assert.match(report.configuration.endpointOriginHash, /^sha256:[a-f0-9]{64}$/);
  for (const name of ["promptHash", "schemaHash", "policyHash", "catalogHash"]) {
    assert.match(report.configuration[name], /^sha256:[a-f0-9]{64}$/);
  }
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  const receipt = createCandidateAnalysisReceipt(report, bytes);
  assert.equal(receipt.analysisCount, 2);
  assert.equal(receipt.reportFile, "model-analysis.json");
  assert.deepEqual(receipt.eligibleSet, report.eligibleSet);
  assert.deepEqual(receipt.rejectedLedger, report.rejectedLedger);
  assert.doesNotMatch(JSON.stringify({ report, receipt }), /fixture-token-must-not-escape/);
});

test("accepts mai-chat mode and records its MAI v1 configuration", async () => {
  const input = makeCandidateAnalysisFixture(1);
  const report = await analyzeCandidates({
    ...input,
    mode: "mai-chat",
    clientFactory: (entry) => makeSuccessfulClient(entry.candidate),
  });

  assert.equal(report.configuration.apiMode, "mai-chat");
  assert.equal(report.configuration.apiVersion, "v1");
});

test("analyzes only the healthy eligible subset and binds the exact rejected ledger", async () => {
  const input = makeCandidateAnalysisFixture(3);
  rejectCandidateAsIndeterminate(input, 1);
  const invoked = [];
  const report = await analyzeCandidates({
    ...input,
    clientFactory: (entry) => {
      invoked.push(entry.candidateId);
      return makeSuccessfulClient(entry.candidate);
    },
  });

  const eligibleIds = input.candidateGates.eligible
    .map((entry) => entry.candidate.identityKey)
    .sort((left, right) => left.localeCompare(right));
  assert.deepEqual(invoked, eligibleIds);
  assert.deepEqual(report.eligibleSet.candidateIds, eligibleIds);
  assert.equal(report.rejectedLedger.count, 1);
  assert.deepEqual(report.rejectedLedger.entries, input.candidateGates.rejected);
  assert.match(report.rejectedLedger.hash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(
    createCandidateAnalysisReceipt(
      report,
      Buffer.from(`${JSON.stringify(report, null, 2)}\n`),
    ).rejectedLedger,
    report.rejectedLedger,
  );
});

test("fails closed for partial inputs, duplicate IDs, discovery drift, and analysis failure", async () => {
  const cases = [
    {
      mutate(input) { input.discovery.status = "partial"; },
      code: "CANDIDATE_ANALYSIS_INPUT_INVALID",
    },
    {
      mutate(input) { input.candidateGates.status = "incomplete"; },
      code: "CANDIDATE_ANALYSIS_INPUT_INVALID",
    },
    {
      mutate(input) { input.candidateGates.summary.executedCandidateChecks -= 1; },
      code: "CANDIDATE_ANALYSIS_INPUT_INVALID",
    },
    {
      mutate(input) { input.candidateGates.mutationPerformed = true; },
      code: "CANDIDATE_ANALYSIS_INPUT_INVALID",
    },
    {
      mutate(input) { input.candidateGates.eligible.push(structuredClone(input.candidateGates.eligible[0])); },
      code: "CANDIDATE_ANALYSIS_INPUT_INVALID",
    },
    {
      mutate(input) { input.candidateGates.eligible[0].candidate.title = "tampered"; },
      code: "CANDIDATE_ANALYSIS_INPUT_INVALID",
    },
    {
      mutate(input) {
        input.candidateGates.rejected.push({
          candidateId: input.candidateGates.eligible[0].candidate.identityKey,
          reasonCodes: ["TAMPERED"],
        });
        input.candidateGates.summary.rejected += 1;
      },
      code: "CANDIDATE_ANALYSIS_INPUT_INVALID",
    },
    {
      mutate(input) {
        input.candidateGates.eligible.pop();
        input.candidateGates.summary.eligible -= 1;
      },
      code: "CANDIDATE_ANALYSIS_INPUT_INVALID",
    },
    {
      mutate() {},
      code: "CANDIDATE_ANALYSIS_INCOMPLETE",
      clientFactory: () => ({ async invoke() { throw new Error("provider failed"); } }),
    },
  ];

  for (const definition of cases) {
    const input = makeCandidateAnalysisFixture(2);
    definition.mutate(input);
    await assert.rejects(
      analyzeCandidates({
        ...input,
        clientFactory: definition.clientFactory ?? (
          (entry) => makeSuccessfulClient(entry.candidate)
        ),
      }),
      (error) => error instanceof CandidateAnalysisError && error.code === definition.code,
    );
  }
});

test("requires enabled AI policy and exact trusted artifact provenance", async () => {
  const disabled = makeCandidateAnalysisFixture(1);
  disabled.policy.automation.ai.relevanceClassification = false;
  await assert.rejects(
    analyzeCandidates({
      ...disabled,
      clientFactory: (entry) => makeSuccessfulClient(entry.candidate),
    }),
    (error) => error instanceof CandidateAnalysisError && error.code === "AI_POLICY_DISABLED",
  );

  for (const mutate of [
    (input) => { input.sourceDiscoveryArtifact.repository = "attacker/gallery"; },
    (input) => { input.sourceDiscoveryArtifact.sourceSha = "f".repeat(40); },
    (input) => { input.sourceDiscoveryArtifact.digest = "sha256:invalid"; },
    (input) => { input.sourceDiscoveryArtifact.artifactName = "gallery-discovery-latest"; },
    (input) => { input.provenance.workflowPath = ".github/workflows/other.yml"; },
  ]) {
    const input = makeCandidateAnalysisFixture(1);
    mutate(input);
    await assert.rejects(
      analyzeCandidates({
        ...input,
        clientFactory: (entry) => makeSuccessfulClient(entry.candidate),
      }),
      (error) => error instanceof CandidateAnalysisError && error.code === "CANDIDATE_ANALYSIS_INPUT_INVALID",
    );
  }
});

test("CLI writes exactly the report and receipt with hashes for every input file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gallery-candidate-analysis-"));
  const input = makeCandidateAnalysisFixture(2);
  const files = {
    "discovery.json": input.discovery,
    "candidate-gates.json": input.candidateGates,
    "active.json": input.activeCatalog,
    "retired.json": input.retiredCatalog,
    "policy.json": input.policy,
    "analysis-schema.json": input.analysisSchema,
    "source-artifact.json": input.sourceDiscoveryArtifact,
  };
  try {
    await Promise.all(Object.entries(files).map(([name, value]) => (
      writeFile(path.join(root, name), `${JSON.stringify(value, null, 2)}\n`)
    )));
    const result = await main([
      "--discovery", "discovery.json",
      "--candidate-gates", "candidate-gates.json",
      "--active-catalog", "active.json",
      "--retired-catalog", "retired.json",
      "--policy", "policy.json",
      "--analysis-schema", "analysis-schema.json",
      "--source-discovery-artifact", "source-artifact.json",
      "--output-directory", "output",
      "--mode", "responses",
    ], {
      rootDirectory: root,
      environment: input.environment,
      provenance: input.provenance,
      generatedAt: "2026-08-28T12:00:00.000Z",
      clientFactory: (entry) => makeSuccessfulClient(entry.candidate),
      createInvocationId: (candidateId) => `${candidateId}-invocation`,
    });
    assert.deepEqual(await readdir(path.join(root, "output")), [
      "model-analysis-receipt.json",
      "model-analysis.json",
    ]);
    const reportBytes = await readFile(path.join(root, "output", "model-analysis.json"));
    const receipt = JSON.parse(await readFile(
      path.join(root, "output", "model-analysis-receipt.json"),
      "utf8",
    ));
    assert.equal(
      receipt.reportFileHash,
      `sha256:${createHash("sha256").update(reportBytes).digest("hex")}`,
    );
    const expectedFileNames = {
      discovery: "discovery.json",
      candidateGates: "candidate-gates.json",
      activeCatalog: "active.json",
      retiredCatalog: "retired.json",
      policy: "policy.json",
      analysisSchema: "analysis-schema.json",
      sourceDiscoveryArtifact: "source-artifact.json",
    };
    for (const [key, name] of Object.entries(expectedFileNames)) {
      const bytes = await readFile(path.join(root, name));
      assert.equal(
        result.report.fileHashes[key],
        `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      );
    }
    assert.equal(
      `${reportBytes}\n${JSON.stringify(receipt)}`
        .includes(input.environment.AZURE_OPENAI_BEARER_TOKEN),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed when live Azure configuration is missing or invalid", async () => {
  const cases = [
    (input) => { delete input.environment.AZURE_OPENAI_ENDPOINT; },
    (input) => { delete input.environment.AZURE_OPENAI_DEPLOYMENT; },
    (input) => { delete input.environment.AZURE_OPENAI_BEARER_TOKEN; },
    (input) => { input.environment.AZURE_OPENAI_ENDPOINT = "https://example.com"; },
  ];
  for (const mutate of cases) {
    const input = makeCandidateAnalysisFixture(1);
    mutate(input);
    await assert.rejects(
      analyzeCandidates({
        ...input,
        clientFactory: (entry) => makeSuccessfulClient(entry.candidate),
      }),
      (error) => ["AZURE_CONFIG_INVALID", "CANDIDATE_ANALYSIS_INPUT_INVALID"].includes(error.code),
    );
  }
});