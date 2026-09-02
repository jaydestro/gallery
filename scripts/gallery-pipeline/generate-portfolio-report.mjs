import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DAY_MS = 24 * 60 * 60 * 1000;
const UNKNOWN = "Unknown";

const LANGUAGE_TAGS = Object.freeze([
  ["csharp", ".NET/C#"],
  ["go", "Go"],
  ["java", "Java"],
  ["javascript", "JavaScript"],
  ["python", "Python"],
  ["typescript", "TypeScript"],
]);

const API_VECTOR_DATABASE_TAGS = Object.freeze([
  ["vectoraisearch", "Azure AI Search"],
  ["vectorcosmosmongo", "Azure Cosmos DB for MongoDB"],
  ["vectorcosmosnosql", "Azure Cosmos DB for NoSQL"],
  ["vectorpostrgresql", "PostgreSQL"],
]);

const FRAMEWORK_SCENARIO_TAGS = Object.freeze([
  ["agent", "Agent"],
  ["architecturedesign", "Architecture/design"],
  ["analytics", "Analytics"],
  ["BCDR", "BCDR"],
  ["chat", "Interactive chat"],
  ["CQRS", "CQRS"],
  ["data-modeling", "Data modeling"],
  ["event-driven", "Event-driven"],
  ["event-sourcing", "Event sourcing"],
  ["graphrag", "Graph RAG"],
  ["infrastructure", "Infrastructure"],
  ["langchain", "LangChain"],
  ["llamaindex", "LlamaIndex"],
  ["llmops", "LLM Ops"],
  ["mcp", "MCP"],
  ["migration", "Migration"],
  ["outbox-pattern", "Outbox pattern"],
  ["promptflow", "Prompt flow"],
  ["ragPattern", "RAG pattern"],
  ["search", "Search"],
  ["semantickernel", "Semantic Kernel"],
  ["serverless", "Serverless"],
  ["springai", "Spring AI"],
  ["summarization", "Summarization"],
]);

const CONTENT_TYPE_TAGS = Object.freeze([
  ["blog", "Blog"],
  ["deck", "Presentation"],
  ["documentation", "Documentation"],
  ["example", "Example"],
  ["video", "Video"],
]);

const PUBLICATION_AGE_ORDER = Object.freeze([
  "0-89 days",
  "90-179 days",
  "180-364 days",
  "1-2 years",
  "2+ years",
  "Future dated",
  UNKNOWN,
]);

const HEALTH_BAND_ORDER = Object.freeze([
  "90-100",
  "75-89",
  "50-74",
  "0-49",
  UNKNOWN,
]);

function requireValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new TypeError(`${option} requires a value`);
  }
  return value;
}

export function parseArguments(argv = []) {
  const options = {
    rootDir: process.cwd(),
    outputDir: "portfolio-report",
    asOf: null,
    catalogPath: null,
    retiredPath: null,
    healthPath: null,
    trustedSourcesPath: null,
    discoveryMetricsPaths: [],
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    const optionNames = new Map([
      ["--root", "rootDir"],
      ["--output-dir", "outputDir"],
      ["--as-of", "asOf"],
      ["--catalog", "catalogPath"],
      ["--retired", "retiredPath"],
      ["--health", "healthPath"],
      ["--trusted-sources", "trustedSourcesPath"],
    ]);
    if (optionNames.has(argument)) {
      options[optionNames.get(argument)] = requireValue(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--discovery-metrics") {
      options.discoveryMetricsPaths.push(requireValue(argv, index, argument));
      index += 1;
      continue;
    }
    throw new TypeError(`Unknown option: ${argument}`);
  }

  return options;
}

function utcDateString(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function requireAsOf(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError("--as-of must use YYYY-MM-DD format");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError("--as-of must be a valid calendar date");
  }
  return value;
}

function quarterFor(asOf) {
  const date = new Date(`${asOf}T00:00:00.000Z`);
  const year = date.getUTCFullYear();
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  const startMonth = (quarter - 1) * 3;
  const quarterStart = new Date(Date.UTC(year, startMonth, 1)).toISOString().slice(0, 10);
  const quarterEnd = new Date(Date.UTC(year, startMonth + 3, 0)).toISOString().slice(0, 10);
  return {
    label: `${year}-Q${quarter}`,
    asOf,
    quarterStart,
    quarterEnd,
  };
}

function percentage(count, total) {
  return total === 0 ? 0 : Math.round((count * 10_000) / total) / 100;
}

function countValues(values) {
  const counts = new Map();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function orderedValues(counts, order = null) {
  const keys = [...counts.keys()];
  if (!order) return keys.sort((left, right) => left.localeCompare(right, "en-US"));
  const indexes = new Map(order.map((value, index) => [value, index]));
  return keys.sort((left, right) => (
    (indexes.get(left) ?? Number.MAX_SAFE_INTEGER) - (indexes.get(right) ?? Number.MAX_SAFE_INTEGER) ||
    left.localeCompare(right, "en-US")
  ));
}

function distribution(values, recordCount, { order = null, scope = "active-catalog" } = {}) {
  const counts = countValues(values);
  return {
    scope,
    recordCount,
    assignmentCount: values.length,
    values: orderedValues(counts, order).map((label) => ({
      label,
      count: counts.get(label),
      percentageOfRecords: percentage(counts.get(label), recordCount),
    })),
  };
}

function tagsFor(record) {
  return new Set(Array.isArray(record?.tags) ? record.tags : []);
}

function tagDistribution(records, taxonomy) {
  const values = [];
  for (const record of records) {
    const tags = tagsFor(record);
    const labels = taxonomy.filter(([tag]) => tags.has(tag)).map(([, label]) => label);
    values.push(...(labels.length > 0 ? labels : [UNKNOWN]));
  }
  return distribution(values, records.length, {
    order: [...taxonomy.map(([, label]) => label), UNKNOWN],
  });
}

function publicationDate(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(`${date.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

function publicationAge(value, asOf) {
  const published = publicationDate(value);
  if (!published) return UNKNOWN;
  const reportDate = new Date(`${asOf}T00:00:00.000Z`);
  const days = Math.floor((reportDate.getTime() - published.getTime()) / DAY_MS);
  if (days < 0) return "Future dated";
  if (days < 90) return "0-89 days";
  if (days < 180) return "90-179 days";
  if (days < 365) return "180-364 days";
  if (days < 730) return "1-2 years";
  return "2+ years";
}

function healthBand(score) {
  if (!Number.isInteger(score) || score < 0 || score > 100) return UNKNOWN;
  if (score >= 90) return "90-100";
  if (score >= 75) return "75-89";
  if (score >= 50) return "50-74";
  return "0-49";
}

function ownershipLabel(record) {
  const tags = tagsFor(record);
  const firstParty = tags.has("microsoft");
  const community = tags.has("community");
  if (firstParty && community) return "Conflicting";
  if (firstParty) return "First-party";
  if (community) return "Community";
  return UNKNOWN;
}

function sourceOwner(record) {
  return typeof record?.sourceOwner === "string" && record.sourceOwner.trim() !== ""
    ? record.sourceOwner.trim()
    : UNKNOWN;
}

function findingCollector() {
  const findings = new Map();
  return {
    add(code, { recordId = null, sourceId = null } = {}) {
      const finding = findings.get(code) ?? {
        code,
        count: 0,
        recordIds: new Set(),
        sourceIds: new Set(),
      };
      finding.count += 1;
      if (recordId) finding.recordIds.add(recordId);
      if (sourceId) finding.sourceIds.add(sourceId);
      findings.set(code, finding);
    },
    values() {
      return [...findings.values()]
        .sort((left, right) => left.code.localeCompare(right.code, "en-US"))
        .map((finding) => ({
          code: finding.code,
          count: finding.count,
          recordIds: [...finding.recordIds].sort((left, right) => left.localeCompare(right, "en-US")),
          sourceIds: [...finding.sourceIds].sort((left, right) => left.localeCompare(right, "en-US")),
        }));
    },
  };
}

function trustedSourceSummary(trustedSources) {
  const sources = Array.isArray(trustedSources?.sources) ? trustedSources.sources : [];
  return {
    registered: sources.length,
    enabled: sources.filter((source) => source.enabled === true).length,
    disabled: sources.filter((source) => source.enabled !== true).length,
    trustTier: distribution(
      sources.map((source) => source.trustTier || UNKNOWN),
      sources.length,
      { scope: "trusted-source-registry" },
    ),
    sourceType: distribution(
      sources.map((source) => source.type || UNKNOWN),
      sources.length,
      { scope: "trusted-source-registry" },
    ),
    cadence: distribution(
      sources.map((source) => source.cadence || UNKNOWN),
      sources.length,
      { scope: "trusted-source-registry" },
    ),
  };
}

function sourceYield(discoveryArtifacts, trustedSources, findings) {
  if (discoveryArtifacts.length === 0) return null;

  const registry = new Map(
    (trustedSources?.sources ?? []).map((source) => [source.id, source]),
  );
  const sources = new Map();
  const artifacts = [];

  discoveryArtifacts.forEach((artifact, artifactIndex) => {
    const sourceRows = Array.isArray(artifact?.data?.sources) ? artifact.data.sources : [];
    artifacts.push({
      artifact: artifact.name || `artifact-${artifactIndex + 1}`,
      schemaVersion: artifact?.data?.schemaVersion ?? UNKNOWN,
      status: artifact?.data?.status ?? UNKNOWN,
      sourceCount: sourceRows.length,
      candidates: sourceRows.reduce((total, source) => total + (Number(source.candidateCount) || 0), 0),
      rejected: sourceRows.reduce((total, source) => total + (Number(source.rejectedCount) || 0), 0),
    });

    for (const row of sourceRows) {
      const sourceId = row.sourceRegistryId || UNKNOWN;
      const registered = registry.get(sourceId);
      const aggregate = sources.get(sourceId) ?? {
        sourceId,
        ownerLabel: registered?.ownerLabel ?? UNKNOWN,
        trustTier: registered?.trustTier ?? UNKNOWN,
        runs: 0,
        candidates: 0,
        rejected: 0,
        statuses: [],
      };
      aggregate.runs += 1;
      aggregate.candidates += Number(row.candidateCount) || 0;
      aggregate.rejected += Number(row.rejectedCount) || 0;
      aggregate.statuses.push(row.status || UNKNOWN);
      sources.set(sourceId, aggregate);

      if (row.status !== "succeeded") {
        findings.add(`DISCOVERY_SOURCE_${String(row.status || UNKNOWN).toUpperCase().replaceAll("-", "_")}`, {
          sourceId,
        });
      }
      if (!registered) findings.add("DISCOVERY_SOURCE_NOT_REGISTERED", { sourceId });
    }
  });

  return {
    artifactCount: discoveryArtifacts.length,
    artifacts: artifacts.sort((left, right) => left.artifact.localeCompare(right.artifact, "en-US")),
    sources: [...sources.values()]
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId, "en-US"))
      .map((source) => {
        const observed = source.candidates + source.rejected;
        return {
          ...source,
          statuses: [...new Set(source.statuses)].sort((left, right) => left.localeCompare(right, "en-US")),
          observed,
          candidateYieldPercent: observed === 0 ? null : percentage(source.candidates, observed),
        };
      }),
  };
}

function assertInputs(catalog, retired, health, trustedSources, discoveryArtifacts) {
  if (!Array.isArray(catalog)) throw new TypeError("Catalog input must be a JSON array");
  if (!Array.isArray(retired?.entries)) throw new TypeError("Retired input must contain an entries array");
  if (!Array.isArray(health?.entries)) throw new TypeError("Health input must contain an entries array");
  if (!Array.isArray(trustedSources?.sources)) {
    throw new TypeError("Trusted sources input must contain a sources array");
  }
  if (!Array.isArray(discoveryArtifacts)) throw new TypeError("Discovery artifacts must be an array");
}

export function generatePortfolioReport({
  catalog,
  retired,
  health,
  trustedSources,
  discoveryArtifacts = [],
  asOf,
}) {
  assertInputs(catalog, retired, health, trustedSources, discoveryArtifacts);
  const reportDate = requireAsOf(asOf);
  const findings = findingCollector();
  const retiredRecords = retired.entries.map((entry) => entry.record).filter(Boolean);
  const retiredIds = new Set(retiredRecords.map((record) => record.id));
  const activeIds = new Set(catalog.map((record) => record.id));
  const healthById = new Map();

  for (const entry of health.entries) {
    if (healthById.has(entry.galleryId)) {
      findings.add("DUPLICATE_HEALTH_ENTRY", { recordId: entry.galleryId });
      continue;
    }
    healthById.set(entry.galleryId, entry);
    if (!activeIds.has(entry.galleryId) && !retiredIds.has(entry.galleryId)) {
      findings.add("UNMATCHED_HEALTH_ENTRY", { recordId: entry.galleryId });
    }
  }

  const ageValues = [];
  const ownerCoverageValues = [];
  const ownerValues = [];
  const ownershipValues = [];
  const healthBandValues = [];
  let healthCovered = 0;

  for (const record of catalog) {
    const recordId = record?.id ?? UNKNOWN;
    const age = publicationAge(record?.publishedAt, reportDate);
    ageValues.push(age);
    if (age === UNKNOWN) findings.add("PUBLICATION_DATE_UNKNOWN", { recordId });
    if (age === "Future dated") findings.add("PUBLICATION_DATE_IN_FUTURE", { recordId });

    const owner = sourceOwner(record);
    ownerValues.push(owner);
    ownerCoverageValues.push(owner === UNKNOWN ? UNKNOWN : "Known");
    if (owner === UNKNOWN) findings.add("SOURCE_OWNER_UNKNOWN", { recordId });

    const ownership = ownershipLabel(record);
    ownershipValues.push(ownership);
    if (ownership === UNKNOWN) findings.add("OWNERSHIP_TAG_UNKNOWN", { recordId });
    if (ownership === "Conflicting") findings.add("OWNERSHIP_TAG_CONFLICT", { recordId });

    if (record?.lifecycleStatus !== "active") {
      findings.add(`LIFECYCLE_${String(record?.lifecycleStatus || UNKNOWN).toUpperCase().replaceAll("-", "_")}`, {
        recordId,
      });
    }

    const healthEntry = healthById.get(record?.id);
    if (!healthEntry) {
      healthBandValues.push(UNKNOWN);
      findings.add("HEALTH_ENTRY_MISSING", { recordId });
      continue;
    }
    healthCovered += 1;
    healthBandValues.push(healthBand(healthEntry.healthScore));
    if (healthEntry.status !== "healthy") {
      findings.add(`HEALTH_STATUS_${String(healthEntry.status || UNKNOWN).toUpperCase().replaceAll("-", "_")}`, {
        recordId,
      });
    }
    for (const reason of healthEntry.healthReasons ?? []) {
      findings.add(`HEALTH_REASON_${reason}`, { recordId });
    }
  }

  const lifecycleValues = [
    ...catalog.map((record) => record?.lifecycleStatus || UNKNOWN),
    ...retiredRecords.map(() => "retired"),
  ];
  const yieldReport = sourceYield(discoveryArtifacts, trustedSources, findings);
  const unresolvedFindings = findings.values();

  return {
    schemaVersion: "1.0.0",
    reportType: "quarterly-gallery-portfolio",
    generatedAt: `${reportDate}T00:00:00.000Z`,
    period: quarterFor(reportDate),
    methodology: {
      taxonomyScope: "Language, API/vector database, framework/scenario, and content type count active-catalog tag assignments; records without a matching tag count as Unknown.",
      lifecycleScope: "Lifecycle counts active-catalog records plus retained retirement-ledger records.",
      missingDates: "Missing or invalid publication dates are reported as Unknown; no dates are inferred.",
      sourceYield: "Source yield is an observed candidate share from explicitly supplied discovery artifacts, not a measure of demand, quality, or causation.",
      demandAndCausation: "Not assessed.",
    },
    inputs: {
      catalogSchemaVersion: "2.0.0",
      retiredVersion: retired.version ?? UNKNOWN,
      healthVersion: health.version ?? UNKNOWN,
      trustedSourcesVersion: trustedSources.version ?? UNKNOWN,
      discoveryArtifactsSupplied: discoveryArtifacts.length,
    },
    counts: {
      active: catalog.length,
      retired: retiredRecords.length,
      totalPortfolio: catalog.length + retiredRecords.length,
      healthCovered,
      healthMissing: catalog.length - healthCovered,
      unresolvedFindings: unresolvedFindings.reduce((total, finding) => total + finding.count, 0),
      unresolvedFindingTypes: unresolvedFindings.length,
    },
    distributions: {
      language: tagDistribution(catalog, LANGUAGE_TAGS),
      apiVectorDatabase: tagDistribution(catalog, API_VECTOR_DATABASE_TAGS),
      frameworkScenario: tagDistribution(catalog, FRAMEWORK_SCENARIO_TAGS),
      contentType: tagDistribution(catalog, CONTENT_TYPE_TAGS),
      publicationAge: distribution(ageValues, catalog.length, { order: PUBLICATION_AGE_ORDER }),
      publisherSourceOwnerKnownUnknown: distribution(ownerCoverageValues, catalog.length, {
        order: ["Known", UNKNOWN],
      }),
      publisherSourceOwner: distribution(ownerValues, catalog.length),
      firstPartyCommunity: distribution(ownershipValues, catalog.length, {
        order: ["First-party", "Community", "Conflicting", UNKNOWN],
      }),
      healthBand: distribution(healthBandValues, catalog.length, { order: HEALTH_BAND_ORDER }),
      lifecycle: distribution(lifecycleValues, catalog.length + retiredRecords.length, {
        order: ["active", "needs-review", "quarantined", "retired", UNKNOWN],
        scope: "active-catalog-and-retirement-ledger",
      }),
    },
    trustedSources: trustedSourceSummary(trustedSources),
    unresolvedFindings,
    ...(yieldReport ? { sourceYield: yieldReport } : {}),
  };
}

function markdownCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\r", " ").replaceAll("\n", " ");
}

function distributionMarkdown(title, report) {
  const lines = [
    `### ${title}`,
    "",
    `Scope: ${report.scope}; ${report.assignmentCount} assignments across ${report.recordCount} records.`,
    "",
    "| Value | Count | Percent of records |",
    "| --- | ---: | ---: |",
  ];
  for (const value of report.values) {
    lines.push(`| ${markdownCell(value.label)} | ${value.count} | ${value.percentageOfRecords.toFixed(2)}% |`);
  }
  return lines.join("\n");
}

export function renderPortfolioMarkdown(report) {
  const lines = [
    `# Gallery Portfolio Report: ${report.period.label}`,
    "",
    `As of ${report.period.asOf}. Quarter: ${report.period.quarterStart} through ${report.period.quarterEnd}.`,
    "",
    "## Summary",
    "",
    "| Measure | Count |",
    "| --- | ---: |",
    `| Active catalog | ${report.counts.active} |`,
    `| Retired ledger | ${report.counts.retired} |`,
    `| Total portfolio | ${report.counts.totalPortfolio} |`,
    `| Active records with health data | ${report.counts.healthCovered} |`,
    `| Active records without health data | ${report.counts.healthMissing} |`,
    `| Unresolved finding instances | ${report.counts.unresolvedFindings} |`,
    "",
    "## Portfolio Distributions",
    "",
    distributionMarkdown("Language", report.distributions.language),
    "",
    distributionMarkdown("API / Vector Database", report.distributions.apiVectorDatabase),
    "",
    distributionMarkdown("Framework / Scenario", report.distributions.frameworkScenario),
    "",
    distributionMarkdown("Content Type", report.distributions.contentType),
    "",
    distributionMarkdown("Publication Age", report.distributions.publicationAge),
    "",
    distributionMarkdown("Publisher / Source Owner Coverage", report.distributions.publisherSourceOwnerKnownUnknown),
    "",
    distributionMarkdown("Publisher / Source Owner", report.distributions.publisherSourceOwner),
    "",
    distributionMarkdown("First-party / Community Tags", report.distributions.firstPartyCommunity),
    "",
    distributionMarkdown("Health Band", report.distributions.healthBand),
    "",
    distributionMarkdown("Lifecycle", report.distributions.lifecycle),
    "",
    "## Trusted Source Registry",
    "",
    `Registered: ${report.trustedSources.registered}; enabled: ${report.trustedSources.enabled}; disabled: ${report.trustedSources.disabled}.`,
    "",
    distributionMarkdown("Trust Tier", report.trustedSources.trustTier),
    "",
    distributionMarkdown("Registered Source Type", report.trustedSources.sourceType),
    "",
    distributionMarkdown("Registered Cadence", report.trustedSources.cadence),
    "",
    "## Unresolved Findings",
    "",
  ];

  if (report.unresolvedFindings.length === 0) {
    lines.push("No unresolved findings.");
  } else {
    lines.push("Detailed affected record and source IDs are available in the JSON report.", "");
    lines.push("| Finding | Count |", "| --- | ---: |");
    for (const finding of report.unresolvedFindings) {
      lines.push(`| ${markdownCell(finding.code)} | ${finding.count} |`);
    }
  }

  if (report.sourceYield) {
    lines.push(
      "",
      "## Observed Source Yield",
      "",
      "Yield uses only explicitly supplied discovery artifacts. It does not measure demand, quality, or causation.",
      "",
      "| Source | Owner | Trust tier | Runs | Candidates | Rejected | Observed | Candidate yield | Statuses |",
      "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
    );
    for (const source of report.sourceYield.sources) {
      const yieldValue = source.candidateYieldPercent === null
        ? UNKNOWN
        : `${source.candidateYieldPercent.toFixed(2)}%`;
      lines.push(
        `| ${markdownCell(source.sourceId)} | ${markdownCell(source.ownerLabel)} | ${markdownCell(source.trustTier)} | ${source.runs} | ${source.candidates} | ${source.rejected} | ${source.observed} | ${yieldValue} | ${markdownCell(source.statuses.join(", "))} |`,
      );
    }
  }

  lines.push(
    "",
    "## Methodology",
    "",
    `- ${report.methodology.taxonomyScope}`,
    `- ${report.methodology.lifecycleScope}`,
    `- ${report.methodology.missingDates}`,
    `- Demand and causation: ${report.methodology.demandAndCausation}`,
    "",
  );
  return lines.join("\n");
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new TypeError(`Could not read ${label} at ${filePath}: ${error.message}`);
  }
}

function resolveFromRoot(rootDir, suppliedPath, defaultPath) {
  const value = suppliedPath ?? defaultPath;
  return path.isAbsolute(value) ? value : path.resolve(rootDir, value);
}

export async function runPortfolioReport(options = {}, { now = new Date() } = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const asOf = requireAsOf(options.asOf ?? utcDateString(now));
  const inputPaths = {
    catalog: resolveFromRoot(rootDir, options.catalogPath, path.join("static", "templates.json")),
    retired: resolveFromRoot(rootDir, options.retiredPath, path.join("static", "retired-templates.json")),
    health: resolveFromRoot(rootDir, options.healthPath, path.join("static", "gallery-health.json")),
    trustedSources: resolveFromRoot(
      rootDir,
      options.trustedSourcesPath,
      path.join(".github", "gallery-pipeline", "trusted-sources.json"),
    ),
  };
  const discoveryPaths = [...(options.discoveryMetricsPaths ?? [])]
    .map((value) => resolveFromRoot(rootDir, value, value))
    .sort((left, right) => left.localeCompare(right, "en-US"));

  const [catalog, retired, health, trustedSources, discoveryData] = await Promise.all([
    readJson(inputPaths.catalog, "catalog"),
    readJson(inputPaths.retired, "retired ledger"),
    readJson(inputPaths.health, "health snapshot"),
    readJson(inputPaths.trustedSources, "trusted source registry"),
    Promise.all(discoveryPaths.map(async (filePath) => ({
      name: path.basename(filePath),
      data: await readJson(filePath, "discovery metrics"),
    }))),
  ]);
  const report = generatePortfolioReport({
    catalog,
    retired,
    health,
    trustedSources,
    discoveryArtifacts: discoveryData,
    asOf,
  });
  const markdown = renderPortfolioMarkdown(report);
  const outputDir = resolveFromRoot(rootDir, options.outputDir, "portfolio-report");
  const jsonPath = path.join(outputDir, "portfolio-report.json");
  const markdownPath = path.join(outputDir, "portfolio-report.md");
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(markdownPath, markdown, "utf8"),
  ]);
  return { report, markdown, jsonPath, markdownPath };
}

function usage() {
  return [
    "Usage: node scripts/gallery-pipeline/generate-portfolio-report.mjs [options]",
    "",
    "Options:",
    "  --as-of YYYY-MM-DD             Reporting date (defaults to current UTC date)",
    "  --output-dir PATH              Output directory (default: portfolio-report)",
    "  --root PATH                    Repository root (default: current directory)",
    "  --catalog PATH                 Override active v2 catalog input",
    "  --retired PATH                 Override retired ledger input",
    "  --health PATH                  Override health snapshot input",
    "  --trusted-sources PATH         Override trusted source registry input",
    "  --discovery-metrics PATH       Add an explicit discovery artifact; repeatable",
    "  --help                         Show this help",
    "",
  ].join("\n");
}

export async function main(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, now = new Date() } = {},
) {
  try {
    const options = parseArguments(argv);
    if (options.help) {
      stdout.write(usage());
      return 0;
    }
    const result = await runPortfolioReport(options, { now });
    stdout.write(`Generated ${result.jsonPath}\nGenerated ${result.markdownPath}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error?.message ?? error}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}