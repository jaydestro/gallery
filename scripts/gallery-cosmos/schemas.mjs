import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const schemaFiles = Object.freeze({
  catalogItem: "catalog-item.schema.json",
  pipelineReceipt: "pipeline-receipt.schema.json",
  publicCatalog: "public-catalog.schema.json",
  reviewCandidate: "review-candidate.schema.json",
  reviewDecision: "review-decision.schema.json",
});
const cosmosSystemFields = new Set(["_attachments", "_etag", "_lsn", "_rid", "_self", "_ts"]);

export const schemas = Object.freeze(Object.fromEntries(await Promise.all(
  Object.entries(schemaFiles).map(async ([name, fileName]) => [
    name,
    JSON.parse(await readFile(path.join(moduleDirectory, "schemas", fileName), "utf8")),
  ]),
)));
const galleryCatalogSchema = JSON.parse(await readFile(
  path.resolve(moduleDirectory, "..", "..", ".github", "gallery-pipeline", "catalog.schema.json"),
  "utf8",
));

const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
addFormats(ajv);
const validateGalleryCatalog = ajv.compile(galleryCatalogSchema);
const validators = Object.freeze(Object.fromEntries(
  Object.entries(schemas).map(([name, schema]) => [name, ajv.compile(schema)]),
));

export class CosmosSchemaError extends Error {
  constructor(documentType, errors) {
    const message = errors
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    super(`${documentType} document is invalid: ${message}`);
    this.name = "CosmosSchemaError";
    this.code = "COSMOS_SCHEMA_INVALID";
    this.documentType = documentType;
    this.errors = structuredClone(errors);
  }
}

function withoutCosmosSystemFields(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) return document;
  return Object.fromEntries(Object.entries(document).filter(([key]) => !cosmosSystemFields.has(key)));
}

export function assertDocument(documentType, document) {
  const validate = validators[documentType];
  if (!validate) {
    throw new TypeError(`Unknown Cosmos document type: ${documentType}.`);
  }
  if (!validate(withoutCosmosSystemFields(document))) {
    throw new CosmosSchemaError(documentType, validate.errors ?? []);
  }
  return document;
}

export function isDocument(documentType, document) {
  const validate = validators[documentType];
  if (!validate) return false;
  return validate(withoutCosmosSystemFields(document));
}

export function assertGalleryCatalog(records) {
  if (!validateGalleryCatalog(records)) {
    throw new CosmosSchemaError("galleryCatalog", validateGalleryCatalog.errors ?? []);
  }
  return records;
}