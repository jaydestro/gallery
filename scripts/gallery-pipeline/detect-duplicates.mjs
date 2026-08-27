import { canonicalizeUrl } from "./shared/canonicalize.mjs";

function requireArray(value, name) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array`);
  }
}

function existingCanonicalUrl(record) {
  const value = record?.canonicalUrl ?? record?.canonicalSource ?? record?.source;
  return typeof value === "string" && value.trim() ? canonicalizeUrl(value) : null;
}

function addIndex(index, value, match) {
  if (!value) {
    return;
  }
  const matches = index.get(value) ?? [];
  matches.push(match);
  index.set(value, matches);
}

function indexRecord(indexes, record, scope, index) {
  const reference = { scope, index };
  if (typeof record?.identityKey === "string" && record.identityKey.trim()) {
    addIndex(indexes.identities, record.identityKey.trim(), { ...reference, field: "identityKey" });
  }
  const canonicalUrl = existingCanonicalUrl(record);
  if (canonicalUrl) {
    addIndex(indexes.urls, canonicalUrl, { ...reference, field: "canonicalUrl" });
  }
}

export function detectExactDuplicates(candidates, { active = [], retired = [] } = {}) {
  requireArray(candidates, "candidates");
  requireArray(active, "active");
  requireArray(retired, "retired");

  const indexes = {
    identities: new Map(),
    urls: new Map(),
  };
  active.forEach((record, index) => indexRecord(indexes, record, "active", index));
  retired.forEach((record, index) => indexRecord(indexes, record, "retired", index));

  const accepted = [];
  const duplicates = [];

  candidates.forEach((candidate, index) => {
    if (typeof candidate?.identityKey !== "string" || !candidate.identityKey.trim()) {
      throw new TypeError(`Candidate at index ${index} is missing identityKey`);
    }
    if (typeof candidate?.canonicalUrl !== "string" || !candidate.canonicalUrl.trim()) {
      throw new TypeError(`Candidate at index ${index} is missing canonicalUrl`);
    }

    const identityKey = candidate.identityKey.trim();
    const canonicalUrl = canonicalizeUrl(candidate.canonicalUrl);
    const matches = [
      ...(indexes.identities.get(identityKey) ?? []),
      ...(indexes.urls.get(canonicalUrl) ?? []),
    ];
    const reasons = [];
    if (indexes.identities.has(identityKey)) {
      reasons.push("identity-key");
    }
    if (indexes.urls.has(canonicalUrl)) {
      reasons.push("canonical-url");
    }

    if (reasons.length) {
      duplicates.push({ candidate, reasons, matches });
    } else {
      accepted.push(candidate);
    }
    indexRecord(indexes, candidate, "incoming", index);
  });

  return { accepted, duplicates };
}