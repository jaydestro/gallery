import { normalizeCandidates } from "../normalize.mjs";
import { enrichCandidateMetadata } from "../enrich-candidate.mjs";

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;
const PLAYLIST_ID_PATTERN = /^PL(?:[A-Za-z0-9_-]{16}|[A-Za-z0-9_-]{32})$/;
const COSMOS_TERM = /\b(?:azure\s+)?cosmos\s*db\b|\bcosmosdb\b/i;
const YOUTUBE_THUMBNAIL_HOSTS = new Set(["i.ytimg.com", "img.youtube.com"]);

function officialThumbnailUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      YOUTUBE_THUMBNAIL_HOSTS.has(url.hostname.toLowerCase())
    ) ? value.trim() : null;
  } catch {
    return null;
  }
}

function configuredIds(source = {}) {
  const channelIds = new Set(
    source.type === "youtube-channel" && CHANNEL_ID_PATTERN.test(source.channelId ?? "")
      ? [source.channelId]
      : [],
  );
  const playlistIds = new Set(
    source.type === "youtube-playlist" && PLAYLIST_ID_PATTERN.test(source.playlistId ?? "")
      ? [source.playlistId]
      : [],
  );
  return { channelIds, playlistIds };
}

export function isYouTubeSourceConfigured(source) {
  const { channelIds, playlistIds } = configuredIds(source);
  return channelIds.size + playlistIds.size === 1;
}

export function isYouTubeDiscoveryEnabled(source) {
  return source?.enabled === true && isYouTubeSourceConfigured(source);
}

function normalizedVideo(video) {
  const snippet = video?.snippet ?? {};
  const contentDetails = video?.contentDetails ?? {};
  const thumbnails = snippet.thumbnails ?? {};
  const captionsAvailable = contentDetails.caption === "true" || video?.captionsAvailable === true;
  return {
    id: video?.id,
    title: snippet.title,
    description: snippet.description ?? "",
    publishedAt: snippet.publishedAt ?? null,
    channelId: snippet.videoOwnerChannelId ?? snippet.channelId,
    channelTitle: snippet.videoOwnerChannelTitle ?? snippet.channelTitle,
    playlistIds: [video?.playlistId, ...(video?.playlistIds ?? [])].filter(Boolean),
    captionsAvailable,
    transcript: captionsAvailable && typeof video?.transcript === "string" ? video.transcript : "",
    thumbnailUrl: thumbnails.maxres?.url ?? thumbnails.high?.url ?? thumbnails.medium?.url ??
      thumbnails.default?.url ?? null,
  };
}

function comesFromConfiguredSource(video, ids) {
  return (
    ids.channelIds.has(video.channelId) ||
    video.playlistIds.some((playlistId) => ids.playlistIds.has(playlistId))
  );
}

export function discoverYouTube({ source, videos, fixture, offline = false, discoveredAt } = {}) {
  const payload = fixture ?? (videos ? { source, videos, discoveredAt } : null);
  if (!payload) {
    if (offline) {
      return [];
    }
    throw new TypeError("YouTube discovery requires normalized videos or a fixture");
  }
  const sourceConfig = source ?? payload.source;
  if (!isYouTubeDiscoveryEnabled(sourceConfig)) {
    return [];
  }

  const ids = configuredIds(sourceConfig);
  const discoveryTime = discoveredAt ?? payload.discoveredAt;
  const candidates = [];
  for (const item of payload.videos ?? payload.items ?? []) {
    const video = normalizedVideo(item);
    if (
      !VIDEO_ID_PATTERN.test(video.id ?? "") ||
      !CHANNEL_ID_PATTERN.test(video.channelId ?? "") ||
      !video.title ||
      !comesFromConfiguredSource(video, ids)
    ) {
      continue;
    }
    if (!COSMOS_TERM.test([video.title, video.description, video.transcript].join("\n"))) {
      continue;
    }
    const canonicalUrl = `https://www.youtube.com/watch?v=${video.id}`;
    const author = video.channelTitle ?? video.channelId;
    const catalogMetadata = enrichCandidateMetadata({
      sourceType: "video",
      sourceId: video.id,
      trustTier: sourceConfig.trustTier,
      launchUrl: canonicalUrl,
      websiteUrls: [`https://www.youtube.com/channel/${video.channelId}`],
      author,
      sourceOwner: author,
      publishedAt: video.publishedAt,
      previewUrls: [officialThumbnailUrl(video.thumbnailUrl)],
    });

    candidates.push({
      sourceType: "video",
      sourceId: video.id,
      canonicalUrl,
      title: video.title,
      description: video.description,
      publisher: author,
      publishedAt: video.publishedAt,
      modifiedAt: null,
      discoveredAt: discoveryTime,
      evidence: [
        { type: "youtube-description", value: video.description || video.title },
        ...(video.transcript
          ? [{ type: "youtube-transcript", value: video.transcript }]
          : []),
      ],
      metadata: {
        ...catalogMetadata,
        sourceRegistryId: sourceConfig.id,
        trustTier: sourceConfig.trustTier,
        youtubeSourceType: sourceConfig.type,
        youtubeSourceId: sourceConfig.channelId ?? sourceConfig.playlistId,
        videoId: video.id,
        channelId: video.channelId,
        playlistIds: [...video.playlistIds].sort(),
        captionsAvailable: video.captionsAvailable,
      },
    });
  }
  return normalizeCandidates(candidates);
}