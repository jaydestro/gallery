import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCandidateGates } from "./candidate-gates.mjs";
import { normalizeCandidate } from "./normalize.mjs";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(await readFile(
  path.join(TEST_DIRECTORY, "fixtures", "candidate-gates", "input.json"),
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
    ...remainingOverrides,
  };
}

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
  assert.equal(report.startedAt, fixture.checkedAt);
  assert.equal(report.completedAt, fixture.checkedAt);
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
    { name: "429", status: 429, reasonCode: "SOURCE_HTTP_429" },
    { name: "500", status: 500, reasonCode: "SOURCE_HTTP_500" },
    { name: "partial", status: 206, reasonCode: "SOURCE_PARTIAL_RESPONSE" },
    { name: "malformed", reasonCode: "SOURCE_RESPONSE_MALFORMED", malformed: true },
    { name: "dns", reasonCode: "SOURCE_DNS_ERROR", dns: true },
    { name: "timeout", reasonCode: "SOURCE_TIMEOUT", timeout: true },
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
        assert.deepEqual(report.rejected, [{
          candidateId: candidate.identityKey,
          reasonCodes: [definition.reasonCode],
        }]);
        assert.doesNotMatch(JSON.stringify(report.rejected), /fixture|details/i);
      }
      assert.equal(fetchCalls, definition.dns ? 0 : 1);
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

test("caps availability concurrency at six and preserves identity ordering", async () => {
  const candidates = Array.from({ length: 12 }, (_, index) => (
    blogCandidate(`parallel-${String(index).padStart(2, "0")}`)
  )).reverse();
  let active = 0;
  let maximumActive = 0;
  const report = await runCandidateGates(gateOptions({
    candidates,
    concurrency: 20,
    fetchImpl: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return new Response(null, { status: 200 });
    },
  }));
  const identities = report.eligible.map((item) => item.candidate.identityKey);

  assert.equal(maximumActive, 6);
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
  assert.equal(calls.length, 2);
});

test("marks mixed resolved and indeterminate availability as partial", async () => {
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

  assert.equal(report.status, "partial");
  assert.equal(report.summary.indeterminateAvailabilityChecks, 1);
  assert.deepEqual(report.eligible.map((item) => item.candidate.identityKey), [healthy.identityKey]);
  assert.deepEqual(report.rejected, [{
    candidateId: indeterminate.identityKey,
    reasonCodes: ["SOURCE_TIMEOUT"],
  }]);
});