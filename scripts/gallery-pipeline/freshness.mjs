import { canonicalizeUrl } from "./shared/canonicalize.mjs";

export const FRESHNESS_COMPONENT_MAXIMUMS = Object.freeze({
  availabilityIntegrity: 25,
  maintenanceFreshness: 25,
  sampleUsability: 20,
  productRelevance: 20,
  galleryValue: 10,
});

const DAY_MS = 24 * 60 * 60 * 1000;
const DEPENDENCY_FILE_PATTERN = /(?:^|\/)(?:package(?:-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|.*\.(?:csproj|fsproj|vbproj)|packages\.lock\.json|pom\.xml|build\.gradle(?:\.kts)?|gradle\.properties|requirements(?:-[^/]*)?\.txt|poetry\.lock|pyproject\.toml|go\.(?:mod|sum)|cargo\.(?:toml|lock))$/i;
const DEPENDENCY_MESSAGE_PATTERN = /\b(?:bump|dependabot|dependencies?|renovate|update\s+(?:package|module|library|libraries))\b/i;
const BOT_LOGIN_PATTERN = /(?:\[bot\]|-bot|_bot)$/i;
const COSMOS_PATTERN = /\b(?:azure\s+)?cosmos\s*db\b|\bcosmosdb\b|\bazure-cosmos\b|\bMicrosoft\.Azure\.Cosmos\b|\b@azure\/cosmos\b|\bcom\.azure:azure-cosmos\b/i;
const INACTIVITY_REASONS = new Set([
  "BOT_OR_DEPENDENCY_ONLY_ACTIVITY",
  "MEANINGFUL_ACTIVITY_OVER_365_DAYS",
  "MEANINGFUL_ACTIVITY_OVER_730_DAYS",
  "NO_MEANINGFUL_COMMIT_EVIDENCE",
]);

function asDate(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function isoDate(value) {
  return asDate(value)?.toISOString() ?? null;
}

function ageInDays(value, now) {
  const date = asDate(value);
  return date ? Math.max(0, Math.floor((now.getTime() - date.getTime()) / DAY_MS)) : null;
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object ?? {}, key);
}

function signalValue(signals, key, derived) {
  return typeof signals?.[key] === "boolean" ? signals[key] : derived;
}

function scoreSignal(value, points, unknownPoints = Math.floor(points / 2)) {
  if (value === true) return points;
  if (value === false) return 0;
  return unknownPoints;
}

function addNegativeReason(reasons, value, reason) {
  if (value === false) reasons.add(reason);
}

function canonicalSourceForRecord(record) {
  const source = record?.canonicalSource ?? record?.source ?? record?.website;
  return canonicalizeUrl(source);
}

export function repositoryCoordinates(value) {
  const canonicalSource = canonicalizeUrl(value);
  const url = new URL(canonicalSource);
  if (url.hostname !== "github.com") return null;
  const [owner, repository] = url.pathname.split("/").filter(Boolean);
  if (!owner || !repository) return null;
  return {
    owner,
    repository,
    fullName: `${owner}/${repository}`,
    repositoryUrl: `https://github.com/${owner}/${repository}`,
    linkedPath: url.pathname.split("/").filter(Boolean).slice(2).join("/") || null,
  };
}

export function isGitHubBackedRecord(record) {
  if (record?.sourceType === "github-repository" || record?.sourceType === "github-path") {
    return true;
  }
  try {
    return repositoryCoordinates(record?.canonicalSource ?? record?.source ?? record?.website) !== null;
  } catch {
    return false;
  }
}

function commitDate(commit) {
  return isoDate(
    commit?.committedAt ??
    commit?.commit?.author?.date ??
    commit?.commit?.committer?.date ??
    commit?.author?.date ??
    commit?.committer?.date,
  );
}

function commitLogin(commit) {
  return String(
    commit?.author?.login ??
    commit?.committer?.login ??
    commit?.actor?.login ??
    "",
  );
}

function isBotCommit(commit) {
  return (
    commit?.author?.type === "Bot" ||
    commit?.committer?.type === "Bot" ||
    commit?.actor?.type === "Bot" ||
    BOT_LOGIN_PATTERN.test(commitLogin(commit))
  );
}

function isDependencyOnlyCommit(commit) {
  if (commit?.dependencyOnly === true) return true;
  const files = Array.isArray(commit?.files) ? commit.files : [];
  if (files.length > 0) {
    return files.every((file) => DEPENDENCY_FILE_PATTERN.test(String(file?.filename ?? file?.path ?? file)));
  }
  const message = String(commit?.commit?.message ?? commit?.message ?? "");
  return DEPENDENCY_MESSAGE_PATTERN.test(message);
}

export function findLastMeaningfulChange(metadata) {
  const repository = metadata?.repository ?? metadata ?? {};
  const commitsSupplied = own(metadata, "commits") || own(repository, "commits");
  const commits = metadata?.commits ?? repository?.commits ?? [];
  if (commitsSupplied) {
    const meaningfulDates = commits
      .filter((commit) => !isBotCommit(commit) && !isDependencyOnlyCommit(commit))
      .map(commitDate)
      .filter(Boolean)
      .sort();
    return {
      commitsSupplied: true,
      excludedCommitCount: commits.length - meaningfulDates.length,
      lastMeaningfulChange: meaningfulDates.at(-1) ?? null,
    };
  }
  return {
    commitsSupplied: false,
    excludedCommitCount: 0,
    lastMeaningfulChange: isoDate(repository.pushed_at ?? repository.updated_at),
  };
}

function latestDate(items, selectors) {
  return (Array.isArray(items) ? items : [])
    .flatMap((item) => selectors.map((selector) => isoDate(selector(item))))
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
}

function scoreAvailability(record, metadata, reasons) {
  const repository = metadata?.repository ?? metadata ?? {};
  const signals = metadata?.signals ?? repository?.signals ?? {};
  const coordinates = repositoryCoordinates(canonicalSourceForRecord(record));
  const deleted = (
    repository.deleted === true ||
    metadata?.availability === "deleted" ||
    (metadata?.status === 404 && metadata?.authoritative === true)
  );
  const archived = repository.archived === true;
  const disabled = repository.disabled === true;
  const privateRepository = repository.private === true;

  if (deleted) reasons.add("REPOSITORY_DELETED");
  if (archived) reasons.add("REPOSITORY_ARCHIVED");
  if (disabled) reasons.add("REPOSITORY_DISABLED");
  if (privateRepository) reasons.add("REPOSITORY_PRIVATE");

  if (deleted || archived || disabled) {
    return { score: 0, authoritative: true, deleted, archived, disabled, privateRepository };
  }

  const repositoryAvailable = metadata?.indeterminate !== true && metadata?.errorCode === undefined;
  const active = repositoryAvailable && !privateRepository;
  const defaultBranchPresent = typeof repository.default_branch === "string" && repository.default_branch.trim() !== "";
  const defaultBranchExists = signalValue(signals, "defaultBranchExists", defaultBranchPresent || undefined);
  const linkedPathExists = coordinates?.linkedPath
    ? signalValue(signals, "linkedPathExists", metadata?.linkedPathExists)
    : true;

  if (!repositoryAvailable) reasons.add("REPOSITORY_AVAILABILITY_INDETERMINATE");
  addNegativeReason(reasons, defaultBranchExists, "DEFAULT_BRANCH_MISSING");
  addNegativeReason(reasons, linkedPathExists, "LINKED_PATH_MISSING");

  const score =
    scoreSignal(repositoryAvailable, 10, 0) +
    scoreSignal(active, 6, 0) +
    scoreSignal(defaultBranchPresent, 3, 0) +
    scoreSignal(defaultBranchExists, 3) +
    scoreSignal(linkedPathExists, 3);
  return { score, authoritative: false, deleted, archived, disabled, privateRepository };
}

function scoreMaintenance(metadata, policy, now, reasons) {
  const repository = metadata?.repository ?? metadata ?? {};
  const signals = metadata?.signals ?? repository?.signals ?? {};
  const activity = findLastMeaningfulChange(metadata);
  const meaningfulAge = ageInDays(activity.lastMeaningfulChange, now);
  let meaningfulScore = 0;
  if (meaningfulAge !== null && meaningfulAge <= policy.freshness.reviewAfterDays) {
    meaningfulScore = 15;
  } else if (meaningfulAge !== null && meaningfulAge <= policy.freshness.highSeverityAfterDays) {
    meaningfulScore = 8;
    reasons.add("MEANINGFUL_ACTIVITY_OVER_365_DAYS");
  } else if (meaningfulAge !== null) {
    reasons.add("MEANINGFUL_ACTIVITY_OVER_730_DAYS");
  } else {
    reasons.add("NO_MEANINGFUL_COMMIT_EVIDENCE");
  }
  if (activity.commitsSupplied && activity.excludedCommitCount > 0) {
    reasons.add("BOT_OR_DEPENDENCY_ONLY_ACTIVITY");
  }

  const releasesSupplied = own(metadata, "releases") || own(repository, "releases");
  const releases = metadata?.releases ?? repository?.releases ?? [];
  const latestRelease = latestDate(releases, [
    (release) => release?.published_at,
    (release) => release?.created_at,
  ]);
  const releaseAge = ageInDays(latestRelease, now);
  let releaseScore = 1;
  if (releasesSupplied && releases.length === 0) releaseScore = 2;
  else if (releaseAge !== null && releaseAge <= policy.freshness.reviewAfterDays) releaseScore = 3;
  else if (releaseAge !== null && releaseAge <= policy.freshness.highSeverityAfterDays) releaseScore = 2;
  else if (releaseAge !== null) releaseScore = 1;

  const interactionsSupplied = own(metadata, "issues") || own(metadata, "pulls");
  const interactions = [...(metadata?.issues ?? []), ...(metadata?.pulls ?? [])];
  const humanInteractions = interactions.filter((item) => item?.user?.type !== "Bot" && !BOT_LOGIN_PATTERN.test(String(item?.user?.login ?? "")));
  const latestInteraction = latestDate(humanInteractions, [
    (item) => item?.updated_at,
    (item) => item?.closed_at,
    (item) => item?.created_at,
  ]);
  const interactionAge = ageInDays(latestInteraction, now);
  const interactionScore = interactionsSupplied
    ? (humanInteractions.length === 0 || (interactionAge !== null && interactionAge <= policy.freshness.reviewAfterDays) ? 2 : 0)
    : 1;

  const supportedRuntime = signalValue(signals, "supportedRuntime");
  const supportedDependencies = signalValue(signals, "supportedDependencies");
  addNegativeReason(reasons, supportedRuntime, "UNSUPPORTED_RUNTIME");
  addNegativeReason(reasons, supportedDependencies, "UNSUPPORTED_DEPENDENCIES");

  return {
    score:
      meaningfulScore +
      releaseScore +
      interactionScore +
      scoreSignal(supportedRuntime, 3, 1) +
      scoreSignal(supportedDependencies, 2, 1),
    activity,
  };
}

function readmeText(metadata) {
  const readme = metadata?.readme ?? metadata?.repository?.readme;
  if (typeof readme === "string") return readme;
  if (typeof readme?.content === "string") return readme.content;
  return "";
}

function scoreUsability(metadata, reasons) {
  const repository = metadata?.repository ?? metadata ?? {};
  const signals = metadata?.signals ?? repository?.signals ?? {};
  const readme = readmeText(metadata);
  const readmeKnown = own(metadata, "readme") || own(repository, "readme");
  const hasReadme = signalValue(signals, "readmePresent", readmeKnown ? readme.length > 0 : undefined);
  const prerequisites = signalValue(signals, "prerequisitesPresent", readme ? /\bprerequisites?\b|\brequirements?\b/i.test(readme) : undefined);
  const setup = signalValue(signals, "setupPresent", readme ? /\b(?:getting started|installation|setup|quickstart|run locally)\b/i.test(readme) : undefined);
  const cleanup = signalValue(signals, "cleanupPresent", readme ? /\b(?:clean up|cleanup|tear down|teardown|destroy)\b/i.test(readme) : undefined);
  const license = signalValue(signals, "licensePresent", repository.license !== undefined ? Boolean(repository.license) : undefined);
  const reproducible = signalValue(signals, "reproducible");

  addNegativeReason(reasons, hasReadme, "README_MISSING");
  addNegativeReason(reasons, prerequisites, "PREREQUISITES_MISSING");
  addNegativeReason(reasons, setup, "SETUP_GUIDANCE_MISSING");
  addNegativeReason(reasons, cleanup, "CLEANUP_GUIDANCE_MISSING");
  addNegativeReason(reasons, license, "LICENSE_MISSING");
  addNegativeReason(reasons, reproducible, "REPRODUCIBILITY_NOT_DEMONSTRATED");

  return (
    scoreSignal(hasReadme, 4) +
    scoreSignal(prerequisites, 3, 1) +
    scoreSignal(setup, 5, 2) +
    scoreSignal(cleanup, 2, 1) +
    scoreSignal(license, 2, 1) +
    scoreSignal(reproducible, 4, 2)
  );
}

function scoreRelevance(record, metadata, reasons) {
  const repository = metadata?.repository ?? metadata ?? {};
  const signals = metadata?.signals ?? repository?.signals ?? {};
  const relevanceText = [
    record?.title,
    record?.description,
    record?.summary,
    ...(record?.tags ?? []),
    repository?.description,
    ...(repository?.topics ?? []),
    readmeText(metadata),
  ].filter(Boolean).join("\n");
  const cosmosMaterial = signalValue(signals, "cosmosDbMaterial", COSMOS_PATTERN.test(relevanceText));
  const currentProduct = signalValue(signals, "currentProductFeature");
  const supportedDependencies = signalValue(signals, "supportedDependencies");
  const currentGuidance = signalValue(signals, "currentAuthAndDeploymentGuidance");

  addNegativeReason(reasons, cosmosMaterial, "COSMOS_DB_NOT_MATERIAL");
  addNegativeReason(reasons, currentProduct, "PRODUCT_FEATURE_OUTDATED");
  addNegativeReason(reasons, currentGuidance, "AUTH_OR_DEPLOYMENT_GUIDANCE_OUTDATED");

  return (
    scoreSignal(cosmosMaterial, 8, 0) +
    scoreSignal(currentProduct, 5, 3) +
    scoreSignal(supportedDependencies, 3, 1) +
    scoreSignal(currentGuidance, 4, 2)
  );
}

function scoreGalleryValue(metadata, reasons) {
  const signals = metadata?.signals ?? metadata?.repository?.signals ?? {};
  const uniqueCoverage = signalValue(signals, "uniqueCoverage");
  const audienceDemand = signalValue(signals, "audienceDemand");
  const strategicPriority = signalValue(signals, "strategicPriority");
  const noBetterReplacement = signalValue(signals, "noBetterReplacement");

  addNegativeReason(reasons, uniqueCoverage, "DUPLICATE_OR_REPLACED_COVERAGE");
  addNegativeReason(reasons, noBetterReplacement, "BETTER_REPLACEMENT_AVAILABLE");

  return (
    scoreSignal(uniqueCoverage, 4, 2) +
    scoreSignal(audienceDemand, 2, 1) +
    scoreSignal(strategicPriority, 2, 1) +
    scoreSignal(noBetterReplacement, 2, 1)
  );
}

export function classifyFreshnessScore(score, policy) {
  if (!Number.isInteger(score) || score < 0 || score > 100) {
    throw new RangeError("Freshness score must be an integer from 0 through 100");
  }
  if (score >= policy.healthThresholds.healthyMinimum) return "healthy";
  if (score >= policy.healthThresholds.needsReviewMinimum) return "needs-review";
  if (score >= policy.healthThresholds.quarantineMinimum) return "quarantine";
  return "retire";
}

function currentEntryFor(record, canonicalSource, currentHealth) {
  const galleryId = record?.id ?? record?.title ?? canonicalSource;
  return (currentHealth?.entries ?? []).find((entry) => {
    if (entry.galleryId === galleryId) return true;
    try {
      return canonicalizeUrl(entry.canonicalSource) === canonicalSource;
    } catch {
      return false;
    }
  }) ?? null;
}

function findingsContinue(current, adverseReasons) {
  if (!current || current.status === "healthy" || current.status === "indeterminate") return false;
  const previousReasons = new Set(current.healthReasons ?? []);
  return adverseReasons.some((reason) => previousReasons.has(reason));
}

function graceElapsed(startedAt, policy, now) {
  const started = asDate(startedAt);
  return started !== null && now.getTime() - started.getTime() >= policy.lifecycle.retirementGraceDays * DAY_MS;
}

function lifecycleDecision({ band, authoritative, adverseReasons, indeterminate, current, policy, now }) {
  if (indeterminate) {
    return {
      status: "indeterminate",
      recommendation: "no-action",
      consecutiveFindings: current?.consecutiveFindings ?? 0,
      gracePeriodStartedAt: current?.gracePeriodStartedAt ?? null,
    };
  }

  if (adverseReasons.length === 0 && band === "healthy") {
    return { status: "healthy", recommendation: "keep", consecutiveFindings: 0, gracePeriodStartedAt: null };
  }

  const continuing = findingsContinue(current, adverseReasons);
  const consecutiveFindings = (continuing ? current.consecutiveFindings : 0) + 1;
  const inactivityOnly = adverseReasons.length > 0 && adverseReasons.every((reason) => INACTIVITY_REASONS.has(reason));
  if (inactivityOnly) {
    return {
      status: "needs-review",
      recommendation: "keep-visible",
      consecutiveFindings,
      gracePeriodStartedAt: current?.gracePeriodStartedAt ?? null,
    };
  }

  const retirementCandidate = authoritative || band === "retire";
  const gracePeriodStartedAt = retirementCandidate
    ? (continuing && current?.gracePeriodStartedAt ? current.gracePeriodStartedAt : now.toISOString())
    : null;
  const confirmed = consecutiveFindings >= policy.lifecycle.requiredConfirmations;
  if (retirementCandidate && confirmed && graceElapsed(gracePeriodStartedAt, policy, now)) {
    return { status: "retired", recommendation: "retire", consecutiveFindings, gracePeriodStartedAt };
  }
  if (authoritative || (confirmed && (band === "quarantine" || band === "retire"))) {
    return { status: "quarantined", recommendation: "quarantine", consecutiveFindings, gracePeriodStartedAt };
  }
  return {
    status: band === "healthy" ? "healthy" : "needs-review",
    recommendation: band === "healthy" ? "keep" : "keep-visible",
    consecutiveFindings,
    gracePeriodStartedAt,
  };
}

function healthEvidence(canonicalSource, evaluatedAt, components, metadata) {
  const evidence = Object.entries(components).map(([name, score]) => ({
    kind: "component-score",
    observedAt: evaluatedAt,
    source: canonicalSource,
    value: `${name}:${score}/${FRESHNESS_COMPONENT_MAXIMUMS[name]}`,
  }));
  if (metadata?.errorCode) {
    evidence.push({
      kind: "evaluation-error",
      observedAt: evaluatedAt,
      source: canonicalSource,
      value: metadata.errorCode,
    });
  }
  return evidence;
}

export function evaluateRepositoryFreshness(record, metadata, { policy, health, evaluatedAt } = {}) {
  if (!policy?.healthThresholds || !policy?.lifecycle || !policy?.freshness) {
    throw new TypeError("Freshness evaluation requires policy health, lifecycle, and freshness thresholds");
  }
  const now = asDate(evaluatedAt ?? new Date().toISOString());
  if (!now) throw new TypeError("evaluatedAt must be a valid date-time");
  const checkedAt = now.toISOString();
  const canonicalSource = canonicalSourceForRecord(record);
  const galleryId = record?.id ?? record?.title ?? canonicalSource;
  const current = currentEntryFor(record, canonicalSource, health);
  const reasons = new Set();
  const availability = scoreAvailability(record, metadata ?? {}, reasons);
  const maintenance = scoreMaintenance(metadata ?? {}, policy, now, reasons);
  const components = {
    availabilityIntegrity: availability.score,
    maintenanceFreshness: maintenance.score,
    sampleUsability: scoreUsability(metadata ?? {}, reasons),
    productRelevance: scoreRelevance(record, metadata ?? {}, reasons),
    galleryValue: scoreGalleryValue(metadata ?? {}, reasons),
  };
  const healthScore = Object.values(components).reduce((sum, score) => sum + score, 0);
  const band = classifyFreshnessScore(healthScore, policy);
  const indeterminate = (
    metadata == null ||
    metadata.indeterminate === true ||
    metadata.partial === true ||
    metadata.complete === false ||
    metadata.errorCode !== undefined
  );
  if (indeterminate) reasons.add("FRESHNESS_EVALUATION_INDETERMINATE");
  const adverseReasons = [...reasons].filter((reason) => (
    reason !== "REPOSITORY_AVAILABILITY_INDETERMINATE" &&
    reason !== "FRESHNESS_EVALUATION_INDETERMINATE"
  ));
  const lifecycle = lifecycleDecision({
    band,
    authoritative: availability.authoritative,
    adverseReasons,
    indeterminate,
    current,
    policy,
    now,
  });
  const sourceState = {
    availability: indeterminate ? "indeterminate" : (availability.deleted ? "broken" : "available"),
    archived: availability.archived,
    disabled: availability.disabled,
    lastMeaningfulChange: maintenance.activity.lastMeaningfulChange,
  };
  const healthEntry = {
    galleryId,
    canonicalSource,
    checkedAt,
    status: lifecycle.status,
    healthScore,
    components,
    healthReasons: [...reasons].sort(),
    consecutiveFindings: lifecycle.consecutiveFindings,
    gracePeriodStartedAt: lifecycle.gracePeriodStartedAt,
    sourceState,
    evidence: healthEvidence(canonicalSource, checkedAt, components, metadata),
  };
  return {
    galleryId,
    canonicalSource,
    applicability: "applicable",
    scoreBand: band,
    recommendation: lifecycle.recommendation,
    mutation: "none",
    health: healthEntry,
  };
}

function metadataEntries(githubMetadata) {
  if (githubMetadata instanceof Map) return [...githubMetadata.entries()];
  if (Array.isArray(githubMetadata)) return githubMetadata.map((entry) => [null, entry]);
  if (Array.isArray(githubMetadata?.repositories)) {
    return githubMetadata.repositories.map((entry) => [null, entry]);
  }
  return Object.entries(githubMetadata ?? {});
}

function metadataForRecord(record, githubMetadata) {
  const canonicalSource = canonicalSourceForRecord(record);
  const coordinates = repositoryCoordinates(canonicalSource);
  const targetFullName = coordinates.fullName.toLowerCase();
  const targetRepositoryUrl = coordinates.repositoryUrl.toLowerCase();
  for (const [key, metadata] of metadataEntries(githubMetadata)) {
    const repository = metadata?.repository ?? metadata ?? {};
    const candidates = [
      key,
      repository.full_name,
      repository.html_url,
      metadata?.canonicalSource,
    ].filter(Boolean).map((value) => String(value).toLowerCase());
    if (candidates.includes(targetFullName) || candidates.includes(targetRepositoryUrl) || candidates.includes(canonicalSource.toLowerCase())) {
      return metadata;
    }
  }
  return null;
}

export function evaluateCatalogFreshness(records, { githubMetadata, policy, health, evaluatedAt } = {}) {
  if (!Array.isArray(records)) throw new TypeError("records must be an array");
  const checkedAt = isoDate(evaluatedAt ?? new Date().toISOString());
  if (!checkedAt) throw new TypeError("evaluatedAt must be a valid date-time");
  const entries = records.map((record) => {
    const canonicalSource = canonicalSourceForRecord(record);
    const galleryId = record?.id ?? record?.title ?? canonicalSource;
    if (!isGitHubBackedRecord(record)) {
      return {
        galleryId,
        canonicalSource,
        applicability: "not-applicable",
        reasonCodes: ["NON_GITHUB_SOURCE"],
        recommendation: "no-action",
        mutation: "none",
        health: null,
      };
    }
    return evaluateRepositoryFreshness(
      record,
      metadataForRecord(record, githubMetadata),
      { policy, health, evaluatedAt: checkedAt },
    );
  });
  return {
    version: "1.0.0",
    generatedAt: checkedAt,
    mode: "dry-run",
    entries,
    healthSnapshot: {
      $schema: "../.github/gallery-pipeline/health.schema.json",
      version: policy.contractVersions.health,
      entries: entries.flatMap((entry) => entry.health ? [entry.health] : []),
    },
  };
}