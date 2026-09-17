import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { auditCatalog, checkUrl, discoverArticles, discoverFromFeed, findDuplicates, validateCatalog } from '../core.mjs';
import { buildClassificationPrompt, buildCopilotArguments, runCopilotClassification } from '../copilot.mjs';
import { urlFingerprint } from '../normalize.mjs';
import { planCatalogPromotion } from '../promotion.mjs';

const policy = {
  requestTimeoutMs: 250,
  maxResponseBytes: 128,
  redirectLimit: 2,
  trackingParameters: ['utm_*', 'fbclid'],
  ageReviewThresholdDays: 730,
  inclusionTerms: ['azure cosmos db', 'cosmos db'],
  knownRetiredTerms: ['documentclient'],
};

function catalogEntry(overrides = {}) {
  return {
    title: 'Example', description: 'Azure Cosmos DB example', preview: 'coming soon', website: 'https://example.com',
    author: 'Author', source: 'https://example.com/item', date: '2026-01-01', tags: ['example'], ...overrides,
  };
}

test('validates catalogs and detects exact and normalized duplicates without mutation', async () => {
  const catalog = [
    catalogEntry(),
    catalogEntry({ title: 'Exact', source: 'https://example.com/item' }),
    catalogEntry({ title: 'Normalized', source: 'https://example.com/item/?utm_source=test#fragment' }),
  ];
  const before = JSON.stringify(catalog);
  validateCatalog(catalog);
  const duplicates = findDuplicates(catalog, policy.trackingParameters);
  assert.deepEqual(duplicates[0], { exact: [1], normalized: [1, 2] });
  const report = await auditCatalog(catalog, policy, {
    now: new Date('2026-09-17T00:00:00Z'),
    checker: async (url) => ({ outcome: 'healthy', reason: 'test', status: 200, finalUrl: url }),
  });
  assert.equal(report.length, catalog.length);
  assert.ok(report.every((entry) => entry.outcome === 'duplicate'));
  assert.ok(report.every((entry) => entry.reasonCodes.includes('duplicate')));
  assert.equal(JSON.stringify(catalog), before);
});

test('audits catalog URLs with bounded concurrency while preserving order', async () => {
  const catalog = Array.from({ length: 9 }, (_, index) => catalogEntry({ title: `Item ${index}`, source: `https://example.com/${index}` }));
  let active = 0;
  let maximumActive = 0;
  const report = await auditCatalog(catalog, { ...policy, auditConcurrency: 3 }, {
    checker: async (url) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { outcome: 'healthy', reason: 'test', status: 200, finalUrl: url };
    },
  });
  assert.equal(maximumActive, 3);
  assert.deepEqual(report.map((entry) => entry.catalogIndex), catalog.map((_, index) => index));
});

test('classifies age alone as review rather than broken or retired', async () => {
  const report = await auditCatalog([catalogEntry({ date: '2020-01-01' })], policy, {
    now: new Date('2026-09-17T00:00:00Z'),
    checker: async (url) => ({ outcome: 'healthy', reason: 'test', status: 200, finalUrl: url }),
  });
  assert.equal(report[0].outcome, 'review');
  assert.ok(report[0].reasonCodes.includes('age-review'));
});

test('filters RSS by lookback and inclusion terms and deduplicates live, retired, and feed URLs', () => {
  const source = { id: 'feed', trustTier: 'first-party', lookbackDays: 45, allowedHostnames: ['example.com'] };
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title>Azure Cosmos DB new guide</title><link>https://example.com/new?utm_source=rss</link><pubDate>2026-09-10T00:00:00Z</pubDate><description>Technical tutorial</description></item>
    <item><title>Duplicate Cosmos DB guide</title><link>https://example.com/new</link><pubDate>2026-09-11T00:00:00Z</pubDate></item>
    <item><title>Existing Cosmos DB guide</title><link>https://example.com/live/</link><pubDate>2026-09-11T00:00:00Z</pubDate></item>
    <item><title>Retired Cosmos DB guide</title><link>https://example.com/retired</link><pubDate>2026-09-11T00:00:00Z</pubDate></item>
    <item><title>Unrelated article</title><link>https://example.com/other</link><pubDate>2026-09-11T00:00:00Z</pubDate></item>
    <item><title>Old Cosmos DB guide</title><link>https://example.com/old</link><pubDate>2025-01-01T00:00:00Z</pubDate></item>
  </channel></rss>`;
  const existing = new Set([
    urlFingerprint('https://example.com/live', policy.trackingParameters),
    urlFingerprint('https://example.com/retired/', policy.trackingParameters),
  ]);
  const candidates = discoverFromFeed(xml, source, policy, existing, { now: new Date('2026-09-17T00:00:00Z') });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].url, 'https://example.com/new');
});

test('classifies HTTP outcomes, redirects, timeouts, and response limits', async (context) => {
  const server = http.createServer((request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { Location: '/ok' }); response.end(); return; }
    if (request.url === '/redirect-without-location') { response.writeHead(302); response.end(); return; }
    if (request.url === '/missing') { response.writeHead(404); response.end('missing'); return; }
    if (request.url === '/gone') { response.writeHead(410); response.end('gone'); return; }
    if (request.url === '/unauthorized') { response.writeHead(401); response.end('unauthorized'); return; }
    if (request.url === '/forbidden') { response.writeHead(403); response.end('forbidden'); return; }
    if (request.url === '/limited') { response.writeHead(429); response.end('limited'); return; }
    if (request.url === '/server-error') { response.writeHead(500); response.end('error'); return; }
    if (request.url === '/large') { response.writeHead(200, { 'Content-Length': '1024' }); response.end('x'.repeat(1024)); return; }
    if (request.url === '/slow') return;
    response.writeHead(200); response.end('ok');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => server.close());
  const { port } = server.address();
  const check = (route) => checkUrl(`http://127.0.0.1:${port}${route}`, policy, { allowPrivate: true, githubApi: false });
  assert.equal((await check('/ok')).outcome, 'healthy');
  assert.equal((await check('/redirect')).outcome, 'redirected');
  assert.equal((await check('/redirect-without-location')).outcome, 'indeterminate');
  assert.equal((await check('/missing')).outcome, 'broken');
  assert.equal((await check('/gone')).outcome, 'broken');
  for (const route of ['/unauthorized', '/forbidden', '/limited', '/server-error', '/large', '/slow']) assert.equal((await check(route)).outcome, 'indeterminate');
});

test('blocks IPv4-mapped private IPv6 addresses before fetching', async () => {
  let fetched = false;
  const result = await checkUrl('http://[::ffff:127.0.0.1]/', policy, {
    githubApi: false,
    fetchImpl: async () => { fetched = true; return new Response('ok'); },
  });
  assert.equal(result.outcome, 'indeterminate');
  assert.equal(result.reason, 'private-host');
  assert.equal(fetched, false);
});

test('validates YouTube videos through the bounded oEmbed endpoint', async () => {
  let requestedUrl;
  const result = await checkUrl('https://youtu.be/6IIUtEFKJec?si=tracking', policy, {
    allowPrivate: true,
    fetchImpl: async (url) => {
      requestedUrl = url.toString();
      return new Response('{"title":"Video"}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.match(requestedUrl, /^https:\/\/www\.youtube\.com\/oembed\?/);
  assert.match(requestedUrl, /6IIUtEFKJec/);
  assert.equal(result.outcome, 'healthy');
  assert.equal(result.reason, 'youtube-available');
  assert.equal(result.finalUrl, 'https://www.youtube.com/watch?v=6IIUtEFKJec');
});

test('treats an unhandled YouTube redirect as indeterminate', async () => {
  const result = await checkUrl('https://youtu.be/6IIUtEFKJec', policy, {
    allowPrivate: true,
    fetchImpl: async () => new Response('', { status: 302 }),
  });
  assert.equal(result.outcome, 'indeterminate');
  assert.equal(result.reason, 'youtube-http-302');
});

test('handles GitHub authentication, private repositories, and referenced paths conservatively', async () => {
  const unauthorized = await checkUrl('https://github.com/example/repository', policy, {
    fetchImpl: async () => new Response('{"message":"Bad credentials"}', { status: 401 }),
  });
  assert.equal(unauthorized.outcome, 'indeterminate');
  assert.equal(unauthorized.reason, 'github-http-401');

  const privateRepository = await checkUrl('https://github.com/example/repository', policy, {
    fetchImpl: async () => new Response('{"private":true,"html_url":"https://github.com/example/repository"}', { status: 200 }),
  });
  assert.equal(privateRepository.outcome, 'review');
  assert.equal(privateRepository.reason, 'github-private');

  const requests = [];
  const missingPath = await checkUrl('https://github.com/example/repository/blob/main/missing.md', policy, {
    fetchImpl: async (url) => {
      requests.push(url.toString());
      return url.hostname === 'api.github.com'
        ? new Response('{"private":false,"html_url":"https://github.com/example/repository"}', { status: 200 })
        : new Response('missing', { status: 404 });
    },
  });
  assert.equal(requests.length, 2);
  assert.equal(missingPath.outcome, 'broken');
  assert.equal(missingPath.reason, 'http-404');
});

test('rejects failed feeds and unresolved or off-host article candidates', async () => {
  const source = { id: 'feed', url: 'https://example.com/feed', enabled: true, trustTier: 'first-party', lookbackDays: 45, allowedHostnames: ['example.com'] };
  const failed = await discoverArticles([source], policy, [], [], {
    feedProvider: async () => ({ status: 500, body: '<rss><channel></channel></rss>' }),
  });
  assert.equal(failed.sourceResults[0].status, 'partial');
  assert.equal(failed.sourceResults[0].error, 'feed-http-500');

  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title>Healthy Cosmos DB guide</title><link>https://example.com/healthy</link><pubDate>2026-09-10T00:00:00Z</pubDate></item>
    <item><title>Dead Cosmos DB guide</title><link>https://example.com/dead</link><pubDate>2026-09-10T00:00:00Z</pubDate></item>
    <item><title>Redirected Cosmos DB guide</title><link>https://example.com/redirected</link><pubDate>2026-09-10T00:00:00Z</pubDate></item>
  </channel></rss>`;
  const discovery = await discoverArticles([source], policy, [], [], {
    now: new Date('2026-09-17T00:00:00Z'),
    feedProvider: async () => xml,
    checker: async (url) => {
      if (url.endsWith('/dead')) return { outcome: 'broken', finalUrl: url };
      if (url.endsWith('/redirected')) return { outcome: 'redirected', finalUrl: 'https://other.example/article' };
      return { outcome: 'healthy', finalUrl: url };
    },
  });
  assert.deepEqual(discovery.candidates.map((candidate) => candidate.url), ['https://example.com/healthy']);
  assert.equal(discovery.sourceResults[0].candidateCount, 1);
});

test('retries malformed Copilot output once and returns an incomplete fallback', () => {
  let calls = 0;
  const result = runCopilotClassification({
    prompt: 'prompt', candidatePath: 'candidates.json', auditPath: 'audit.json', catalogPath: 'catalog.json', candidates: [], catalog: [],
    execute: () => { calls += 1; return { status: 0, stdout: calls === 1 ? 'not json' : '{"newContent":[]}' }; },
  });
  assert.equal(calls, 2);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.attempts, 2);
});

test('repairs ANSI-wrapped malformed model JSON through the classification path', () => {
  const candidate = { url: 'https://example.com/new' };
  const response = `{
    newContent: [{
      candidateIndex: 0,
      url: "${candidate.url}",
      verdict: "review",
      confidence: "low",
      criteria: ["uncertain",],
      evidence: "Needs
review.",
      relatedUrl: null,
    },],
    existingContent: [],
  }`;
  const result = runCopilotClassification({
    prompt: 'prompt', candidatePath: 'candidates.json', auditPath: 'audit.json', catalogPath: 'catalog.json',
    candidates: [candidate], catalog: [], execute: () => ({ status: 0, stdout: `\u001b[32m${response}\u001b[0m` }),
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.classification.newContent[0].url, candidate.url);
  assert.equal(result.classification.newContent[0].evidence, 'Needs\nreview.');
});

test('embeds JSON inputs as untrusted prompt data without native attachments', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'gallery-copilot-'));
  const documents = [
    { candidates: [{ title: 'Candidate', url: 'https://example.com/new', summary: 'Useful guide.' }] },
    { entries: [
      { catalogIndex: 0, title: 'Healthy', url: 'https://example.com/healthy', outcome: 'healthy', reasonCodes: ['http-ok'] },
      { catalogIndex: 1, title: 'Existing', url: 'https://example.com/old', outcome: 'broken', reasonCodes: ['http-404'] },
    ] },
    [
      { title: 'Healthy', description: 'Keep this.', source: 'https://example.com/healthy', tags: ['blog'] },
      { title: 'Existing', description: 'Catalog description.', source: 'https://example.com/old', tags: ['blog'] },
    ],
  ];
  const files = ['candidates.json', 'audit.json', 'catalog.json'].map((name, index) => {
    const file = path.join(directory, name);
    writeFileSync(file, JSON.stringify(documents[index]));
    return file;
  });
  const options = {
    prompt: 'Classify the documents.',
    candidatePath: files[0],
    auditPath: files[1],
    catalogPath: files[2],
    existingEntries: [{ catalogIndex: 1, url: 'https://example.com/old' }],
  };
  const prompt = buildClassificationPrompt(options);
  const argumentsList = buildCopilotArguments(options);
  assert.match(prompt, /BEGIN ARTICLE CANDIDATES/);
  assert.match(prompt, /BEGIN RETIREMENT CANDIDATES/);
  assert.match(prompt, /BEGIN CATALOG COMPARISON ONLY/);
  assert.match(prompt, /Catalog description/);
  assert.match(prompt, /Keep this/);
  const retirementSection = prompt.match(/BEGIN RETIREMENT CANDIDATES ---([\s\S]*?)--- END RETIREMENT CANDIDATES/)?.[1] ?? '';
  assert.doesNotMatch(retirementSection, /Keep this/);
  assert.equal(argumentsList[0], '-p');
  assert.equal(argumentsList[1], prompt);
  assert.ok(argumentsList.includes('--no-color'));
  assert.equal(argumentsList.some((argument) => argument.startsWith('--attachment')), false);
  assert.ok(Buffer.byteLength(prompt, 'utf8') <= 96 * 1024);
});

test('accepts a fenced strict Copilot response with exact indexes and URLs', () => {
  const candidates = [{ url: 'https://example.com/new' }];
  const catalog = [{ source: 'https://example.com/existing' }];
  const response = {
    newContent: [{ candidateIndex: 0, url: candidates[0].url, verdict: 'review', confidence: 'low', criteria: ['uncertain'], evidence: 'Needs review.', relatedUrl: null }],
    existingContent: [{ catalogIndex: 0, url: catalog[0].source, verdict: 'keep', confidence: 'high', criteria: ['useful'], evidence: 'Still useful.', relatedUrl: null }],
  };
  const result = runCopilotClassification({
    prompt: 'prompt', candidatePath: 'candidates.json', auditPath: 'audit.json', catalogPath: 'catalog.json', candidates, catalog,
    execute: () => ({ status: 0, stdout: `\`\`\`json\n${JSON.stringify(response)}\n\`\`\`` }),
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.attempts, 1);
});

test('rejects empty Copilot classification criteria', () => {
  const candidates = [{ url: 'https://example.com/new' }];
  const response = {
    newContent: [{ candidateIndex: 0, url: candidates[0].url, verdict: 'review', confidence: 'low', criteria: [' '], evidence: 'Needs review.', relatedUrl: null }],
    existingContent: [],
  };
  const result = runCopilotClassification({
    prompt: 'prompt', candidatePath: 'candidates.json', auditPath: 'audit.json', catalogPath: 'catalog.json', candidates, catalog: [],
    execute: () => ({ status: 0, stdout: JSON.stringify(response) }),
  });
  assert.equal(result.status, 'incomplete');
  assert.match(result.error, /invalid criteria/);
});

test('promotes only high-confidence additions with complete source metadata', () => {
  const candidate = {
    sourceId: 'feed', title: 'New Cosmos DB article', url: 'https://example.com/new', publishedAt: '2026-09-10T00:00:00Z',
    author: null, summary: 'A practical Azure Cosmos DB guide.',
    classification: { verdict: 'include', confidence: 'high' },
  };
  const result = planCatalogPromotion({
    catalog: [catalogEntry()], retiredCatalog: [], candidateReport: { candidates: [candidate] }, auditReport: { entries: [] }, policy,
    sourcesDocument: { sources: [{ id: 'feed', catalogDefaults: { website: 'https://example.com', author: 'Publisher', tags: ['blog'] } }] },
  });
  assert.equal(result.additions.length, 1);
  assert.equal(result.catalog[0].source, candidate.url);
  assert.equal(result.catalog[0].author, 'Publisher');
  assert.deepEqual(result.catalog[0].tags, ['blog']);
});

test('retires only high-confidence classifications backed by strong deterministic evidence', () => {
  const catalog = [catalogEntry(), catalogEntry({ title: 'Old', source: 'https://example.com/old' })];
  const classifications = [
    { verdict: 'retire-proposed', confidence: 'high', evidence: 'Old but still available.', relatedUrl: null, criteria: ['age'] },
    { verdict: 'retire-proposed', confidence: 'high', evidence: 'The source is gone.', relatedUrl: 'https://example.com/new', criteria: ['broken'] },
  ];
  const result = planCatalogPromotion({
    catalog, retiredCatalog: [], candidateReport: { candidates: [] }, sourcesDocument: { sources: [] }, policy,
    auditReport: { entries: [
      { catalogIndex: 0, url: catalog[0].source, outcome: 'review', reasonCodes: ['age-review'], classification: classifications[0] },
      { catalogIndex: 1, url: catalog[1].source, outcome: 'broken', reasonCodes: ['http-404'], classification: classifications[1] },
    ] },
    now: new Date('2026-09-17T00:00:00Z'),
  });
  assert.deepEqual(result.catalog, [catalog[0]]);
  assert.equal(result.retirements.length, 1);
  assert.equal(result.retirements[0].source, catalog[1].source);
  assert.equal(result.retirements[0].retiredAt, '2026-09-17T00:00:00.000Z');
});

test('promotion is a no-op for review verdicts and already cataloged URLs', () => {
  const catalog = [catalogEntry()];
  const result = planCatalogPromotion({
    catalog, retiredCatalog: [], policy, auditReport: { entries: [] },
    sourcesDocument: { sources: [{ id: 'feed', catalogDefaults: { website: 'https://example.com', author: 'Publisher', tags: ['blog'] } }] },
    candidateReport: { candidates: [
      { sourceId: 'feed', title: 'Review', url: 'https://example.com/review', publishedAt: '2026-09-10T00:00:00Z', summary: 'Summary', classification: { verdict: 'review', confidence: 'high' } },
      { sourceId: 'feed', title: 'Duplicate', url: 'https://example.com/item/', publishedAt: '2026-09-10T00:00:00Z', summary: 'Summary', classification: { verdict: 'include', confidence: 'high' } },
    ] },
  });
  assert.deepEqual(result.catalog, catalog);
  assert.equal(result.additions.length, 0);
  assert.deepEqual(result.skippedAdditions, [{ url: 'https://example.com/item/', reason: 'already-cataloged' }]);
});

test('does not retire entries based only on duplicate findings', () => {
  const catalog = [catalogEntry()];
  const classification = { verdict: 'retire-proposed', confidence: 'high', evidence: 'Shares a source.', relatedUrl: null, criteria: ['duplicate'] };
  const result = planCatalogPromotion({
    catalog, retiredCatalog: [], candidateReport: { candidates: [] }, sourcesDocument: { sources: [] }, policy,
    auditReport: { entries: [{ catalogIndex: 0, url: catalog[0].source, outcome: 'duplicate', reasonCodes: ['duplicate'], classification }] },
  });
  assert.deepEqual(result.catalog, catalog);
  assert.equal(result.retirements.length, 0);
});

test('validates a sparse retirement candidate set with original catalog indexes', () => {
  const catalog = [catalogEntry(), catalogEntry({ source: 'https://example.com/retire' })];
  const existingEntries = [{ catalogIndex: 1, url: catalog[1].source }];
  const response = {
    newContent: [],
    existingContent: [{ catalogIndex: 1, url: catalog[1].source, verdict: 'retire-proposed', confidence: 'high', criteria: ['broken'], evidence: 'Source is gone.', relatedUrl: null }],
  };
  const result = runCopilotClassification({
    prompt: 'prompt', candidatePath: 'candidates.json', auditPath: 'audit.json', catalogPath: 'catalog.json',
    candidates: [], catalog, existingEntries, execute: () => ({ status: 0, stdout: JSON.stringify(response) }),
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.classification.existingContent[0].catalogIndex, 1);
});

test('accepts classifications returned out of input order and normalizes them by index', () => {
  const candidates = [{ url: 'https://example.com/first' }, { url: 'https://example.com/second' }];
  const classify = (candidateIndex) => ({
    candidateIndex, url: candidates[candidateIndex].url, verdict: 'review', confidence: 'low',
    criteria: ['uncertain'], evidence: 'Needs review.', relatedUrl: null,
  });
  const response = { newContent: [classify(1), classify(0)], existingContent: [] };
  const result = runCopilotClassification({
    prompt: 'prompt', candidatePath: 'candidates.json', auditPath: 'audit.json', catalogPath: 'catalog.json',
    candidates, catalog: [], execute: () => ({ status: 0, stdout: JSON.stringify(response) }),
  });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.classification.newContent.map((item) => item.candidateIndex), [0, 1]);
});

test('rejects duplicate, missing, and out-of-range candidate indexes', () => {
  const candidates = [{ url: 'https://example.com/first' }, { url: 'https://example.com/second' }];
  const classify = (candidateIndex, url = candidates[candidateIndex]?.url ?? 'https://example.com/other') => ({
    candidateIndex, url, verdict: 'review', confidence: 'low', criteria: ['uncertain'], evidence: 'Needs review.', relatedUrl: null,
  });
  for (const newContent of [[classify(0), classify(0)], [classify(0)], [classify(0), classify(2)]]) {
    const result = runCopilotClassification({
      prompt: 'prompt', candidatePath: 'candidates.json', auditPath: 'audit.json', catalogPath: 'catalog.json',
      candidates, catalog: [], execute: () => ({ status: 0, stdout: JSON.stringify({ newContent, existingContent: [] }) }),
    });
    assert.equal(result.status, 'incomplete');
  }
});

test('validates sparse existing indexes exactly once and normalizes their order', () => {
  const existingEntries = [
    { catalogIndex: 2, url: 'https://example.com/two' },
    { catalogIndex: 5, url: 'https://example.com/five' },
  ];
  const classify = (catalogIndex, url = existingEntries.find((entry) => entry.catalogIndex === catalogIndex)?.url ?? 'https://example.com/other') => ({
    catalogIndex, url, verdict: 'review', confidence: 'low', criteria: ['uncertain'], evidence: 'Needs review.', relatedUrl: null,
  });
  const accepted = runCopilotClassification({
    prompt: 'prompt', candidatePath: 'candidates.json', auditPath: 'audit.json', catalogPath: 'catalog.json',
    candidates: [], catalog: [], existingEntries,
    execute: () => ({ status: 0, stdout: JSON.stringify({ newContent: [], existingContent: [classify(5), classify(2)] }) }),
  });
  assert.equal(accepted.status, 'complete');
  assert.deepEqual(accepted.classification.existingContent.map((item) => item.catalogIndex), [2, 5]);

  for (const existingContent of [[classify(2), classify(2)], [classify(2)], [classify(2), classify(7)]]) {
    const result = runCopilotClassification({
      prompt: 'prompt', candidatePath: 'candidates.json', auditPath: 'audit.json', catalogPath: 'catalog.json',
      candidates: [], catalog: [], existingEntries,
      execute: () => ({ status: 0, stdout: JSON.stringify({ newContent: [], existingContent }) }),
    });
    assert.equal(result.status, 'incomplete');
  }
});