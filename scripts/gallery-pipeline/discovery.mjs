import { Buffer } from "node:buffer";

import { detectExactDuplicates } from "./detect-duplicates.mjs";
import { discoverFeeds } from "./discover/feeds.mjs";
import { discoverGitHub } from "./discover/github.mjs";
import { discoverLearn } from "./discover/learn.mjs";
import {
  discoverYouTube,
  isYouTubeDiscoveryEnabled,
  isYouTubeSourceConfigured,
  officialYouTubeFeedUrl,
} from "./discover/youtube.mjs";
import { canonicalizeLearnUrl, extractYouTubeVideoId } from "./shared/canonicalize.mjs";
import { safeFetch } from "./shared/safe-fetch.mjs";

const GITHUB_HOST = "api.github.com";
const LEARN_HOST = "learn.microsoft.com";
const YOUTUBE_API_HOST = "youtube.googleapis.com";
const YOUTUBE_API_ENDPOINT = `https://${YOUTUBE_API_HOST}/youtube/v3`;
const YOUTUBE_FEED_HOST = "www.youtube.com";
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const YOUTUBE_UPLOADS_PLAYLIST_ID = /^UU[A-Za-z0-9_-]{22}$/;
const YOUTUBE_THUMBNAIL_HOST = /^(?:i(?:[1-9])?\.ytimg\.com|img\.youtube\.com)$/;
const YOUTUBE_VIDEO_BATCH_SIZE = 50;
const MAX_XML_DEPTH = 64;
const MAX_XML_NODES = 10_000;
const LEARN_ROOT_PATH = "/azure/cosmos-db";
const POLICY_MAX_REDIRECTS = 5;
const DISCOVERY_DEADLINE_REASON = "DISCOVERY_DEADLINE_EXCEEDED";
const DISCOVERY_CADENCES = new Set(["all", "daily", "weekly"]);

const DEFAULT_LIMITS = Object.freeze({
  githubPageSize: 50,
  githubListingPages: 2,
  githubRepositories: 100,
  feedEntries: 100,
  sitemapFiles: 4,
  learnDocuments: 500,
  youtubePageSize: 50,
  youtubeListingPages: 2,
  youtubeCandidates: 100,
  responseBytes: 2 * 1024 * 1024,
});

const HARD_LIMITS = Object.freeze({
  githubPageSize: 100,
  githubListingPages: 5,
  githubRepositories: 250,
  feedEntries: 250,
  sitemapFiles: 8,
  learnDocuments: 2_000,
  youtubePageSize: 50,
  youtubeListingPages: 5,
  youtubeCandidates: 250,
  responseBytes: 4 * 1024 * 1024,
});

class HttpStatusError extends Error {
  constructor(url, status, detail = null) {
    super(`Request failed with HTTP ${status}${detail ? ` (${detail})` : ""}: ${url}`);
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

function cleanError(error, secrets = []) {
  let message = error instanceof Error ? error.message : String(error);
  message = message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/([?&]key=)[^&\s]+/gi, "$1[redacted]")
    .replace(/(X-Goog-Api-Key\s*[:=]\s*)\S+/gi, "$1[redacted]");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret) {
      message = message.replaceAll(secret, "[redacted]");
    }
  }
  return message;
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
  let feedNode;
  let atom = false;
  if (rootName === "rss") {
    const channel = firstChild(root, "channel");
    if (!channel) throw new TypeError("RSS document is missing its channel element");
    feedNode = channel;
    entries = children(channel, "item");
  } else if (rootName === "feed") {
    atom = true;
    feedNode = root;
    entries = children(root, "entry");
  } else {
    throw new TypeError("Feed root must be rss or feed");
  }

  const feedLinkNodes = children(feedNode, "link");
  const feedAlternateLink = feedLinkNodes.find(
    (node) => !node.attributes.rel || node.attributes.rel === "alternate",
  );
  const feedSiteUrl = atom
    ? feedAlternateLink?.attributes.href ?? nodeText(feedAlternateLink)
    : nodeText(firstChild(feedNode, "link"));
  const feedAuthorNode = firstChild(feedNode, "author");
  const feedAuthor = plainText(
    nodeText(firstChild(feedAuthorNode ?? feedNode, feedAuthorNode ? "name" : "creator")) ||
      nodeText(feedAuthorNode),
  ) || null;
  const feedImageNode = firstChild(feedNode, "image");
  const feedImageUrl = feedImageNode
    ? nodeText(firstChild(feedImageNode, "url")) ||
      feedImageNode.attributes.href || feedImageNode.attributes.src || null
    : null;

  return entries.map((entry) => {
    const linkNodes = children(entry, "link");
    const alternateLink = linkNodes.find(
      (node) => !node.attributes.rel || node.attributes.rel === "alternate",
    );
    const author = firstChild(entry, "author");
    const description = nodeText(firstChild(entry, atom ? "summary" : "description"));
    const content = nodeText(firstChild(entry, "encoded")) || nodeText(firstChild(entry, "content"));
    const thumbnail = firstChild(entry, "thumbnail");
    const enclosure = children(entry, atom ? "link" : "enclosure").find((node) =>
      node.attributes.rel === "enclosure" || String(node.attributes.type ?? "").startsWith("image/"),
    );
    const mediaContent = children(entry, "content").find((node) =>
      node.attributes.url && String(node.attributes.type ?? "").startsWith("image/"),
    );
    const entryImage = firstChild(entry, "image");
    const entryImageUrl = entryImage ? nodeText(firstChild(entryImage, "url")) : null;
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
      author: plainText(
        nodeText(firstChild(author ?? entry, author ? "name" : "creator")) || nodeText(author),
      ) || feedAuthor,
      feedSiteUrl: feedSiteUrl || null,
      imageUrl: thumbnail?.attributes.url ?? enclosure?.attributes.href ?? enclosure?.attributes.url ??
        mediaContent?.attributes.url ?? entryImageUrl ?? feedImageUrl,
    };
  });
}

function validYouTubeTimestamp(value) {
  return typeof value === "string" && value !== "" && !Number.isNaN(new Date(value).valueOf());
}

function parseYouTubeFeedEntry(entry, source, index) {
  const entryNumber = index + 1;
  const videoId = nodeText(firstChild(entry, "videoid"));
  if (!YOUTUBE_VIDEO_ID.test(videoId)) {
    throw new TypeError(`YouTube feed entry ${entryNumber} has an invalid yt:videoId`);
  }
  if (nodeText(firstChild(entry, "id")) !== `yt:video:${videoId}`) {
    throw new TypeError(`YouTube feed entry ${videoId} has a mismatched Atom id`);
  }

  const channelId = nodeText(firstChild(entry, "channelid"));
  if (!YOUTUBE_CHANNEL_ID.test(channelId) || channelId !== source.channelId) {
    throw new TypeError(`YouTube feed entry ${videoId} channel ID does not match ${source.channelId}`);
  }

  const title = plainText(nodeText(firstChild(entry, "title")));
  const publishedAt = nodeText(firstChild(entry, "published"));
  const updatedAt = nodeText(firstChild(entry, "updated"));
  const author = firstChild(entry, "author");
  const channelTitle = plainText(nodeText(firstChild(author, "name")));
  const channelUrl = nodeText(firstChild(author, "uri"));
  const expectedChannelUrl = `https://www.youtube.com/channel/${channelId}`;
  const alternateLink = children(entry, "link").find(
    (node) => !node.attributes.rel || node.attributes.rel === "alternate",
  );
  if (!title) throw new TypeError(`YouTube feed entry ${videoId} is missing its title`);
  if (!validYouTubeTimestamp(publishedAt) || !validYouTubeTimestamp(updatedAt)) {
    throw new TypeError(`YouTube feed entry ${videoId} has an invalid published or updated timestamp`);
  }
  if (!channelTitle || channelUrl !== expectedChannelUrl) {
    throw new TypeError(`YouTube feed entry ${videoId} has invalid author channel metadata`);
  }
  if (extractYouTubeVideoId(alternateLink?.attributes.href) !== videoId) {
    throw new TypeError(`YouTube feed entry ${videoId} has an invalid alternate URL`);
  }

  const mediaGroup = firstChild(entry, "group");
  const descriptionNode = firstChild(mediaGroup, "description");
  const thumbnailUrl = firstChild(mediaGroup, "thumbnail")?.attributes.url;
  let thumbnail;
  try {
    thumbnail = new URL(thumbnailUrl);
  } catch {
    throw new TypeError(`YouTube feed entry ${videoId} has an invalid thumbnail URL`);
  }
  if (
    !descriptionNode ||
    thumbnail.protocol !== "https:" ||
    thumbnail.username ||
    thumbnail.password ||
    !YOUTUBE_THUMBNAIL_HOST.test(thumbnail.hostname.toLowerCase()) ||
    !thumbnail.pathname.startsWith(`/vi/${videoId}/`)
  ) {
    throw new TypeError(`YouTube feed entry ${videoId} has invalid media metadata`);
  }

  return {
    id: videoId,
    snippet: {
      title,
      description: plainText(nodeText(descriptionNode)),
      publishedAt,
      channelId,
      channelTitle,
      thumbnails: { high: { url: thumbnail.toString() } },
    },
    updatedAt,
    channelUrl,
  };
}

export function parseYouTubeFeedXml(xml, source) {
  const root = parseSafeXml(xml);
  if (localName(root.name) !== "feed") {
    throw new TypeError("YouTube official feed root must be Atom feed");
  }
  if (!source || source.type !== "youtube-channel" || !YOUTUBE_CHANNEL_ID.test(source.channelId ?? "")) {
    throw new TypeError("YouTube official feed requires a configured channel source");
  }

  const expectedChannelUrl = `https://www.youtube.com/channel/${source.channelId}`;
  const alternateLink = children(root, "link").find(
    (node) => !node.attributes.rel || node.attributes.rel === "alternate",
  );
  const feedAuthor = firstChild(root, "author");
  if (
    alternateLink?.attributes.href !== expectedChannelUrl ||
    nodeText(firstChild(feedAuthor, "uri")) !== expectedChannelUrl
  ) {
    throw new TypeError("YouTube official feed channel URL does not match the configured channel");
  }

  const videos = [];
  const rejected = [];
  const issues = [];
  const seenVideoIds = new Set();
  for (const [index, entry] of children(root, "entry").entries()) {
    const reportedVideoId = nodeText(firstChild(entry, "videoid"));
    try {
      const video = parseYouTubeFeedEntry(entry, source, index);
      if (seenVideoIds.has(video.id)) {
        throw new TypeError(`YouTube official feed contains duplicate video ID ${video.id}`);
      }
      seenVideoIds.add(video.id);
      videos.push(video);
    } catch (error) {
      issues.push(cleanError(error));
      rejected.push({
        sourceRegistryId: source.id,
        sourceType: "video",
        sourceId: YOUTUBE_VIDEO_ID.test(reportedVideoId) ? reportedVideoId : `${source.id}:entry-${index + 1}`,
        canonicalUrl: YOUTUBE_VIDEO_ID.test(reportedVideoId)
          ? `https://www.youtube.com/watch?v=${reportedVideoId}`
          : null,
        reason: "invalid-youtube-feed-entry",
        evidence: [],
      });
    }
  }
  return { videos, rejected, issues };
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

async function fetchBounded(
  url,
  { trustedHosts, headers, fetchOptions, limits, maxRedirects = 0 },
) {
  return safeFetch(url, {
    ...fetchOptions,
    trustedHosts,
    headers: { ...(fetchOptions.headers ?? {}), ...headers },
    maxBytes: limits.responseBytes,
    maxRedirects,
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
  const exactUrl = String(entry.url).trim();
  const url = new URL(exactUrl);
  const root = new URL(source.endpoint);
  const rootPath = root.pathname.replace(/\/$/, "").toLowerCase();
  const candidatePath = localeNeutralLearnPath(url.pathname).toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
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
    url: exactUrl,
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
      const href = decodeHtmlAttribute(match[1] ?? match[2] ?? match[3] ?? "").trim();
      const url = new URL(href, root);
      const candidatePath = localeNeutralLearnPath(url.pathname).replace(/\/$/, "");
      if (
        url.origin !== root.origin ||
        (candidatePath !== LEARN_ROOT_PATH && !candidatePath.startsWith(`${LEARN_ROOT_PATH}/`))
      ) {
        continue;
      }
      const exactUrl = /^https:\/\//i.test(href)
        ? href
        : href.startsWith("//")
          ? `${root.protocol}${href}`
          : url.toString();
      const deduplicationUrl = new URL(url);
      deduplicationUrl.hash = "";
      const deduplicationKey = deduplicationUrl.toString();
      if (!seen.has(deduplicationKey)) {
        seen.add(deduplicationKey);
        entries.push({ url: exactUrl, lastModified: null });
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
    maxRedirects: POLICY_MAX_REDIRECTS,
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
            url: canonicalizeLearnUrl(source.endpoint),
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

function youtubeApiUrl(resource, parameters) {
  if (!new Set(["channels", "playlistItems", "videos"]).has(resource)) {
    throw new TypeError(`Unsupported YouTube API resource: ${resource}`);
  }
  const url = new URL(`${YOUTUBE_API_ENDPOINT}/${resource}`);
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(name, String(value));
    }
  }
  return url;
}

function parseYouTubeResponse(response) {
  let payload;
  try {
    payload = response.json();
  } catch {
    throw new TypeError(`YouTube API returned invalid JSON: ${response.url}`);
  }
  if (response.status < 200 || response.status >= 300) {
    const reasons = payload?.error?.errors
      ?.map((item) => item?.reason)
      .filter((reason) => typeof reason === "string" && reason)
      .sort();
    throw new HttpStatusError(response.url, response.status, reasons?.join(", ") || "YouTube API error");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError(`YouTube API returned a non-object payload: ${response.url}`);
  }
  return payload;
}

async function youtubeRequest(resource, parameters, context) {
  const url = youtubeApiUrl(resource, parameters);
  context.endpoints.push(url.toString());
  try {
    const response = await fetchBounded(url, {
      trustedHosts: [YOUTUBE_API_HOST],
      fetchOptions: context.fetchOptions,
      limits: context.limits,
      headers: {
        Accept: "application/json",
        "X-Goog-Api-Key": context.youtubeApiKey,
      },
    });
    return parseYouTubeResponse(response);
  } catch (error) {
    throw new Error(cleanError(error, [context.youtubeApiKey]));
  }
}

function youtubePublicSourceUrl(source) {
  if (source?.type === "youtube-channel" && isYouTubeSourceConfigured(source)) {
    return `https://www.youtube.com/channel/${source.channelId}`;
  }
  if (source?.type === "youtube-playlist" && isYouTubeSourceConfigured(source)) {
    return `https://www.youtube.com/playlist?list=${source.playlistId}`;
  }
  return null;
}

async function resolveYouTubePlaylist(source, context) {
  if (source.type === "youtube-playlist") return source.playlistId;
  const payload = await youtubeRequest("channels", {
    part: "contentDetails",
    id: source.channelId,
    fields: "items(id,contentDetails/relatedPlaylists/uploads)",
  }, context);
  if (!Array.isArray(payload.items)) {
    throw new TypeError("YouTube channels response did not contain an item array");
  }
  const channel = payload.items.find((item) => item?.id === source.channelId);
  const uploadsPlaylistId = channel?.contentDetails?.relatedPlaylists?.uploads;
  const expectedUploadsPlaylistId = `UU${source.channelId.slice(2)}`;
  if (
    !YOUTUBE_UPLOADS_PLAYLIST_ID.test(uploadsPlaylistId ?? "") ||
    uploadsPlaylistId !== expectedUploadsPlaylistId
  ) {
    throw new TypeError(`YouTube channel ${source.channelId} did not return its exact uploads playlist`);
  }
  return uploadsPlaylistId;
}

function recordYouTubeIssue(issues, error, context) {
  issues.push(cleanError(error, [context.youtubeApiKey]));
}

async function collectYouTubeVideoIds(playlistId, context, issues) {
  const videoIds = [];
  const seenVideoIds = new Set();
  const seenPageTokens = new Set();
  let pageToken = null;
  for (let page = 1; page <= context.limits.youtubeListingPages; page += 1) {
    const remaining = context.limits.youtubeCandidates - videoIds.length;
    if (remaining <= 0) break;
    let payload;
    try {
      payload = await youtubeRequest("playlistItems", {
        part: "contentDetails",
        playlistId,
        maxResults: Math.min(context.limits.youtubePageSize, remaining),
        pageToken,
        fields: "nextPageToken,items(contentDetails/videoId)",
      }, context);
    } catch (error) {
      recordYouTubeIssue(issues, error, context);
      break;
    }
    if (!Array.isArray(payload.items)) {
      recordYouTubeIssue(
        issues,
        new TypeError("YouTube playlistItems response did not contain an item array"),
        context,
      );
      break;
    }
    for (const item of payload.items) {
      const videoId = item?.contentDetails?.videoId;
      if (YOUTUBE_VIDEO_ID.test(videoId ?? "") && !seenVideoIds.has(videoId)) {
        seenVideoIds.add(videoId);
        videoIds.push(videoId);
      }
      if (videoIds.length >= context.limits.youtubeCandidates) break;
    }
    if (videoIds.length >= context.limits.youtubeCandidates || payload.nextPageToken === undefined) {
      break;
    }
    if (
      typeof payload.nextPageToken !== "string" ||
      payload.nextPageToken.length === 0 ||
      payload.nextPageToken.length > 512 ||
      seenPageTokens.has(payload.nextPageToken)
    ) {
      recordYouTubeIssue(issues, new TypeError("YouTube returned an invalid pagination token"), context);
      break;
    }
    seenPageTokens.add(payload.nextPageToken);
    pageToken = payload.nextPageToken;
  }
  return videoIds;
}

async function collectYouTubeVideos(videoIds, playlistId, context, issues) {
  const videosById = new Map();
  for (let index = 0; index < videoIds.length; index += YOUTUBE_VIDEO_BATCH_SIZE) {
    const batch = videoIds.slice(index, index + YOUTUBE_VIDEO_BATCH_SIZE);
    let payload;
    try {
      payload = await youtubeRequest("videos", {
        part: "contentDetails,snippet",
        id: batch.join(","),
        fields: "items(id,snippet(title,description,publishedAt,channelId,channelTitle,thumbnails),contentDetails/caption)",
      }, context);
    } catch (error) {
      recordYouTubeIssue(issues, error, context);
      break;
    }
    if (!Array.isArray(payload.items)) {
      recordYouTubeIssue(
        issues,
        new TypeError("YouTube videos response did not contain an item array"),
        context,
      );
      break;
    }
    const requestedIds = new Set(batch);
    for (const video of payload.items) {
      if (requestedIds.has(video?.id) && !videosById.has(video.id)) {
        videosById.set(video.id, { ...video, playlistIds: [playlistId] });
      }
    }
  }
  return videoIds.map((videoId) => videosById.get(videoId)).filter(Boolean);
}

async function collectYouTubeFeed(source, context) {
  const expectedEndpoint = officialYouTubeFeedUrl(source.channelId);
  if (!exactEndpoint(source.endpoint, expectedEndpoint)) {
    throw new TypeError(`YouTube official feed endpoint must exactly match ${expectedEndpoint}`);
  }
  context.endpoints.push(source.endpoint);
  const response = requireSuccess(
    await fetchBounded(source.endpoint, {
      trustedHosts: [YOUTUBE_FEED_HOST],
      fetchOptions: context.fetchOptions,
      limits: context.limits,
      headers: { Accept: "application/atom+xml, application/xml, text/xml" },
    }),
  );
  const parsed = parseYouTubeFeedXml(response.text(), source);
  const videos = parsed.videos.slice(0, context.limits.youtubeCandidates);
  const candidates = discoverYouTube({ source, videos, discoveredAt: context.discoveredAt });
  const acceptedIds = new Set(candidates.map((candidate) => candidate.sourceId));
  const rejected = [
    ...parsed.rejected,
    ...videos
      .filter((video) => !acceptedIds.has(video.id))
      .map((video) => ({
        sourceRegistryId: source.id,
        sourceType: "video",
        sourceId: video.id,
        canonicalUrl: `https://www.youtube.com/watch?v=${video.id}`,
        reason: "insufficient-cosmos-evidence",
        evidence: [],
      })),
  ];
  return { candidates, rejected, issues: parsed.issues };
}

async function collectYouTube(source, context) {
  if (!isYouTubeSourceConfigured(source)) {
    throw new TypeError("YouTube source requires one immutable ID matching its source type");
  }
  if (source.type === "youtube-channel" && source.transport === "official-feed") {
    return collectYouTubeFeed(source, context);
  }
  if (!exactEndpoint(source.endpoint, YOUTUBE_API_ENDPOINT)) {
    throw new TypeError(`YouTube source endpoint must exactly match ${YOUTUBE_API_ENDPOINT}`);
  }
  if (typeof context.youtubeApiKey !== "string" || context.youtubeApiKey.trim() === "") {
    throw new TypeError("YOUTUBE_API_KEY is required for enabled YouTube discovery sources");
  }
  context.youtubeApiKey = context.youtubeApiKey.trim();

  const issues = [];
  let playlistId;
  try {
    playlistId = await resolveYouTubePlaylist(source, context);
  } catch (error) {
    recordYouTubeIssue(issues, error, context);
    return { candidates: [], rejected: [], issues };
  }
  const videoIds = await collectYouTubeVideoIds(playlistId, context, issues);
  const videos = await collectYouTubeVideos(videoIds, playlistId, context, issues);
  const candidates = discoverYouTube({ source, videos, discoveredAt: context.discoveredAt });
  const acceptedIds = new Set(candidates.map((candidate) => candidate.sourceId));
  const returnedIds = new Set(videos.map((video) => video.id));
  const rejected = videos
    .filter((video) => !acceptedIds.has(video.id))
    .map((video) => ({
      sourceRegistryId: source.id,
      sourceType: "video",
      sourceId: video.id,
      canonicalUrl: `https://www.youtube.com/watch?v=${video.id}`,
      reason: "insufficient-cosmos-evidence",
      evidence: [],
    }));
  for (const videoId of videoIds) {
    if (!returnedIds.has(videoId)) {
      rejected.push({
        sourceRegistryId: source.id,
        sourceType: "video",
        sourceId: videoId,
        canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
        reason: issues.length > 0 ? "youtube-video-indeterminate" : "youtube-video-unavailable",
        evidence: [],
      });
    }
  }
  return { candidates, rejected, issues };
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
    } else if (source.type === "youtube-channel" || source.type === "youtube-playlist") {
      result = await collectYouTube(source, sourceContext);
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
  environment = process.env,
  discoveredAt = new Date().toISOString(),
  cadence = "all",
  fetchOptions = {},
  limits: limitOverrides = {},
  deadlineMilliseconds = fetchOptions.deadlineMilliseconds,
  now = fetchOptions.now ?? Date.now,
} = {}) {
  const timestamp = new Date(discoveredAt);
  if (Number.isNaN(timestamp.valueOf())) throw new TypeError("discoveredAt must be a valid date-time");
  const normalizedTimestamp = timestamp.toISOString();
  if (!DISCOVERY_CADENCES.has(cadence)) {
    throw new TypeError("cadence must be one of: all, daily, weekly");
  }
  if (
    deadlineMilliseconds !== undefined &&
    (!Number.isFinite(deadlineMilliseconds) || deadlineMilliseconds < 0)
  ) {
    throw new TypeError("deadlineMilliseconds must be a non-negative finite number");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");
  const limits = normalizeLimits(limitOverrides);
  const candidates = [];
  const rejected = [];
  const statuses = [];
  const operationFetchOptions = {
    ...fetchOptions,
    deadlineMilliseconds,
    now,
  };
  const deadlineExceeded = (error) => (
    deadlineMilliseconds !== undefined &&
    (now() >= deadlineMilliseconds || error?.code === "DEADLINE_EXCEEDED")
  );
  const recordDeadline = (source, { queried, endpoints = [] }) => {
    statuses.push({
      sourceRegistryId: source.id,
      sourceType: source.type,
      status: "indeterminate",
      queried,
      candidateCount: 0,
      rejectedCount: 1,
      endpoints,
      reason: DISCOVERY_DEADLINE_REASON,
    });
    rejected.push({
      sourceRegistryId: source.id,
      sourceType: source.type,
      sourceId: source.id,
      canonicalUrl: youtubePublicSourceUrl(source) ?? source.endpoint ?? null,
      reason: "source-indeterminate",
      evidence: [{ type: "source-error", value: DISCOVERY_DEADLINE_REASON }],
    });
  };

  for (const source of sourceList(trustedSources)) {
    if (cadence !== "all" && source?.cadence !== cadence) {
      statuses.push(skippedStatus(source ?? {}, "cadence-not-selected"));
      continue;
    }
    if (source?.enabled !== true) {
      statuses.push(skippedStatus(source ?? {}, "source-disabled"));
      continue;
    }
    if (source.type === "youtube-channel" || source.type === "youtube-playlist") {
      if (!isYouTubeSourceConfigured(source) || !isYouTubeDiscoveryEnabled(source)) {
        statuses.push(skippedStatus(source, "immutable-youtube-source-id-required"));
        continue;
      }
    }
    if (deadlineMilliseconds !== undefined && now() >= deadlineMilliseconds) {
      recordDeadline(source, { queried: false });
      continue;
    }
    try {
      const result = await querySource(source, {
        githubToken,
        youtubeApiKey: environment?.YOUTUBE_API_KEY,
        discoveredAt: normalizedTimestamp,
        fetchOptions: operationFetchOptions,
        limits,
      });
      if (deadlineMilliseconds !== undefined && now() >= deadlineMilliseconds) {
        recordDeadline(source, { queried: true, endpoints: result.status.endpoints });
        continue;
      }
      candidates.push(...result.candidates);
      rejected.push(...result.rejected);
      statuses.push(result.status);
    } catch (error) {
      if (deadlineExceeded(error)) {
        recordDeadline(source, {
          queried: (error?.discoveryEndpoints?.length ?? 0) > 0,
          endpoints: error?.discoveryEndpoints ?? [],
        });
        continue;
      }
      statuses.push({
        sourceRegistryId: source.id,
        sourceType: source.type,
        status: "indeterminate",
        queried: source.type === "youtube-channel" || source.type === "youtube-playlist"
          ? (error?.discoveryEndpoints?.length ?? 0) > 0
          : true,
        candidateCount: 0,
        rejectedCount: 1,
        endpoints: error?.discoveryEndpoints ?? [],
        reason: cleanError(error),
      });
      rejected.push({
        sourceRegistryId: source.id,
        sourceType: source.type,
        sourceId: source.id,
        canonicalUrl: youtubePublicSourceUrl(source) ?? source.endpoint ?? null,
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
    cadence,
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