import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertValid,
  formatIssues,
  loadValidationContext,
  validatePolicyData,
} from "./validation.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

try {
  const context = await loadValidationContext(rootDir);
  const issues = validatePolicyData(context);
  assertValid("Gallery policy validation", issues);
  console.log(`Gallery policy validation passed: ${context.schemas.schemaFiles.length + 1} schemas compiled, 5 configs validated.`);
} catch (error) {
  console.error(error.message);
  if (error.issues) console.error(formatIssues(error.issues));
  process.exitCode = 1;
}