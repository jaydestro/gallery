import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  candidateAvailabilityRuntimeBudgetSeconds,
  runCandidateGates,
} from "./candidate-gates.mjs";
import { normalizeCandidate } from "./normalize.mjs";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(await readFile(
  path.join(TEST_DIRECTORY, "fixtures", "candidate-gates", "input.json"),
  "utf8",
));
const productionPolicy = JSON.parse(await readFile(
  path.resolve(TEST_DIRECTORY, "../../.github/gallery-pipeline/policy.json"),
  "utf8",
));
const publicLookup = async () => [{ address: "20.12.34.56", family: 4 }];

function blogCandidate(sourceId, overrides = {}) {
  const template = fixture.discovery.candidates[0];
  const { evidence, metadata, ...properties } = overrides;
  return normalizeCandidate({
    ...template,
    ...properties,
    sourceId,
    canonicalUrl: properties.canonicalUrl ?? `https://example.com/${sourceId}`,
    title: properties.title ?? `${sourceId} Cosmos DB article`,
    evidence: evidence ?? structuredClone(template.evidence),
    metadata: {
      ...template.metadata,
      ...metadata,
    },
  });
}

function githubCandidate(sourceId, overrides = {}) {
  return normalizeCandidate({
    sourceType: "github-repository",
    sourceId,
    canonicalUrl: `https://github.com/AzureCosmosDB/${sourceId}`,
    title: sourceId,
    description: "Azure Cosmos DB sample",
    publisher: "AzureCosmosDB",
    publishedAt: null,
    modifiedAt: null,
    discoveredAt: fixture.discovery.candidates[0].discoveredAt,
    evidence: [
      { type: "github-description-signal", value: "Azure Cosmos DB sample" },
      { type: "github-readme-signal", value: "Uses Azure Cosmos DB" },
    ],
    metadata: {
      sourceRegistryId: "trusted-github",
      trustTier: "first-party",
      strongSignalKinds: [],
      corroboratingSignalKinds: ["description", "readme"],
      ...overrides.metadata,
    },
    ...overrides,
  });
}

function responseFetch(status, calls = []) {
  return async (input, init = {}) => {
    calls.push(`${init.method ?? "GET"} ${new URL(input).toString()}`);
    return new Response(null, { status });
  };
}

function gateOptions(overrides = {}) {
  const {
    discovery: discoveryOverride,
    candidates: candidateOverride,
    sourceStatuses: sourceStatusOverride,
    ...remainingOverrides
  } = overrides;
  const discovery = discoveryOverride ?? structuredClone(fixture.discovery);
  if (candidateOverride !== undefined && discoveryOverride === undefined) {
    discovery.candidates = candidateOverride;
  }
  if (sourceStatusOverride !== undefined && discoveryOverride === undefined) {
    discovery.sources = sourceStatusOverride;
  }
  return {
    discovery,
    candidates: candidateOverride ?? discovery.candidates,
    sourceStatuses: sourceStatusOverride ?? discovery.sources,
    trustedSources: structuredClone(fixture.trustedSources),
    activeCatalog: structuredClone(fixture.activeCatalog),
    retiredCatalog: structuredClone(fixture.retiredCatalog),
    policy: structuredClone(fixture.policy),
    checkedAt: fixture.checkedAt,
    token: null,
    lookup: publicLookup,
    fetchImpl: responseFetch(200),
    delay: async () => {},
    ...remainingOverrides,
  };
}

test("candidate availability has a five-second runtime cap without changing lifecycle retries", () => {
  assert.deepEqual(productionPolicy.http.retryDelaySeconds, [0, 5, 30, 120]);
  assert.deepEqual(productionPolicy.candidateAvailability.retryDelaySeconds, [0, 2]);
  assert.equal(productionPolicy.candidateAvailability.maxTotalSecondsPerUrl, 5);
  assert.equal(
    candidateAvailabilityRuntimeBudgetSeconds(productionPolicy.candidateAvailability),
    5,
  );
  assert.ok(
    candidateAvailabilityRuntimeBudgetSeconds(productionPolicy.candidateAvailability) <= 5,
  );
});

test("returns an ordered dry-run report with one timestamp and never invokes AI", async () => {
  let aiInvocations = 0;
  let writeInvocations = 0;
  const report = await runCandidateGates(gateOptions({
    candidates: [...structuredClone(fixture.discovery.candidates)].reverse(),
    client: {
      async invoke() {
        aiInvocations += 1;
        throw new Error("AI must not run");
      },
    },
    writer: {
      async write() {
        writeInvocations += 1;
        throw new Error("writes must not run");
      },
    },
  }));

  assert.equal(report.mode, "dry-run");
  assert.equal(report.mutationPerformed, false);
  assert.equal(report.status, "complete");
  assert.equal(report.coverageStatus, "complete");
  assert.equal(report.startedAt, fixture.checkedAt);
  assert.equal(report.completedAt, fixture.checkedAt);
  assert.equal(report.summary.selectedCandidates, 2);
  assert.equal(report.summary.executedCandidateChecks, 2);
  assert.equal(report.summary.executedAvailabilityChecks, 2);
  assert.equal(report.summary.indeterminateAvailabilityChecks, 0);
  assert.deepEqual(
    report.eligible.map((item) => item.candidate.identityKey),
    ["blog-post:alpha", "blog-post:beta"],
  );
  assert.ok(report.eligible.every((item) => item.availability.checkedAt === fixture.checkedAt));
  assert.ok(report.eligible.every((item) => item.availability.classification === "healthy"));
  assert.equal(aiInvocations, 0);
  assert.equal(writeInvocations, 0);
});

test("uses deterministic gate validation for approved corroborating evidence and rejects invented evidence", async () => {
  const valid = githubCandidate("corroborated");
  const invalid = blogCandidate("invented", {
    evidence: [{ type: "invented-signal", value: "Claimed Cosmos evidence" }],
  });
  const calls = [];
  const report = await runCandidateGates(gateOptions({
    candidates: [invalid, valid],
    fetchImpl: responseFetch(200, calls),
  }));

  assert.equal(report.eligible.length, 1);
  assert.equal(report.eligible[0].candidate.identityKey, valid.identityKey);
  assert.equal(
    report.eligible[0].deterministicGate.cosmosRelevance.strategy,
    "corroborating-signals",
  );
  assert.deepEqual(report.rejected, [{
    candidateId: invalid.identityKey,
    reasonCodes: ["COSMOS_EVIDENCE_REJECTED"],
  }]);
  assert.equal(calls.length, 1);
});

test("rejects unnormalized, unsuccessful, and trust-mismatched candidates before network", async () => {
  const unnormalized = { ...blogCandidate("unnormalized"), title: " trailing space " };
  const unsuccessful = blogCandidate("unsuccessful", {
    metadata: { sourceRegistryId: "failed-feed" },
  });
  const trustMismatch = blogCandidate("trust-mismatch", {
    metadata: { trustTier: "community" },
  });
  let fetchCalls = 0;
  const report = await runCandidateGates(gateOptions({
    candidates: [trustMismatch, unnormalized, unsuccessful],
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("network must not run");
    },
  }));
  const reasons = new Map(report.rejected.map((item) => [item.candidateId, item.reasonCodes]));

  assert.deepEqual(reasons.get(unnormalized.identityKey), ["CANDIDATE_NOT_NORMALIZED"]);
  assert.deepEqual(reasons.get(unsuccessful.identityKey), ["SOURCE_DISCOVERY_NOT_SUCCEEDED"]);
  assert.deepEqual(reasons.get(trustMismatch.identityKey), ["SOURCE_TRUST_MISMATCH"]);
  assert.equal(fetchCalls, 0);
});

test("rejects a non-default enriched launch port before health checking the canonical URL", async () => {
  const splitEndpoint = blogCandidate("split-endpoint");
  splitEndpoint.metadata.launchUrl = "https://example.com:8443/split-endpoint";
  const calls = [];
  const report = await runCandidateGates(gateOptions({
    candidates: [splitEndpoint],
    fetchImpl: responseFetch(200, calls),
  }));

  assert.equal(splitEndpoint.canonicalUrl, "https://example.com/split-endpoint");
  assert.deepEqual(report.rejected, [{
    candidateId: splitEndpoint.identityKey,
    reasonCodes: ["CANDIDATE_NOT_NORMALIZED"],
  }]);
  assert.equal(report.summary.availabilityChecks, 0);
  assert.deepEqual(calls, []);
});

test("rejects active and retired exact duplicates before any network check", async () => {
  const active = blogCandidate("active-duplicate");
  const retired = blogCandidate("retired-duplicate");
  const discovery = structuredClone(fixture.discovery);
  discovery.candidates = [retired, active];
  let fetchCalls = 0;
  const report = await runCandidateGates(gateOptions({
    discovery,
    candidates: [retired, active],
    sourceStatuses: structuredClone(discovery.sources),
    activeCatalog: [{ id: "active", canonicalSource: active.canonicalUrl }],
    retiredCatalog: { entries: [{ record: { id: "retired", canonicalSource: retired.canonicalUrl } }] },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("duplicate checks must run first");
    },
  }));

  assert.equal(report.eligible.length, 0);
  assert.ok(report.rejected.every((item) => item.reasonCodes[0] === "EXACT_DUPLICATE"));
  assert.equal(fetchCalls, 0);
});

test("rejects candidates and source statuses detached from the discovery envelope", async (context) => {
  await context.test("candidate absent from discovery candidates", async () => {
    const discovery = structuredClone(fixture.discovery);
    const detachedCandidate = blogCandidate("detached-candidate");
    let fetchCalls = 0;
    const report = await runCandidateGates(gateOptions({
      discovery,
      candidates: [detachedCandidate],
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("detached candidates must not reach network");
      },
    }));

    assert.deepEqual(report.rejected, [{
      candidateId: detachedCandidate.identityKey,
      reasonCodes: ["CANDIDATE_NOT_IN_DISCOVERY"],
    }]);
    assert.equal(fetchCalls, 0);
  });

  await context.test("source statuses replayed from another envelope", async () => {
    const discovery = structuredClone(fixture.discovery);
    const replayedStatuses = structuredClone(discovery.sources);
    let fetchCalls = 0;
    const report = await runCandidateGates(gateOptions({
      discovery,
      sourceStatuses: replayedStatuses,
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("replayed statuses must not reach network");
      },
    }));

    assert.ok(report.rejected.every((item) => (
      item.reasonCodes.includes("SOURCE_STATUS_NOT_IN_DISCOVERY")
    )));
    assert.equal(fetchCalls, 0);
  });
});

test("rejects unqueried and duplicate source statuses before network", async (context) => {
  await context.test("succeeded but not queried", async () => {
    const sourceStatuses = structuredClone(fixture.discovery.sources);
    sourceStatuses.find((status) => status.sourceRegistryId === "trusted-feed").queried = false;
    let fetchCalls = 0;
    const report = await runCandidateGates(gateOptions({
      sourceStatuses,
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("unqueried statuses must not reach network");
      },
    }));

    assert.ok(report.rejected.every((item) => (
      item.reasonCodes.includes("SOURCE_DISCOVERY_NOT_SUCCEEDED")
    )));
    assert.equal(fetchCalls, 0);
  });

  await context.test("duplicate source registry status", async () => {
    const sourceStatuses = structuredClone(fixture.discovery.sources);
    sourceStatuses.push(structuredClone(sourceStatuses[0]));
    let fetchCalls = 0;
    const report = await runCandidateGates(gateOptions({
      sourceStatuses,
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("duplicate statuses must not reach network");
      },
    }));

    assert.ok(report.rejected.every((item) => (
      item.reasonCodes.includes("SOURCE_REGISTRY_ID_DUPLICATE")
    )));
    assert.equal(fetchCalls, 0);
  });
});

test("rejects duplicate registries, adapter mismatches, and discovery timestamp replay", async (context) => {
  await context.test("duplicate trusted registry ID", async () => {
    const trustedSources = structuredClone(fixture.trustedSources);
    trustedSources.sources.push(structuredClone(trustedSources.sources[0]));
    const report = await runCandidateGates(gateOptions({ trustedSources }));

    assert.ok(report.rejected.every((item) => (
      item.reasonCodes.includes("SOURCE_REGISTRY_ID_DUPLICATE")
    )));
  });

  await context.test("candidate source type disagrees with registry adapter", async () => {
    const candidate = blogCandidate("wrong-adapter", {
      metadata: { sourceRegistryId: "trusted-github" },
    });
    const report = await runCandidateGates(gateOptions({ candidates: [candidate] }));

    assert.deepEqual(report.rejected, [{
      candidateId: candidate.identityKey,
      reasonCodes: ["SOURCE_TYPE_MISMATCH"],
    }]);
  });

  await context.test("status source type disagrees with registry adapter", async () => {
    const sourceStatuses = structuredClone(fixture.discovery.sources);
    sourceStatuses.find((status) => status.sourceRegistryId === "trusted-feed").sourceType = "github-organization";
    const report = await runCandidateGates(gateOptions({ sourceStatuses }));

    assert.ok(report.rejected.every((item) => (
      item.reasonCodes.includes("SOURCE_TYPE_MISMATCH")
    )));
  });

  await context.test("candidate discoveredAt disagrees with envelope completedAt", async () => {
    const candidate = blogCandidate("replayed-candidate", {
      discoveredAt: "2026-08-27T00:00:00.000Z",
    });
    const report = await runCandidateGates(gateOptions({ candidates: [candidate] }));

    assert.deepEqual(report.rejected, [{
      candidateId: candidate.identityKey,
      reasonCodes: ["DISCOVERY_TIMESTAMP_MISMATCH"],
    }]);
  });
});

test("accepts only complete 2xx availability and sanitizes all other source outcomes", async (context) => {
  const cases = [
    { name: "200", status: 200, eligible: true },
    { name: "204", status: 204, eligible: true },
    { name: "404", status: 404, reasonCode: "SOURCE_HTTP_404" },
    { name: "410", status: 410, reasonCode: "SOURCE_HTTP_410" },
    { name: "429", status: 429, reasonCode: "SOURCE_HTTP_429", retried: true },
    { name: "500", status: 500, reasonCode: "SOURCE_HTTP_500", retried: true },
    { name: "partial", status: 206, reasonCode: "SOURCE_PARTIAL_RESPONSE" },
    { name: "malformed", reasonCode: "SOURCE_RESPONSE_MALFORMED", malformed: true },
    { name: "dns", reasonCode: "SOURCE_DNS_ERROR", dns: true, retried: true },
    { name: "timeout", reasonCode: "SOURCE_TIMEOUT", timeout: true, retried: true },
  ];

  for (const definition of cases) {
    await context.test(definition.name, async () => {
      const candidate = blogCandidate(`availability-${definition.name}`);
      let fetchCalls = 0;
      const lookup = definition.dns
        ? async () => {
            const error = new Error("fixture DNS failure details");
            error.code = "ENOTFOUND";
            throw error;
          }
        : publicLookup;
      const fetchImpl = async () => {
        fetchCalls += 1;
        if (definition.timeout) {
          const error = new Error("fixture timed out details");
          error.name = "AbortError";
          throw error;
        }
        if (definition.malformed) {
          return { status: undefined, statusText: "", headers: new Headers(), body: null };
        }
        return new Response(null, { status: definition.status });
      };
      const report = await runCandidateGates(gateOptions({
        candidates: [candidate],
        lookup,
        fetchImpl,
      }));

      assert.equal(report.eligible.length, definition.eligible ? 1 : 0);
      if (!definition.eligible) {
        const rejection = {
          candidateId: candidate.identityKey,
          reasonCodes: [definition.reasonCode],
        };
        if (definition.retried) {
          rejection.availability = {
            checkedAt: fixture.checkedAt,
            classification: "indeterminate",
            statusCode: Number.isInteger(definition.status) ? definition.status : null,
            reasonCode: definition.reasonCode,
            retryAttempts: 1,
            retryReasons: [definition.reasonCode],
          };
        }
        assert.deepEqual(report.rejected, [rejection]);
        assert.doesNotMatch(JSON.stringify(report.rejected), /fixture|details/i);
      }
      assert.equal(fetchCalls, definition.dns ? 0 : (definition.retried ? 2 : 1));
    });
  }
});

test("deduplicates a shared URL check and deterministically rejects the later identity", async () => {
  const sharedUrl = "https://example.com/shared";
  const alpha = blogCandidate("shared-alpha", { canonicalUrl: sharedUrl });
  const zeta = blogCandidate("shared-zeta", { canonicalUrl: sharedUrl });
  const calls = [];
  const report = await runCandidateGates(gateOptions({
    candidates: [zeta, alpha],
    fetchImpl: responseFetch(200, calls),
  }));

  assert.deepEqual(report.eligible.map((item) => item.candidate.identityKey), [alpha.identityKey]);
  assert.deepEqual(report.rejected, [{
    candidateId: zeta.identityKey,
    reasonCodes: ["EXACT_DUPLICATE"],
  }]);
  assert.equal(calls.length, 1);
  assert.equal(report.summary.availabilityChecks, 1);
});

test("recovers transient availability and reports sanitized retry metadata", async () => {
  const candidate = blogCandidate("retry-recovery");
  const delays = [];
  let calls = 0;
  const report = await runCandidateGates(gateOptions({
    candidates: [candidate],
    policy: {
      ...structuredClone(fixture.policy),
      http: {
        ...structuredClone(fixture.policy.http),
        retryDelaySeconds: [0, 5, 30, 120],
      },
    },
    delay: async (milliseconds) => delays.push(milliseconds),
    fetchImpl: async () => {
      calls += 1;
      return new Response(null, { status: calls === 1 ? 503 : 200 });
    },
  }));

  assert.equal(report.status, "complete");
  assert.equal(report.eligible.length, 1);
  assert.deepEqual(report.eligible[0].availability, {
    checkedAt: fixture.checkedAt,
    classification: "healthy",
    statusCode: 200,
    reasonCode: null,
    retryAttempts: 1,
    retryReasons: ["SOURCE_HTTP_503"],
  });
  assert.deepEqual(delays, [2_000]);
  assert.equal(calls, 2);
});

test("retains retry exhaustion as partial coverage after complete execution", async () => {
  const candidate = blogCandidate("retry-exhaustion");
  const delays = [];
  let calls = 0;
  const report = await runCandidateGates(gateOptions({
    candidates: [candidate],
    policy: {
      ...structuredClone(fixture.policy),
      http: {
        ...structuredClone(fixture.policy.http),
        retryDelaySeconds: [0, 5, 30, 120],
      },
    },
    delay: async (milliseconds) => delays.push(milliseconds),
    fetchImpl: async () => {
      calls += 1;
      return new Response("sensitive upstream response", { status: 503 });
    },
  }));

  assert.equal(report.status, "complete");
  assert.equal(report.coverageStatus, "partial");
  assert.equal(report.summary.executedCandidateChecks, 1);
  assert.equal(report.summary.executedAvailabilityChecks, 1);
  assert.equal(report.eligible.length, 0);
  assert.deepEqual(report.rejected, [{
    candidateId: candidate.identityKey,
    reasonCodes: ["SOURCE_HTTP_503"],
    availability: {
      checkedAt: fixture.checkedAt,
      classification: "indeterminate",
      statusCode: 503,
      reasonCode: "SOURCE_HTTP_503",
      retryAttempts: 1,
      retryReasons: ["SOURCE_HTTP_503"],
    },
  }]);
  assert.doesNotMatch(JSON.stringify(report.rejected), /sensitive|upstream/i);
  assert.deepEqual(delays, [2_000]);
  assert.equal(calls, 2);
});

test("uses the operation deadline without restarting it and never accepts a late response", async () => {
  const candidates = ["charlie", "alpha", "bravo"].map((id) => blogCandidate(id));
  const calls = [];
  let currentMilliseconds = 500;
  const report = await runCandidateGates(gateOptions({
    candidates,
    concurrency: 1,
    now: () => currentMilliseconds,
    deadlineMilliseconds: 1_000,
    fetchImpl: async (input) => {
      calls.push(new URL(input).toString());
      currentMilliseconds = 1_000;
      return new Response(null, { status: 200 });
    },
  }));

  assert.equal(report.status, "incomplete");
  assert.equal(report.coverageStatus, "partial");
  assert.equal(report.summary.selectedCandidates, 3);
  assert.equal(report.summary.executedCandidateChecks, 0);
  assert.equal(report.summary.executedAvailabilityChecks, 0);
  assert.deepEqual(calls, ["https://example.com/alpha"]);
  assert.deepEqual(report.eligible, []);
  assert.equal(report.summary.indeterminateAvailabilityChecks, 3);
  assert.equal(report.summary.deadlineExceededAvailabilityChecks, 3);
  assert.deepEqual(report.rejected, ["blog-post:alpha", "blog-post:bravo", "blog-post:charlie"].map((candidateId) => ({
    candidateId,
    reasonCodes: ["CANDIDATE_GATE_DEADLINE_EXCEEDED"],
    availability: {
      checkedAt: fixture.checkedAt,
      classification: "indeterminate",
      statusCode: null,
      reasonCode: "CANDIDATE_GATE_DEADLINE_EXCEEDED",
    },
  })));
});

test("bounds the candidate GET body by the operation deadline", async () => {
  const candidate = blogCandidate("slow-body");
  const calls = [];
  let currentMilliseconds = 0;
  const report = await runCandidateGates(gateOptions({
    candidates: [candidate],
    deadlineMilliseconds: 100,
    now: () => currentMilliseconds,
    fetchImpl: async (_input, init = {}) => {
      const method = init.method ?? "GET";
      calls.push(method);
      if (method === "HEAD") return new Response(null, { status: 405 });
      return new Response(new ReadableStream({
        pull(controller) {
          currentMilliseconds = 100;
          controller.enqueue(new TextEncoder().encode("late"));
          controller.close();
        },
      }), { status: 200 });
    },
  }));

  assert.deepEqual(calls, ["HEAD", "GET"]);
  assert.equal(report.status, "incomplete");
  assert.equal(report.coverageStatus, "partial");
  assert.equal(report.summary.selectedCandidates, 1);
  assert.equal(report.summary.executedCandidateChecks, 0);
  assert.equal(report.summary.executedAvailabilityChecks, 0);
  assert.deepEqual(report.eligible, []);
  assert.deepEqual(report.rejected, [{
    candidateId: candidate.identityKey,
    reasonCodes: ["CANDIDATE_GATE_DEADLINE_EXCEEDED"],
    availability: {
      checkedAt: fixture.checkedAt,
      classification: "indeterminate",
      statusCode: null,
      reasonCode: "CANDIDATE_GATE_DEADLINE_EXCEEDED",
    },
  }]);
});

test("candidate gates serialize Learn checks with injected pacing and deterministic output", async () => {
  const candidates = Array.from({ length: 8 }, (_, index) => (
    blogCandidate(`host-learn-${index}`, {
      canonicalUrl: `https://learn.microsoft.com/azure/cosmos-db/host-${index}`,
    })
  )).reverse();
  const delays = [];
  const startedUrls = [];
  let activeLearn = 0;
  let maximumActiveLearn = 0;
  const report = await runCandidateGates(gateOptions({
    candidates,
    concurrency: 20,
    delay: async (milliseconds) => delays.push(milliseconds),
    fetchImpl: async (input) => {
      const url = new URL(input).toString();
      activeLearn += 1;
      maximumActiveLearn = Math.max(maximumActiveLearn, activeLearn);
      startedUrls.push(url);
      await Promise.resolve();
      activeLearn -= 1;
      return new Response(null, { status: 200 });
    },
  }));
  const identities = report.eligible.map((item) => item.candidate.identityKey);
  const expectedUrls = Array.from(
    { length: 8 },
    (_, index) => `https://learn.microsoft.com/azure/cosmos-db/host-${index}`,
  );

  assert.equal(maximumActiveLearn, 1);
  assert.deepEqual(delays, Array(7).fill(200));
  assert.deepEqual(startedUrls, expectedUrls);
  assert.deepEqual(identities, [...identities].sort((left, right) => left.localeCompare(right)));
});

test("enforces maxCandidatesPerRun after stable identity sorting", async () => {
  const calls = [];
  const candidates = ["charlie", "alpha", "bravo"].map((id) => blogCandidate(id));
  const report = await runCandidateGates(gateOptions({
    candidates,
    policy: {
      ...structuredClone(fixture.policy),
      batching: { maxCandidatesPerRun: 2 },
    },
    fetchImpl: responseFetch(200, calls),
  }));

  assert.deepEqual(
    report.eligible.map((item) => item.candidate.identityKey),
    ["blog-post:alpha", "blog-post:bravo"],
  );
  assert.deepEqual(report.rejected, [{
    candidateId: "blog-post:charlie",
    reasonCodes: ["BATCH_CANDIDATE_LIMIT_EXCEEDED"],
  }]);
  assert.equal(report.status, "complete");
  assert.equal(report.coverageStatus, "partial");
  assert.equal(report.summary.selectedCandidates, 2);
  assert.equal(report.summary.executedCandidateChecks, 2);
  assert.equal(calls.length, 2);
});

test("marks mixed outcomes as complete execution with partial coverage", async () => {
  const healthy = blogCandidate("mixed-healthy");
  const indeterminate = blogCandidate("mixed-indeterminate");
  const report = await runCandidateGates(gateOptions({
    candidates: [indeterminate, healthy],
    fetchImpl: async (input) => {
      if (new URL(input).pathname.endsWith("mixed-indeterminate")) {
        const error = new Error("fixture timeout details");
        error.name = "AbortError";
        throw error;
      }
      return new Response(null, { status: 200 });
    },
  }));

  assert.equal(report.status, "complete");
  assert.equal(report.coverageStatus, "partial");
  assert.equal(report.summary.selectedCandidates, 2);
  assert.equal(report.summary.executedCandidateChecks, 2);
  assert.equal(report.summary.executedAvailabilityChecks, 2);
  assert.equal(report.summary.indeterminateAvailabilityChecks, 1);
  assert.deepEqual(report.eligible.map((item) => item.candidate.identityKey), [healthy.identityKey]);
  assert.deepEqual(report.rejected, [{
    candidateId: indeterminate.identityKey,
    reasonCodes: ["SOURCE_TIMEOUT"],
    availability: {
      checkedAt: fixture.checkedAt,
      classification: "indeterminate",
      statusCode: null,
      reasonCode: "SOURCE_TIMEOUT",
      retryAttempts: 1,
      retryReasons: ["SOURCE_TIMEOUT"],
    },
  }]);
});

test("completes all 155 checks, retains 13 indeterminate candidates, and retries them later", async () => {
  const candidates = Array.from({ length: 155 }, (_, index) => (
    blogCandidate(`live-shape-${String(index).padStart(3, "0")}`)
  ));
  const indeterminateUrls = new Set(
    candidates.slice(0, 13).map((candidate) => candidate.canonicalUrl),
  );
  const policy = {
    ...structuredClone(fixture.policy),
    batching: { maxCandidatesPerRun: 200 },
  };
  const report = await runCandidateGates(gateOptions({
    candidates,
    policy,
    fetchImpl: async (input) => {
      if (indeterminateUrls.has(new URL(input).toString())) {
        const error = new Error("fixture timeout details");
        error.name = "AbortError";
        throw error;
      }
      return new Response(null, { status: 200 });
    },
  }));

  assert.equal(report.status, "complete");
  assert.equal(report.coverageStatus, "partial");
  assert.deepEqual(report.summary, {
    candidates: 155,
    selectedCandidates: 155,
    executedCandidateChecks: 155,
    availabilityChecks: 155,
    executedAvailabilityChecks: 155,
    indeterminateAvailabilityChecks: 13,
    deadlineExceededAvailabilityChecks: 0,
    eligible: 142,
    rejected: 13,
  });
  assert.equal(report.rejected.every((entry) => entry.reasonCodes[0] === "SOURCE_TIMEOUT"), true);

  const retry = await runCandidateGates(gateOptions({
    candidates,
    policy,
    fetchImpl: responseFetch(200),
  }));
  assert.equal(retry.status, "complete");
  assert.equal(retry.coverageStatus, "complete");
  assert.equal(retry.summary.executedCandidateChecks, 155);
  assert.equal(retry.summary.eligible, 155);
  assert.equal(retry.summary.rejected, 0);
});