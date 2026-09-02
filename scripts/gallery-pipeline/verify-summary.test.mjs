import assert from "node:assert/strict";
import test from "node:test";

import {
  AI_LIMITS,
  AiAnalysisError,
} from "./analyze-content.mjs";
import {
  GROUNDING_THRESHOLD,
  GROUNDING_SYSTEM_INSTRUCTIONS,
  verifySummary,
} from "./verify-summary.mjs";

const sourceUrl = "https://learn.microsoft.com/azure/cosmos-db/nosql/vector-search";
const candidate = Object.freeze({
  sourceId: "vector-guide",
  title: "Vector search guide",
  description: "Azure Cosmos DB for NoSQL supports vector search for application retrieval.",
  canonicalUrl: sourceUrl,
  retrievedContent: [{
    url: sourceUrl,
    text: "Azure Cosmos DB for NoSQL supports vector search. The feature can retrieve similar items for AI application scenarios.",
  }],
});
const summary = "Azure Cosmos DB for NoSQL supports vector search. The guide describes retrieval for AI application scenarios.";

function groundingOutput(request, overrides = {}) {
  return {
    invocationId: request.invocationId,
    candidateId: "vector-guide",
    summary,
    grounding: {
      score: 0.99,
      claims: [
        {
          claim: "Azure Cosmos DB for NoSQL supports vector search.",
          entailed: true,
          evidence: [{ url: sourceUrl, excerpt: "Azure Cosmos DB for NoSQL supports vector search." }],
        },
        {
          claim: "The guide describes retrieval for AI application scenarios.",
          entailed: true,
          evidence: [{ url: sourceUrl, excerpt: "retrieve similar items for AI application scenarios" }],
        },
      ],
    },
    ...overrides,
  };
}

test("loads the grounding threshold from validated policy", () => {
  assert.equal(GROUNDING_THRESHOLD, 0.95);
});

test("uses an independent fixed-instruction invocation and verifies each sentence", async () => {
  const requests = [];
  const client = {
    async invoke(request) {
      requests.push(request);
      return { outputText: JSON.stringify(groundingOutput(request)) };
    },
  };

  const result = await verifySummary({
    candidate,
    summary,
    client,
    previousInvocationId: "relevance-shared-id",
    createInvocationId: () => "grounding-id",
  });

  assert.equal(result.invocationId, "grounding-grounding-id");
  assert.notEqual(result.invocationId, "relevance-shared-id");
  assert.equal(result.grounding.claims.length, 2);
  assert.equal(requests[0].systemInstructions, GROUNDING_SYSTEM_INSTRUCTIONS);
  assert.deepEqual(requests[0].tools, []);
  assert.equal(requests[0].maxOutputTokens, AI_LIMITS.groundingMaxOutputTokens);
  const input = JSON.parse(requests[0].input);
  assert.equal(input.trustBoundary, "UNTRUSTED_RETRIEVED_CONTENT");
  assert.equal(input.invocationId, "grounding-grounding-id");
});

test("fails closed before invocation when the summary is not two or three sentences", async () => {
  let invoked = false;
  await assert.rejects(
    verifySummary({
      candidate,
      summary: "Only one sentence is present.",
      client: { async invoke() { invoked = true; } },
      previousInvocationId: "relevance-one",
    }),
    (error) => error instanceof AiAnalysisError && error.code === "SUMMARY_FORMAT_INVALID",
  );
  assert.equal(invoked, false);
});

test("fails closed on an unsupported claim or grounding score", async (context) => {
  const cases = [
    {
      name: "unsupported claim",
      mutate(output) {
        output.grounding.claims[1].entailed = false;
        output.grounding.claims[1].evidence = [];
      },
    },
    {
      name: "grounding below 0.95",
      mutate(output) {
        output.grounding.score = 0.949;
      },
    },
  ];

  for (const item of cases) {
    await context.test(item.name, async () => {
      const client = {
        async invoke(request) {
          const output = groundingOutput(request);
          item.mutate(output);
          return { outputText: JSON.stringify(output) };
        },
      };
      await assert.rejects(
        verifySummary({
          candidate,
          summary,
          client,
          previousInvocationId: "relevance-one",
          createInvocationId: () => item.name,
        }),
        (error) => error instanceof AiAnalysisError && error.code === "UNSUPPORTED_SUMMARY_CLAIM",
      );
    });
  }
});

test("fails closed when claims, summaries, or evidence do not match input", async (context) => {
  const cases = [
    {
      name: "claim mismatch",
      mutate(output) { output.grounding.claims[0].claim = "A changed claim."; },
      code: "CLAIM_MISMATCH",
    },
    {
      name: "summary mismatch",
      mutate(output) { output.summary = `${summary} Changed.`; },
      code: "SUMMARY_MISMATCH",
    },
    {
      name: "evidence mismatch",
      mutate(output) { output.grounding.claims[0].evidence[0].url = "https://example.com/untrusted"; },
      code: "EVIDENCE_MISMATCH",
    },
  ];

  for (const item of cases) {
    await context.test(item.name, async () => {
      const client = {
        async invoke(request) {
          const output = groundingOutput(request);
          item.mutate(output);
          return { outputText: JSON.stringify(output) };
        },
      };
      await assert.rejects(
        verifySummary({
          candidate,
          summary,
          client,
          previousInvocationId: "relevance-one",
          createInvocationId: () => item.name,
        }),
        (error) => error instanceof AiAnalysisError && error.code === item.code,
      );
    });
  }
});

test("rejects replay of grounding output bound to an earlier model-visible invocation ID", async () => {
  let replayedOutput;
  const visibleInvocationIds = [];
  const client = {
    async invoke(request) {
      const input = JSON.parse(request.input);
      visibleInvocationIds.push(input.invocationId);
      assert.equal(input.invocationId, request.invocationId);
      replayedOutput ??= groundingOutput(request);
      return { outputText: JSON.stringify(replayedOutput) };
    },
  };

  await verifySummary({
    candidate,
    summary,
    client,
    previousInvocationId: "relevance-one",
    createInvocationId: () => "nonce-one",
  });
  await assert.rejects(
    verifySummary({
      candidate,
      summary,
      client,
      previousInvocationId: "relevance-two",
      createInvocationId: () => "nonce-two",
    }),
    (error) => error instanceof AiAnalysisError && error.code === "INVOCATION_MISMATCH",
  );
  assert.deepEqual(visibleInvocationIds, ["grounding-nonce-one", "grounding-nonce-two"]);
});

test("rejects a fabricated grounding excerpt from an otherwise allowed URL", async () => {
  const client = {
    async invoke(request) {
      const output = groundingOutput(request);
      output.grounding.claims[0].evidence[0].excerpt = "A fabricated source excerpt.";
      return { outputText: JSON.stringify(output) };
    },
  };

  await assert.rejects(
    verifySummary({
      candidate,
      summary,
      client,
      previousInvocationId: "relevance-one",
      createInvocationId: () => "fabricated-grounding-evidence",
    }),
    (error) => error instanceof AiAnalysisError && error.code === "EVIDENCE_MISMATCH",
  );
});

test("treats .NET and Node.js periods as part of their sentences", async () => {
  const technologyCandidate = {
    ...candidate,
    retrievedContent: [{
      url: sourceUrl,
      text: "The .NET SDK supports Azure Cosmos DB development. Node.js clients can use the JavaScript SDK.",
    }],
  };
  const technologySummary = "The .NET SDK supports Azure Cosmos DB development. Node.js clients can use the JavaScript SDK.";
  const client = {
    async invoke(request) {
      return {
        outputText: JSON.stringify({
          invocationId: request.invocationId,
          candidateId: "vector-guide",
          summary: technologySummary,
          grounding: {
            score: 1,
            claims: [
              {
                claim: "The .NET SDK supports Azure Cosmos DB development.",
                entailed: true,
                evidence: [{
                  url: sourceUrl,
                  excerpt: "The .NET SDK supports Azure Cosmos DB development.",
                }],
              },
              {
                claim: "Node.js clients can use the JavaScript SDK.",
                entailed: true,
                evidence: [{
                  url: sourceUrl,
                  excerpt: "Node.js clients can use the JavaScript SDK.",
                }],
              },
            ],
          },
        }),
      };
    },
  };

  const result = await verifySummary({
    candidate: technologyCandidate,
    summary: technologySummary,
    client,
    previousInvocationId: "relevance-technologies",
    createInvocationId: () => "technologies",
  });

  assert.deepEqual(
    result.grounding.claims.map((claim) => claim.claim),
    [
      "The .NET SDK supports Azure Cosmos DB development.",
      "Node.js clients can use the JavaScript SDK.",
    ],
  );
});

test("fails closed on grounding refusal", async () => {
  await assert.rejects(
    verifySummary({
      candidate,
      summary,
      client: { async invoke() { return { refusal: "No" }; } },
      previousInvocationId: "relevance-one",
      createInvocationId: () => "refusal",
    }),
    (error) => error instanceof AiAnalysisError && error.code === "MODEL_REFUSAL",
  );
});