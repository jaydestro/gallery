import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  AiAnalysisError,
  analyzeContent,
} from "./analyze-content.mjs";
import { CANDIDATE_SCHEMA_VERSION, normalizeCandidate } from "./normalize.mjs";
import { canonicalizeUrl } from "./shared/canonicalize.mjs";
import { verifySummary } from "./verify-summary.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(moduleDirectory, "..", "..");
const ANALYSIS_VERSION = "1.0.0";
const AZURE_CHAT_API_VERSION = "2024-10-21";

const analysisSchema = JSON.parse(await readFile(
  path.join(DEFAULT_ROOT, ".github", "gallery-pipeline", "analysis.schema.json"),
  "utf8",
));
const finalAjv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
addFormats(finalAjv);
const validateFinalSchema = finalAjv.compile(analysisSchema);

function schemaMessage(validate) {
  return (validate.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("; ");
}

export function validateFinalAnalysis(analysis) {
  if (!validateFinalSchema(analysis)) {
    throw new AiAnalysisError(
      "ANALYSIS_SCHEMA_INVALID",
      `Final analysis failed strict analysis.schema validation: ${schemaMessage(validateFinalSchema)}`,
    );
  }
  return analysis;
}

const DETERMINISTIC_GATE_KEYS = [
  "candidateId",
  "provenance",
  "sourceAvailability",
  "cosmosRelevance",
  "duplicateCheck",
  "normalization",
];
const GITHUB_STRONG_SIGNAL_KINDS = new Set(["sdk", "infrastructure", "code"]);
const GITHUB_CORROBORATING_SIGNAL_KINDS = new Set([
  "topic",
  "description",
  "readme",
  "official-link",
]);
const GITHUB_CORROBORATING_SIGNAL_MINIMUM = 2;
const DIRECT_RELEVANCE_REQUIREMENTS = Object.freeze({
  "blog-post": Object.freeze({
    signalKinds: new Set(["feed-entry-content"]),
    minimum: 1,
  }),
  "learn-document": Object.freeze({
    signalKinds: new Set(["learn-cosmos-section"]),
    minimum: 1,
  }),
  video: Object.freeze({
    signalKinds: new Set(["youtube-description", "youtube-transcript"]),
    minimum: 1,
  }),
});

function rejectDeterministicGate(message, details = {}) {
  throw new AiAnalysisError("DETERMINISTIC_GATE_REJECTED", message, details);
}

function requireExactObject(value, name, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    rejectDeterministicGate(`${name} must be an object.`);
  }
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  if (!isDeepStrictEqual(actualKeys, expectedKeys)) {
    rejectDeterministicGate(`${name} must contain exactly: ${expectedKeys.join(", ")}.`);
  }
  return value;
}

function validateNormalizedCandidate(candidate) {
  let normalized;
  try {
    normalized = normalizeCandidate(candidate);
  } catch (error) {
    rejectDeterministicGate("Candidate normalization/schema boundary did not pass.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!isDeepStrictEqual(candidate, normalized)) {
    rejectDeterministicGate("Candidate must exactly match the normalized candidate shape.");
  }
  return normalized;
}

function validateProvenance(candidate, provenance) {
  requireExactObject(provenance, "deterministicGate.provenance", [
    "status",
    "sourceRegistryId",
    "trusted",
  ]);
  if (provenance.status !== "passed" || provenance.trusted !== true) {
    rejectDeterministicGate("Trusted provenance/source registry did not pass.");
  }
  const sourceRegistryId = candidate.metadata?.sourceRegistryId;
  if (
    typeof sourceRegistryId !== "string" ||
    sourceRegistryId.trim() === "" ||
    provenance.sourceRegistryId !== sourceRegistryId
  ) {
    rejectDeterministicGate("Gate source registry does not match the normalized candidate.");
  }
}

function validateSourceAvailability(sourceAvailability) {
  requireExactObject(sourceAvailability, "deterministicGate.sourceAvailability", ["status"]);
  if (sourceAvailability.status !== "healthy") {
    rejectDeterministicGate("Source availability must be healthy and determinate.");
  }
}

function distinctSignalKinds(cosmosRelevance) {
  if (
    !Array.isArray(cosmosRelevance.signalKinds) ||
    cosmosRelevance.signalKinds.length === 0 ||
    cosmosRelevance.signalKinds.some((kind) => typeof kind !== "string" || kind.trim() === "")
  ) {
    rejectDeterministicGate("Deterministic Cosmos relevance requires non-empty signal kinds.");
  }
  const kinds = cosmosRelevance.signalKinds.map((kind) => kind.trim());
  if (new Set(kinds).size !== kinds.length) {
    rejectDeterministicGate("Deterministic Cosmos relevance signal kinds must be unique.");
  }
  return kinds;
}

function validateGitHubRelevance(candidate, strategy, signalKinds, evidenceTypes) {
  const requirement = strategy === "strong-signal"
    ? {
        allowedKinds: GITHUB_STRONG_SIGNAL_KINDS,
        metadataKey: "strongSignalKinds",
      }
    : strategy === "corroborating-signals"
      ? {
          allowedKinds: GITHUB_CORROBORATING_SIGNAL_KINDS,
          metadataKey: "corroboratingSignalKinds",
        }
      : null;
  if (!requirement) {
    rejectDeterministicGate("GitHub relevance must use a strong signal or corroborating signals.");
  }
  const candidateKinds = new Set(
    Array.isArray(candidate.metadata?.[requirement.metadataKey])
      ? candidate.metadata[requirement.metadataKey]
      : [],
  );
  if (
    signalKinds.some((kind) => (
      !requirement.allowedKinds.has(kind) ||
      !candidateKinds.has(kind) ||
      !evidenceTypes.has(`github-${kind}-signal`)
    ))
  ) {
    rejectDeterministicGate("GitHub candidate lacks the required deterministic Cosmos signals.");
  }
  const qualifyingKinds = signalKinds.filter((kind) => kind !== "official-link");
  if (
    (strategy === "strong-signal" && qualifyingKinds.length < 1) ||
    (strategy === "corroborating-signals" &&
      qualifyingKinds.length < GITHUB_CORROBORATING_SIGNAL_MINIMUM)
  ) {
    rejectDeterministicGate("GitHub candidate lacks the required deterministic Cosmos signals.");
  }
}

function validateDirectRelevance(candidate, strategy, signalKinds, evidenceTypes) {
  const requirement = DIRECT_RELEVANCE_REQUIREMENTS[candidate.sourceType];
  if (
    strategy !== "strong-signal" ||
    !requirement ||
    signalKinds.length < requirement.minimum ||
    signalKinds.some((kind) => (
      !requirement.signalKinds.has(kind) ||
      !evidenceTypes.has(kind)
    ))
  ) {
    rejectDeterministicGate(
      `Candidate lacks deterministic Cosmos relevance evidence for ${candidate.sourceType}.`,
    );
  }
}

function validateCosmosRelevance(candidate, cosmosRelevance) {
  requireExactObject(cosmosRelevance, "deterministicGate.cosmosRelevance", [
    "status",
    "strategy",
    "signalKinds",
  ]);
  if (cosmosRelevance.status !== "passed") {
    rejectDeterministicGate("Deterministic Cosmos relevance did not pass.");
  }
  const signalKinds = distinctSignalKinds(cosmosRelevance);
  const evidenceTypes = new Set(candidate.evidence.map((item) => item.type));
  if (["github-path", "github-repository"].includes(candidate.sourceType)) {
    validateGitHubRelevance(candidate, cosmosRelevance.strategy, signalKinds, evidenceTypes);
  } else {
    validateDirectRelevance(candidate, cosmosRelevance.strategy, signalKinds, evidenceTypes);
  }
}

function gateCatalogRecords(catalog) {
  if (Array.isArray(catalog)) return catalog;
  if (Array.isArray(catalog?.entries)) return catalog.entries.map((entry) => entry?.record ?? entry);
  rejectDeterministicGate("Catalog must be an array or contain an entries array.");
}

function canonicalRecordUrl(record) {
  const value = record?.canonicalUrl ?? record?.canonicalSource ?? record?.source;
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return canonicalizeUrl(value);
  } catch {
    return null;
  }
}

function validateDuplicateCheck(candidate, catalog, duplicateCheck) {
  requireExactObject(duplicateCheck, "deterministicGate.duplicateCheck", [
    "canonicalUrlChecked",
    "identityKeyChecked",
    "outcome",
    "status",
  ]);
  if (
    duplicateCheck.status !== "passed" ||
    duplicateCheck.identityKeyChecked !== true ||
    duplicateCheck.canonicalUrlChecked !== true
  ) {
    rejectDeterministicGate("Exact identity and canonical duplicate checks did not pass.");
  }
  if (!["unique", "duplicate-fast-path"].includes(duplicateCheck.outcome)) {
    rejectDeterministicGate("Duplicate check outcome must be unique or duplicate-fast-path.");
  }

  const matches = gateCatalogRecords(catalog).filter((record) => (
    record?.identityKey === candidate.identityKey ||
    canonicalRecordUrl(record) === candidate.canonicalUrl
  ));
  if (duplicateCheck.outcome === "unique" && matches.length > 0) {
    rejectDeterministicGate("Duplicate gate claimed unique for an exact catalog match.");
  }
  if (
    duplicateCheck.outcome === "duplicate-fast-path" &&
    !matches.some((record) => canonicalRecordUrl(record) === candidate.canonicalUrl)
  ) {
    rejectDeterministicGate("Duplicate fast-path requires an exact canonical catalog match.");
  }
}

function validateNormalization(candidate, normalization) {
  requireExactObject(normalization, "deterministicGate.normalization", ["schemaVersion", "status"]);
  if (
    normalization.status !== "passed" ||
    normalization.schemaVersion !== CANDIDATE_SCHEMA_VERSION ||
    normalization.schemaVersion !== candidate.schemaVersion
  ) {
    rejectDeterministicGate("Candidate normalization/schema boundary did not pass.");
  }
}

export function validateDeterministicGate({ candidate, catalog = [], deterministicGate }) {
  const normalizedCandidate = validateNormalizedCandidate(candidate);
  requireExactObject(deterministicGate, "deterministicGate", DETERMINISTIC_GATE_KEYS);
  if (deterministicGate.candidateId !== normalizedCandidate.identityKey) {
    rejectDeterministicGate("Gate candidate ID is stale or does not match the normalized candidate.");
  }
  validateProvenance(normalizedCandidate, deterministicGate.provenance);
  validateSourceAvailability(deterministicGate.sourceAvailability);
  validateCosmosRelevance(normalizedCandidate, deterministicGate.cosmosRelevance);
  validateDuplicateCheck(normalizedCandidate, catalog, deterministicGate.duplicateCheck);
  validateNormalization(normalizedCandidate, deterministicGate.normalization);
  return deterministicGate;
}

function analysisCatalogForGate(candidate, catalog, deterministicGate) {
  if (deterministicGate.duplicateCheck.outcome !== "duplicate-fast-path") return catalog;
  const duplicateRecord = gateCatalogRecords(catalog).find(
    (record) => canonicalRecordUrl(record) === candidate.canonicalUrl,
  );
  return [{ ...duplicateRecord, canonicalSource: candidate.canonicalUrl }];
}

export async function runAiAnalysis({
  candidate,
  catalog = [],
  client,
  createInvocationId,
  deterministicGate,
  timeoutMilliseconds,
}) {
  validateDeterministicGate({ candidate, catalog, deterministicGate });
  const analysisCatalog = analysisCatalogForGate(candidate, catalog, deterministicGate);
  const analysisStage = await analyzeContent({
    candidate,
    catalog: analysisCatalog,
    client,
    createInvocationId,
    timeoutMilliseconds,
  });
  let grounding = { score: 1, claims: [] };
  let groundingEvaluation = "not-evaluated";
  let groundingInvocationId = null;

  if (analysisStage.analysis.generatedSummary !== null) {
    const groundingStage = await verifySummary({
      candidate,
      summary: analysisStage.analysis.generatedSummary,
      client,
      previousInvocationId: analysisStage.invocationId,
      createInvocationId,
      timeoutMilliseconds,
    });
    grounding = groundingStage.grounding;
    groundingEvaluation = "evaluated";
    groundingInvocationId = groundingStage.invocationId;
    if (groundingInvocationId === analysisStage.invocationId) {
      throw new AiAnalysisError("INVOCATION_MISMATCH", "Relevance and grounding invocation IDs must be independent.");
    }
  }

  const analysis = validateFinalAnalysis({
    version: ANALYSIS_VERSION,
    candidateId: analysisStage.analysis.candidateId,
    relevance: analysisStage.analysis.relevance,
    grounding,
    duplicate: analysisStage.analysis.duplicate,
    quality: analysisStage.analysis.quality,
    recommendation: analysisStage.analysis.recommendation,
    reasonCodes: analysisStage.analysis.reasonCodes,
    generatedSummary: analysisStage.analysis.generatedSummary,
  });

  return {
    analysis,
    invocations: {
      relevance: analysisStage.invocationId,
      grounding: groundingInvocationId,
    },
    evaluationState: {
      grounding: groundingEvaluation,
    },
    deterministic: analysisStage.deterministic,
  };
}

function requiredEnvironmentValue(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new AiAnalysisError("AZURE_CONFIG_INVALID", `${name} is required.`);
  }
  return value.trim();
}

function azureEndpoint(environment) {
  const value = requiredEnvironmentValue(environment, "AZURE_OPENAI_ENDPOINT");
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("not HTTPS");
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new AiAnalysisError("AZURE_CONFIG_INVALID", "AZURE_OPENAI_ENDPOINT must be an HTTPS URL without credentials.");
  }
}

function responseSchemaName(operation) {
  return `gallery_${operation.replace(/[^a-z0-9_-]/gi, "_").toLowerCase()}`;
}

function responsesRequest(request, deployment) {
  return {
    model: deployment,
    instructions: request.systemInstructions,
    input: [{ role: "user", content: [{ type: "input_text", text: request.input }] }],
    tools: [],
    max_output_tokens: request.maxOutputTokens,
    text: {
      format: {
        type: "json_schema",
        name: responseSchemaName(request.operation),
        strict: true,
        schema: request.schema,
      },
    },
    metadata: { invocation_id: request.invocationId },
  };
}

function chatRequest(request) {
  return {
    messages: [
      { role: "system", content: request.systemInstructions },
      { role: "user", content: request.input },
    ],
    tools: [],
    max_completion_tokens: request.maxOutputTokens,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: responseSchemaName(request.operation),
        strict: true,
        schema: request.schema,
      },
    },
  };
}

function responsesOutput(data) {
  const refusal = data?.refusal ?? data?.output
    ?.flatMap((item) => item?.content ?? [])
    .find((item) => item?.type === "refusal")?.refusal;
  if (refusal) return { refusal: String(refusal) };
  if (typeof data?.output_text === "string") return { outputText: data.output_text };
  const outputText = data?.output
    ?.flatMap((item) => item?.content ?? [])
    .filter((item) => item?.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
  return { outputText };
}

function chatOutput(data) {
  const message = data?.choices?.[0]?.message;
  if (message?.refusal) return { refusal: String(message.refusal) };
  if (typeof message?.content === "string") return { outputText: message.content };
  const outputText = Array.isArray(message?.content)
    ? message.content.map((item) => item?.text ?? "").join("")
    : undefined;
  return { outputText };
}

export function createAzureOpenAIClient({
  environment = process.env,
  fetchImpl = globalThis.fetch,
  mode = "responses",
} = {}) {
  if (!["responses", "chat"].includes(mode)) {
    throw new AiAnalysisError("AZURE_CONFIG_INVALID", "Azure client mode must be responses or chat.");
  }
  if (typeof fetchImpl !== "function") {
    throw new AiAnalysisError("AZURE_CONFIG_INVALID", "A fetch implementation is required.");
  }
  const endpoint = azureEndpoint(environment);
  const deployment = requiredEnvironmentValue(environment, "AZURE_OPENAI_DEPLOYMENT");
  const bearerToken = requiredEnvironmentValue(environment, "AZURE_OPENAI_BEARER_TOKEN");

  return Object.freeze({
    async invoke(request) {
      const url = mode === "responses"
        ? `${endpoint}/openai/v1/responses`
        : `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${AZURE_CHAT_API_VERSION}`;
      const body = mode === "responses"
        ? responsesRequest(request, deployment)
        : chatRequest(request);
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });
      if (!response?.ok) {
        throw new AiAnalysisError(
          "AI_PROVIDER_FAILURE",
          `Azure OpenAI request failed with HTTP ${response?.status ?? "unknown"}.`,
        );
      }
      let data;
      try {
        data = await response.json();
      } catch (error) {
        throw new AiAnalysisError("MALFORMED_MODEL_OUTPUT", "Azure OpenAI returned malformed JSON.", {
          cause: error.message,
        });
      }
      return mode === "responses" ? responsesOutput(data) : chatOutput(data);
    },
  });
}

function replaceFixtureTokens(value, replacements) {
  if (typeof value === "string") {
    return Object.entries(replacements).reduce(
      (current, [token, replacement]) => current.replaceAll(token, replacement),
      value,
    );
  }
  if (Array.isArray(value)) return value.map((item) => replaceFixtureTokens(item, replacements));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceFixtureTokens(item, replacements)]),
    );
  }
  return value;
}

export function createFixtureClient(fixtureCase) {
  const requests = [];
  return {
    requests,
    async invoke(request) {
      requests.push(request);
      const fixtureResponse = fixtureCase?.responses?.[request.operation];
      if (!fixtureResponse) {
        throw new AiAnalysisError("FIXTURE_MISSING", `No fixture response for ${request.operation}.`);
      }
      if (fixtureResponse.refusal) return { refusal: fixtureResponse.refusal };
      if (fixtureResponse.malformedOutput !== undefined) {
        return { outputText: fixtureResponse.malformedOutput };
      }
      const input = JSON.parse(request.input);
      const replacements = {
        "$INVOCATION_ID": request.invocationId,
        "$CANDIDATE_ID": input.candidate.candidateId,
        "$SUMMARY": input.proposedSummary ?? "",
      };
      if (
        typeof fixtureCase?.candidate?.canonicalUrl === "string" &&
        typeof input.candidate?.canonicalUrl === "string"
      ) {
        replacements[fixtureCase.candidate.canonicalUrl] = input.candidate.canonicalUrl;
      }
      const output = replaceFixtureTokens(fixtureResponse.output, replacements);
      return { outputText: JSON.stringify(output) };
    },
  };
}

const FIXTURE_DISCOVERED_AT = "2026-08-27T00:00:00.000Z";
const FIXTURE_EVIDENCE_TYPE = Object.freeze({
  "blog-post": "feed-entry-content",
  "github-path": "github-sdk-signal",
  "github-repository": "github-sdk-signal",
  "learn-document": "learn-cosmos-section",
  video: "youtube-description",
});

function fixtureSourceId(candidate) {
  if (candidate.sourceType !== "video" || /^[A-Za-z0-9_-]{11}$/.test(candidate.sourceId ?? "")) {
    return candidate.sourceId;
  }
  try {
    const videoId = new URL(candidate.canonicalUrl).searchParams.get("v");
    if (/^[A-Za-z0-9_-]{11}$/.test(videoId ?? "")) return videoId;
  } catch {}
  return Buffer.from(String(candidate.sourceId), "utf8").toString("base64url").padEnd(11, "0").slice(0, 11);
}

function normalizeFixtureCandidate(fixtureCase) {
  const rawCandidate = fixtureCase.candidate;
  const evidenceType = FIXTURE_EVIDENCE_TYPE[rawCandidate.sourceType];
  const retrievedContent = Array.isArray(rawCandidate.retrievedContent)
    ? rawCandidate.retrievedContent
    : [];
  const evidence = retrievedContent.length > 0
    ? retrievedContent.map((item) => ({
        type: evidenceType,
        value: item.text ?? item.excerpt ?? item.value,
        ...(item.url ? { url: item.url } : {}),
      }))
    : [{
        type: evidenceType,
        value: rawCandidate.description || rawCandidate.title,
        url: rawCandidate.canonicalUrl,
      }];
  const isGitHub = ["github-path", "github-repository"].includes(rawCandidate.sourceType);
  return normalizeCandidate({
    ...rawCandidate,
    sourceId: fixtureSourceId(rawCandidate),
    discoveredAt: rawCandidate.discoveredAt ?? FIXTURE_DISCOVERED_AT,
    evidence,
    metadata: {
      ...rawCandidate.metadata,
      sourceRegistryId: rawCandidate.metadata?.sourceRegistryId ?? `fixture-${rawCandidate.sourceType}`,
      trustTier: rawCandidate.metadata?.trustTier ?? "fixture",
      ...(isGitHub ? {
        strongSignalKinds: rawCandidate.metadata?.strongSignalKinds ?? ["sdk"],
        corroboratingSignalKinds: rawCandidate.metadata?.corroboratingSignalKinds ?? [],
      } : {}),
    },
  });
}

function fixtureRelevanceGate(candidate) {
  const isGitHub = ["github-path", "github-repository"].includes(candidate.sourceType);
  return {
    status: "passed",
    strategy: "strong-signal",
    signalKinds: isGitHub
      ? [...candidate.metadata.strongSignalKinds]
      : candidate.evidence
        .map((item) => item.type)
        .filter((type) => DIRECT_RELEVANCE_REQUIREMENTS[candidate.sourceType]?.signalKinds.has(type)),
  };
}

export function prepareFixtureAnalysisCase(fixtureCase, catalog = []) {
  const candidate = normalizeFixtureCandidate(fixtureCase);
  const canonicalDuplicate = gateCatalogRecords(catalog).some(
    (record) => canonicalRecordUrl(record) === candidate.canonicalUrl,
  );
  return {
    candidate,
    deterministicGate: {
      candidateId: candidate.identityKey,
      provenance: {
        status: "passed",
        sourceRegistryId: candidate.metadata.sourceRegistryId,
        trusted: true,
      },
      sourceAvailability: { status: "healthy" },
      cosmosRelevance: fixtureRelevanceGate(candidate),
      duplicateCheck: {
        status: "passed",
        outcome: canonicalDuplicate ? "duplicate-fast-path" : "unique",
        identityKeyChecked: true,
        canonicalUrlChecked: true,
      },
      normalization: {
        status: "passed",
        schemaVersion: CANDIDATE_SCHEMA_VERSION,
      },
    },
  };
}

function comparableFixtureAnalysis(expectedAnalysis, fixtureCase, candidate, catalog) {
  const replacements = {};
  if (typeof fixtureCase.candidate?.canonicalUrl === "string") {
    replacements[fixtureCase.candidate.canonicalUrl] = candidate.canonicalUrl;
  }
  for (const record of gateCatalogRecords(catalog)) {
    if (canonicalRecordUrl(record) !== candidate.canonicalUrl) continue;
    for (const value of [record?.canonicalUrl, record?.canonicalSource, record?.source]) {
      if (typeof value === "string") replacements[value] = candidate.canonicalUrl;
    }
  }
  return {
    ...replaceFixtureTokens(structuredClone(expectedAnalysis), replacements),
    candidateId: candidate.identityKey,
  };
}

function precision(predictions, expected, predicate) {
  let predictedPositive = 0;
  let truePositive = 0;
  for (let index = 0; index < predictions.length; index += 1) {
    if (!predicate(predictions[index])) continue;
    predictedPositive += 1;
    if (predicate(expected[index])) truePositive += 1;
  }
  return predictedPositive === 0 ? null : truePositive / predictedPositive;
}

function evaluationFailure(code, message, report) {
  return new AiAnalysisError(code, message, { report });
}

function isExactDuplicateCase(fixtureCase) {
  return ["exact-duplicate", "canonical-duplicate"].includes(fixtureCase.category);
}

export async function evaluateFixtureSet({ evaluationSet, fixtureCases, fixtureCatalog, policy }) {
  if (!evaluationSet?.enabled || !Array.isArray(evaluationSet.seed) || evaluationSet.seed.length === 0) {
    throw new AiAnalysisError("EVALUATION_SET_INVALID", "The labeled evaluation set must be enabled and non-empty.");
  }
  if (!Array.isArray(fixtureCases?.cases) || !Array.isArray(fixtureCatalog)) {
    throw new AiAnalysisError("EVALUATION_SET_INVALID", "Fixture cases and catalog must be arrays.");
  }

  const expectedById = new Map(evaluationSet.seed.map((analysis) => {
    validateFinalAnalysis(analysis);
    return [analysis.candidateId, analysis];
  }));
  const predictions = [];
  const expected = [];
  const semanticPredictions = [];
  const semanticExpected = [];
  const failures = [];
  const caseResults = [];
  const groundingEvaluation = {
    evaluated: 0,
    notEvaluated: 0,
    failed: 0,
    notReached: 0,
  };
  let passedCases = 0;
  let exactDuplicateCases = 0;
  let exactDuplicateRejections = 0;
  let unsupportedSummaryClaimCount = 0;

  for (const fixtureCase of fixtureCases.cases) {
    const expectedAnalysis = expectedById.get(fixtureCase.candidateId);
    if (!expectedAnalysis) {
      failures.push({ candidateId: fixtureCase.candidateId, reason: "missing expected label" });
      groundingEvaluation.notReached += 1;
      caseResults.push({
        candidateId: fixtureCase.candidateId,
        category: fixtureCase.category,
        analysis: "not-evaluated",
        grounding: "not-reached",
        passed: false,
      });
      continue;
    }
    const client = createFixtureClient(fixtureCase);
    let actual = null;
    let caught = null;
    let comparableExpected = expectedAnalysis;
    let resultEvaluationState = null;
    let invocationCounter = 0;
    try {
      const catalog = fixtureCase.useFixtureCatalog ? fixtureCatalog : [];
      const prepared = prepareFixtureAnalysisCase(fixtureCase, catalog);
      comparableExpected = comparableFixtureAnalysis(
        expectedAnalysis,
        fixtureCase,
        prepared.candidate,
        catalog,
      );
      const result = await runAiAnalysis({
        candidate: prepared.candidate,
        catalog,
        client,
        createInvocationId: () => `${fixtureCase.candidateId}-${++invocationCounter}`,
        deterministicGate: prepared.deterministicGate,
      });
      actual = result.analysis;
      resultEvaluationState = result.evaluationState;
    } catch (error) {
      caught = error;
    }

    if (actual) {
      predictions.push(actual);
      expected.push(comparableExpected);
      if (!isExactDuplicateCase(fixtureCase)) {
        semanticPredictions.push(actual);
        semanticExpected.push(comparableExpected);
      }
    }

    if (isExactDuplicateCase(fixtureCase)) {
      exactDuplicateCases += 1;
      if (actual?.recommendation === "reject" && actual?.duplicate?.classification === "duplicate") {
        exactDuplicateRejections += 1;
      }
    }
    if (fixtureCase.category === "unsupported-summary" && actual && actual.generatedSummary !== null) {
      unsupportedSummaryClaimCount += 1;
    }

    let passed = false;
    if (fixtureCase.expectedFailureCode) {
      if (caught?.code === fixtureCase.expectedFailureCode) {
        passed = true;
        passedCases += 1;
      } else {
        failures.push({
          candidateId: fixtureCase.candidateId,
          reason: caught ? `unexpected ${caught.code}` : "unsupported summary was accepted",
        });
      }
    } else if (caught) {
      failures.push({ candidateId: fixtureCase.candidateId, reason: caught.code ?? caught.message });
    } else if (!isDeepStrictEqual(actual, comparableExpected)) {
      failures.push({ candidateId: fixtureCase.candidateId, reason: "analysis did not match its label" });
    } else {
      passed = true;
      passedCases += 1;
    }

    const groundingStatus = actual
      ? resultEvaluationState.grounding
      : client.requests.some((request) => request.operation === "summary-grounding")
        ? "failed"
        : "not-reached";
    if (groundingStatus === "evaluated") groundingEvaluation.evaluated += 1;
    else if (groundingStatus === "not-evaluated") groundingEvaluation.notEvaluated += 1;
    else if (groundingStatus === "failed") groundingEvaluation.failed += 1;
    else groundingEvaluation.notReached += 1;
    caseResults.push({
      candidateId: fixtureCase.candidateId,
      category: fixtureCase.category,
      analysis: actual ? "completed" : passed ? "expected-failure" : "failed",
      grounding: groundingStatus,
      passed,
    });
  }

  if (expectedById.size !== fixtureCases.cases.length) {
    failures.push({ candidateId: "evaluation-set", reason: "label and fixture counts differ" });
  }

  const metrics = {
    relevancePrecision: precision(
      predictions,
      expected,
      (analysis) => analysis?.relevance?.material === true,
    ),
    semanticDuplicatePrecision: precision(
      semanticPredictions,
      semanticExpected,
      (analysis) => analysis?.duplicate?.classification === "duplicate",
    ),
    exactDuplicateRejectionRate: exactDuplicateCases === 0
      ? 0
      : exactDuplicateRejections / exactDuplicateCases,
    unsupportedSummaryClaimCount,
  };
  const thresholds = policy?.evaluationThresholds;
  if (!thresholds) {
    throw new AiAnalysisError("EVALUATION_SET_INVALID", "Policy evaluation thresholds are required.");
  }
  const thresholdResults = {
    relevancePrecision: Number.isFinite(metrics.relevancePrecision) &&
      metrics.relevancePrecision >= thresholds.relevancePrecision,
    semanticDuplicatePrecision: Number.isFinite(metrics.semanticDuplicatePrecision) &&
      metrics.semanticDuplicatePrecision >= thresholds.semanticDuplicatePrecision,
    exactDuplicateRejectionRate: metrics.exactDuplicateRejectionRate >= thresholds.exactDuplicateRejectionRate,
    unsupportedSummaryClaimCount: metrics.unsupportedSummaryClaimCount <= thresholds.unsupportedSummaryClaimCount,
  };
  const report = {
    version: evaluationSet.version,
    cases: { total: fixtureCases.cases.length, passed: passedCases, failed: failures.length },
    metrics,
    thresholds,
    thresholdResults,
    evaluationState: {
      completedAnalyses: predictions.length,
      grounding: groundingEvaluation,
    },
    caseResults,
    failures,
    passed: failures.length === 0 && Object.values(thresholdResults).every(Boolean),
  };
  if (!report.passed) {
    throw evaluationFailure("EVALUATION_THRESHOLD_FAILED", "Fixture evaluation failed policy thresholds.", report);
  }
  return report;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function runFixtureEvaluation({ rootDir = DEFAULT_ROOT } = {}) {
  const [evaluationSet, fixtureCases, supplementalFixtureCases, fixtureCatalog, policy] = await Promise.all([
    readJson(path.join(rootDir, ".github", "gallery-pipeline", "evaluation-set.json")),
    readJson(path.join(rootDir, "scripts", "gallery-pipeline", "fixtures", "ai", "cases.json")),
    readJson(path.join(
      rootDir,
      "scripts",
      "gallery-pipeline",
      "fixtures",
      "ai",
      "evaluation",
      "cases.json",
    )),
    readJson(path.join(rootDir, "scripts", "gallery-pipeline", "fixtures", "ai", "catalog.json")),
    readJson(path.join(rootDir, ".github", "gallery-pipeline", "policy.json")),
  ]);
  return evaluateFixtureSet({
    evaluationSet,
    fixtureCases: {
      version: fixtureCases.version,
      cases: [...fixtureCases.cases, ...supplementalFixtureCases.cases],
    },
    fixtureCatalog,
    policy,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await runFixtureEvaluation(), null, 2));
  } catch (error) {
    if (error instanceof AiAnalysisError && error.details.report) {
      console.error(JSON.stringify(error.details.report, null, 2));
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}