import { normalizeCandidates } from "../normalize.mjs";
import { canonicalizeUrl } from "../shared/canonicalize.mjs";

const COSMOS_TERM = /\b(?:azure\s+)?cosmos\s*db\b|\bcosmosdb\b/i;

function trustedArticleHost(articleUrl, source) {
  const allowedHosts = new Set([
    new URL(source.endpoint).hostname.toLowerCase(),
    ...(source.allowedHosts ?? []).map((host) => String(host).toLowerCase()),
  ]);
  return allowedHosts.has(new URL(articleUrl).hostname.toLowerCase());
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
  const candidates = [];
  for (const entry of payload.entries ?? []) {
    const sourceId = entry?.id ?? entry?.guid;
    const link = entry?.canonicalUrl ?? entry?.link;
    if (!sourceId || !link || !entry?.title) {
      continue;
    }
    const canonicalUrl = canonicalizeUrl(link);
    if (!trustedArticleHost(canonicalUrl, sourceConfig)) {
      continue;
    }
    const relevanceText = [entry.title, entry.description, entry.summary, entry.content]
      .filter(Boolean)
      .join("\n");
    if (!COSMOS_TERM.test(relevanceText)) {
      continue;
    }

    candidates.push({
      sourceType: "blog-post",
      sourceId: String(sourceId),
      canonicalUrl,
      title: entry.title,
      description: entry.description ?? entry.summary ?? "",
      publisher: entry.publisher ?? entry.author ?? sourceConfig.ownerLabel,
      publishedAt: entry.publishedAt ?? entry.pubDate ?? null,
      modifiedAt: entry.modifiedAt ?? entry.updatedAt ?? null,
      discoveredAt: discoveryTime,
      evidence: [
        {
          type: "feed-entry-content",
          value: entry.content ?? entry.description ?? entry.summary ?? entry.title,
        },
      ],
      metadata: {
        sourceRegistryId: sourceConfig.id,
        trustTier: sourceConfig.trustTier,
        feedEntryId: String(sourceId),
        feedUrl: canonicalizeUrl(sourceConfig.endpoint),
      },
    });
  }
  return normalizeCandidates(candidates);
}