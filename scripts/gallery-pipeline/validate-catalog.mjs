import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertValid,
  formatIssues,
  loadValidationContext,
  validateCatalogData,
} from "./validation.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

try {
  const context = await loadValidationContext(rootDir);
  const issues = validateCatalogData(context);
  assertValid("Gallery catalog validation", issues);
  console.log(`Gallery catalog validation passed: ${context.catalog.length} active records and ${context.retired.entries.length} retired records validated.`);
} catch (error) {
  console.error(error.message);
  if (error.issues) console.error(formatIssues(error.issues));
  process.exitCode = 1;
}