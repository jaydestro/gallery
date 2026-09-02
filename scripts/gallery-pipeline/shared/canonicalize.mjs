const TRACKING_PARAMETERS = new Set([
  "_hsenc",
  "_hsmi",
  "campaign",
  "cid",
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "msclkid",
  "ocid",
  "ref",
  "referrer",
  "sc_cid",
  "source",
]);

const YOUTUBE_HOSTS = new Set([
  "m.youtube.com",
  "music.youtube.com",
  "www.youtube-nocookie.com",
  "www.youtube.com",
  "youtube.com",
  "youtube-nocookie.com",
  "youtu.be",
]);

const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

function parseUrl(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError("URL must be a non-empty string");
  }

  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`Unsupported URL protocol: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new TypeError("URLs containing credentials are not allowed");
  }

  url.protocol = "https:";
  url.hostname = url.hostname.toLowerCase();
  url.port = "";
  url.hash = "";
  return url;
}

function stripTrackingParameters(url) {
  for (const name of [...url.searchParams.keys()]) {
    const normalizedName = name.toLowerCase();
    if (
      normalizedName.startsWith("utm_") ||
      normalizedName.startsWith("wt.") ||
      TRACKING_PARAMETERS.has(normalizedName)
    ) {
      url.searchParams.delete(name);
    }
  }
  url.searchParams.sort();
}

function trimTrailingSlash(url) {
  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
}

export function extractYouTubeVideoId(value) {
  const url = parseUrl(value);
  if (!YOUTUBE_HOSTS.has(url.hostname)) {
    return null;
  }

  let videoId = null;
  if (url.hostname === "youtu.be") {
    [videoId] = url.pathname.split("/").filter(Boolean);
  } else if (url.pathname === "/watch") {
    videoId = url.searchParams.get("v");
  } else {
    const [kind, identifier] = url.pathname.split("/").filter(Boolean);
    if (kind === "embed" || kind === "shorts" || kind === "live") {
      videoId = identifier;
    }
  }

  return videoId && YOUTUBE_ID_PATTERN.test(videoId) ? videoId : null;
}

export function canonicalizeYouTubeUrl(value) {
  const videoId = extractYouTubeVideoId(value);
  if (!videoId) {
    throw new TypeError("YouTube URL must contain an immutable video ID");
  }
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function canonicalizeGitHubUrl(value) {
  const url = parseUrl(value);
  if (url.hostname === "www.github.com") {
    url.hostname = "github.com";
  }
  if (url.hostname !== "github.com") {
    throw new TypeError("GitHub URL must use github.com");
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length >= 2) {
    segments[0] = segments[0].toLowerCase();
    segments[1] = segments[1].replace(/\.git$/i, "").toLowerCase();
  }
  url.pathname = segments.length ? `/${segments.join("/")}` : "/";
  stripTrackingParameters(url);
  trimTrailingSlash(url);
  return url.toString();
}

export function canonicalizeLearnUrl(value) {
  const url = parseUrl(value);
  if (url.hostname === "docs.microsoft.com") {
    url.hostname = "learn.microsoft.com";
  }
  if (url.hostname !== "learn.microsoft.com") {
    throw new TypeError("Microsoft Learn URL must use learn.microsoft.com");
  }

  url.pathname = url.pathname.replace(/^\/[a-z]{2}-[a-z]{2}(?=\/)/i, "");
  stripTrackingParameters(url);
  trimTrailingSlash(url);
  return url.toString();
}

export function canonicalizeUrl(value) {
  const url = parseUrl(value);
  if (url.hostname === "github.com" || url.hostname === "www.github.com") {
    return canonicalizeGitHubUrl(value);
  }
  if (url.hostname === "learn.microsoft.com" || url.hostname === "docs.microsoft.com") {
    return canonicalizeLearnUrl(value);
  }
  if (YOUTUBE_HOSTS.has(url.hostname) && extractYouTubeVideoId(value)) {
    return canonicalizeYouTubeUrl(value);
  }

  stripTrackingParameters(url);
  trimTrailingSlash(url);
  return url.toString();
}

export function normalizeRepositoryPath(value = "") {
  const segments = String(value)
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment && segment !== ".");

  if (segments.includes("..")) {
    throw new TypeError("Repository paths cannot contain parent traversal");
  }
  return segments.join("/");
}

export function generateIdentityKey({ sourceType, sourceId, repositoryPath = "" }) {
  if (typeof sourceType !== "string" || sourceType.trim() === "") {
    throw new TypeError("sourceType is required for identity generation");
  }
  if ((typeof sourceId !== "string" && typeof sourceId !== "number") || String(sourceId).trim() === "") {
    throw new TypeError("sourceId is required for identity generation");
  }

  const normalizedType = sourceType.trim().toLowerCase();
  let normalizedId = String(sourceId).trim();
  if (normalizedType === "video") {
    if (!YOUTUBE_ID_PATTERN.test(normalizedId)) {
      throw new TypeError("Video identities require an immutable YouTube video ID");
    }
  } else if (normalizedType === "learn-document" && /^https?:\/\//i.test(normalizedId)) {
    normalizedId = canonicalizeLearnUrl(normalizedId);
  }

  const parts = [normalizedType, encodeURIComponent(normalizedId)];
  const normalizedPath = normalizeRepositoryPath(repositoryPath);
  if (normalizedPath) {
    parts.push(encodeURIComponent(normalizedPath));
  }
  return parts.join(":");
}