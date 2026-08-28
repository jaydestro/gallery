export const HEALTH_SCHEMA = "../.github/gallery-pipeline/health.schema.json";

export const HEALTH_RUN = Object.freeze({
  repository: "example/gallery",
  runId: "123456789",
  runAttempt: 1,
  sourceRef: "refs/heads/main",
  sourceSha: "0123456789abcdef0123456789abcdef01234567",
  observedAt: "2026-08-27T12:00:00.000Z",
});

export function prettyJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

export function makeHealthEntry({
  checkedAt = HEALTH_RUN.observedAt,
  canonicalSource = "https://example.com/gallery-sample",
  consecutiveFindings = 1,
  galleryId = "fixture-health",
  gracePeriodStartedAt = HEALTH_RUN.observedAt,
  reason = "SOURCE_HTTP_404",
  status = "needs-review",
} = {}) {
  const healthy = status === "healthy";
  return {
    galleryId,
    canonicalSource,
    checkedAt,
    status,
    healthScore: healthy ? 100 : 75,
    components: {
      availabilityIntegrity: healthy ? 25 : 0,
      maintenanceFreshness: 25,
      sampleUsability: 20,
      productRelevance: 20,
      galleryValue: 10,
    },
    healthReasons: healthy ? [] : [reason],
    consecutiveFindings: healthy ? 0 : consecutiveFindings,
    gracePeriodStartedAt: healthy ? null : gracePeriodStartedAt,
    sourceState: {
      availability: healthy ? "available" : "broken",
      archived: null,
      disabled: null,
      lastMeaningfulChange: null,
    },
    evidence: [{
      kind: "availability-check",
      observedAt: checkedAt,
      source: canonicalSource,
      value: healthy ? "healthy" : reason,
    }],
  };
}

export function makeHealthPersistenceFixture() {
  const catalog = [{
    id: "fixture-health",
    canonicalSource: "https://example.com/gallery-sample",
  }];
  const priorHealth = {
    $schema: HEALTH_SCHEMA,
    version: "1.0.0",
    entries: [],
  };
  const proposedHealth = {
    $schema: HEALTH_SCHEMA,
    version: "1.0.0",
    entries: [makeHealthEntry()],
  };
  return {
    catalog,
    catalogBytes: prettyJsonBytes(catalog),
    priorHealth,
    priorHealthBytes: prettyJsonBytes(priorHealth),
    proposedHealth,
    run: { ...HEALTH_RUN },
    summary: {
      sources: 1,
      entries: 1,
      healthy: 0,
      definitiveFailures: 1,
      indeterminate: 0,
      needsReview: 1,
      quarantined: 0,
    },
    sources: [{
      canonicalSource: catalog[0].canonicalSource,
      galleryIds: [catalog[0].id],
      classification: "definitive-failure",
      reason: "SOURCE_HTTP_404",
      statusCode: 404,
      retryAttempts: 0,
      retryReasons: [],
      evidence: [{ kind: "http-status", value: "HEAD 404" }],
    }],
  };
}