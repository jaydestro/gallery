import dns from 'node:dns/promises';
import net from 'node:net';
import { XMLParser } from 'fast-xml-parser';
import { normalizeUrl, urlFingerprint } from './normalize.mjs';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const REQUIRED_STRING_FIELDS = ['title', 'description', 'preview', 'website', 'source', 'date'];
const NON_EMPTY_FIELDS = new Set(['title', 'description', 'source', 'date']);

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function privateAddress(address) {
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb');
  }
  if (!net.isIPv4(address)) return true;
  const [first, second] = address.split('.').map(Number);
  return first === 0 || first === 10 || first === 127 || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

async function assertSafeUrl(value, allowPrivate) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported-protocol');
  if (url.username || url.password) throw new Error('embedded-credentials');
  if (allowPrivate) return url;
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) throw new Error('private-host');
  const addresses = net.isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true });
  if (addresses.length === 0 || addresses.some(({ address }) => privateAddress(address))) throw new Error('private-host');
  return url;
}

async function readBoundedBody(response, maximumBytes) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) throw new Error('response-too-large');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error('response-too-large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function boundedGet(value, policy, options = {}) {
  const timeoutSignal = AbortSignal.timeout(policy.requestTimeoutMs);
  let current = new URL(value);
  let redirects = 0;
  while (true) {
    await assertSafeUrl(current, options.allowPrivate === true);
    if (options.allowedHostnames && !options.allowedHostnames.includes(current.hostname.toLowerCase())) throw new Error('hostname-not-allowlisted');
    const response = await (options.fetchImpl ?? fetch)(current, {
      headers: options.headers,
      redirect: 'manual',
      signal: timeoutSignal,
    });
    if (REDIRECT_STATUSES.has(response.status) && response.headers.get('location')) {
      if (redirects >= policy.redirectLimit) throw new Error('redirect-limit');
      current = new URL(response.headers.get('location'), current);
      redirects += 1;
      continue;
    }
    return {
      body: await readBoundedBody(response, policy.maxResponseBytes),
      finalUrl: current.toString(),
      redirects,
      status: response.status,
    };
  }
}

function statusResult(result) {
  if (result.status === 404 || result.status === 410) return { outcome: 'broken', reason: `http-${result.status}` };
  if (result.status < 200 || result.status >= 400) return { outcome: 'indeterminate', reason: `http-${result.status}` };
  if (result.redirects > 0) return { outcome: 'redirected', reason: 'http-redirect' };
  return { outcome: 'healthy', reason: 'http-ok' };
}

function githubRepository(value) {
  const url = new URL(value);
  const parts = url.pathname.split('/').filter(Boolean);
  return url.hostname.toLowerCase() === 'github.com' && parts.length === 2
    ? { owner: parts[0], repository: parts[1].replace(/\.git$/i, '') }
    : null;
}

function youtubeVideo(value) {
  const normalized = new URL(normalizeUrl(value));
  return normalized.hostname === 'www.youtube.com' && normalized.pathname === '/watch' && normalized.searchParams.has('v')
    ? normalized.toString()
    : null;
}

export async function checkUrl(value, policy, options = {}) {
  try {
    const videoUrl = youtubeVideo(value);
    if (videoUrl) {
      const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`;
      const result = await boundedGet(oembedUrl, policy, { ...options, allowedHostnames: ['www.youtube.com'] });
      if (result.status === 404 || result.status === 410) return { ...result, finalUrl: videoUrl, outcome: 'broken', reason: 'youtube-unavailable' };
      if (result.status < 200 || result.status >= 400) return { ...result, finalUrl: videoUrl, outcome: 'indeterminate', reason: `youtube-http-${result.status}` };
      return { ...result, finalUrl: videoUrl, outcome: 'healthy', reason: 'youtube-available' };
    }
    const repository = githubRepository(value);
    if (repository && options.githubApi !== false) {
      const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'gallery-content-audit' };
      const githubToken = options.githubToken ?? process.env.GITHUB_TOKEN;
      if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
      const apiResult = await boundedGet(`https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}`, policy, {
        ...options,
        allowedHostnames: ['api.github.com'],
        headers,
      });
      if (apiResult.status === 404 || apiResult.status === 410) return { ...apiResult, outcome: 'broken', reason: 'github-missing' };
      if (apiResult.status === 403 || apiResult.status === 429 || apiResult.status >= 500) return { ...apiResult, outcome: 'indeterminate', reason: `github-http-${apiResult.status}` };
      const metadata = JSON.parse(apiResult.body);
      if (metadata.disabled) return { ...apiResult, outcome: 'review', reason: 'github-disabled' };
      if (metadata.archived) return { ...apiResult, outcome: 'review', reason: 'github-archived' };
      return { ...apiResult, finalUrl: metadata.html_url ?? value, outcome: 'healthy', reason: 'github-active' };
    }
    const result = await boundedGet(value, policy, options);
    return { ...result, ...statusResult(result) };
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return {
      finalUrl: value,
      status: null,
      outcome: 'indeterminate',
      reason: timeout ? 'timeout' : (error?.message ?? 'network-error'),
    };
  }
}

export function validateCatalog(catalog) {
  if (!Array.isArray(catalog)) throw new TypeError('Catalog must be an array');
  catalog.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError(`Catalog entry ${index} must be an object`);
    for (const field of REQUIRED_STRING_FIELDS) {
      if (typeof entry[field] !== 'string' || (NON_EMPTY_FIELDS.has(field) && entry[field].trim() === '')) throw new TypeError(`Catalog entry ${index} has invalid ${field}`);
    }
    if ((typeof entry.author !== 'string' && !Array.isArray(entry.author)) || (Array.isArray(entry.author) && entry.author.some((author) => typeof author !== 'string'))) throw new TypeError(`Catalog entry ${index} has invalid author`);
    if (!Array.isArray(entry.tags) || entry.tags.some((tag) => typeof tag !== 'string')) throw new TypeError(`Catalog entry ${index} has invalid tags`);
    if (Number.isNaN(Date.parse(entry.date))) throw new TypeError(`Catalog entry ${index} has invalid date`);
    normalizeUrl(entry.source);
  });
  return catalog.length;
}

export function findDuplicates(catalog, trackingParameters = []) {
  const exact = new Map();
  const normalized = new Map();
  catalog.forEach((entry, index) => {
    const exactKey = entry.source.trim();
    const normalizedKey = urlFingerprint(entry.source, trackingParameters);
    exact.set(exactKey, [...(exact.get(exactKey) ?? []), index]);
    normalized.set(normalizedKey, [...(normalized.get(normalizedKey) ?? []), index]);
  });
  return catalog.map((entry) => ({
    exact: exact.get(entry.source.trim()).filter((index) => catalog[index] !== entry),
    normalized: normalized.get(urlFingerprint(entry.source, trackingParameters)).filter((index) => catalog[index] !== entry),
  }));
}

function reviewSignals(entry, policy, now) {
  const signals = [];
  const ageDays = (now.getTime() - Date.parse(entry.date)) / 86_400_000;
  if (ageDays > policy.ageReviewThresholdDays) signals.push('age-review');
  const text = `${entry.title} ${entry.description} ${entry.source}`.toLowerCase();
  if (policy.knownRetiredTerms.some((term) => text.includes(term.toLowerCase()))) signals.push('known-retired-term');
  return signals;
}

export async function auditCatalog(catalog, policy, options = {}) {
  validateCatalog(catalog);
  const duplicates = findDuplicates(catalog, policy.trackingParameters);
  const scannedAt = (options.now ?? new Date()).toISOString();
  const checker = options.checker ?? ((url) => checkUrl(url, policy));
  const entries = [];
  for (let index = 0; index < catalog.length; index += 1) {
    const item = catalog[index];
    const checked = await checker(item.source);
    const signals = reviewSignals(item, policy, options.now ?? new Date());
    let outcome = checked.outcome;
    const duplicate = duplicates[index];
    if (!['broken', 'indeterminate'].includes(outcome) && (duplicate.exact.length > 0 || duplicate.normalized.length > 0)) outcome = 'duplicate';
    else if (outcome === 'healthy' && signals.length > 0) outcome = 'review';
    entries.push({
      catalogIndex: index,
      title: item.title,
      url: item.source,
      normalizedUrl: normalizeUrl(item.source, policy.trackingParameters),
      outcome,
      reasonCodes: [checked.reason, ...signals].filter(Boolean),
      httpStatus: checked.status ?? null,
      finalUrl: checked.finalUrl ?? item.source,
      duplicates: duplicate,
      scannedAt,
      classification: null,
    });
  }
  return entries;
}

function textValue(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (value && typeof value === 'object') return String(value['#text'] ?? value.name ?? '');
  return '';
}

function entryLink(entry) {
  for (const link of asArray(entry.link)) {
    if (typeof link === 'string') return link;
    if (link?.['@_href'] && (!link['@_rel'] || link['@_rel'] === 'alternate')) return link['@_href'];
    if (link?.['#text']) return link['#text'];
  }
  return '';
}

export function discoverFromFeed(xml, source, policy, existingFingerprints, options = {}) {
  const parser = new XMLParser({ ignoreAttributes: false, processEntities: false, trimValues: true });
  const parsed = parser.parse(xml);
  const entries = asArray(parsed.rss?.channel?.item ?? parsed.feed?.entry);
  const now = options.now ?? new Date();
  const earliest = now.getTime() - source.lookbackDays * 86_400_000;
  const terms = source.inclusionTerms ?? policy.inclusionTerms;
  const seen = new Set();
  const candidates = [];
  for (const entry of entries) {
    const title = textValue(entry.title).trim();
    const rawUrl = entryLink(entry).trim();
    const publishedAt = textValue(entry.pubDate ?? entry.published ?? entry.updated).trim();
    const summary = textValue(entry.description ?? entry.summary ?? entry.content).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000);
    if (!title || !rawUrl || !publishedAt || Number.isNaN(Date.parse(publishedAt)) || Date.parse(publishedAt) < earliest) continue;
    let normalized;
    try {
      normalized = normalizeUrl(rawUrl, policy.trackingParameters);
    } catch {
      continue;
    }
    if (!source.allowedHostnames.includes(new URL(normalized).hostname.toLowerCase())) continue;
    const haystack = `${title} ${summary} ${normalized}`.toLowerCase();
    const matchedTerms = terms.filter((term) => haystack.includes(term.toLowerCase()));
    const fingerprint = urlFingerprint(normalized, policy.trackingParameters);
    if (matchedTerms.length === 0 || existingFingerprints.has(fingerprint) || seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    candidates.push({
      candidateIndex: candidates.length,
      sourceId: source.id,
      title,
      url: normalized,
      publishedAt: new Date(publishedAt).toISOString(),
      author: textValue(entry.author ?? entry['dc:creator']).trim() || null,
      summary,
      signals: [`trust:${source.trustTier}`, ...matchedTerms.map((term) => `term:${term.toLowerCase()}`)],
      discoveredAt: now.toISOString(),
      classification: null,
    });
  }
  return candidates;
}

export async function discoverArticles(sources, policy, liveCatalog, retiredCatalog, options = {}) {
  const existing = new Set([...liveCatalog, ...retiredCatalog].map((entry) => urlFingerprint(entry.source, policy.trackingParameters)));
  const candidates = [];
  const sourceResults = [];
  const seen = new Set();
  for (const source of sources.filter((item) => item.enabled)) {
    try {
      const feedUrl = new URL(source.url);
      if (!source.allowedHostnames.includes(feedUrl.hostname.toLowerCase())) throw new Error('source-hostname-not-allowlisted');
      const xml = options.feedProvider
        ? await options.feedProvider(source)
        : (await boundedGet(source.url, policy, { allowedHostnames: source.allowedHostnames })).body;
      const discovered = discoverFromFeed(xml, source, policy, existing, { now: options.now });
      for (const candidate of discovered) {
        const fingerprint = urlFingerprint(candidate.url, policy.trackingParameters);
        if (seen.has(fingerprint)) continue;
        candidate.candidateIndex = candidates.length;
        seen.add(fingerprint);
        candidates.push(candidate);
      }
      sourceResults.push({ sourceId: source.id, status: 'complete', candidateCount: discovered.length });
    } catch (error) {
      sourceResults.push({ sourceId: source.id, status: 'partial', candidateCount: 0, error: error?.message ?? 'source-error' });
    }
  }
  return { candidates, sourceResults };
}