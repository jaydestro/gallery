import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIRECTORY = path.resolve(TEST_DIRECTORY, "../..");
const WORKFLOW_DIRECTORY = path.join(ROOT_DIRECTORY, ".github", "workflows");
const WORKFLOW_FILES = [
  "deploy.yml",
  "evaluate-pipeline-policy.yml",
  "propose-gallery-changes.yml",
  "validate-gallery-change.yml",
];
const VERIFIED_ACTION_PINS = new Map([
  ["actions/checkout", "3d3c42e5aac5ba805825da76410c181273ba90b1"],
  ["actions/configure-pages", "983d7736d9b0ae728b81ab479565c72886d7745b"],
  ["actions/deploy-pages", "d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e"],
  ["actions/setup-node", "820762786026740c76f36085b0efc47a31fe5020"],
  ["actions/upload-artifact", "ea165f8d65b6e75b540449e92b4886f43607fa02"],
  ["actions/upload-pages-artifact", "56afc609e74202658d3ffba0e8f6dda462b719fa"],
  ["azure/login", "7ddb5af1ef8758cf1353cf3b42f940aee27ba21c"],
]);

async function readWorkflow(fileName) {
  return readFile(path.join(WORKFLOW_DIRECTORY, fileName), "utf8");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function yamlSection(source, key, indentation = 0) {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const prefix = " ".repeat(indentation);
  const keyPattern = new RegExp(`^${escapeRegExp(prefix + key)}:\\s*(?:#.*)?$`);
  const start = lines.findIndex((line) => keyPattern.test(line));
  assert.notEqual(start, -1, `Missing ${key} section at indentation ${indentation}`);

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const currentIndentation = line.match(/^ */)[0].length;
    if (currentIndentation <= indentation) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function actionReferences(source) {
  return [...source.matchAll(
    /^\s*uses:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([^\s#]+)(?:\s+#.*)?$/gm,
  )].map((match) => ({ action: match[1], ref: match[2] }));
}

test("owned workflows pin every external action to a verified commit", async () => {
  for (const fileName of WORKFLOW_FILES) {
    const workflow = await readWorkflow(fileName);
    const references = actionReferences(workflow);
    assert.ok(references.length > 0, `${fileName} must contain external action references`);
    for (const { action, ref } of references) {
      assert.match(ref, /^[0-9a-f]{40}$/, `${fileName}: ${action} must use a full commit SHA`);
      assert.equal(
        ref,
        VERIFIED_ACTION_PINS.get(action),
        `${fileName}: ${action} must use the repository's verified pin`,
      );
    }
  }
});

test("Pages deployment auto-runs only on main and delegates manual refs to its environment", async () => {
  const workflow = await readWorkflow("deploy.yml");
  const triggers = yamlSection(workflow, "on");
  const push = yamlSection(triggers, "push", 2);
  const buildJob = yamlSection(workflow, "build", 2);
  const deployJob = yamlSection(workflow, "deploy", 2);
  const buildPermissions = yamlSection(buildJob, "permissions", 4);
  const deployPermissions = yamlSection(deployJob, "permissions", 4);
  const environment = yamlSection(deployJob, "environment", 4);

  assert.deepEqual(
    [...push.matchAll(/^\s+-\s+([^\s#]+)\s*$/gm)].map((match) => match[1]),
    ["main"],
  );
  assert.match(triggers, /^  workflow_dispatch:\s*$/m);
  assert.doesNotMatch(triggers, /pull_request|pull_request_target/);
  assert.match(workflow, /^permissions:\s*\{\}\s*$/m);
  assert.match(buildPermissions, /^\s+contents:\s*read\s*$/m);
  assert.doesNotMatch(buildPermissions, /pages:|id-token:/);
  assert.match(deployPermissions, /^\s+pages:\s*write\s*$/m);
  assert.match(deployPermissions, /^\s+id-token:\s*write\s*$/m);
  assert.doesNotMatch(deployPermissions, /contents:/);
  assert.equal(workflow.match(/^\s+pages:\s*write\s*$/gm)?.length, 1);
  assert.equal(workflow.match(/^\s+id-token:\s*write\s*$/gm)?.length, 1);
  assert.match(environment, /^\s+name:\s*github-pages\s*$/m);
  assert.doesNotMatch(buildJob, /^    if:/m);
  assert.doesNotMatch(deployJob, /^    if:/m);
});

test("policy pull requests run only the secretless deterministic evaluation", async () => {
  const workflow = await readWorkflow("evaluate-pipeline-policy.yml");
  const triggers = yamlSection(workflow, "on");
  const pullRequest = yamlSection(triggers, "pull_request", 2);
  const deterministicJob = yamlSection(workflow, "deterministic-evaluation", 2);
  const trustedJob = yamlSection(workflow, "trusted-model-evaluation", 2);

  assert.match(triggers, /^  workflow_dispatch:\s*$/m);
  assert.doesNotMatch(triggers, /^  (?:push|pull_request_target):/m);
  assert.match(pullRequest, /^    paths:\s*$/m);
  for (const expectedPath of [
    ".github/gallery-pipeline/**",
    ".github/workflows/evaluate-pipeline-policy.yml",
    "package-lock.json",
    "package.json",
    "scripts/gallery-pipeline/**",
  ]) {
    assert.match(pullRequest, new RegExp(`^\\s+- '${escapeRegExp(expectedPath)}'\\s*$`, "m"));
  }
  assert.match(workflow, /^permissions:\s*\r?\n\s+contents:\s*read\s*$/m);
  assert.match(deterministicJob, /^    name:\s*Run deterministic policy fixtures\s*$/m);
  assert.doesNotMatch(
    deterministicJob,
    /\$\{\{\s*secrets\.|id-token:\s*write|azure\/login@|environment:|AZURE_CLIENT_ID/,
  );
  assert.match(trustedJob, /github\.event_name == 'workflow_dispatch'/);
  assert.match(
    trustedJob,
    /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/,
  );
  assert.match(trustedJob, /ref:\s*\$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(trustedJob, /^\s+environment:\s*gallery-model-evaluation\s*$/m);
  assert.match(trustedJob, /^\s+id-token:\s*write\s*$/m);
  assert.equal(workflow.match(/^\s+id-token:\s*write\s*$/gm)?.length, 1);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./);
});

test("gallery proposal verification always publishes token-safe diagnostics", async () => {
  const workflow = await readWorkflow("propose-gallery-changes.yml");
  const normalizedWorkflow = workflow.replaceAll("\r\n", "\n");
  const permissions = yamlSection(normalizedWorkflow, "permissions");
  const proposeJob = yamlSection(normalizedWorkflow, "propose", 2);
  const directorySetup = normalizedWorkflow.indexOf(
    "mkdir -p proposal-inputs/discovery proposal-inputs/health proposal-inputs/freshness gallery-proposal",
  );
  const diagnosticsWriterStart = normalizedWorkflow.indexOf("          write_diagnostics() {");
  const finalizerStart = normalizedWorkflow.indexOf("          finalize_diagnostics() {");
  const initialReportStart = normalizedWorkflow.indexOf(
    "          if ! write_diagnostics; then\n            printf 'Failed to initialize upstream artifact diagnostics.",
  );
  const trapRegistration = normalizedWorkflow.indexOf("          trap finalize_diagnostics EXIT");
  const firstVerification = normalizedWorkflow.indexOf(
    '          if [[ "$TRUSTED_REF" != refs/heads/* ]]',
  );
  const uploadStart = proposeJob.indexOf("      - name: Upload proposal reports and proposed state");

  for (const [name, index] of [
    ["diagnostic directory setup", directorySetup],
    ["diagnostic writer", diagnosticsWriterStart],
    ["diagnostic finalizer", finalizerStart],
    ["initial diagnostic report", initialReportStart],
    ["EXIT trap", trapRegistration],
    ["first verification", firstVerification],
    ["artifact upload", uploadStart],
  ]) {
    assert.notEqual(index, -1, `Missing ${name}`);
  }
  assert.ok(directorySetup < initialReportStart, "diagnostic directory must exist before the report");
  assert.ok(initialReportStart < trapRegistration, "diagnostic report must exist before the EXIT trap");
  assert.ok(trapRegistration < firstVerification, "EXIT trap must cover every verification");

  const diagnosticsWriter = normalizedWorkflow.slice(diagnosticsWriterStart, finalizerStart);
  const finalizer = normalizedWorkflow.slice(finalizerStart, initialReportStart);
  assert.match(
    diagnosticsWriter,
    /> gallery-proposal\/upstream-artifact-diagnostics\.json\s*$/m,
  );
  assert.doesNotMatch(
    diagnosticsWriter,
    /GH_TOKEN|github\.token|\$\{\{\s*secrets\.|printenv|set -x/,
  );
  assert.match(finalizer, /local exit_code=\$\?/);
  assert.match(finalizer, /trap - EXIT/);
  assert.match(finalizer, /if ! write_diagnostics; then/);
  assert.match(finalizer, /exit "\$exit_code"/);
  assert.doesNotMatch(finalizer, /GH_TOKEN|github\.token|\$\{\{\s*secrets\.|printenv|set -x/);
  assert.match(normalizedWorkflow, /^          overall_status="verified"\s*$/m);

  assert.match(permissions, /^  contents:\s*read\s*$/m);
  assert.match(permissions, /^  actions:\s*read\s*$/m);
  assert.doesNotMatch(permissions, /write/);
  const uploadStep = proposeJob.slice(uploadStart);
  assert.match(uploadStep, /^        if:\s*always\(\)\s*$/m);
  assert.match(
    uploadStep,
    /^        uses:\s*actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\s+# v4\s*$/m,
  );
  assert.match(uploadStep, /^          path:\s*gallery-proposal\/\s*$/m);
  assert.match(uploadStep, /^          if-no-files-found:\s*error\s*$/m);
});

test("gallery validation exposes one stable universal PR and merge-queue check", async () => {
  const workflow = await readWorkflow("validate-gallery-change.yml");
  const triggers = yamlSection(workflow, "on");
  const validateJob = yamlSection(workflow, "validate", 2);

  assert.match(workflow, /^name:\s*Validate gallery change\s*$/m);
  assert.match(triggers, /^  pull_request:\s*$/m);
  assert.match(triggers, /^  merge_group:\s*$/m);
  assert.match(triggers, /^  workflow_dispatch:\s*$/m);
  assert.doesNotMatch(triggers, /paths:|pull_request_target/);
  assert.match(validateJob, /^    name:\s*Test, validate, and build\s*$/m);
  assert.doesNotMatch(validateJob, /^    if:/m);
  assert.match(workflow, /^permissions:\s*\r?\n\s+contents:\s*read\s*$/m);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\.|id-token:\s*write|pages:\s*write/);
});