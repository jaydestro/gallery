import { normalizeCandidates } from "../normalize.mjs";
import { enrichCandidateMetadata } from "../enrich-candidate.mjs";
import { canonicalizeLearnUrl } from "../shared/canonicalize.mjs";

const COSMOS_TERM = /\b(?:azure\s+)?cosmos\s*db\b|\bcosmosdb\b/i;

function withinRoot(candidateUrl, rootUrl) {
  const candidate = new URL(candidateUrl);
  const root = new URL(rootUrl);
  const candidatePath = candidate.pathname.toLowerCase();
  const rootPath = root.pathname.replace(/\/$/, "").toLowerCase();
  return (
    candidate.hostname === root.hostname &&
    (candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`))
  );
}

function configuredHostUrl(value, rootUrl) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    const root = new URL(rootUrl);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.hostname === root.hostname
    ) ? value.trim() : null;
  } catch {
    return null;
  }
}

export function discoverLearn({ source, documents, fixture, offline = false, discoveredAt } = {}) {
  const payload = fixture ?? (documents ? { source, documents, discoveredAt } : null);
  if (!payload) {
    if (offline) {
      return [];
    }
    throw new TypeError("Learn discovery requires normalized documents or a fixture");
  }
  const sourceConfig = source ?? payload.source;
  if (!sourceConfig?.enabled) {
    return [];
  }

  const rootUrl = canonicalizeLearnUrl(sourceConfig.endpoint);
  const discoveryTime = discoveredAt ?? payload.discoveredAt;
  const candidates = [];
  for (const document of payload.documents ?? []) {
    if (!document?.url || !document?.title) {
      continue;
    }
    const launchUrl = document.canonicalUrl ?? document.url;
    let canonicalUrl;
    try {
      canonicalUrl = canonicalizeLearnUrl(launchUrl);
    } catch {
      continue;
    }
    if (!withinRoot(canonicalUrl, rootUrl)) {
      continue;
    }
    const relevanceText = [document.title, document.description, document.sectionText]
      .filter(Boolean)
      .join("\n");
    if (!COSMOS_TERM.test(relevanceText)) {
      continue;
    }
    const publishedAt = document.publishedAt ?? null;
    const catalogMetadata = enrichCandidateMetadata({
      launchUrl,
      websiteUrls: [rootUrl],
      author: sourceConfig.ownerLabel,
      sourceOwner: sourceConfig.ownerLabel,
      publishedAt,
      previewUrls: [document.imageUrl, document.thumbnailUrl, document.image?.url]
        .map((value) => configuredHostUrl(value, rootUrl)),
    });

    candidates.push({
      sourceType: "learn-document",
      sourceId: String(document.id ?? document.uid ?? canonicalUrl),
      canonicalUrl,
      title: document.title,
      description: document.description ?? "",
      publisher: document.publisher ?? sourceConfig.ownerLabel,
      publishedAt,
      modifiedAt: document.lastModified ?? document.modifiedAt ?? null,
      discoveredAt: discoveryTime,
      evidence: [
        {
          type: "learn-cosmos-section",
          value: document.sectionText ?? document.description ?? document.title,
        },
      ],
      metadata: {
        ...catalogMetadata,
        sourceRegistryId: sourceConfig.id,
        trustTier: sourceConfig.trustTier,
        documentId: document.id ?? document.uid ?? null,
        lastModifiedEvidence: document.lastModified ?? document.modifiedAt ?? null,
      },
    });
  }
  return normalizeCandidates(candidates);
}