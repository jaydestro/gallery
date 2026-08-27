import { normalizeCandidates } from "../normalize.mjs";
import { canonicalizeLearnUrl } from "../shared/canonicalize.mjs";

const COSMOS_TERM = /\b(?:azure\s+)?cosmos\s*db\b|\bcosmosdb\b/i;

function withinRoot(candidateUrl, rootUrl) {
  const candidate = new URL(candidateUrl);
  const root = new URL(rootUrl);
  const rootPath = root.pathname.replace(/\/$/, "");
  return (
    candidate.hostname === root.hostname &&
    (candidate.pathname === rootPath || candidate.pathname.startsWith(`${rootPath}/`))
  );
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
    const canonicalUrl = canonicalizeLearnUrl(document.canonicalUrl ?? document.url);
    if (!withinRoot(canonicalUrl, rootUrl)) {
      continue;
    }
    const relevanceText = [document.title, document.description, document.sectionText]
      .filter(Boolean)
      .join("\n");
    if (!COSMOS_TERM.test(relevanceText)) {
      continue;
    }

    candidates.push({
      sourceType: "learn-document",
      sourceId: String(document.id ?? document.uid ?? canonicalUrl),
      canonicalUrl,
      title: document.title,
      description: document.description ?? "",
      publisher: document.publisher ?? sourceConfig.ownerLabel,
      publishedAt: document.publishedAt ?? null,
      modifiedAt: document.lastModified ?? document.modifiedAt ?? null,
      discoveredAt: discoveryTime,
      evidence: [
        {
          type: "learn-cosmos-section",
          value: document.sectionText ?? document.description ?? document.title,
        },
      ],
      metadata: {
        sourceRegistryId: sourceConfig.id,
        trustTier: sourceConfig.trustTier,
        documentId: document.id ?? document.uid ?? null,
        lastModifiedEvidence: document.lastModified ?? document.modifiedAt ?? null,
      },
    });
  }
  return normalizeCandidates(candidates);
}