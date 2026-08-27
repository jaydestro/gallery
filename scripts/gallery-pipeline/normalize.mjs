import { canonicalizeUrl, generateIdentityKey, normalizeRepositoryPath } from "./shared/canonicalize.mjs";

export const CANDIDATE_SCHEMA_VERSION = "1.0.0";

const SOURCE_TYPES = new Set([
  "blog-post",
  "github-path",
  "github-repository",
  "learn-document",
  "video",
]);

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeTimestamp(value, name, { required = false } = {}) {
  if (value === null || value === undefined || value === "") {
    if (required) {
      throw new TypeError(`${name} is required`);
    }
    return null;
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf())) {
    throw new TypeError(`${name} must be a valid date-time`);
  }
  return timestamp.toISOString();
}

function normalizeEvidence(evidence) {
  if (!Array.isArray(evidence)) {
    throw new TypeError("evidence must be an array");
  }
  return evidence.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError("Each evidence item must be an object");
    }
    const normalized = {
      type: requireString(item.type, "evidence.type"),
      value: requireString(item.value, "evidence.value"),
    };
    if (item.url) {
      normalized.url = canonicalizeUrl(item.url);
    }
    return normalized;
  });
}

export function normalizeCandidate(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError("candidate must be an object");
  }

  const sourceType = requireString(candidate.sourceType, "sourceType").toLowerCase();
  if (!SOURCE_TYPES.has(sourceType)) {
    throw new TypeError(`Unsupported candidate sourceType: ${sourceType}`);
  }

  const sourceId = String(candidate.sourceId ?? "").trim();
  if (!sourceId) {
    throw new TypeError("sourceId must be a stable source-native identifier");
  }
  const repositoryPath = normalizeRepositoryPath(candidate.repositoryPath);
  const metadata = candidate.metadata ?? {};
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TypeError("metadata must be an object");
  }

  return {
    schemaVersion: CANDIDATE_SCHEMA_VERSION,
    sourceType,
    sourceId,
    identityKey: generateIdentityKey({ sourceType, sourceId, repositoryPath }),
    canonicalUrl: canonicalizeUrl(requireString(candidate.canonicalUrl, "canonicalUrl")),
    title: requireString(candidate.title, "title"),
    description: typeof candidate.description === "string" ? candidate.description.trim() : "",
    publisher: requireString(candidate.publisher, "publisher"),
    publishedAt: normalizeTimestamp(candidate.publishedAt, "publishedAt"),
    modifiedAt: normalizeTimestamp(candidate.modifiedAt, "modifiedAt"),
    discoveredAt: normalizeTimestamp(candidate.discoveredAt, "discoveredAt", { required: true }),
    evidence: normalizeEvidence(candidate.evidence ?? []),
    metadata: { ...metadata },
  };
}

export function normalizeCandidates(candidates) {
  if (!Array.isArray(candidates)) {
    throw new TypeError("candidates must be an array");
  }
  return candidates.map(normalizeCandidate).sort((left, right) => left.identityKey.localeCompare(right.identityKey));
}