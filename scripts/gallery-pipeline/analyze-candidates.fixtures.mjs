import { makeProposalFixture } from "./propose-catalog-changes.fixtures.mjs";

export function makeCandidateAnalysisFixture(candidateCount = 2) {
  const proposal = makeProposalFixture({ candidateCount });
  for (const value of Object.values(proposal.policy.automation.ai)) {
    if (value !== true) throw new Error("Proposal fixture must enable every AI policy flag.");
  }
  return {
    discovery: proposal.discovery,
    candidateGates: proposal.candidateGates,
    activeCatalog: proposal.activeCatalog,
    retiredCatalog: proposal.retired,
    policy: proposal.policy,
    analysisSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
    },
    sourceDiscoveryArtifact: proposal.upstreamArtifacts.find((entry) => entry.name === "discovery"),
    provenance: {
      repository: proposal.trustedRepository,
      workflowId: "98765",
      workflowPath: ".github/workflows/analyze-gallery-candidates.yml",
      runId: "54321",
      runAttempt: 1,
      sourceRef: proposal.trustedRef,
      sourceSha: proposal.trustedSha,
    },
    environment: {
      AZURE_OPENAI_ENDPOINT: "https://gallery-analysis.openai.azure.com",
      AZURE_OPENAI_DEPLOYMENT: "gallery-model",
      AZURE_OPENAI_BEARER_TOKEN: "fixture-token-must-not-escape",
    },
  };
}

export function makeSuccessfulClient(candidate) {
  const candidateId = candidate.identityKey;
  const evidence = candidate.evidence[0].value;
  const claim = `${evidence}.`;
  const summary = `${claim} ${claim}`;
  let invocation = 0;
  return {
    async invoke(request) {
      invocation += 1;
      const input = JSON.parse(request.input);
      if (request.operation === "content-analysis") {
        return {
          outputText: JSON.stringify({
            invocationId: request.invocationId,
            candidateId,
            relevance: {
              score: 0.99,
              material: true,
              evidence: [{
                url: candidate.canonicalUrl,
                excerpt: evidence,
              }],
              rationale: "Direct Cosmos DB evidence.",
            },
            duplicate: {
              score: 0.1,
              classification: "unique",
              matchedEntryId: null,
              evidence: [],
            },
            quality: { passes: true, flags: [] },
            recommendation: "publish",
            reasonCodes: ["MATERIAL_RELEVANCE"],
            generatedSummary: summary,
          }),
        };
      }
      if (request.operation === "summary-grounding") {
        return {
          outputText: JSON.stringify({
            invocationId: request.invocationId,
            candidateId,
            summary,
            grounding: {
              score: 0.99,
              claims: [
                {
                  claim,
                  entailed: true,
                  evidence: [{ url: candidate.canonicalUrl, excerpt: evidence }],
                },
                {
                  claim,
                  entailed: true,
                  evidence: [{ url: candidate.canonicalUrl, excerpt: evidence }],
                },
              ],
            },
          }),
        };
      }
      throw new Error(`Unexpected operation ${request.operation} for ${input.candidate?.candidateId ?? invocation}.`);
    },
  };
}