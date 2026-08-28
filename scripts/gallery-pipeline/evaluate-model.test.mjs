import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  evaluateModelSet,
  modelEvaluationExitCode,
  runModelEvaluation,
} from "./evaluate-model.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const policy = Object.freeze({
  version: "1.0.0",
  evaluationThresholds: {
    relevancePrecision: 0.99,
    semanticDuplicatePrecision: 0.99,
    exactDuplicateRejectionRate: 1,
    unsupportedSummaryClaimCount: 0,
  },
});

function candidateCase(candidateId = "model-evaluation-case") {
  return {
    candidateId,
    candidate: {
      sourceId: candidateId,
      sourceType: "learn-document",
      title: "Azure Cosmos DB vector search guide",
      description: "A guide to Azure Cosmos DB vector search.",
      canonicalUrl: `https://example.com/${candidateId}`,
      publisher: "Example publisher",
      retrievedContent: [{
        url: `https://example.com/${candidateId}`,
        text: "Azure Cosmos DB supports vector search. The guide covers vector policies.",
      }],
    },
  };
}

function labelFor(candidateId, overrides = {}) {
  return {
    candidateId,
    category: "non-duplicate",
    relevanceMaterial: true,
    duplicateClassification: "unique",
    recommendation: "keep",
    grounding: "not-evaluated",
    ...overrides,
  };
}

function evaluationDocuments(cases, labels) {
  return {
    candidateSet: { version: "1.0.0", cases },
    labelSet: { version: "1.0.0", labels },
  };
}

function analysisOutput(request, input, options = {}) {
  const material = options.material ?? true;
  const classification = options.duplicateClassification ?? "unique";
  const score = classification === "duplicate" ? 0.99 : classification === "indeterminate" ? 0.9 : 0.1;
  const evidence = material
    ? [{ url: input.candidate.canonicalUrl, excerpt: "Azure Cosmos DB supports vector search." }]
    : [];
  return {
    invocationId: request.invocationId,
    candidateId: input.candidate.candidateId,
    relevance: {
      score: material ? 0.99 : 0.1,
      material,
      evidence,
      rationale: material ? "Azure Cosmos DB is central." : "Azure Cosmos DB is incidental.",
    },
    duplicate: {
      score,
      classification,
      matchedEntryId: options.matchedEntryId ?? null,
      evidence: options.duplicateEvidence ?? [],
    },
    quality: { passes: true, flags: [] },
    recommendation: options.recommendation ?? "keep",
    reasonCodes: options.reasonCodes ?? [],
    generatedSummary: options.generatedSummary ?? null,
  };
}

function staticDecisionClient(options = {}, requests = []) {
  return {
    async invoke(request) {
      requests.push(request);
      const input = JSON.parse(request.input);
      if (request.operation === "content-analysis") {
        return { outputText: JSON.stringify(analysisOutput(request, input, options)) };
      }
      const claims = input.proposedSummary
        .split(/(?<=[.!?])\s+/)
        .filter(Boolean)
        .map((claim) => ({
          claim,
          entailed: true,
          evidence: [{
            url: input.candidate.canonicalUrl,
            excerpt: claim === "Azure Cosmos DB supports vector search."
              ? "Azure Cosmos DB supports vector search."
              : "The guide covers vector policies.",
          }],
        }));
      return {
        outputText: JSON.stringify({
          invocationId: request.invocationId,
          candidateId: input.candidate.candidateId,
          summary: input.proposedSummary,
          grounding: { score: 1, claims },
        }),
      };
    },
  };
}

test("release fixtures keep immutable candidate inputs separate from independent labels", async () => {
  const [candidateText, labelText] = await Promise.all([
    readFile(path.join(
      rootDir,
      "scripts/gallery-pipeline/fixtures/model-evaluation/candidates.json",
    ), "utf8"),
    readFile(path.join(
      rootDir,
      "scripts/gallery-pipeline/fixtures/model-evaluation/labels.json",
    ), "utf8"),
  ]);
  const candidates = JSON.parse(candidateText);
  const labels = JSON.parse(labelText);
  const candidateIds = candidates.cases.map((fixtureCase) => fixtureCase.candidateId).sort();
  const labelIds = labels.labels.map((label) => label.candidateId).sort();

  assert.equal(candidates.cases.length, 15);
  assert.deepEqual(candidateIds, labelIds);
  assert.ok(candidateIds.every((candidateId) => /^eval-[a-f0-9]{8}$/.test(candidateId)));
  assert.ok(candidates.cases.every((fixtureCase) => (
    /^src-[a-f0-9]{8}$/.test(fixtureCase.candidate.sourceId) ||
    /^[A-Za-z0-9_-]{11}$/.test(fixtureCase.candidate.sourceId)
  )));
  assert.ok(candidates.cases.every((fixtureCase) => !Object.hasOwn(fixtureCase, "category")));
  assert.equal(candidateText.includes('"responses"'), false);
  assert.equal(candidateText.includes('"expected'), false);
  assert.ok(labels.labels.every((label) => (
    !Object.hasOwn(label, "candidate") && typeof label.category === "string"
  )));
  assert.equal(labelText.includes("generatedSummary"), false);
  assert.equal(labelText.includes("retrievedContent"), false);
});

test("workflow isolates real-model access to trusted default-branch dispatches", async () => {
  const workflow = await readFile(
    path.join(rootDir, ".github/workflows/evaluate-pipeline-policy.yml"),
    "utf8",
  );
  const trustedJob = workflow.slice(workflow.indexOf("  trusted-model-evaluation:"));
  const trustedCondition = trustedJob.match(/    if: >-\r?\n([\s\S]*?)    runs-on:/)?.[1] ?? "";

  assert.match(workflow, /ENABLE_GALLERY_MODEL_EVALUATION == 'true'/);
  assert.doesNotMatch(workflow, /^  (?:pull_request|merge_group):/m);
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.match(trustedCondition, /github\.event_name == 'workflow_dispatch'/);
  assert.match(
    trustedCondition,
    /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/,
  );
  assert.match(trustedJob, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  for (const variable of [
    "AZURE_CLIENT_ID",
    "AZURE_TENANT_ID",
    "AZURE_SUBSCRIPTION_ID",
    "AZURE_OPENAI_ENDPOINT",
    "AZURE_OPENAI_DEPLOYMENT",
  ]) {
    assert.equal(trustedCondition.includes(`vars.${variable} != ''`), false);
    assert.match(trustedJob, new RegExp(`${variable}: \\$\\{\\{ vars\\.${variable} \\}\\}`));
    assert.match(trustedJob, new RegExp(`\\b${variable}\\b`));
  }
  assert.match(trustedJob, /Validate live evaluation configuration/);
  assert.match(trustedJob, /Live model evaluation is enabled but required variables are missing/);
  assert.match(trustedJob, /exit 1/);
  assert.match(workflow, /environment: gallery-model-evaluation/);
  assert.equal(workflow.match(/id-token:\s*write/g)?.length, 1);
  assert.match(workflow, /azure\/login@7ddb5af1ef8758cf1353cf3b42f940aee27ba21c/);
  assert.match(workflow, /az account get-access-token/);
  assert.match(workflow, /token_resource="https:\/\/cognitiveservices\.azure\.com\/"/);
  assert.match(workflow, /echo "::add-mask::\$token"/);
  assert.equal(workflow.includes("GITHUB_ENV"), false);
  assert.match(workflow, /Upload model evaluation report\s+if: always\(\)/);
  assert.match(workflow, /Run deterministic policy and model fixtures\s+run: npm run gallery:test/);
  assert.doesNotMatch(workflow, /\baz\s+[^\r\n]*(?:create|update|delete|set)\b/);
});

test("release candidates pass deterministic gates against the complete catalog", async () => {
  const [candidateSet, labelSet, activeCatalog, retiredCatalog, releasePolicy] = await Promise.all([
    readFile(path.join(
      rootDir,
      "scripts/gallery-pipeline/fixtures/model-evaluation/candidates.json",
    ), "utf8").then(JSON.parse),
    readFile(path.join(
      rootDir,
      "scripts/gallery-pipeline/fixtures/model-evaluation/labels.json",
    ), "utf8").then(JSON.parse),
    readFile(path.join(rootDir, "static/templates.json"), "utf8").then(JSON.parse),
    readFile(path.join(rootDir, "static/retired-templates.json"), "utf8").then(JSON.parse),
    readFile(path.join(rootDir, ".github/gallery-pipeline/policy.json"), "utf8").then(JSON.parse),
  ]);
  const report = await evaluateModelSet({
    candidateSet,
    labelSet,
    catalog: [...activeCatalog, ...retiredCatalog.entries],
    policy: releasePolicy,
    client: { async invoke() { throw new Error("stop after deterministic gates"); } },
    provenance: {},
  });
  const deterministicResults = report.caseResults.filter((result) => result.deterministic === true);

  assert.equal(report.cases.attempted, 15);
  assert.equal(deterministicResults.length, 4);
  assert.ok(deterministicResults.every((result) => result.passed));
  assert.ok(report.caseResults.every((result) => (
    result.error === null || result.error.code === "AI_PROVIDER_FAILURE"
  )));
});

test("does not feed labels to prompts and scores grounded output without comparing prose", async () => {
  const fixtureCase = candidateCase("eval-0d4a7c91");
  fixtureCase.candidate.sourceId = "src-3e8b16f2";
  const documents = evaluationDocuments(
    [fixtureCase],
    [labelFor(fixtureCase.candidateId, {
      category: "label-only-category-canary",
      recommendation: "publish",
      grounding: "evaluated",
    })],
  );
  const requests = [];
  const generatedSummary = "Azure Cosmos DB supports vector search. The guide covers vector policies.";
  const report = await evaluateModelSet({
    ...documents,
    catalog: [],
    policy,
    client: staticDecisionClient({ recommendation: "publish", generatedSummary }, requests),
    createInvocationId: (candidateId, invocation) => `${candidateId}-${invocation}`,
    provenance: {},
    generatedAt: "2026-08-28T00:00:00.000Z",
  });

  assert.equal(report.caseResults[0].passed, true);
  assert.deepEqual(report.caseResults[0].actual, {
    relevanceMaterial: true,
    duplicateClassification: "unique",
    recommendation: "publish",
    grounding: "evaluated",
    summaryGenerated: true,
  });
  assert.equal(JSON.stringify(report).includes(generatedSummary), false);
  for (const request of requests) {
    const input = JSON.parse(request.input);
    assert.equal(Object.hasOwn(input, "labels"), false);
    assert.equal(Object.hasOwn(input, "expected"), false);
    assert.equal(Object.hasOwn(input, "category"), false);
    assert.equal(request.input.includes("duplicateClassification"), false);
    assert.equal(request.input.includes("relevanceMaterial"), false);
    assert.equal(JSON.stringify(request).includes("label-only-category-canary"), false);
  }
  assert.equal(Object.isFrozen(documents.candidateSet), true);
  assert.equal(Object.isFrozen(documents.candidateSet.cases[0].candidate), true);
  assert.equal(Object.isFrozen(documents.labelSet), true);
});

test("sends the complete catalog through deterministic bounded batches", async () => {
  const fixtureCase = candidateCase("full-catalog-case");
  const documents = evaluationDocuments([fixtureCase], [labelFor(fixtureCase.candidateId)]);
  const catalog = Array.from({ length: 41 }, (_, index) => ({
    id: `catalog-${index}`,
    title: `Catalog entry ${index}`,
    description: `Description ${index}`,
    source: `https://example.com/catalog/${index}`,
  }));
  const requests = [];
  const report = await evaluateModelSet({
    ...documents,
    catalog,
    policy,
    client: staticDecisionClient({}, requests),
    provenance: {},
  });
  const contentInputs = requests
    .filter((request) => request.operation === "content-analysis")
    .map((request) => JSON.parse(request.input));

  assert.equal(report.caseResults[0].passed, true);
  assert.equal(contentInputs.length, 2);
  assert.ok(contentInputs.every((input) => input.catalogCoverage.batchCount === 2));
  assert.ok(contentInputs.every((input) => input.catalogCoverage.totalEntries === 41));
  assert.equal(contentInputs.reduce((total, input) => total + input.catalog.length, 0), 41);
});

test("runs exact duplicate gates without invoking the configured model client", async () => {
  const fixtureCase = candidateCase("exact-catalog-case");
  const documents = evaluationDocuments(
    [fixtureCase],
    [labelFor(fixtureCase.candidateId, {
      category: "exact-duplicate",
      duplicateClassification: "duplicate",
      recommendation: "reject",
    })],
  );
  const catalog = [{
    id: "existing-entry",
    title: "Existing entry",
    description: "A guide to Azure Cosmos DB vector search.",
    source: fixtureCase.candidate.canonicalUrl,
  }];
  const report = await evaluateModelSet({
    ...documents,
    catalog,
    policy,
    client: { async invoke() { throw new Error("model must not run"); } },
    provenance: {},
  });

  assert.equal(report.caseResults[0].passed, true);
  assert.equal(report.caseResults[0].deterministic, true);
  assert.match(report.caseResults[0].invocations.relevance, /^deterministic-exact-duplicate-/);
});

test("attempts every case and maps failures or partial completion to a nonzero exit", async () => {
  const passing = candidateCase("passing-case");
  const failing = candidateCase("failing-case");
  const documents = evaluationDocuments(
    [passing, failing],
    [labelFor(passing.candidateId), labelFor(failing.candidateId)],
  );
  const report = await evaluateModelSet({
    ...documents,
    catalog: [],
    policy,
    clientFactory: (fixtureCase) => (
      fixtureCase.candidateId === passing.candidateId
        ? staticDecisionClient()
        : { async invoke() { throw new Error("provider unavailable"); } }
    ),
    provenance: {},
  });

  assert.deepEqual(report.cases, {
    required: 2,
    attempted: 2,
    completed: 1,
    passed: 1,
    failed: 1,
    partial: true,
  });
  assert.equal(report.caseResults[1].error.code, "AI_PROVIDER_FAILURE");
  assert.equal(report.passed, false);
  assert.equal(modelEvaluationExitCode(report), 1);
  assert.equal(modelEvaluationExitCode({ passed: true }), 0);
});

test("CLI writes a failure report and exits nonzero when Azure configuration is incomplete", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "gallery-model-evaluation-cli-"));
  const outputPath = path.join(temporaryRoot, "failure-report.json");
  const environment = { ...process.env };
  delete environment.AZURE_OPENAI_ENDPOINT;
  delete environment.AZURE_OPENAI_DEPLOYMENT;
  delete environment.AZURE_OPENAI_BEARER_TOKEN;
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./evaluate-model.mjs", import.meta.url)), "--output", outputPath],
    { cwd: rootDir, encoding: "utf8", env: environment },
  );
  const report = JSON.parse(await readFile(outputPath, "utf8"));

  assert.equal(result.status, 1);
  assert.equal(report.passed, false);
  assert.equal(report.fatalError.code, "MODEL_EVALUATION_INPUT_INVALID");
  assert.equal(JSON.stringify(report).includes("AZURE_OPENAI_BEARER_TOKEN"), false);
});

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("writes token-free provenance hashes and identifiers", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "gallery-model-evaluation-"));
  const fixtureCase = candidateCase("provenance-case");
  const documents = evaluationDocuments([fixtureCase], [labelFor(fixtureCase.candidateId)]);
  await Promise.all([
    writeJson(path.join(temporaryRoot, "candidates.json"), documents.candidateSet),
    writeJson(path.join(temporaryRoot, "labels.json"), documents.labelSet),
    writeJson(path.join(temporaryRoot, "active.json"), []),
    writeJson(path.join(temporaryRoot, "retired.json"), { version: "1.0.0", entries: [] }),
    writeJson(path.join(temporaryRoot, "policy.json"), policy),
  ]);
  const token = "token-that-must-never-be-reported";
  const outputPath = path.join(temporaryRoot, "report.json");
  const environment = {
    AZURE_OPENAI_ENDPOINT: "https://fixture.openai.azure.com/",
    AZURE_OPENAI_DEPLOYMENT: "gallery-evaluator",
    AZURE_OPENAI_BEARER_TOKEN: token,
    GITHUB_RUN_ID: "12345",
  };
  const { report } = await runModelEvaluation({
    rootDir: temporaryRoot,
    candidatesPath: "candidates.json",
    labelsPath: "labels.json",
    activeCatalogPath: "active.json",
    retiredCatalogPath: "retired.json",
    policyPath: "policy.json",
    outputPath,
    environment,
    commitId: "0123456789abcdef",
    client: staticDecisionClient(),
    generatedAt: "2026-08-28T00:00:00.000Z",
  });
  const reportText = await readFile(outputPath, "utf8");

  assert.equal(reportText.includes(token), false);
  assert.equal(report.provenance.commitId, "0123456789abcdef");
  assert.equal(report.provenance.deployment.deploymentId, "gallery-evaluator");
  assert.equal(report.provenance.workflowRunId, "12345");
  assert.match(report.provenance.input.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(report.provenance.labels.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(report.provenance.catalog.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(report.provenance.policy.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(report.provenance.prompts.contentAnalysis.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(report.provenance.prompts.summaryGrounding.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(report.provenance.deployment.endpointSha256, /^sha256:[a-f0-9]{64}$/);
});