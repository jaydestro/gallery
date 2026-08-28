import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  generatePortfolioReport,
  main,
  parseArguments,
  renderPortfolioMarkdown,
  runPortfolioReport,
} from "./generate-portfolio-report.mjs";

const ROOT_DIRECTORY = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE = JSON.parse(
  await readFile(new URL("./fixtures/portfolio-report/input.json", import.meta.url), "utf8"),
);

function fixtureReport({ includeDiscovery = true } = {}) {
  return generatePortfolioReport({
    catalog: structuredClone(FIXTURE.catalog),
    retired: structuredClone(FIXTURE.retired),
    health: structuredClone(FIXTURE.health),
    trustedSources: structuredClone(FIXTURE.trustedSources),
    discoveryArtifacts: includeDiscovery
      ? [{ name: "discovery.json", data: structuredClone(FIXTURE.discovery) }]
      : [],
    asOf: FIXTURE.asOf,
  });
}

function countFor(distribution, label) {
  return distribution.values.find((value) => value.label === label)?.count ?? 0;
}

test("parses read-only report options and repeatable discovery metrics", () => {
  assert.deepEqual(
    parseArguments([
      "--root", "repo",
      "--as-of", "2026-08-28",
      "--output-dir", "out",
      "--catalog", "active.json",
      "--retired", "retired.json",
      "--health", "health.json",
      "--trusted-sources", "sources.json",
      "--discovery-metrics", "one.json",
      "--discovery-metrics", "two.json",
    ]),
    {
      rootDir: "repo",
      outputDir: "out",
      asOf: "2026-08-28",
      catalogPath: "active.json",
      retiredPath: "retired.json",
      healthPath: "health.json",
      trustedSourcesPath: "sources.json",
      discoveryMetricsPaths: ["one.json", "two.json"],
      help: false,
    },
  );
  assert.throws(() => parseArguments(["--write"]), /Unknown option/);
  assert.throws(() => parseArguments(["--catalog"]), /requires a value/);
});

test("aggregates portfolio dimensions without inventing missing dates or owners", () => {
  const report = fixtureReport();

  assert.deepEqual(report.period, {
    label: "2026-Q3",
    asOf: "2026-08-28",
    quarterStart: "2026-07-01",
    quarterEnd: "2026-09-30",
  });
  assert.deepEqual(report.counts, {
    active: 4,
    retired: 1,
    totalPortfolio: 5,
    healthCovered: 3,
    healthMissing: 1,
    unresolvedFindings: 15,
    unresolvedFindingTypes: 14,
  });
  assert.equal(report.distributions.language.assignmentCount, 5);
  assert.equal(countFor(report.distributions.language, UNKNOWN_LABEL), 1);
  assert.equal(countFor(report.distributions.apiVectorDatabase, "Azure Cosmos DB for NoSQL"), 1);
  assert.equal(countFor(report.distributions.frameworkScenario, "RAG pattern"), 1);
  assert.equal(countFor(report.distributions.contentType, "Example"), 2);
  assert.equal(countFor(report.distributions.publicationAge, "1-2 years"), 1);
  assert.equal(countFor(report.distributions.publicationAge, "Future dated"), 1);
  assert.equal(countFor(report.distributions.publicationAge, UNKNOWN_LABEL), 1);
  assert.equal(countFor(report.distributions.publisherSourceOwnerKnownUnknown, "Known"), 2);
  assert.equal(countFor(report.distributions.publisherSourceOwnerKnownUnknown, UNKNOWN_LABEL), 2);
  assert.equal(countFor(report.distributions.firstPartyCommunity, "Conflicting"), 1);
  assert.equal(countFor(report.distributions.healthBand, UNKNOWN_LABEL), 1);
  assert.equal(countFor(report.distributions.lifecycle, "retired"), 1);
  assert.ok(report.unresolvedFindings.some((finding) => finding.code === "PUBLICATION_DATE_UNKNOWN"));
  assert.ok(report.unresolvedFindings.some((finding) => finding.code === "UNMATCHED_HEALTH_ENTRY"));
});

const UNKNOWN_LABEL = "Unknown";

test("includes source yield only when discovery metrics are explicitly supplied", () => {
  const withoutMetrics = fixtureReport({ includeDiscovery: false });
  assert.equal("sourceYield" in withoutMetrics, false);
  assert.equal(withoutMetrics.inputs.discoveryArtifactsSupplied, 0);

  const withMetrics = fixtureReport();
  assert.equal(withMetrics.sourceYield.artifactCount, 1);
  assert.deepEqual(
    withMetrics.sourceYield.sources.map(({ sourceId, candidates, rejected, candidateYieldPercent }) => ({
      sourceId,
      candidates,
      rejected,
      candidateYieldPercent,
    })),
    [
      { sourceId: "source-a", candidates: 4, rejected: 6, candidateYieldPercent: 40 },
      { sourceId: "source-b", candidates: 0, rejected: 2, candidateYieldPercent: 0 },
    ],
  );
  assert.equal(withMetrics.methodology.demandAndCausation, "Not assessed.");
});

test("renders byte-stable JSON data and Markdown for identical inputs", () => {
  const first = fixtureReport();
  const second = fixtureReport();
  assert.equal(JSON.stringify(first), JSON.stringify(second));

  const markdown = renderPortfolioMarkdown(first);
  assert.equal(markdown, renderPortfolioMarkdown(second));
  assert.match(markdown, /^# Gallery Portfolio Report: 2026-Q3$/m);
  assert.match(markdown, /Missing or invalid publication dates are reported as Unknown/);
  assert.match(markdown, /Demand and causation: Not assessed\./);
  assert.match(markdown, /Observed Source Yield/);
});

test("writes deterministic reports from the real v2 catalog and sidecars", async (context) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "gallery-portfolio-report-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));

  const first = await runPortfolioReport({
    rootDir: ROOT_DIRECTORY,
    outputDir,
    asOf: FIXTURE.asOf,
  });
  const firstJson = await readFile(first.jsonPath, "utf8");
  const firstMarkdown = await readFile(first.markdownPath, "utf8");
  const second = await runPortfolioReport({
    rootDir: ROOT_DIRECTORY,
    outputDir,
    asOf: FIXTURE.asOf,
  });

  assert.ok(first.report.counts.active > 0);
  assert.equal(first.report.inputs.catalogSchemaVersion, "2.0.0");
  assert.equal(first.report.counts.totalPortfolio, first.report.counts.active + first.report.counts.retired);
  assert.equal("sourceYield" in first.report, false);
  assert.equal(await readFile(second.jsonPath, "utf8"), firstJson);
  assert.equal(await readFile(second.markdownPath, "utf8"), firstMarkdown);
  assert.deepEqual(JSON.parse(firstJson), first.report);
});

test("CLI help is side-effect free and invalid report dates fail closed", async () => {
  let output = "";
  let errors = "";
  assert.equal(await main(["--help"], {
    stdout: { write: (value) => { output += value; } },
    stderr: { write: (value) => { errors += value; } },
  }), 0);
  assert.match(output, /--discovery-metrics/);
  assert.equal(errors, "");

  assert.throws(
    () => generatePortfolioReport({
      catalog: [],
      retired: { entries: [] },
      health: { entries: [] },
      trustedSources: { sources: [] },
      asOf: "2026-02-30",
    }),
    /valid calendar date/,
  );

  const sameDayReport = generatePortfolioReport({
    catalog: [{
      id: "same-day",
      publishedAt: "2026-08-28T23:59:59.000Z",
      sourceOwner: "Microsoft",
      lifecycleStatus: "active",
      tags: ["documentation", "microsoft"],
    }],
    retired: { entries: [] },
    health: { entries: [] },
    trustedSources: { sources: [] },
    asOf: "2026-08-28",
  });
  assert.equal(countFor(sameDayReport.distributions.publicationAge, "0-89 days"), 1);
  assert.equal(countFor(sameDayReport.distributions.publicationAge, "Future dated"), 0);
});