import { normalizeCandidates } from "../normalize.mjs";

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{10,}$/;
const COSMOS_TERM = /\b(?:azure\s+)?cosmos\s*db\b|\bcosmosdb\b/i;

function configuredIds(source = {}) {
  const channelIds = new Set(
    [source.channelId, ...(source.channelIds ?? [])]
      .filter((value) => typeof value === "string" && SOURCE_ID_PATTERN.test(value)),
  );
  const playlistIds = new Set(
    [source.playlistId, ...(source.playlistIds ?? [])]
      .filter((value) => typeof value === "string" && SOURCE_ID_PATTERN.test(value)),
  );
  return { channelIds, playlistIds };
}

export function isYouTubeDiscoveryEnabled(source) {
  if (source?.enabled !== true) {
    return false;
  }
  const { channelIds, playlistIds } = configuredIds(source);
  return channelIds.size > 0 || playlistIds.size > 0;
}

function normalizedVideo(video) {
  const snippet = video?.snippet ?? {};
  const rawId = typeof video?.id === "object" ? video.id.videoId : video?.id ?? video?.videoId;
  return {
    id: rawId,
    title: video?.title ?? snippet.title,
    description: video?.description ?? snippet.description ?? "",
    publishedAt: video?.publishedAt ?? snippet.publishedAt ?? null,
    channelId: video?.channelId ?? snippet.channelId,
    channelTitle: video?.channelTitle ?? snippet.channelTitle,
    playlistIds: [video?.playlistId, ...(video?.playlistIds ?? [])].filter(Boolean),
    transcript: video?.transcript ?? video?.captions ?? "",
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
    if (!VIDEO_ID_PATTERN.test(video.id ?? "") || !video.title || !comesFromConfiguredSource(video, ids)) {
      continue;
    }
    if (!COSMOS_TERM.test([video.title, video.description, video.transcript].join("\n"))) {
      continue;
    }

    candidates.push({
      sourceType: "video",
      sourceId: video.id,
      canonicalUrl: `https://www.youtube.com/watch?v=${video.id}`,
      title: video.title,
      description: video.description,
      publisher: video.channelTitle ?? video.channelId,
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
        sourceRegistryId: sourceConfig.id,
        trustTier: sourceConfig.trustTier,
        videoId: video.id,
        channelId: video.channelId,
        playlistIds: [...video.playlistIds].sort(),
        captionsAvailable: Boolean(video.transcript),
      },
    });
  }
  return normalizeCandidates(candidates);
}