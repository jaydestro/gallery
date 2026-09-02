import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  ANALYSIS_SYSTEM_INSTRUCTIONS,
  AiAnalysisError,
} from "./analyze-content.mjs";
import {
  createAzureOpenAIClient,
  prepareFixtureAnalysisCase,
  runAiAnalysis,
} from "./ai-analysis.mjs";
import { GROUNDING_SYSTEM_INSTRUCTIONS } from "./verify-summary.mjs";

const execFileAsync = promisify(execFile);
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(moduleDirectory, "..", "..");
const REPORT_VERSION = "1.0.0";
const EXACT_DUPLICATE_CATEGORIES = new Set(["exact-duplicate", "canonical-duplicate"]);
const DUPLICATE_CLASSIFICATIONS = new Set(["unique", "duplicate", "indeterminate"]);
const RECOMMENDATIONS = new Set(["publish", "update", "keep", "reject", "quarantine", "retire"]);
const GROUNDING_STATUSES = new Set(["evaluated", "not-evaluated"]);
const API_MODES = new Set(["responses", "chat", "mai-chat"]);

const DEFAULT_PATHS = Object.freeze({
  candidates: path.join("scripts", "gallery-pipeline", "fixtures", "model-evaluation", "candidates.json"),
  labels: path.join("scripts", "gallery-pipeline", "fixtures", "model-evaluation", "labels.json"),
  activeCatalog: path.join("static", "templates.json"),
  retiredCatalog: path.join("static", "retired-templates.json"),
  policy: path.join(".github", "gallery-pipeline", "policy.json"),
  output: path.join("artifacts", "model-evaluation", "report.json"),
});

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function evaluationInputError(message) {
  return new AiAnalysisError("MODEL_EVALUATION_INPUT_INVALID", message);
}

function requireExactKeys(value, name, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw evaluationInputError(`${name} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw evaluationInputError(`${name} must contain exactly: ${expected.join(", ")}.`);
  }
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw evaluationInputError(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function requireUniqueIds(items, name) {
  const ids = new Set();
  for (const [index, item] of items.entries()) {
    const candidateId = requireString(item.candidateId, `${name}[${index}].candidateId`);
    if (ids.has(candidateId)) throw evaluationInputError(`${name} contains duplicate ID ${candidateId}.`);
    ids.add(candidateId);
  }
  return ids;
}

function validateCandidateSet(candidateSet) {
  requireExactKeys(candidateSet, "candidate set", ["cases", "version"]);
  requireString(candidateSet.version, "candidate set version");
  if (!Array.isArray(candidateSet.cases) || candidateSet.cases.length === 0) {
    throw evaluationInputError("candidate set cases must be a non-empty array.");
  }
  for (const [index, fixtureCase] of candidateSet.cases.entries()) {
    requireExactKeys(fixtureCase, `candidate set cases[${index}]`, ["candidate", "candidateId"]);
    if (!fixtureCase.candidate || typeof fixtureCase.candidate !== "object" || Array.isArray(fixtureCase.candidate)) {
      throw evaluationInputError(`candidate set cases[${index}].candidate must be an object.`);
    }
  }
  return requireUniqueIds(candidateSet.cases, "candidate set cases");
}

function validateLabelSet(labelSet) {
  requireExactKeys(labelSet, "label set", ["labels", "version"]);
  requireString(labelSet.version, "label set version");
  if (!Array.isArray(labelSet.labels) || labelSet.labels.length === 0) {
    throw evaluationInputError("label set labels must be a non-empty array.");
  }
  for (const [index, label] of labelSet.labels.entries()) {
    requireExactKeys(label, `label set labels[${index}]`, [
      "candidateId",
      "category",
      "duplicateClassification",
      "grounding",
      "recommendation",
      "relevanceMaterial",
    ]);
    requireString(label.category, `label set labels[${index}].category`);
    if (typeof label.relevanceMaterial !== "boolean") {
      throw evaluationInputError(`label set labels[${index}].relevanceMaterial must be boolean.`);
    }
    if (!DUPLICATE_CLASSIFICATIONS.has(label.duplicateClassification)) {
      throw evaluationInputError(`label set labels[${index}] has an invalid duplicate classification.`);
    }
    if (!RECOMMENDATIONS.has(label.recommendation)) {
      throw evaluationInputError(`label set labels[${index}] has an invalid recommendation.`);
    }
    if (!GROUNDING_STATUSES.has(label.grounding)) {
      throw evaluationInputError(`label set labels[${index}] has an invalid grounding status.`);
    }
  }
  return requireUniqueIds(labelSet.labels, "label set labels");
}

function validateEvaluationInputs(candidateSet, labelSet) {
  const candidateIds = validateCandidateSet(candidateSet);
  const labelIds = validateLabelSet(labelSet);
  if (candidateSet.version !== labelSet.version) {
    throw evaluationInputError("candidate and label set versions must match.");
  }
  const missingLabels = [...candidateIds].filter((candidateId) => !labelIds.has(candidateId));
  const missingCandidates = [...labelIds].filter((candidateId) => !candidateIds.has(candidateId));
  if (missingLabels.length > 0 || missingCandidates.length > 0) {
    throw evaluationInputError(
      `candidate and label IDs must match exactly; missing labels: ${missingLabels.join(", ") || "none"}; ` +
      `missing candidates: ${missingCandidates.join(", ") || "none"}.`,
    );
  }
}

function activeCatalogRecords(value) {
  if (!Array.isArray(value)) throw evaluationInputError("active catalog must be an array.");
  return value;
}

function retiredCatalogRecords(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.entries)) {
    throw evaluationInputError("retired catalog must contain an entries array.");
  }
  return value.entries.map((entry) => entry?.record ?? entry);
}

function safeError(error, secrets = []) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, "[REDACTED]");
  }
  return {
    code: typeof error?.code === "string" ? error.code : "MODEL_EVALUATION_ERROR",
    message,
  };
}

function divide(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function decisionFor(result) {
  return {
    relevanceMaterial: result.analysis.relevance.material,
    duplicateClassification: result.analysis.duplicate.classification,
    recommendation: result.analysis.recommendation,
    grounding: result.evaluationState.grounding,
    summaryGenerated: result.analysis.generatedSummary !== null,
  };
}

function expectedDecision(label) {
  return {
    relevanceMaterial: label.relevanceMaterial,
    duplicateClassification: label.duplicateClassification,
    recommendation: label.recommendation,
    grounding: label.grounding,
  };
}

function decisionMismatches(actual, expected) {
  return Object.keys(expected).filter((key) => actual?.[key] !== expected[key]);
}

function thresholdPassed(value, threshold) {
  return Number.isFinite(value) && value >= threshold;
}

function scoreEvaluation(caseResults, policy) {
  const completed = caseResults.filter((result) => result.actual !== null);
  const isExactDuplicate = (result) => (
    result.deterministic === true || EXACT_DUPLICATE_CATEGORIES.has(result.category)
  );
  const exactDuplicates = caseResults.filter(isExactDuplicate);
  const semanticCases = caseResults.filter((result) => !isExactDuplicate(result));
  const relevanceCorrect = completed.filter((result) => (
    result.actual.relevanceMaterial === result.expected.relevanceMaterial
  )).length;
  const recommendationCorrect = completed.filter((result) => (
    result.actual.recommendation === result.expected.recommendation
  )).length;
  const duplicateCorrect = completed.filter((result) => (
    result.actual.duplicateClassification === result.expected.duplicateClassification
  )).length;
  const groundingCorrect = completed.filter((result) => (
    result.actual.grounding === result.expected.grounding
  )).length;
  const relevancePredictedPositive = completed.filter((result) => result.actual.relevanceMaterial).length;
  const relevanceTruePositive = completed.filter((result) => (
    result.actual.relevanceMaterial && result.expected.relevanceMaterial
  )).length;
  const semanticPredictedDuplicate = semanticCases.filter((result) => (
    result.actual?.duplicateClassification === "duplicate"
  )).length;
  const semanticTrueDuplicate = semanticCases.filter((result) => (
    result.actual?.duplicateClassification === "duplicate" &&
    result.expected.duplicateClassification === "duplicate"
  )).length;
  const exactDuplicateRejections = exactDuplicates.filter((result) => (
    result.actual?.duplicateClassification === "duplicate" && result.actual?.recommendation === "reject"
  )).length;
  const unsupportedSummaryClaimCount = caseResults.filter((result) => (
    result.error?.code === "UNSUPPORTED_SUMMARY_CLAIM"
  )).length;

  const metrics = {
    relevancePrecision: divide(relevanceTruePositive, relevancePredictedPositive),
    semanticDuplicatePrecision: divide(semanticTrueDuplicate, semanticPredictedDuplicate),
    exactDuplicateRejectionRate: divide(exactDuplicateRejections, exactDuplicates.length),
    unsupportedSummaryClaimCount,
  };
  const thresholds = policy?.evaluationThresholds;
  if (!thresholds) throw evaluationInputError("policy evaluationThresholds are required.");
  const thresholdResults = {
    relevancePrecision: thresholdPassed(metrics.relevancePrecision, thresholds.relevancePrecision),
    semanticDuplicatePrecision: thresholdPassed(
      metrics.semanticDuplicatePrecision,
      thresholds.semanticDuplicatePrecision,
    ),
    exactDuplicateRejectionRate: thresholdPassed(
      metrics.exactDuplicateRejectionRate,
      thresholds.exactDuplicateRejectionRate,
    ),
    unsupportedSummaryClaimCount:
      metrics.unsupportedSummaryClaimCount <= thresholds.unsupportedSummaryClaimCount,
  };

  return {
    classifications: {
      relevance: {
        correct: relevanceCorrect,
        total: caseResults.length,
        accuracy: divide(relevanceCorrect, caseResults.length),
        precision: metrics.relevancePrecision,
      },
      recommendation: {
        correct: recommendationCorrect,
        total: caseResults.length,
        accuracy: divide(recommendationCorrect, caseResults.length),
      },
    },
    duplicate: {
      correct: duplicateCorrect,
      total: caseResults.length,
      accuracy: divide(duplicateCorrect, caseResults.length),
      semanticPrecision: metrics.semanticDuplicatePrecision,
      exactRejectionRate: metrics.exactDuplicateRejectionRate,
    },
    grounding: {
      correct: groundingCorrect,
      total: caseResults.length,
      accuracy: divide(groundingCorrect, caseResults.length),
      unsupportedSummaryClaimCount,
    },
    metrics,
    thresholds,
    thresholdResults,
  };
}

export async function evaluateModelSet({
  candidateSet,
  labelSet,
  catalog,
  policy,
  client,
  clientFactory,
  createInvocationId,
  provenance,
  generatedAt = new Date().toISOString(),
}) {
  deepFreeze(candidateSet);
  deepFreeze(labelSet);
  deepFreeze(catalog);
  deepFreeze(policy);
  validateEvaluationInputs(candidateSet, labelSet);
  if (!Array.isArray(catalog)) throw evaluationInputError("combined catalog must be an array.");
  const labelsById = new Map(labelSet.labels.map((label) => [label.candidateId, label]));
  const caseResults = [];

  for (const fixtureCase of candidateSet.cases) {
    const label = labelsById.get(fixtureCase.candidateId);
    const expected = expectedDecision(label);
    let actual = null;
    let error = null;
    let invocations = null;
    let deterministic = null;
    try {
      const prepared = prepareFixtureAnalysisCase(fixtureCase, catalog);
      let invocationCount = 0;
      const result = await runAiAnalysis({
        candidate: prepared.candidate,
        catalog,
        client: clientFactory ? clientFactory(fixtureCase) : client,
        createInvocationId: () => (
          createInvocationId
            ? createInvocationId(fixtureCase.candidateId, ++invocationCount)
            : `${fixtureCase.candidateId}-${randomUUID()}`
        ),
        deterministicGate: prepared.deterministicGate,
      });
      actual = decisionFor(result);
      invocations = result.invocations;
      deterministic = result.deterministic;
    } catch (caught) {
      error = safeError(caught);
    }
    const mismatches = error ? ["execution"] : decisionMismatches(actual, expected);
    caseResults.push({
      candidateId: fixtureCase.candidateId,
      category: label.category,
      status: error ? "failed" : "completed",
      passed: !error && mismatches.length === 0,
      expected,
      actual,
      mismatches,
      error,
      invocations,
      deterministic,
    });
  }

  const scores = scoreEvaluation(caseResults, policy);
  const completedCases = caseResults.filter((result) => result.status === "completed").length;
  const passedCases = caseResults.filter((result) => result.passed).length;
  const report = {
    version: REPORT_VERSION,
    generatedAt,
    provenance,
    cases: {
      required: candidateSet.cases.length,
      attempted: caseResults.length,
      completed: completedCases,
      passed: passedCases,
      failed: caseResults.length - passedCases,
      partial: completedCases !== candidateSet.cases.length,
    },
    scores,
    caseResults,
    passed: (
      completedCases === candidateSet.cases.length &&
      passedCases === candidateSet.cases.length &&
      Object.values(scores.thresholdResults).every(Boolean)
    ),
  };
  return deepFreeze(report);
}

async function readJsonSnapshot(filePath, name) {
  const bytes = await readFile(filePath);
  let data;
  try {
    data = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw evaluationInputError(`${name} must contain valid JSON.`);
  }
  return deepFreeze({
    data: deepFreeze(data),
    sha256: sha256(bytes),
  });
}

function relativePath(rootDir, filePath) {
  return path.relative(rootDir, filePath).replaceAll(path.sep, "/");
}

async function resolveCommitId(rootDir, environment, override) {
  if (override) return override;
  if (typeof environment.GITHUB_SHA === "string" && environment.GITHUB_SHA.trim()) {
    return environment.GITHUB_SHA.trim();
  }
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: rootDir,
      windowsHide: true,
    });
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

function resolvePath(rootDir, configuredPath, defaultPath) {
  return path.resolve(rootDir, configuredPath ?? defaultPath);
}

function deploymentProvenance(environment, mode) {
  if (!API_MODES.has(mode)) {
    throw evaluationInputError("API mode must be responses, chat, or mai-chat.");
  }
  const deploymentId = requireString(environment.AZURE_OPENAI_DEPLOYMENT, "AZURE_OPENAI_DEPLOYMENT");
  const endpoint = requireString(environment.AZURE_OPENAI_ENDPOINT, "AZURE_OPENAI_ENDPOINT");
  let endpointOrigin;
  try {
    endpointOrigin = new URL(endpoint).origin;
  } catch {
    throw evaluationInputError("AZURE_OPENAI_ENDPOINT must be a valid URL.");
  }
  return {
    deploymentId,
    mode,
    endpointSha256: sha256(endpointOrigin),
  };
}

function redactReport(report, secrets) {
  if (typeof report === "string") {
    return secrets.reduce(
      (value, secret) => (secret ? value.replaceAll(secret, "[REDACTED]") : value),
      report,
    );
  }
  if (Array.isArray(report)) return report.map((value) => redactReport(value, secrets));
  if (report && typeof report === "object") {
    return Object.fromEntries(
      Object.entries(report).map(([key, value]) => [key, redactReport(value, secrets)]),
    );
  }
  return report;
}

async function writeReport(outputPath, report) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

export function modelEvaluationExitCode(report) {
  return report?.passed === true ? 0 : 1;
}

export async function runModelEvaluation(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? DEFAULT_ROOT);
  const environment = options.environment ?? process.env;
  const paths = {
    candidates: resolvePath(rootDir, options.candidatesPath, DEFAULT_PATHS.candidates),
    labels: resolvePath(rootDir, options.labelsPath, DEFAULT_PATHS.labels),
    activeCatalog: resolvePath(rootDir, options.activeCatalogPath, DEFAULT_PATHS.activeCatalog),
    retiredCatalog: resolvePath(rootDir, options.retiredCatalogPath, DEFAULT_PATHS.retiredCatalog),
    policy: resolvePath(rootDir, options.policyPath, DEFAULT_PATHS.policy),
    output: resolvePath(rootDir, options.outputPath, DEFAULT_PATHS.output),
  };
  const [candidateSnapshot, labelSnapshot, activeSnapshot, retiredSnapshot, policySnapshot] =
    await Promise.all([
      readJsonSnapshot(paths.candidates, "candidate set"),
      readJsonSnapshot(paths.labels, "label set"),
      readJsonSnapshot(paths.activeCatalog, "active catalog"),
      readJsonSnapshot(paths.retiredCatalog, "retired catalog"),
      readJsonSnapshot(paths.policy, "policy"),
    ]);
  validateEvaluationInputs(candidateSnapshot.data, labelSnapshot.data);
  const activeCatalog = activeCatalogRecords(activeSnapshot.data);
  const retiredCatalog = retiredCatalogRecords(retiredSnapshot.data);
  const catalog = deepFreeze([...activeCatalog, ...retiredCatalog]);
  const mode = options.mode ?? environment.AZURE_OPENAI_MODE ?? "responses";
  const deployment = deploymentProvenance(environment, mode);
  const policyId = requireString(policySnapshot.data.version, "policy version");
  const commitId = await resolveCommitId(rootDir, environment, options.commitId);
  const provenance = deepFreeze({
    input: {
      id: "gallery-model-evaluation-candidates",
      version: candidateSnapshot.data.version,
      path: relativePath(rootDir, paths.candidates),
      sha256: candidateSnapshot.sha256,
    },
    labels: {
      id: "gallery-model-evaluation-labels",
      version: labelSnapshot.data.version,
      path: relativePath(rootDir, paths.labels),
      sha256: labelSnapshot.sha256,
    },
    catalog: {
      id: "gallery-active-and-retired-catalog",
      activeEntries: activeCatalog.length,
      retiredEntries: retiredCatalog.length,
      totalEntries: catalog.length,
      sha256: sha256(`${activeSnapshot.sha256}\n${retiredSnapshot.sha256}`),
    },
    policy: {
      id: policyId,
      path: relativePath(rootDir, paths.policy),
      sha256: policySnapshot.sha256,
    },
    prompts: {
      contentAnalysis: {
        id: "gallery-content-analysis",
        sha256: sha256(ANALYSIS_SYSTEM_INSTRUCTIONS),
      },
      summaryGrounding: {
        id: "gallery-summary-grounding",
        sha256: sha256(GROUNDING_SYSTEM_INSTRUCTIONS),
      },
    },
    commitId,
    deployment,
    workflowRunId: environment.GITHUB_RUN_ID ?? null,
  });
  const azureClient = options.client ?? createAzureOpenAIClient({ environment, mode });
  const report = await evaluateModelSet({
    candidateSet: candidateSnapshot.data,
    labelSet: labelSnapshot.data,
    catalog,
    policy: policySnapshot.data,
    client: azureClient,
    clientFactory: options.clientFactory,
    createInvocationId: options.createInvocationId,
    provenance,
    generatedAt: options.generatedAt,
  });
  const redactedReport = deepFreeze(redactReport(report, [environment.AZURE_OPENAI_BEARER_TOKEN]));
  await writeReport(paths.output, redactedReport);
  return { report: redactedReport, outputPath: paths.output };
}

function parseArguments(argv) {
  const options = {};
  const names = new Map([
    ["--candidates", "candidatesPath"],
    ["--labels", "labelsPath"],
    ["--active-catalog", "activeCatalogPath"],
    ["--retired-catalog", "retiredCatalogPath"],
    ["--policy", "policyPath"],
    ["--output", "outputPath"],
    ["--mode", "mode"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const name = names.get(argv[index]);
    if (!name || index + 1 >= argv.length) {
      throw evaluationInputError(`Unknown or incomplete argument: ${argv[index] ?? ""}.`);
    }
    options[name] = argv[++index];
  }
  return options;
}

async function main() {
  let options = {};
  try {
    options = parseArguments(process.argv.slice(2));
    const { report, outputPath } = await runModelEvaluation(options);
    console.log(JSON.stringify({ passed: report.passed, cases: report.cases, outputPath }, null, 2));
    process.exitCode = modelEvaluationExitCode(report);
  } catch (error) {
    const outputPath = resolvePath(DEFAULT_ROOT, options.outputPath, DEFAULT_PATHS.output);
    const report = {
      version: REPORT_VERSION,
      generatedAt: new Date().toISOString(),
      passed: false,
      fatalError: safeError(error, [process.env.AZURE_OPENAI_BEARER_TOKEN]),
    };
    await writeReport(outputPath, report);
    console.error(JSON.stringify(report, null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}