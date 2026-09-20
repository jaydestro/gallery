import fs from 'node:fs/promises';
import path from 'node:path';
import { urlFingerprint } from './normalize.mjs';

const STRONG_RETIREMENT_REASONS = new Set([
  'github-archived',
  'github-disabled',
  'known-retired-term',
]);

export function strongRetirementEvidence(entry) {
  return entry.outcome === 'broken'
    || entry.reasonCodes.some((reason) => STRONG_RETIREMENT_REASONS.has(reason));
}

function buildCatalogEntry(candidate, source) {
  const defaults = source.catalogDefaults;
  if (!defaults || !candidate.summary?.trim()) return null;
  const author = candidate.author?.trim() || defaults.author;
  if (!author || !defaults.website || !Array.isArray(defaults.tags) || defaults.tags.length === 0) return null;
  return {
    title: candidate.title.trim(),
    description: candidate.summary.trim(),
    preview: defaults.preview ?? 'coming soon',
    website: defaults.website,
    author,
    source: candidate.url,
    date: candidate.publishedAt.slice(0, 10),
    tags: [...defaults.tags],
  };
}

export function planCatalogPromotion({ catalog, retiredCatalog, candidateReport, auditReport, sourcesDocument, policy, now = new Date() }) {
  const sourceById = new Map(sourcesDocument.sources.map((source) => [source.id, source]));
  const knownUrls = new Set([...catalog, ...retiredCatalog].map((entry) => urlFingerprint(entry.source, policy.trackingParameters)));
  const additions = [];
  const skippedAdditions = [];

  for (const candidate of candidateReport.candidates) {
    const classification = candidate.classification;
    if (classification?.verdict !== 'include' || classification.confidence !== 'high') continue;
    const fingerprint = urlFingerprint(candidate.url, policy.trackingParameters);
    const entry = buildCatalogEntry(candidate, sourceById.get(candidate.sourceId) ?? {});
    if (knownUrls.has(fingerprint)) {
      skippedAdditions.push({ url: candidate.url, reason: 'already-cataloged' });
    } else if (!entry) {
      skippedAdditions.push({ url: candidate.url, reason: 'missing-catalog-metadata' });
    } else {
      knownUrls.add(fingerprint);
      additions.push(entry);
    }
  }

  const retirements = [];
  const retirementIndexes = new Set();
  for (const auditEntry of auditReport.entries) {
    const classification = auditEntry.classification;
    if (classification?.verdict !== 'retire-proposed' || classification.confidence !== 'high' || !strongRetirementEvidence(auditEntry)) continue;
    const original = catalog[auditEntry.catalogIndex];
    if (!original || original.source !== auditEntry.url) continue;
    retirementIndexes.add(auditEntry.catalogIndex);
    retirements.push({
      ...original,
      retiredAt: now.toISOString(),
      retirementReason: classification.evidence,
      replacementUrl: classification.relatedUrl,
      retirementEvidence: {
        auditOutcome: auditEntry.outcome,
        reasonCodes: [...auditEntry.reasonCodes],
        criteria: [...classification.criteria],
      },
    });
  }

  additions.sort((left, right) => right.date.localeCompare(left.date) || left.title.localeCompare(right.title));
  return {
    catalog: [...additions, ...catalog.filter((_, index) => !retirementIndexes.has(index))],
    retiredCatalog: [...retiredCatalog, ...retirements],
    additions,
    retirements,
    skippedAdditions,
  };
}

export function promotionMarkdown(result, generatedAt) {
  const cardDetails = (entry) => [
    `  - Description: ${entry.description?.trim() || '**MISSING**'}`,
    `  - Author: ${Array.isArray(entry.author) ? entry.author.join(', ') : (entry.author?.trim() || '**MISSING**')}`,
    `  - Date: ${entry.date?.trim() || '**MISSING**'}`,
    `  - Tags: ${entry.tags?.length ? entry.tags.join(', ') : '**MISSING**'}`,
    `  - Website: ${entry.website?.trim() || '**MISSING**'}`,
    `  - Preview: ${entry.preview?.trim() || '**MISSING**'}`,
    `  - Source: ${entry.source?.trim() || '**MISSING**'}`,
  ];
  return [
    '# Automated gallery content update', '',
    `Generated: ${generatedAt}`, '',
    'Comment with item IDs to request changes, for example: `include A1; exclude A2; keep R1`.', '',
    `Additions: ${result.additions.length}`, '',
    ...result.additions.flatMap((entry, index) => [
      `- **A${index + 1}** Add [${entry.title}](${entry.source})`,
      ...cardDetails(entry),
    ]),
    '', `Retirements: ${result.retirements.length}`, '',
    ...result.retirements.map((entry, index) => `- **R${index + 1}** Retire [${entry.title}](${entry.source}): ${entry.retirementReason}`),
    '', `Skipped high-confidence additions: ${result.skippedAdditions.length}`, '',
    ...result.skippedAdditions.map((entry, index) => `- **S${index + 1}** ${entry.url}: ${entry.reason}`),
    '', 'This pull request is generated as a draft and requires human approval before merge.', '',
  ].join('\n');
}

export async function applyCatalogPromotion({ root, now = new Date() }) {
  const readJson = async (file) => JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
  const outputDirectory = path.join(root, 'output', 'gallery-content-review');
  const [catalog, retiredCatalog, candidateReport, auditReport, metadata, sourcesDocument, policy] = await Promise.all([
    readJson('static/templates.json'),
    readJson('static/retired-templates.json'),
    readJson('output/gallery-content-review/article-candidates.json'),
    readJson('output/gallery-content-review/audit-report.json'),
    readJson('output/gallery-content-review/run-metadata.json'),
    readJson('.github/gallery-audit/sources.json'),
    readJson('.github/gallery-audit/policy.json'),
  ]);
  if (!metadata.complete || metadata.copilot?.status !== 'complete') {
    throw new Error('Promotion requires a complete deterministic scan and Copilot classification');
  }
  const result = planCatalogPromotion({ catalog, retiredCatalog, candidateReport, auditReport, sourcesDocument, policy, now });
  await Promise.all([
    fs.writeFile(path.join(root, 'static', 'templates.json'), `${JSON.stringify(result.catalog, null, 2)}\n`),
    fs.writeFile(path.join(root, 'static', 'retired-templates.json'), `${JSON.stringify(result.retiredCatalog, null, 2)}\n`),
    fs.writeFile(path.join(outputDirectory, 'promotion-result.json'), `${JSON.stringify({
      generatedAt: now.toISOString(),
      additions: result.additions,
      retirements: result.retirements,
      skippedAdditions: result.skippedAdditions,
    }, null, 2)}\n`),
    fs.writeFile(path.join(outputDirectory, 'promotion-summary.md'), promotionMarkdown(result, now.toISOString())),
  ]);
  return result;
}