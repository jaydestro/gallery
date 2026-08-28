import { canonicalizeUrl } from "./shared/canonicalize.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const AVAILABLE_COMPONENTS = Object.freeze({
  availabilityIntegrity: 25,
  maintenanceFreshness: 25,
  sampleUsability: 20,
  productRelevance: 20,
  galleryValue: 10,
});

function asDate(value, name) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`${name} must be a valid date-time`);
  }
  return date;
}

function sourceForRecord(record) {
  const source = record?.canonicalSource ?? record?.source ?? record?.website;
  if (typeof source !== "string" || source.trim() === "") {
    throw new TypeError("Every gallery record must have a source URL");
  }
  return canonicalizeUrl(source);
}

function galleryIdForRecord(record, canonicalSource) {
  const galleryId = record?.id ?? record?.title ?? canonicalSource;
  if (typeof galleryId !== "string" || galleryId.trim() === "") {
    throw new TypeError("Every gallery record must have a stable ID or title");
  }
  return galleryId;
}

export function groupCatalogSources(records) {
  if (!Array.isArray(records)) {
    throw new TypeError("Catalog records must be an array");
  }

  const sources = new Map();
  for (const record of records) {
    const canonicalSource = sourceForRecord(record);
    const galleryId = galleryIdForRecord(record, canonicalSource);
    const group = sources.get(canonicalSource) ?? { canonicalSource, records: [] };
    group.records.push({ galleryId, record });
    sources.set(canonicalSource, group);
  }

  return [...sources.values()]
    .map((group) => ({
      ...group,
      records: group.records.sort((left, right) => left.galleryId.localeCompare(right.galleryId)),
    }))
    .sort((left, right) => left.canonicalSource.localeCompare(right.canonicalSource));
}

export function githubSourceCoordinates(value) {
  const canonicalSource = canonicalizeUrl(value);
  const url = new URL(canonicalSource);
  if (url.hostname !== "github.com") return null;

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const [owner, repository, route, ref, ...repositoryPath] = segments;
  const coordinates = { owner, repository, canonicalSource, ref: null, repositoryPath: null };
  if ((route === "blob" || route === "tree") && ref && repositoryPath.length > 0) {
    coordinates.ref = ref;
    coordinates.repositoryPath = repositoryPath.join("/");
  }
  return coordinates;
}

export function classifyHttpStatus(status) {
  if (Number.isInteger(status) && status >= 200 && status < 300) {
    return "healthy";
  }
  if (status === 404 || status === 410) {
    return "definitive-failure";
  }
  return "indeterminate";
}

export async function mapWithConcurrency(items, concurrency, worker) {
  if (!Array.isArray(items)) throw new TypeError("items must be an array");
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new TypeError("concurrency must be a positive integer");
  }
  if (typeof worker !== "function") throw new TypeError("worker must be a function");

  const results = new Array(items.length);
  let nextIndex = 0;
  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()),
  );
  return results;
}

function previousEntryFor(previousHealth, galleryId) {
  const entries = Array.isArray(previousHealth?.entries) ? previousHealth.entries : [];
  return entries.find((entry) => entry.galleryId === galleryId) ?? null;
}

function hasSameSource(previous, canonicalSource) {
  try {
    return canonicalizeUrl(previous?.canonicalSource) === canonicalSource;
  } catch {
    return false;
  }
}

function hasPendingFailure(previous) {
  return (
    ["broken", "indeterminate"].includes(previous?.sourceState?.availability) &&
    Number.isSafeInteger(previous?.consecutiveFindings) &&
    previous.consecutiveFindings > 0 &&
    typeof previous.gracePeriodStartedAt === "string" &&
    Array.isArray(previous.healthReasons)
  );
}

function findingRelation(previous, result, checkedAt, canonicalSource) {
  if (!previous) return "new";
  const previousCheck = new Date(previous.checkedAt);
  if (Number.isNaN(previousCheck.getTime())) return "new";
  if (previousCheck.getTime() > checkedAt.getTime()) {
    throw new TypeError("Previous health checkedAt cannot be after the current observation");
  }
  if (!hasPendingFailure(previous)) return "new";
  if (!previous.healthReasons?.includes(result.reason)) return "new";
  try {
    if (canonicalizeUrl(previous.canonicalSource) !== canonicalSource) return "new";
  } catch {
    return "new";
  }
  return previousCheck.getTime() === checkedAt.getTime() ? "replay" : "continuing";
}

function evidenceFor(result, canonicalSource, checkedAt) {
  const evidence = Array.isArray(result.evidence) && result.evidence.length > 0
    ? result.evidence
    : [{ kind: "availability-check", value: result.reason ?? result.classification }];
  return evidence.map((item) => ({
    kind: item.kind,
    observedAt: checkedAt.toISOString(),
    source: canonicalSource,
    value: item.value,
  }));
}

export function evaluateHealthFinding({
  galleryId,
  canonicalSource,
  result,
  previousHealth,
  policy,
  checkedAt,
}) {
  const observedAt = asDate(checkedAt, "checkedAt");
  const normalizedSource = canonicalizeUrl(canonicalSource);
  const previous = previousEntryFor(previousHealth, galleryId);
  const requiredConfirmations = policy?.lifecycle?.requiredConfirmations;
  const retirementGraceDays = policy?.lifecycle?.retirementGraceDays;
  if (!Number.isSafeInteger(requiredConfirmations) || requiredConfirmations < 1) {
    throw new TypeError("Policy requiredConfirmations must be a positive integer");
  }
  if (!Number.isSafeInteger(retirementGraceDays) || retirementGraceDays < 0) {
    throw new TypeError("Policy retirementGraceDays must be a non-negative integer");
  }
  if (!["healthy", "definitive-failure", "indeterminate"].includes(result?.classification)) {
    throw new TypeError("Health result has an invalid classification");
  }

  let status;
  let consecutiveFindings;
  let gracePeriodStartedAt;
  let availability;
  let healthReasons;
  if (result.classification === "healthy") {
    status = "healthy";
    consecutiveFindings = 0;
    gracePeriodStartedAt = null;
    availability = "available";
    healthReasons = [];
  } else if (result.classification === "indeterminate") {
    const preservePendingFailure = hasSameSource(previous, normalizedSource) &&
      hasPendingFailure(previous);
    status = "indeterminate";
    consecutiveFindings = preservePendingFailure ? previous.consecutiveFindings : 0;
    gracePeriodStartedAt = preservePendingFailure ? previous.gracePeriodStartedAt : null;
    availability = "indeterminate";
    healthReasons = preservePendingFailure
      ? [...previous.healthReasons]
      : (result.reason ? [result.reason] : []);
  } else {
    const relation = findingRelation(previous, result, observedAt, normalizedSource);
    consecutiveFindings = relation === "replay"
      ? previous.consecutiveFindings
      : (relation === "continuing" ? previous.consecutiveFindings + 1 : 1);
    gracePeriodStartedAt = relation !== "new" && previous.gracePeriodStartedAt
      ? previous.gracePeriodStartedAt
      : observedAt.toISOString();
    const graceStarted = asDate(gracePeriodStartedAt, "gracePeriodStartedAt");
    const graceElapsed = observedAt.getTime() - graceStarted.getTime() >= retirementGraceDays * DAY_MS;
    const confirmed = consecutiveFindings >= requiredConfirmations;
    status = result.archived === true || result.disabled === true || (confirmed && graceElapsed)
      ? "quarantined"
      : "needs-review";
    availability = "broken";
    healthReasons = result.reason ? [result.reason] : [];
  }

  const availabilityIntegrity = result.classification === "healthy" ? 25 : 0;
  const components = { ...AVAILABLE_COMPONENTS, availabilityIntegrity };
  return {
    galleryId,
    canonicalSource: normalizedSource,
    checkedAt: observedAt.toISOString(),
    status,
    healthScore: Object.values(components).reduce((sum, score) => sum + score, 0),
    components,
    healthReasons,
    consecutiveFindings,
    gracePeriodStartedAt,
    sourceState: {
      availability,
      archived: result.archived ?? null,
      disabled: result.disabled ?? null,
      lastMeaningfulChange: null,
    },
    evidence: evidenceFor(result, normalizedSource, observedAt),
  };
}

export function createHealthSnapshot(records, sourceResults, {
  previousHealth = null,
  policy,
  checkedAt,
  schema = "../.github/gallery-pipeline/health.schema.json",
} = {}) {
  if (!(sourceResults instanceof Map)) {
    throw new TypeError("sourceResults must be a Map keyed by canonical source");
  }
  const groups = groupCatalogSources(records);
  const expectedSources = new Set(groups.map((group) => group.canonicalSource));
  const normalizedResults = new Map();
  for (const [source, result] of sourceResults) {
    const canonicalSource = canonicalizeUrl(source);
    if (normalizedResults.has(canonicalSource)) {
      throw new TypeError(`Duplicate health observation for ${canonicalSource}`);
    }
    if (!expectedSources.has(canonicalSource)) {
      throw new TypeError(`Stale health source identity ${canonicalSource}`);
    }
    normalizedResults.set(canonicalSource, result);
  }
  const entries = [];
  for (const group of groups) {
    const result = normalizedResults.get(group.canonicalSource);
    if (!result) throw new TypeError(`Missing health result for ${group.canonicalSource}`);
    for (const { galleryId } of group.records) {
      entries.push(evaluateHealthFinding({
        galleryId,
        canonicalSource: group.canonicalSource,
        result,
        previousHealth,
        policy,
        checkedAt,
      }));
    }
  }
  entries.sort((left, right) => (
    left.galleryId.localeCompare(right.galleryId) ||
    left.canonicalSource.localeCompare(right.canonicalSource)
  ));
  return {
    $schema: schema,
    version: policy?.contractVersions?.health ?? "1.0.0",
    entries,
  };
}