import { normalizeCandidates } from "../normalize.mjs";
import { enrichCandidateMetadata } from "../enrich-candidate.mjs";

const STRONG_PATTERNS = [
  {
    kind: "sdk",
    name: "dotnet-cosmos-sdk",
    pattern: /\bMicrosoft\.Azure\.Cosmos\b/i,
  },
  {
    kind: "sdk",
    name: "javascript-cosmos-sdk",
    pattern: /["']@azure\/cosmos["']|\b@azure\/cosmos\b/i,
  },
  {
    kind: "sdk",
    name: "python-cosmos-sdk",
    pattern: /\bfrom\s+azure\.cosmos\b|\bimport\s+azure\.cosmos\b|\bazure-cosmos\b/i,
  },
  {
    kind: "sdk",
    name: "java-cosmos-sdk",
    pattern: /\bcom\.azure:azure-cosmos\b|\bcom\.azure\.cosmos\b/i,
  },
  {
    kind: "sdk",
    name: "go-cosmos-sdk",
    pattern: /azure-sdk-for-go\/sdk\/data\/azcosmos/i,
  },
  {
    kind: "infrastructure",
    name: "azure-resource-manager-cosmos-account",
    pattern: /Microsoft\.DocumentDB\/databaseAccounts/i,
  },
  {
    kind: "infrastructure",
    name: "terraform-cosmos-resource",
    pattern: /\bazurerm_cosmosdb_(?:account|sql_database|sql_container|mongo_database|cassandra_keyspace|table)\b/i,
  },
  {
    kind: "code",
    name: "cosmos-client-api",
    pattern: /\b(?:new\s+)?CosmosClient\s*\(/i,
  },
];

const COSMOS_TERM = /\b(?:azure\s+)?cosmos\s*db\b|\bcosmosdb\b/i;
const COSMOS_TOPIC = /^(?:azure-)?cosmos-?db$|^cosmosdb$/i;
const OFFICIAL_COSMOS_LINK = /https:\/\/learn\.microsoft\.com\/(?:[a-z]{2}-[a-z]{2}\/)?azure\/cosmos-db(?:\/|\b)/i;
const GITHUB_MEDIA_HOSTS = new Set(["github.com", "opengraph.githubassets.com"]);

function matchingGitHubPath(value, expectedSegments) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase();
    const segments = url.pathname.split("/").filter(Boolean);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (hostname === "github.com" || hostname === "www.github.com") &&
      segments.length === expectedSegments.length &&
      segments.every((segment, index) =>
        segment.toLowerCase() === expectedSegments[index].toLowerCase())
    ) ? value.trim() : null;
  } catch {
    return null;
  }
}

function trustedGitHubMediaUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (GITHUB_MEDIA_HOSTS.has(hostname) || hostname.endsWith(".githubusercontent.com"))
    ) ? value.trim() : null;
  } catch {
    return null;
  }
}

function fixturePayload({ fixture, apiData, offline }) {
  const payload = fixture ?? apiData;
  if (payload) {
    return Array.isArray(payload) ? { repositories: payload } : payload;
  }
  if (offline) {
    return null;
  }
  throw new TypeError("GitHub discovery requires supplied apiData or a fixture");
}

function repositoryFiles(repository, payload) {
  const files = [...(Array.isArray(repository.files) ? repository.files : [])];
  if (typeof repository.readme === "string") {
    files.push({ path: "README.md", content: repository.readme });
  }

  const fullName = String(repository.full_name ?? "").toLowerCase();
  for (const result of payload.codeSearchResults ?? []) {
    const resultFullName = String(
      result.repository?.full_name ?? result.repositoryFullName ?? "",
    ).toLowerCase();
    if (resultFullName === fullName) {
      files.push({
        path: result.path ?? "code-search-result",
        content: result.content ?? result.text ?? result.text_fragment ?? "",
      });
    }
  }
  return files;
}

function strongSignals(repository, payload) {
  const signals = [];
  const seen = new Set();
  for (const file of repositoryFiles(repository, payload)) {
    const content = typeof file.content === "string" ? file.content : "";
    for (const definition of STRONG_PATTERNS) {
      if (!definition.pattern.test(content)) {
        continue;
      }
      const key = `${definition.kind}:${definition.name}:${file.path ?? "unknown"}`;
      if (!seen.has(key)) {
        seen.add(key);
        signals.push({ ...definition, path: file.path ?? "unknown" });
      }
    }
  }
  return signals;
}

function corroboratingSignals(repository) {
  const signals = [];
  const topics = Array.isArray(repository.topics) ? repository.topics : [];
  if (topics.some((topic) => COSMOS_TOPIC.test(topic))) {
    signals.push({ kind: "topic", value: "approved Cosmos DB topic" });
  }
  if (COSMOS_TERM.test(repository.description ?? "")) {
    signals.push({ kind: "description", value: "Cosmos DB in repository description" });
  }
  if (COSMOS_TERM.test(repository.readme ?? "")) {
    signals.push({ kind: "readme", value: "Cosmos DB in README content" });
  }
  if (OFFICIAL_COSMOS_LINK.test(repository.readme ?? "")) {
    signals.push({ kind: "official-link", value: "Official Cosmos DB documentation link" });
  }
  return signals;
}

function eligibleRepository(repository, source) {
  if (!repository || typeof repository !== "object") {
    return false;
  }
  const fullName = String(repository.full_name ?? "");
  const owner = repository.owner?.login ?? fullName.split("/")[0];
  return (
    repository.id !== null &&
    repository.id !== undefined &&
    String(repository.id).trim() !== "" &&
    typeof repository.name === "string" &&
    repository.name.trim() !== "" &&
    typeof owner === "string" &&
    owner.trim() !== "" &&
    (!source.organization || owner.toLowerCase() === source.organization.toLowerCase()) &&
    repository.private !== true &&
    repository.disabled !== true &&
    repository.archived !== true &&
    repository.size !== 0
  );
}

export function discoverGitHub({ source, apiData, fixture, offline = false, discoveredAt } = {}) {
  const payload = fixturePayload({ fixture, apiData, offline });
  if (!payload) {
    return [];
  }
  const sourceConfig = source ?? payload.source;
  if (!sourceConfig?.enabled) {
    return [];
  }

  const discoveryTime = discoveredAt ?? payload.discoveredAt;
  const candidates = [];
  for (const repository of payload.repositories ?? payload.items ?? []) {
    if (!eligibleRepository(repository, sourceConfig)) {
      continue;
    }

    const strong = strongSignals(repository, payload);
    const corroborating = corroboratingSignals(repository);
    if (strong.length === 0 && new Set(corroborating.map((signal) => signal.kind)).size < 2) {
      continue;
    }

    const fullName = repository.full_name ?? `${repository.owner.login}/${repository.name}`;
    const owner = repository.owner?.login ?? fullName.split("/")[0];
    const repositoryName = fullName.split("/")[1] ?? repository.name;
    const sourceId = String(repository.id);
    const derivedRepositoryUrl = `https://github.com/${owner}/${repositoryName}`;
    const launchUrl = matchingGitHubPath(repository.html_url, [owner, repositoryName]) ?? derivedRepositoryUrl;
    const canonicalUrl = launchUrl;
    const ownerProfileUrl = matchingGitHubPath(repository.owner?.html_url, [owner]);
    const derivedOwnerUrl = `https://github.com/${owner}`;
    const publishedAt = repository.created_at ?? null;
    const catalogMetadata = enrichCandidateMetadata({
      sourceType: "github-repository",
      sourceId,
      trustTier: sourceConfig.trustTier,
      launchUrl,
      websiteUrls: [ownerProfileUrl, repository.homepage, derivedOwnerUrl],
      author: owner,
      sourceOwner: owner,
      publishedAt,
      previewUrls: [
        trustedGitHubMediaUrl(repository.open_graph_image_url ?? repository.openGraphImageUrl),
        trustedGitHubMediaUrl(repository.owner?.avatar_url),
      ],
    });
    candidates.push({
      sourceType: "github-repository",
      sourceId,
      canonicalUrl,
      title: repository.name,
      description: repository.description ?? "",
      publisher: owner,
      publishedAt,
      modifiedAt: repository.pushed_at ?? repository.updated_at ?? null,
      discoveredAt: discoveryTime,
      evidence: [
        ...strong.map((signal) => ({
          type: `github-${signal.kind}-signal`,
          value: `${signal.name} in ${signal.path}`,
        })),
        ...corroborating.map((signal) => ({
          type: `github-${signal.kind}-signal`,
          value: signal.value,
        })),
      ],
      metadata: {
        ...catalogMetadata,
        sourceRegistryId: sourceConfig.id,
        trustTier: sourceConfig.trustTier,
        repositoryId: repository.id,
        fullName,
        defaultBranch: repository.default_branch ?? null,
        archived: Boolean(repository.archived),
        license: repository.license?.spdx_id ?? repository.license ?? null,
        topics: Array.isArray(repository.topics) ? [...repository.topics].sort() : [],
        latestRelease: repository.releases?.[0]?.tag_name ?? null,
        strongSignalKinds: [...new Set(strong.map((signal) => signal.kind))].sort(),
        corroboratingSignalKinds: [...new Set(corroborating.map((signal) => signal.kind))].sort(),
      },
    });
  }
  return normalizeCandidates(candidates);
}