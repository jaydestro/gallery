import { isDeepStrictEqual } from "node:util";

import { validateDeterministicGate } from "./ai-analysis.mjs";
import { detectExactDuplicates } from "./detect-duplicates.mjs";
import { CANDIDATE_SCHEMA_VERSION, normalizeCandidate } from "./normalize.mjs";
import { checkSource, mapAvailabilityChecks } from "./scan-health.mjs";

const MAX_CONCURRENCY = 6;
const MAX_REQUEST_METHODS_PER_URL = 2;
const CANDIDATE_GATE_DEADLINE_REASON = "CANDIDATE_GATE_DEADLINE_EXCEEDED";
const DEFAULT_OPERATION_DEADLINE_SECONDS = 20 * 60;
const DEFAULT_CANDIDATE_AVAILABILITY = Object.freeze({
  retryDelaySeconds: Object.freeze([0, 2]),
  timeoutSeconds: 3,
  maxTotalSecondsPerUrl: 5,
});
const GITHUB_SOURCE_TYPES = new Set(["github-path", "github-repository"]);
const CANDIDATE_TYPES_BY_ADAPTER = new Map([
  ["documentation-root", new Set(["learn-document"])],
  ["github-organization", new Set(["github-repository"])],
  ["rss-feed", new Set(["blog-post"])],
  ["youtube-channel", new Set(["video"])],
  ["youtube-playlist", new Set(["video"])],
]);
const SAFE_SOURCE_REASON_CODES = new Set([
  CANDIDATE_GATE_DEADLINE_REASON,
  "GITHUB_REPOSITORY_ARCHIVED",
  "GITHUB_REPOSITORY_DISABLED",
  "GITHUB_RESPONSE_INVALID",
  "SOURCE_DNS_ERROR",
  "SOURCE_PARTIAL_RESPONSE",
  "SOURCE_REQUEST_INDETERMINATE",
  "SOURCE_RESPONSE_MALFORMED",
  "SOURCE_TIMEOUT",
]);

function requireArray(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value;
}

function registrySources(trustedSources) {
  if (Array.isArray(trustedSources)) return trustedSources;
  return requireArray(trustedSources?.sources, "trustedSources.sources");
}

function catalogRecords(catalog, name) {
  if (Array.isArray(catalog)) return catalog;
  if (Array.isArray(catalog?.entries)) {
    return catalog.entries.map((entry) => entry?.record ?? entry);
  }
  throw new TypeError(`${name} must be an array or contain an entries array`);
}

function normalizedTimestamp(value, name = "checkedAt") {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf())) throw new TypeError(`${name} must be a valid date-time`);
  return timestamp.toISOString();
}

function requireDiscoveryEnvelope(discovery) {
  if (!discovery || typeof discovery !== "object" || Array.isArray(discovery)) {
    throw new TypeError("discovery must be an envelope object");
  }
  return discovery;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function positiveNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number`);
  }
  return value;
}

function optionalDeadline(value, name) {
  if (value === undefined) return Number.POSITIVE_INFINITY;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

function normalizeCandidateAvailability(value = DEFAULT_CANDIDATE_AVAILABILITY) {
  const retryDelaySeconds = value?.retryDelaySeconds;
  if (
    !Array.isArray(retryDelaySeconds) ||
    retryDelaySeconds.length === 0 ||
    retryDelaySeconds[0] !== 0 ||
    retryDelaySeconds.some((delaySeconds) => (
      !Number.isSafeInteger(delaySeconds) || delaySeconds < 0
    ))
  ) {
    throw new TypeError(
      "policy.candidateAvailability.retryDelaySeconds must start at zero and contain non-negative integers",
    );
  }
  return {
    retryDelaySeconds: [...retryDelaySeconds],
    timeoutSeconds: positiveNumber(
      value?.timeoutSeconds,
      "policy.candidateAvailability.timeoutSeconds",
    ),
    maxTotalSecondsPerUrl: positiveNumber(
      value?.maxTotalSecondsPerUrl,
      "policy.candidateAvailability.maxTotalSecondsPerUrl",
    ),
  };
}

export function candidateAvailabilityRuntimeBudgetSeconds(value = DEFAULT_CANDIDATE_AVAILABILITY) {
  const candidateAvailability = normalizeCandidateAvailability(value);
  const perMethodSeconds = (
    candidateAvailability.retryDelaySeconds.reduce((total, delaySeconds) => (
      total + delaySeconds
    ), 0) +
    candidateAvailability.retryDelaySeconds.length * candidateAvailability.timeoutSeconds
  );
  return Math.min(
    candidateAvailability.maxTotalSecondsPerUrl,
    perMethodSeconds * MAX_REQUEST_METHODS_PER_URL,
  );
}

function candidateSourcePolicy(policy, candidateAvailability) {
  return {
    http: {
      retryDelaySeconds: candidateAvailability.retryDelaySeconds,
      timeoutSeconds: candidateAvailability.timeoutSeconds,
      maxRedirects: policy?.http?.maxRedirects ?? 5,
    },
  };
}

function deadlineError() {
  const error = new Error("Candidate availability deadline exceeded");
  error.name = "AbortError";
  return error;
}

async function checkCandidateSource(url, {
  candidateAvailability,
  delay,
  fetchImpl,
  gateDeadlineMilliseconds,
  lookup,
  now,
  policy,
  token,
}) {
  const urlDeadlineMilliseconds = Math.min(
    gateDeadlineMilliseconds,
    now() + candidateAvailability.maxTotalSecondsPerUrl * 1000,
  );
  const boundedDelay = async (milliseconds) => {
    const remainingMilliseconds = urlDeadlineMilliseconds - now();
    if (remainingMilliseconds <= 0) throw deadlineError();
    if (milliseconds >= remainingMilliseconds) {
      await delay(remainingMilliseconds);
      throw deadlineError();
    }
    await delay(milliseconds);
  };
  const boundedFetch = async (input, init = {}) => {
    const remainingMilliseconds = urlDeadlineMilliseconds - now();
    if (remainingMilliseconds <= 0) throw deadlineError();

    const controller = new AbortController();
    const abortFromRequest = () => controller.abort(init.signal?.reason);
    if (init.signal?.aborted) abortFromRequest();
    else init.signal?.addEventListener("abort", abortFromRequest, { once: true });
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(deadlineError());
      }, remainingMilliseconds);
    });
    try {
      return await Promise.race([
        fetchImpl(input, { ...init, signal: controller.signal }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", abortFromRequest);
    }
  };

  const result = await checkSource(url, {
    token,
    fetchImpl: boundedFetch,
    lookup,
    policy: candidateSourcePolicy(policy, candidateAvailability),
    delay: boundedDelay,
    now,
    deadlineMilliseconds: urlDeadlineMilliseconds,
  });
  return now() >= urlDeadlineMilliseconds
    ? {
        classification: "indeterminate",
        reason: CANDIDATE_GATE_DEADLINE_REASON,
      }
    : result;
}

function candidateId(candidate, index) {
  return typeof candidate?.identityKey === "string" && candidate.identityKey.trim()
    ? candidate.identityKey.trim()
    : `candidate-${index + 1}`;
}

function candidateEnvelopes(candidates) {
  return requireArray(candidates, "candidates")
    .map((candidate, index) => ({
      candidate,
      index,
      candidateId: candidateId(candidate, index),
    }))
    .sort((left, right) => (
      left.candidateId.localeCompare(right.candidateId) || left.index - right.index
    ));
}

function exactNormalizedCandidate(candidate) {
  try {
    const normalized = normalizeCandidate(candidate);
    return isDeepStrictEqual(candidate, normalized) ? normalized : null;
  } catch {
    return null;
  }
}

function indexById(items, key = "id") {
  const index = new Map();
  for (const item of items) {
    const id = item?.[key];
    if (typeof id !== "string" || !id.trim()) continue;
    const matches = index.get(id) ?? [];
    matches.push(item);
    index.set(id, matches);
  }
  return index;
}

function provenanceReasonCodes(candidate, {
  discoveryCompletedAt,
  sourceStatusesBound,
  trustedSourceIndex,
  sourceStatusIndex,
}) {
  const reasonCodes = [];
  const sourceRegistryId = candidate.metadata?.sourceRegistryId;
  if (candidate.discoveredAt !== discoveryCompletedAt) {
    reasonCodes.push("DISCOVERY_TIMESTAMP_MISMATCH");
  }
  if (!sourceStatusesBound) {
    reasonCodes.push("SOURCE_STATUS_NOT_IN_DISCOVERY");
  }

  const trustedMatches = trustedSourceIndex.get(sourceRegistryId) ?? [];
  const trustedSource = trustedMatches.length === 1 ? trustedMatches[0] : null;
  if (trustedMatches.length > 1) {
    reasonCodes.push("SOURCE_REGISTRY_ID_DUPLICATE");
  } else if (!trustedSource || trustedSource.enabled !== true) {
    reasonCodes.push("SOURCE_NOT_TRUSTED");
  } else {
    if (candidate.metadata?.trustTier !== trustedSource.trustTier) {
      reasonCodes.push("SOURCE_TRUST_MISMATCH");
    }
    if (!CANDIDATE_TYPES_BY_ADAPTER.get(trustedSource.type)?.has(candidate.sourceType)) {
      reasonCodes.push("SOURCE_TYPE_MISMATCH");
    }
  }

  const statusMatches = sourceStatusIndex.get(sourceRegistryId) ?? [];
  if (statusMatches.length > 1) {
    reasonCodes.push("SOURCE_REGISTRY_ID_DUPLICATE");
  } else if (
    statusMatches.length !== 1 ||
    statusMatches[0].queried !== true ||
    statusMatches[0].status !== "succeeded"
  ) {
    reasonCodes.push("SOURCE_DISCOVERY_NOT_SUCCEEDED");
  }
  if (trustedSource && statusMatches.length === 1 && statusMatches[0].sourceType !== trustedSource.type) {
    reasonCodes.push("SOURCE_TYPE_MISMATCH");
  }
  return [...new Set(reasonCodes)].sort();
}

function uniqueStrings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))]
    .sort((left, right) => left.localeCompare(right));
}

function relevanceOptions(candidate) {
  if (GITHUB_SOURCE_TYPES.has(candidate.sourceType)) {
    const strongKinds = uniqueStrings(candidate.metadata?.strongSignalKinds);
    const options = strongKinds.map((kind) => ({
      status: "passed",
      strategy: "strong-signal",
      signalKinds: [kind],
    }));
    if (strongKinds.length > 1) {
      options.push({
        status: "passed",
        strategy: "strong-signal",
        signalKinds: strongKinds,
      });
    }
    const corroboratingKinds = uniqueStrings(candidate.metadata?.corroboratingSignalKinds);
    if (corroboratingKinds.length > 0) {
      options.push({
        status: "passed",
        strategy: "corroborating-signals",
        signalKinds: corroboratingKinds,
      });
    }
    return options;
  }

  const evidenceKinds = uniqueStrings(candidate.evidence.map((item) => item.type));
  return evidenceKinds.map((kind) => ({
    status: "passed",
    strategy: "strong-signal",
    signalKinds: [kind],
  }));
}

function gateFor(candidate, cosmosRelevance) {
  return {
    candidateId: candidate.identityKey,
    provenance: {
      status: "passed",
      sourceRegistryId: candidate.metadata.sourceRegistryId,
      trusted: true,
    },
    sourceAvailability: { status: "healthy" },
    cosmosRelevance,
    duplicateCheck: {
      status: "passed",
      outcome: "unique",
      identityKeyChecked: true,
      canonicalUrlChecked: true,
    },
    normalization: {
      status: "passed",
      schemaVersion: CANDIDATE_SCHEMA_VERSION,
    },
  };
}

function deriveValidatedGate(candidate, catalog) {
  for (const cosmosRelevance of relevanceOptions(candidate)) {
    const deterministicGate = gateFor(candidate, cosmosRelevance);
    try {
      validateDeterministicGate({ candidate, catalog, deterministicGate });
      return deterministicGate;
    } catch {}
  }
  return null;
}

function safeSourceReasonCode(result) {
  if (result?.statusCode === 206) return "SOURCE_PARTIAL_RESPONSE";
  if (typeof result.reason === "string") {
    if (SAFE_SOURCE_REASON_CODES.has(result.reason)) return result.reason;
    if (/^SOURCE_HTTP_[1-5][0-9]{2}$/.test(result.reason)) return result.reason;
  }
  if (!Number.isInteger(result?.statusCode)) return "SOURCE_RESPONSE_MALFORMED";
  return "SOURCE_REQUEST_INDETERMINATE";
}

function availabilityFor(result, checkedAt) {
  const statusCode = Number.isInteger(result?.statusCode) ? result.statusCode : null;
  const retryAttempts = Number.isSafeInteger(result?.retryAttempts) && result.retryAttempts > 0
    ? result.retryAttempts
    : 0;
  const retryReasons = retryAttempts > 0
    ? uniqueStrings(result?.retryReasons).filter((reason) => (
      SAFE_SOURCE_REASON_CODES.has(reason) || /^SOURCE_HTTP_[1-5][0-9]{2}$/.test(reason)
    ))
    : [];
  const retryMetadata = retryAttempts > 0 ? { retryAttempts, retryReasons } : {};
  const healthy = (
    result?.classification === "healthy" &&
    statusCode >= 200 &&
    statusCode < 300 &&
    statusCode !== 206
  );
  if (healthy) {
    return {
      checkedAt,
      classification: "healthy",
      statusCode,
      reasonCode: null,
      ...retryMetadata,
    };
  }
  return {
    checkedAt,
    classification: result?.classification === "definitive-failure"
      ? "definitive-failure"
      : "indeterminate",
    statusCode,
    reasonCode: safeSourceReasonCode(result),
    ...retryMetadata,
  };
}

function rejectedEntry(envelope, reasonCodes, availability = null) {
  const rejection = {
    candidateId: envelope.candidateId,
    reasonCodes: [...new Set(reasonCodes)].sort(),
  };
  if (
    availability?.retryAttempts > 0 ||
    availability?.reasonCode === CANDIDATE_GATE_DEADLINE_REASON
  ) {
    rejection.availability = availability;
  }
  return rejection;
}

function sortRejected(rejected) {
  return rejected.sort((left, right) => (
    left.candidateId.localeCompare(right.candidateId) ||
    left.reasonCodes.join(":").localeCompare(right.reasonCodes.join(":"))
  ));
}

export async function runCandidateGates(options = {}) {
  const {
    discovery = null,
    candidates = discovery?.candidates,
    sourceStatuses = discovery?.sources,
    trustedSources,
    activeCatalog = [],
    retiredCatalog = [],
    policy,
    checkedAt = null,
    concurrency = MAX_CONCURRENCY,
    token = process.env.GITHUB_TOKEN,
    fetchImpl = globalThis.fetch,
    lookup,
    delay,
    now = Date.now,
    deadlineMilliseconds,
  } = options;
  const envelope = requireDiscoveryEnvelope(discovery);
  const discoveryCandidates = requireArray(envelope.candidates, "discovery.candidates");
  const discoverySourceStatuses = requireArray(envelope.sources, "discovery.sources");
  const discoveryCompletedAt = normalizedTimestamp(
    envelope.completedAt,
    "discovery.completedAt",
  );
  const reportTime = normalizedTimestamp(
    checkedAt ?? discoveryCompletedAt,
  );
  const requestedConcurrency = positiveInteger(concurrency, "concurrency");
  const effectiveConcurrency = Math.min(requestedConcurrency, MAX_CONCURRENCY);
  if (typeof delay !== "undefined" && typeof delay !== "function") {
    throw new TypeError("delay must be a function");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");
  const candidateAvailability = normalizeCandidateAvailability(policy?.candidateAvailability);
  const operationDeadlineSeconds = positiveNumber(
    policy?.discovery?.operationDeadlineSeconds ?? DEFAULT_OPERATION_DEADLINE_SECONDS,
    "policy.discovery.operationDeadlineSeconds",
  );
  const gateDeadlineMilliseconds = Math.min(
    now() + operationDeadlineSeconds * 1000,
    optionalDeadline(deadlineMilliseconds, "deadlineMilliseconds"),
  );
  const wait = delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const maxCandidates = positiveInteger(
    policy?.batching?.maxCandidatesPerRun,
    "policy.batching.maxCandidatesPerRun",
  );
  const activeRecords = catalogRecords(activeCatalog, "activeCatalog");
  const retiredRecords = catalogRecords(retiredCatalog, "retiredCatalog");
  const gateCatalog = [...activeRecords, ...retiredRecords];
  const trustedSourceIndex = indexById(registrySources(trustedSources));
  const sourceStatusIndex = indexById(discoverySourceStatuses, "sourceRegistryId");
  const sourceStatusesBound = sourceStatuses === discoverySourceStatuses;
  const discoveryCandidateCounts = new Map();
  for (const candidate of discoveryCandidates) {
    discoveryCandidateCounts.set(candidate, (discoveryCandidateCounts.get(candidate) ?? 0) + 1);
  }
  const envelopes = candidateEnvelopes(candidates);
  const selected = envelopes.slice(0, maxCandidates);
  const rejected = envelopes.slice(maxCandidates).map((envelope) => (
    rejectedEntry(envelope, ["BATCH_CANDIDATE_LIMIT_EXCEEDED"])
  ));

  const normalizedEnvelopes = [];
  for (const envelope of selected) {
    const candidate = exactNormalizedCandidate(envelope.candidate);
    if (!candidate) {
      rejected.push(rejectedEntry(envelope, ["CANDIDATE_NOT_NORMALIZED"]));
      continue;
    }
    normalizedEnvelopes.push({
      ...envelope,
      discoveryCandidate: envelope.candidate,
      candidate,
      candidateId: candidate.identityKey,
    });
  }

  const envelopeByCandidate = new Map(
    normalizedEnvelopes.map((envelope) => [envelope.candidate, envelope]),
  );
  const exactDuplicates = detectExactDuplicates(
    normalizedEnvelopes.map((envelope) => envelope.candidate),
    { active: activeRecords, retired: retiredRecords },
  );
  for (const duplicate of exactDuplicates.duplicates) {
    rejected.push(rejectedEntry(envelopeByCandidate.get(duplicate.candidate), ["EXACT_DUPLICATE"]));
  }

  const ready = [];
  for (const candidate of exactDuplicates.accepted) {
    const envelope = envelopeByCandidate.get(candidate);
    const discoveryCandidateCount = discoveryCandidateCounts.get(envelope.discoveryCandidate) ?? 0;
    if (discoveryCandidateCount !== 1) {
      rejected.push(rejectedEntry(envelope, [
        discoveryCandidateCount === 0
          ? "CANDIDATE_NOT_IN_DISCOVERY"
          : "CANDIDATE_DISCOVERY_BINDING_NOT_UNIQUE",
      ]));
      continue;
    }
    const provenanceReasons = provenanceReasonCodes(candidate, {
      discoveryCompletedAt,
      sourceStatusesBound,
      trustedSourceIndex,
      sourceStatusIndex,
    });
    if (provenanceReasons.length > 0) {
      rejected.push(rejectedEntry(envelope, provenanceReasons));
      continue;
    }
    const deterministicGate = deriveValidatedGate(candidate, gateCatalog);
    if (!deterministicGate) {
      rejected.push(rejectedEntry(envelope, ["COSMOS_EVIDENCE_REJECTED"]));
      continue;
    }
    ready.push({ envelope, candidate, deterministicGate });
  }

  const urls = [...new Set(ready.map((item) => item.candidate.canonicalUrl))]
    .sort((left, right) => left.localeCompare(right));
  const checkedSources = await mapAvailabilityChecks(urls, effectiveConcurrency, async (url) => {
    if (now() >= gateDeadlineMilliseconds) {
      return [url, {
        classification: "indeterminate",
        reason: CANDIDATE_GATE_DEADLINE_REASON,
      }];
    }
    return [url, await checkCandidateSource(url, {
      candidateAvailability,
      delay: wait,
      fetchImpl,
      gateDeadlineMilliseconds,
      lookup,
      now,
      policy,
      token,
    })];
  }, {
    delay: async (milliseconds) => {
      const remainingMilliseconds = gateDeadlineMilliseconds - now();
      if (remainingMilliseconds <= 0) return;
      await wait(Math.min(milliseconds, remainingMilliseconds));
    },
  });
  const availabilityByUrl = new Map(
    checkedSources.map(([url, result]) => [url, availabilityFor(result, reportTime)]),
  );
  const indeterminateAvailabilityChecks = [...availabilityByUrl.values()]
    .filter((availability) => availability.classification === "indeterminate")
    .length;
  const deadlineExceededAvailabilityChecks = [...availabilityByUrl.values()]
    .filter((availability) => availability.reasonCode === CANDIDATE_GATE_DEADLINE_REASON)
    .length;
  const executedAvailabilityChecks = urls.length - deadlineExceededAvailabilityChecks;
  const incompleteCandidateChecks = ready.filter((item) => (
    availabilityByUrl.get(item.candidate.canonicalUrl)?.reasonCode ===
      CANDIDATE_GATE_DEADLINE_REASON
  )).length;
  const executedCandidateChecks = selected.length - incompleteCandidateChecks;
  const status = executedCandidateChecks === selected.length ? "complete" : "incomplete";
  const coverageStatus = (
    selected.length === envelopes.length && indeterminateAvailabilityChecks === 0
  ) ? "complete" : "partial";

  const eligible = [];
  for (const item of ready) {
    const availability = availabilityByUrl.get(item.candidate.canonicalUrl);
    if (availability.classification !== "healthy") {
      rejected.push(rejectedEntry(item.envelope, [availability.reasonCode], availability));
      continue;
    }
    eligible.push({
      candidate: item.candidate,
      deterministicGate: item.deterministicGate,
      availability,
    });
  }

  sortRejected(rejected);
  return {
    schemaVersion: "2.0.0",
    mode: "dry-run",
    mutationPerformed: false,
    status,
    coverageStatus,
    startedAt: reportTime,
    completedAt: reportTime,
    summary: {
      candidates: envelopes.length,
      selectedCandidates: selected.length,
      executedCandidateChecks,
      availabilityChecks: urls.length,
      executedAvailabilityChecks,
      indeterminateAvailabilityChecks,
      deadlineExceededAvailabilityChecks,
      eligible: eligible.length,
      rejected: rejected.length,
    },
    eligible,
    rejected,
  };
}