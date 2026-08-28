import { normalizeCandidates } from "../normalize.mjs";
import { enrichCandidateMetadata } from "../enrich-candidate.mjs";
import { canonicalizeUrl } from "../shared/canonicalize.mjs";

const COSMOS_TERM = /\b(?:azure\s+)?cosmos\s*db\b|\bcosmosdb\b/i;

function configuredFeedHosts(source) {
  return new Set([
    new URL(source.endpoint).hostname.toLowerCase(),
    ...(source.allowedHosts ?? []).map((host) => String(host).toLowerCase()),
  ]);
}

function trustedFeedUrl(value, allowedHosts) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      allowedHosts.has(url.hostname.toLowerCase())
    ) ? value.trim() : null;
  } catch {
    return null;
  }
}

export function discoverFeeds({ source, entries, fixture, offline = false, discoveredAt } = {}) {
  const payload = fixture ?? (entries ? { source, entries, discoveredAt } : null);
  if (!payload) {
    if (offline) {
      return [];
    }
    throw new TypeError("Feed discovery requires already parsed entries or a fixture");
  }
  const sourceConfig = source ?? payload.source;
  if (!sourceConfig?.enabled) {
    return [];
  }

  const discoveryTime = discoveredAt ?? payload.discoveredAt;
  const allowedHosts = configuredFeedHosts(sourceConfig);
  const candidates = [];
  for (const entry of payload.entries ?? []) {
    const sourceId = entry?.id ?? entry?.guid;
    const link = entry?.canonicalUrl ?? entry?.link;
    if (!sourceId || !link || !entry?.title) {
      continue;
    }
    const launchUrl = trustedFeedUrl(link, allowedHosts);
    if (!launchUrl) {
      continue;
    }
    const canonicalUrl = canonicalizeUrl(launchUrl);
    const relevanceText = [entry.title, entry.description, entry.summary, entry.content]
      .filter(Boolean)
      .join("\n");
    if (!COSMOS_TERM.test(relevanceText)) {
      continue;
    }
    const normalizedSourceId = String(sourceId);
    const publisher = entry.publisher ?? sourceConfig.ownerLabel;
    const sourceOwner = entry.publisher ?? sourceConfig.ownerLabel ?? null;
    const publishedAt = entry.publishedAt ?? entry.pubDate ?? null;
    const articleOrigin = new URL(launchUrl).origin;
    const catalogMetadata = enrichCandidateMetadata({
      sourceType: "blog-post",
      sourceId: normalizedSourceId,
      trustTier: sourceConfig.trustTier,
      launchUrl,
      websiteUrls: [entry.feedSiteUrl, entry.siteUrl, sourceConfig.website, articleOrigin]
        .map((value) => trustedFeedUrl(value, allowedHosts)),
      author: publisher,
      sourceOwner,
      publishedAt,
      previewUrls: [entry.imageUrl, entry.thumbnailUrl, entry.image?.url]
        .map((value) => trustedFeedUrl(value, allowedHosts)),
    });

    candidates.push({
      sourceType: "blog-post",
      sourceId: normalizedSourceId,
      canonicalUrl,
      title: entry.title,
      description: entry.description ?? entry.summary ?? "",
      publisher,
      publishedAt,
      modifiedAt: entry.modifiedAt ?? entry.updatedAt ?? null,
      discoveredAt: discoveryTime,
      evidence: [
        {
          type: "feed-entry-content",
          value: entry.content ?? entry.description ?? entry.summary ?? entry.title,
        },
      ],
      metadata: {
        ...catalogMetadata,
        sourceRegistryId: sourceConfig.id,
        trustTier: sourceConfig.trustTier,
        feedEntryId: normalizedSourceId,
        feedUrl: canonicalizeUrl(sourceConfig.endpoint),
      },
    });
  }
  return normalizeCandidates(candidates);
}