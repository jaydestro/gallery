import { isIP } from "node:net";

import { canonicalizeUrl } from "./shared/canonicalize.mjs";

export const CATALOG_PREVIEW_PLACEHOLDER = "coming soon";

const MAX_METADATA_TEXT_LENGTH = 160;
const MAX_METADATA_URL_LENGTH = 2_048;
const LOCAL_HOSTNAMES = new Set(["localhost", "localhost.localdomain"]);
const LOCAL_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".lan", ".home.arpa"];

class NonDefaultPortError extends TypeError {}

function boundedText(value, name, { nullable = false } = {}) {
  if (value === null || value === undefined || value === "") {
    if (nullable) return null;
    throw new TypeError(`${name} must be a non-empty string`);
  }
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string`);
  }
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) {
    if (nullable) return null;
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return [...normalized].slice(0, MAX_METADATA_TEXT_LENGTH).join("");
}

function parsedPublicHttpsUrl(value, name, { nullable = false } = {}) {
  if (value === null || value === undefined || value === "") {
    if (nullable) return null;
    throw new TypeError(`${name} must be an HTTPS URL`);
  }
  if (
    typeof value !== "string" ||
    value.length > MAX_METADATA_URL_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(`${name} must be an HTTPS URL no longer than ${MAX_METADATA_URL_LENGTH} characters`);
  }
  const exact = value.trim();
  let parsed;
  try {
    parsed = new URL(exact);
  } catch {
    throw new TypeError(`${name} must be an HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) {
    throw new TypeError(`${name} must be an HTTPS URL without credentials`);
  }
  if (parsed.port) {
    throw new NonDefaultPortError(`${name} must not specify a non-default port`);
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  const addressLiteral = hostname.replace(/^\[|\]$/g, "");
  if (
    isIP(addressLiteral) ||
    !hostname.includes(".") ||
    LOCAL_HOSTNAMES.has(hostname) ||
    LOCAL_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw new TypeError(`${name} must not target a literal, private, or local destination`);
  }
  return { exact, parsed };
}

function authoritativeHttpsUrl(value, name, { nullable = false } = {}) {
  return parsedPublicHttpsUrl(value, name, { nullable })?.exact ?? null;
}

function canonicalHttpsUrl(value, name, { nullable = false } = {}) {
  const validated = parsedPublicHttpsUrl(value, name, { nullable });
  if (!validated) return null;
  const { parsed } = validated;
  const canonical = canonicalizeUrl(parsed.toString());
  if (canonical.length > MAX_METADATA_URL_LENGTH) {
    throw new TypeError(`${name} exceeds ${MAX_METADATA_URL_LENGTH} characters after canonicalization`);
  }
  return canonical;
}

function firstCanonicalHttpsUrl(values, name) {
  for (const value of values) {
    try {
      const normalized = canonicalHttpsUrl(value, name, { nullable: true });
      if (normalized) return normalized;
    } catch (error) {
      if (error instanceof NonDefaultPortError) throw error;
    }
  }
  return null;
}

function normalizedTimestamp(value, name) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a valid date-time string`);
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf())) {
    throw new TypeError(`${name} must be a valid date-time`);
  }
  return timestamp.toISOString();
}

export function enrichCandidateMetadata({
  launchUrl,
  websiteUrls = [],
  author,
  sourceOwner = null,
  publishedAt = null,
  previewUrls = [],
}) {
  const website = firstCanonicalHttpsUrl(websiteUrls, "metadata.website");
  if (!website) {
    throw new TypeError("metadata.website requires an authoritative HTTPS publisher, profile, or root URL");
  }
  return {
    launchUrl: authoritativeHttpsUrl(launchUrl, "metadata.launchUrl"),
    website,
    author: boundedText(author, "metadata.author"),
    sourceOwner: boundedText(sourceOwner, "metadata.sourceOwner", { nullable: true }),
    publishedAt: normalizedTimestamp(publishedAt, "metadata.publishedAt"),
    preview: firstCanonicalHttpsUrl(previewUrls, "metadata.preview") ?? CATALOG_PREVIEW_PLACEHOLDER,
  };
}

export function normalizeEnrichedMetadata(metadata, publishedAt) {
  const normalized = { ...metadata };
  if (Object.hasOwn(normalized, "launchUrl")) {
    normalized.launchUrl = authoritativeHttpsUrl(normalized.launchUrl, "metadata.launchUrl");
  }
  if (Object.hasOwn(normalized, "website")) {
    normalized.website = canonicalHttpsUrl(normalized.website, "metadata.website");
  }
  if (Object.hasOwn(normalized, "preview")) {
    normalized.preview = normalized.preview === CATALOG_PREVIEW_PLACEHOLDER
      ? CATALOG_PREVIEW_PLACEHOLDER
      : canonicalHttpsUrl(normalized.preview, "metadata.preview");
  }
  if (Object.hasOwn(normalized, "author")) {
    normalized.author = boundedText(normalized.author, "metadata.author");
  }
  if (Object.hasOwn(normalized, "sourceOwner")) {
    normalized.sourceOwner = boundedText(normalized.sourceOwner, "metadata.sourceOwner", { nullable: true });
  }
  if (Object.hasOwn(normalized, "publishedAt")) {
    normalized.publishedAt = normalizedTimestamp(normalized.publishedAt, "metadata.publishedAt");
    if (normalized.publishedAt !== publishedAt) {
      throw new TypeError("metadata.publishedAt must match candidate publishedAt");
    }
  }
  return normalized;
}