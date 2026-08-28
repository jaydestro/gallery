import { Buffer } from "node:buffer";

import { detectExactDuplicates } from "./detect-duplicates.mjs";
import { discoverFeeds } from "./discover/feeds.mjs";
import { discoverGitHub } from "./discover/github.mjs";
import { discoverLearn } from "./discover/learn.mjs";
import { isYouTubeDiscoveryEnabled } from "./discover/youtube.mjs";
import { safeFetch } from "./shared/safe-fetch.mjs";

const GITHUB_HOST = "api.github.com";
const LEARN_HOST = "learn.microsoft.com";
const IMMUTABLE_SOURCE_ID = /^[A-Za-z0-9_-]{10,}$/;
const MAX_XML_DEPTH = 64;
const MAX_XML_NODES = 10_000;
const LEARN_ROOT_PATH = "/azure/cosmos-db";

const DEFAULT_LIMITS = Object.freeze({
  githubPageSize: 50,
  githubListingPages: 2,
  githubRepositories: 100,
  feedEntries: 100,
  sitemapFiles: 4,
  learnDocuments: 500,
  responseBytes: 2 * 1024 * 1024,
});

const HARD_LIMITS = Object.freeze({
  githubPageSize: 100,
  githubListingPages: 5,
  githubRepositories: 250,
  feedEntries: 250,
  sitemapFiles: 8,
  learnDocuments: 2_000,
  responseBytes: 4 * 1024 * 1024,
});

class HttpStatusError extends Error {
  constructor(url, status) {
    super(`Request failed with HTTP ${status}: ${url}`);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

function boundedInteger(value, name) {
  const fallback = DEFAULT_LIMITS[name];
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return Math.min(parsed, HARD_LIMITS[name]);
}

function normalizeLimits(overrides = {}) {
  return Object.fromEntries(
    Object.keys(DEFAULT_LIMITS).map((name) => [name, boundedInteger(overrides[name], name)]),
  );
}

function sourceList(registry) {
  if (Array.isArray(registry)) {
    return registry;
  }
  if (Array.isArray(registry?.sources)) {
    return registry.sources;
  }
  throw new TypeError("trustedSources must be an array or a registry with a sources array");
}

function activeRecords(catalog) {
  if (Array.isArray(catalog)) {
    return catalog;
  }
  if (Array.isArray(catalog?.entries)) {
    return catalog.entries;
  }
  throw new TypeError("activeCatalog must be an array or an object with an entries array");
}

function retiredRecords(catalog) {
  const entries = activeRecords(catalog);
  return entries.map((entry) => entry?.record ?? entry);
}

function cleanError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}

function localName(name) {
  return String(name).toLowerCase().split(":").at(-1);
}

function decodeXmlText(value) {
  if (/&(?!#\d+;|#x[0-9a-f]+;|amp;|lt;|gt;|quot;|apos;)/i.test(value)) {
    throw new TypeError("XML contains an unsupported entity reference");
  }
  return value.replace(
    /&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos);/gi,
    (match, entity) => {
      const normalized = entity.toLowerCase();
      if (normalized === "amp") return "&";
      if (normalized === "lt") return "<";
      if (normalized === "gt") return ">";
      if (normalized === "quot") return '"';
      if (normalized === "apos") return "'";
      const codePoint = normalized.startsWith("#x")
        ? Number.parseInt(normalized.slice(2), 16)
        : Number.parseInt(normalized.slice(1), 10);
      if (
        !Number.isSafeInteger(codePoint) ||
        codePoint < 0 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        throw new TypeError(`XML contains an invalid character reference: ${match}`);
      }
      return String.fromCodePoint(codePoint);
    },
  );
}

function tagEnd(xml, start) {
  let quote = null;
  for (let index = start; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  throw new TypeError("XML contains an unterminated tag");
}

function parseAttributes(value) {
  const attributes = Object.create(null);
  let offset = 0;
  while (offset < value.length) {
    const whitespace = /^\s+/.exec(value.slice(offset));
    if (whitespace) offset += whitespace[0].length;
    if (offset >= value.length) break;
    const match = /^([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(
      value.slice(offset),
    );
    if (!match) {
      throw new TypeError("XML contains a malformed attribute");
    }
    attributes[match[1].toLowerCase()] = decodeXmlText(match[2] ?? match[3] ?? "");
    offset += match[0].length;
  }
  return attributes;
}

export function parseSafeXml(xml) {
  if (typeof xml !== "string" || xml.trim() === "") {
    throw new TypeError("XML input must be a non-empty string");
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new TypeError("XML declarations and custom entities are not allowed");
  }

  const document = { name: "#document", attributes: Object.create(null), children: [], text: [] };
  const stack = [document];
  let nodeCount = 0;
  let offset = 0;
  while (offset < xml.length) {
    if (xml.startsWith("<!--", offset)) {
      const end = xml.indexOf("-->", offset + 4);
      if (end < 0) throw new TypeError("XML contains an unterminated comment");
      offset = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", offset)) {
      const end = xml.indexOf("]]>", offset + 9);
      if (end < 0) throw new TypeError("XML contains an unterminated CDATA section");
      stack.at(-1).text.push(xml.slice(offset + 9, end));
      offset = end + 3;
      continue;
    }
    if (xml.startsWith("<?", offset)) {
      const end = xml.indexOf("?>", offset + 2);
      if (end < 0) throw new TypeError("XML contains an unterminated processing instruction");
      offset = end + 2;
      continue;
    }
    if (xml[offset] !== "<") {
      const end = xml.indexOf("<", offset);
      const text = xml.slice(offset, end < 0 ? xml.length : end);
      if (text) stack.at(-1).text.push(decodeXmlText(text));
      offset = end < 0 ? xml.length : end;
      continue;
    }

    const end = tagEnd(xml, offset + 1);
    const raw = xml.slice(offset + 1, end).trim();
    if (raw.startsWith("!")) {
      throw new TypeError("XML declarations are not allowed");
    }
    if (raw.startsWith("/")) {
      const closingName = raw.slice(1).trim().toLowerCase();
      if (stack.length === 1 || stack.at(-1).name !== closingName) {
        throw new TypeError(`XML closing tag does not match: ${closingName}`);
      }
      stack.pop();
    } else {
      const selfClosing = raw.endsWith("/");
      const body = selfClosing ? raw.slice(0, -1).trim() : raw;
      const nameMatch = /^([A-Za-z_][\w:.-]*)/.exec(body);
      if (!nameMatch) throw new TypeError("XML contains a malformed tag name");
      const node = {
        name: nameMatch[1].toLowerCase(),
        attributes: parseAttributes(body.slice(nameMatch[0].length)),
        children: [],
        text: [],
      };
      nodeCount += 1;
      if (nodeCount > MAX_XML_NODES) throw new RangeError(`XML exceeded ${MAX_XML_NODES} elements`);
      stack.at(-1).children.push(node);
      if (!selfClosing) {
        if (stack.length >= MAX_XML_DEPTH) throw new RangeError(`XML exceeded depth ${MAX_XML_DEPTH}`);
        stack.push(node);
      }
    }
    offset = end + 1;
  }
  if (stack.length !== 1 || document.children.length !== 1) {
    throw new TypeError("XML must contain exactly one balanced root element");
  }
  return document.children[0];
}

function children(node, name) {
  return node.children.filter((child) => localName(child.name) === name);
}

function firstChild(node, name) {
  return children(node, name)[0] ?? null;
}

function nodeText(node) {
  if (!node) return "";
  return [...node.text, ...node.children.map(nodeText)].join(" ").replace(/\s+/g, " ").trim();
}

function plainText(value) {
  return String(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseFeedXml(xml) {
  const root = parseSafeXml(xml);
  const rootName = localName(root.name);
  let entries;
  let atom = false;
  if (rootName === "rss") {
    const channel = firstChild(root, "channel");
    if (!channel) throw new TypeError("RSS document is missing its channel element");
    entries = children(channel, "item");
  } else if (rootName === "feed") {
    atom = true;
    entries = children(root, "entry");
  } else {
    throw new TypeError("Feed root must be rss or feed");
  }

  return entries.map((entry) => {
    const linkNodes = children(entry, "link");
    const alternateLink = linkNodes.find(
      (node) => !node.attributes.rel || node.attributes.rel === "alternate",
    );
    const author = firstChild(entry, "author");
    const description = nodeText(firstChild(entry, atom ? "summary" : "description"));
    const content = nodeText(firstChild(entry, "encoded")) || nodeText(firstChild(entry, "content"));
    return {
      id: nodeText(firstChild(entry, atom ? "id" : "guid")),
      link: atom
        ? alternateLink?.attributes.href ?? nodeText(alternateLink)
        : nodeText(firstChild(entry, "link")),
      title: plainText(nodeText(firstChild(entry, "title"))),
      description: plainText(description),
      content: plainText(content) || plainText(description),
      publishedAt: nodeText(firstChild(entry, atom ? "published" : "pubdate")) || null,
      modifiedAt: nodeText(firstChild(entry, "updated")) || null,
      author: plainText(nodeText(firstChild(author ?? entry, author ? "name" : "creator"))) || null,
    };
  });
}

export function parseSitemapXml(xml) {
  const root = parseSafeXml(xml);
  const rootName = localName(root.name);
  if (rootName === "urlset") {
    return {
      type: "urlset",
      entries: children(root, "url").map((entry) => ({
        url: nodeText(firstChild(entry, "loc")),
        lastModified: nodeText(firstChild(entry, "lastmod")) || null,
      })),
    };
  }
  if (rootName === "sitemapindex") {
    return {
      type: "sitemapindex",
      entries: children(root, "sitemap").map((entry) => ({
        url: nodeText(firstChild(entry, "loc")),
        lastModified: nodeText(firstChild(entry, "lastmod")) || null,
      })),
    };
  }
  throw new TypeError("Sitemap root must be urlset or sitemapindex");
}

function exactEndpoint(value, expected) {
  const url = new URL(value);
  const endpoint = new URL(expected);
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    url.hostname.toLowerCase() === endpoint.hostname.toLowerCase() &&
    url.pathname === endpoint.pathname &&
    url.search === endpoint.search
  );
}

export function isAllowedGitHubEndpoint(
  value,
  { organization, repository = null, contentPath = null } = {},
) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== GITHUB_HOST || url.username || url.password) {
      return false;
    }
    const encodedOrganization = encodeURIComponent(organization);
    if (url.pathname === `/orgs/${encodedOrganization}/repos`) return true;
    if (url.pathname === "/search/repositories") {
      const allowedParameters = new Set(["q", "sort", "order", "per_page"]);
      return (
        url.searchParams.getAll("q").length === 1 &&
        url.searchParams.get("q") === `cosmos db org:${organization}` &&
        [...url.searchParams.keys()].every((name) => allowedParameters.has(name))
      );
    }
    if (!repository) return false;
    const prefix = `/repos/${encodedOrganization}/${encodeURIComponent(repository)}`;
    return url.pathname === `${prefix}/readme` && contentPath === null;
  } catch {
    return false;
  }
}

function assertLearnSitemapEndpoint(value, source) {
  const url = new URL(value);
  const root = new URL(source.endpoint);
  if (
    url.protocol !== "https:" ||
    url.hostname !== LEARN_HOST ||
    url.hostname !== root.hostname ||
    url.username ||
    url.password ||
    !url.pathname.toLowerCase().endsWith(".xml")
  ) {
    throw new TypeError(`Rejected unverified Microsoft Learn sitemap endpoint: ${url}`);
  }
  return url;
}

async function fetchBounded(url, { trustedHosts, headers, fetchOptions, limits }) {
  return safeFetch(url, {
    ...fetchOptions,
    trustedHosts,
    headers: { ...(fetchOptions.headers ?? {}), ...headers },
    maxBytes: limits.responseBytes,
    maxRedirects: 0,
  });
}

function requireSuccess(response) {
  if (response.status < 200 || response.status >= 300) {
    throw new HttpStatusError(response.url, response.status);
  }
  return response;
}

function githubUrl(pathname, parameters = {}) {
  const url = new URL(`https://${GITHUB_HOST}${pathname}`);
  for (const [name, value] of Object.entries(parameters)) {
    url.searchParams.set(name, String(value));
  }
  return url;
}

async function githubRequest(url, context) {
  if (!isAllowedGitHubEndpoint(url, context.allowlist)) {
    throw new TypeError(`Rejected non-allowlisted GitHub endpoint: ${url}`);
  }
  context.endpoints.push(String(url));
  const response = await fetchBounded(url, {
    trustedHosts: [GITHUB_HOST],
    fetchOptions: context.fetchOptions,
    limits: context.limits,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${context.githubToken}`,
      "User-Agent": "cosmos-gallery-discovery",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  return response;
}

async function collectPages({ makeUrl, extractItems, maxPages, pageSize, context, allowlist }) {
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const response = requireSuccess(
      await githubRequest(makeUrl(page), { ...context, allowlist }),
    );
    const payload = response.json();
    const pageItems = extractItems(payload);
    if (!Array.isArray(pageItems)) throw new TypeError("GitHub page did not contain an item array");
    items.push(...pageItems);
    if (pageItems.length < pageSize) break;
  }
  return items;
}

function repositoryKey(repository) {
  return String(repository?.id ?? repository?.full_name ?? "").toLowerCase();
}

function decodeGitHubContent(payload) {
  if (!payload || Array.isArray(payload) || payload.encoding !== "base64" || typeof payload.content !== "string") {
    throw new TypeError("GitHub content response was not a base64 file");
  }
  return Buffer.from(payload.content.replace(/\s+/g, ""), "base64").toString("utf8");
}

async function fetchRepositoryReadme(repository, context) {
  const fullName = String(repository.full_name ?? "");
  const [owner, name] = fullName.split("/");
  if (owner?.toLowerCase() !== context.source.organization.toLowerCase() || !name) {
    throw new TypeError(`Rejected repository outside configured organization: ${fullName}`);
  }
  const url = githubUrl(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/readme`);
  const response = await githubRequest(url, {
    ...context,
    allowlist: {
      organization: context.source.organization,
      repository: name,
      contentPath: null,
    },
  });
  if (response.status === 404) return null;
  requireSuccess(response);
  return decodeGitHubContent(response.json());
}

async function collectGitHub(source, context) {
  if (!context.githubToken) {
    throw new TypeError("GITHUB_TOKEN is required for enabled GitHub discovery sources");
  }
  const expectedEndpoint = `https://${GITHUB_HOST}/orgs/${encodeURIComponent(source.organization)}`;
  if (!exactEndpoint(source.endpoint, expectedEndpoint)) {
    throw new TypeError(`GitHub source endpoint does not match organization ${source.organization}`);
  }
  const { limits } = context;
  const repositories = await collectPages({
    makeUrl: (page) => githubUrl(`/orgs/${encodeURIComponent(source.organization)}/repos`, {
      type: "public",
      sort: "updated",
      direction: "desc",
      per_page: limits.githubPageSize,
      page,
    }),
    extractItems: (payload) => payload,
    maxPages: limits.githubListingPages,
    pageSize: limits.githubPageSize,
    context,
    allowlist: { organization: source.organization },
  });

  const issues = [];
  let searchResults = [];
  try {
    const searchUrl = githubUrl("/search/repositories", {
      q: `cosmos db org:${source.organization}`,
      sort: "updated",
      order: "desc",
      per_page: Math.min(limits.githubPageSize, limits.githubRepositories),
    });
    const response = requireSuccess(
      await githubRequest(searchUrl, {
        ...context,
        allowlist: { organization: source.organization },
      }),
    );
    const payload = response.json();
    if (!Array.isArray(payload?.items)) {
      throw new TypeError("GitHub repository search did not contain an item array");
    }
    if (payload.incomplete_results) {
      issues.push("GitHub repository search was incomplete");
    }
    searchResults = payload.items;
  } catch (error) {
    issues.push(cleanError(error));
  }

  const byRepository = new Map();
  for (const repository of repositories) {
    const key = repositoryKey(repository);
    if (key && !byRepository.has(key)) byRepository.set(key, { ...repository, files: [] });
  }
  const searchKeys = new Set();
  for (const repository of searchResults) {
    const key = repositoryKey(repository);
    if (!key) continue;
    searchKeys.add(key);
    if (!byRepository.has(key)) byRepository.set(key, { ...repository, files: [] });
  }

  const orderedKeys = [
    ...searchKeys,
    ...repositories.map(repositoryKey).filter(Boolean),
  ];
  const boundedRepositories = [...new Set(orderedKeys)]
    .map((key) => byRepository.get(key))
    .filter(Boolean)
    .slice(0, limits.githubRepositories);
  for (const repository of boundedRepositories) {
    try {
      const readme = await fetchRepositoryReadme(repository, {
        ...context,
        source,
      });
      if (readme) repository.readme = readme;
    } catch {}
  }

  const candidates = discoverGitHub({
    source,
    apiData: { repositories: boundedRepositories },
    discoveredAt: context.discoveredAt,
  }).filter((candidate) => {
    const kinds = new Set(candidate.metadata.corroboratingSignalKinds);
    kinds.delete("official-link");
    return candidate.metadata.strongSignalKinds.length > 0 || kinds.size >= 2;
  });
  const acceptedIds = new Set(candidates.map((candidate) => candidate.sourceId));
  const rejected = boundedRepositories
    .filter((repository) => !acceptedIds.has(String(repository.id)))
    .map((repository) => ({
      sourceRegistryId: source.id,
      sourceType: "github-repository",
      sourceId: String(repository.id ?? repository.full_name ?? "unknown"),
      canonicalUrl: repository.html_url ?? null,
      reason: "insufficient-cosmos-evidence",
      evidence: [],
    }));
  return { candidates, rejected, issues };
}

async function collectFeed(source, context) {
  if (!exactEndpoint(source.endpoint, source.endpoint)) {
    throw new TypeError(`Rejected untrusted feed endpoint: ${source.endpoint}`);
  }
  context.endpoints.push(source.endpoint);
  const endpointHost = new URL(source.endpoint).hostname;
  const response = requireSuccess(
    await fetchBounded(source.endpoint, {
      trustedHosts: [endpointHost, ...(source.allowedHosts ?? [])],
      fetchOptions: context.fetchOptions,
      limits: context.limits,
      headers: { Accept: "application/atom+xml, application/rss+xml, application/xml, text/xml" },
    }),
  );
  const entries = parseFeedXml(response.text()).slice(0, context.limits.feedEntries);
  const candidates = discoverFeeds({ source, entries, discoveredAt: context.discoveredAt });
  const acceptedIds = new Set(candidates.map((candidate) => candidate.sourceId));
  const rejected = entries
    .filter((entry) => !acceptedIds.has(String(entry.id)))
    .map((entry) => ({
      sourceRegistryId: source.id,
      sourceType: "blog-post",
      sourceId: String(entry.id || "unknown"),
      canonicalUrl: entry.link || null,
      reason: entry.id && entry.link && entry.title ? "insufficient-cosmos-evidence" : "invalid-feed-entry",
      evidence: [],
    }));
  return { candidates, rejected, issues: [] };
}

function learnSitemapCandidates(source) {
  const root = new URL(source.endpoint);
  const derived = new URL("sitemap.xml", root).toString();
  return [...new Set([source.sitemapUrl, derived, `${root.origin}/sitemap.xml`].filter(Boolean))];
}

function localeNeutralLearnPath(pathname) {
  return pathname.replace(/^\/[a-z]{2}-[a-z]{2}(?=\/)/i, "");
}

function learnDocument(entry, source, indexUrl, indexType) {
  const url = new URL(entry.url);
  const root = new URL(source.endpoint);
  const rootPath = root.pathname.replace(/\/$/, "");
  const candidatePath = localeNeutralLearnPath(url.pathname);
  if (
    url.protocol !== "https:" ||
    url.hostname !== root.hostname ||
    (candidatePath !== rootPath && !candidatePath.startsWith(`${rootPath}/`))
  ) {
    return null;
  }
  const slug = url.pathname.split("/").filter(Boolean).at(-1) ?? "overview";
  const title = slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
  return {
    id: url.toString(),
    url: url.toString(),
    title: `Azure Cosmos DB: ${title}`,
    description: "Official Azure Cosmos DB documentation.",
    sectionText: indexType === "root"
      ? "Linked from the configured official Microsoft Learn Azure Cosmos DB root index."
      : "Listed in a verified official Microsoft Learn sitemap under the Azure Cosmos DB root.",
    lastModified: entry.lastModified,
    indexUrl,
  };
}

function assertLearnRootEndpoint(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== LEARN_HOST ||
    url.username ||
    url.password ||
    localeNeutralLearnPath(url.pathname).replace(/\/$/, "") !== LEARN_ROOT_PATH
  ) {
    throw new TypeError(`Rejected unverified Microsoft Learn root endpoint: ${url}`);
  }
  return url;
}

function decodeHtmlAttribute(value) {
  return String(value).replace(/&(#\d+|#x[0-9a-f]+|amp|quot|apos|lt|gt);/gi, (match, entity) => {
    const normalized = entity.toLowerCase();
    if (normalized === "amp") return "&";
    if (normalized === "quot") return '"';
    if (normalized === "apos") return "'";
    if (normalized === "lt") return "<";
    if (normalized === "gt") return ">";
    const codePoint = normalized.startsWith("#x")
      ? Number.parseInt(normalized.slice(2), 16)
      : Number.parseInt(normalized.slice(1), 10);
    return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : match;
  });
}

function learnRootEntries(html, source, limit) {
  const root = assertLearnRootEndpoint(source.endpoint);
  const sanitized = String(html)
    .replace(/<!--([\s\S]*?)-->/g, "")
    .replace(/<(?:script|style|template)\b[^>]*>[\s\S]*?<\/(?:script|style|template)>/gi, "");
  const anchorPattern = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  const entries = [];
  const seen = new Set();
  for (const match of sanitized.matchAll(anchorPattern)) {
    try {
      const url = new URL(decodeHtmlAttribute(match[1] ?? match[2] ?? match[3] ?? ""), root);
      const candidatePath = localeNeutralLearnPath(url.pathname).replace(/\/$/, "");
      if (
        url.origin !== root.origin ||
        (candidatePath !== LEARN_ROOT_PATH && !candidatePath.startsWith(`${LEARN_ROOT_PATH}/`))
      ) {
        continue;
      }
      url.hash = "";
      url.search = "";
      const normalized = url.toString();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        entries.push({ url: normalized, lastModified: null });
      }
      if (entries.length >= limit) break;
    } catch {}
  }
  return entries;
}

async function fetchLearnRootIndex(source, context) {
  const root = assertLearnRootEndpoint(source.endpoint);
  context.endpoints.push(root.toString());
  const response = requireSuccess(await fetchBounded(root, {
    trustedHosts: [LEARN_HOST],
    fetchOptions: context.fetchOptions,
    limits: context.limits,
    headers: { Accept: "text/html" },
  }));
  return response.text();
}

async function fetchLearnSitemap(url, source, context) {
  const verified = assertLearnSitemapEndpoint(url, source);
  context.endpoints.push(verified.toString());
  const response = await fetchBounded(verified, {
    trustedHosts: [LEARN_HOST],
    fetchOptions: context.fetchOptions,
    limits: context.limits,
    headers: { Accept: "application/xml, text/xml" },
  });
  if (response.status === 404) return null;
  requireSuccess(response);
  return parseSitemapXml(response.text());
}

async function collectLearn(source, context) {
  let sitemap = null;
  let sitemapUrl = null;
  for (const candidateUrl of learnSitemapCandidates(source)) {
    try {
      sitemap = await fetchLearnSitemap(candidateUrl, source, context);
      if (sitemap) {
        sitemapUrl = candidateUrl;
        break;
      }
    } catch {}
  }
  if (!sitemap || !sitemapUrl) {
    const html = await fetchLearnRootIndex(source, context);
    const documents = learnRootEntries(html, source, context.limits.learnDocuments)
      .map((entry) => learnDocument(entry, source, source.endpoint, "root"))
      .filter(Boolean);
    const candidates = discoverLearn({ source, documents, discoveredAt: context.discoveredAt }).map(
      (candidate) => ({
        ...candidate,
        evidence: [
          ...candidate.evidence,
          {
            type: "learn-official-root-index",
            value: "Linked from the configured official Microsoft Learn root index",
            url: source.endpoint,
          },
        ],
      }),
    );
    return { candidates, rejected: [], issues: [] };
  }

  const issues = [];
  const sitemapEntries = [];
  if (sitemap.type === "urlset") {
    sitemapEntries.push(...sitemap.entries);
  } else {
    const root = new URL(source.endpoint);
    const globalIndex = new URL(sitemapUrl).pathname === "/sitemap.xml";
    const childUrls = sitemap.entries
      .map((entry) => entry.url)
      .filter((url) => {
        try {
          const verified = assertLearnSitemapEndpoint(url, source);
          return !globalIndex || verified.toString().includes("cosmos");
        } catch {
          return false;
        }
      })
      .slice(0, context.limits.sitemapFiles);
    if (childUrls.length === 0) {
      throw new TypeError(`Verified sitemap index did not expose a bounded Cosmos DB shard for ${source.id}`);
    }
    for (const childUrl of childUrls) {
      try {
        const child = await fetchLearnSitemap(childUrl, source, context);
        if (!child || child.type !== "urlset") {
          issues.push(`Sitemap child was unavailable or not a urlset: ${childUrl}`);
          continue;
        }
        sitemapEntries.push(...child.entries);
      } catch (error) {
        issues.push(cleanError(error));
      }
    }
  }

  const documents = sitemapEntries
    .map((entry) => learnDocument(entry, source, sitemapUrl, "sitemap"))
    .filter(Boolean)
    .slice(0, context.limits.learnDocuments);
  if (documents.length === 0) {
    throw new TypeError(`Verified sitemap contained no documents under ${source.endpoint}`);
  }
  const candidates = discoverLearn({ source, documents, discoveredAt: context.discoveredAt }).map(
    (candidate) => ({
      ...candidate,
      evidence: [
        ...candidate.evidence,
        { type: "learn-official-sitemap", value: "Listed by an official Microsoft Learn sitemap", url: sitemapUrl },
      ],
    }),
  );
  return { candidates, rejected: [], issues };
}

function configuredYouTubeSource(source) {
  return [
    source.channelId,
    ...(source.channelIds ?? []),
    source.playlistId,
    ...(source.playlistIds ?? []),
  ].some((value) => typeof value === "string" && IMMUTABLE_SOURCE_ID.test(value));
}

function skippedStatus(source, reason) {
  return {
    sourceRegistryId: source.id,
    sourceType: source.type,
    status: "skipped",
    queried: false,
    candidateCount: 0,
    rejectedCount: 0,
    endpoints: [],
    reason,
  };
}

async function querySource(source, context) {
  const endpoints = [];
  const sourceContext = { ...context, endpoints };
  let result;
  try {
    if (source.type === "github-organization") {
      result = await collectGitHub(source, sourceContext);
    } else if (source.type === "rss-feed") {
      result = await collectFeed(source, sourceContext);
    } else if (source.type === "documentation-root") {
      result = await collectLearn(source, sourceContext);
    } else {
      throw new TypeError(`Unsupported trusted source type: ${source.type}`);
    }
  } catch (error) {
    if (error && typeof error === "object") error.discoveryEndpoints = endpoints;
    throw error;
  }
  return {
    ...result,
    status: {
      sourceRegistryId: source.id,
      sourceType: source.type,
      status: result.issues.length > 0 ? "indeterminate" : "succeeded",
      queried: true,
      candidateCount: result.candidates.length,
      rejectedCount: result.rejected.length,
      endpoints,
      ...(result.issues.length > 0 ? { reason: result.issues.join("; ") } : {}),
    },
  };
}

export function createFixtureTransport(fixtures) {
  const responses = fixtures?.responses ?? fixtures;
  if (!responses || typeof responses !== "object" || Array.isArray(responses)) {
    throw new TypeError("Fixture responses must be an object keyed by exact URL");
  }
  const requests = [];
  return {
    requests,
    async lookup() {
      return [{ address: "203.0.113.10", family: 4 }];
    },
    async fetchImpl(input) {
      const url = String(input);
      requests.push(url);
      const fixture = responses[url];
      if (!fixture) throw new TypeError(`No offline fixture response is configured for ${url}`);
      const status = fixture.status ?? 200;
      const headers = new Headers(fixture.headers ?? {});
      let body = fixture.body ?? "";
      if (typeof body !== "string") {
        body = JSON.stringify(body);
        if (!headers.has("content-type")) headers.set("content-type", "application/json");
      }
      return new Response(body, { status, headers });
    },
  };
}

export async function runDiscovery({
  trustedSources,
  activeCatalog = [],
  retiredCatalog = [],
  githubToken = process.env.GITHUB_TOKEN,
  discoveredAt = new Date().toISOString(),
  fetchOptions = {},
  limits: limitOverrides = {},
} = {}) {
  const timestamp = new Date(discoveredAt);
  if (Number.isNaN(timestamp.valueOf())) throw new TypeError("discoveredAt must be a valid date-time");
  const normalizedTimestamp = timestamp.toISOString();
  const limits = normalizeLimits(limitOverrides);
  const candidates = [];
  const rejected = [];
  const statuses = [];

  for (const source of sourceList(trustedSources)) {
    if (source?.enabled !== true) {
      statuses.push(skippedStatus(source ?? {}, "source-disabled"));
      continue;
    }
    if (source.type === "youtube-channel" || source.type === "youtube-playlist") {
      if (!configuredYouTubeSource(source) || !isYouTubeDiscoveryEnabled(source)) {
        statuses.push(skippedStatus(source, "immutable-youtube-source-id-required"));
      } else {
        statuses.push({
          ...skippedStatus(source, "live-youtube-retrieval-not-configured"),
          status: "indeterminate",
        });
      }
      continue;
    }
    try {
      const result = await querySource(source, {
        githubToken,
        discoveredAt: normalizedTimestamp,
        fetchOptions,
        limits,
      });
      candidates.push(...result.candidates);
      rejected.push(...result.rejected);
      statuses.push(result.status);
    } catch (error) {
      statuses.push({
        sourceRegistryId: source.id,
        sourceType: source.type,
        status: "indeterminate",
        queried: true,
        candidateCount: 0,
        rejectedCount: 1,
        endpoints: error?.discoveryEndpoints ?? [],
        reason: cleanError(error),
      });
      rejected.push({
        sourceRegistryId: source.id,
        sourceType: source.type,
        sourceId: source.id,
        canonicalUrl: source.endpoint ?? null,
        reason: "source-indeterminate",
        evidence: [{ type: "source-error", value: cleanError(error) }],
      });
    }
  }

  const exact = detectExactDuplicates(candidates, {
    active: activeRecords(activeCatalog),
    retired: retiredRecords(retiredCatalog),
  });
  for (const duplicate of exact.duplicates) {
    rejected.push({
      sourceRegistryId: duplicate.candidate.metadata.sourceRegistryId,
      sourceType: duplicate.candidate.sourceType,
      sourceId: duplicate.candidate.sourceId,
      canonicalUrl: duplicate.candidate.canonicalUrl,
      reason: "exact-duplicate",
      duplicateReasons: duplicate.reasons,
      matchedScopes: [...new Set(duplicate.matches.map((match) => match.scope))].sort(),
      evidence: duplicate.candidate.evidence,
    });
  }

  const accepted = exact.accepted.sort((left, right) => left.identityKey.localeCompare(right.identityKey));
  rejected.sort((left, right) =>
    `${left.sourceRegistryId}:${left.sourceId}:${left.reason}`.localeCompare(
      `${right.sourceRegistryId}:${right.sourceId}:${right.reason}`,
    ),
  );
  const indeterminate = statuses.filter((status) => status.status === "indeterminate").length;
  return {
    schemaVersion: "1.0.0",
    mode: "dry-run",
    mutationPerformed: false,
    status: indeterminate > 0 ? "partial" : "complete",
    startedAt: normalizedTimestamp,
    completedAt: normalizedTimestamp,
    summary: {
      sources: statuses.length,
      succeededSources: statuses.filter((status) => status.status === "succeeded").length,
      skippedSources: statuses.filter((status) => status.status === "skipped").length,
      indeterminateSources: indeterminate,
      candidates: accepted.length,
      rejected: rejected.length,
    },
    candidates: accepted,
    rejected,
    sources: statuses,
    evidence: candidates.map((candidate) => ({
      identityKey: candidate.identityKey,
      sourceRegistryId: candidate.metadata.sourceRegistryId,
      items: candidate.evidence,
    })),
  };
}