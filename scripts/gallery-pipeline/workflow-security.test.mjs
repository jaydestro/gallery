import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIRECTORY = path.resolve(TEST_DIRECTORY, "../..");
const WORKFLOW_DIRECTORY = path.join(ROOT_DIRECTORY, ".github", "workflows");
const WORKFLOW_FILES = [
  "analyze-gallery-candidates.yml",
  "authorize-gallery-change.yml",
  "deploy.yml",
  "discover-content.yml",
  "evaluate-pipeline-policy.yml",
  "generate-portfolio-report.yml",
  "publish-gallery-changes.yml",
  "propose-gallery-changes.yml",
  "validate-gallery-change.yml",
];
const VERIFIED_ACTION_PINS = new Map([
  ["actions/checkout", "3d3c42e5aac5ba805825da76410c181273ba90b1"],
  ["actions/configure-pages", "983d7736d9b0ae728b81ab479565c72886d7745b"],
  ["actions/create-github-app-token", "bcd2ba49218906704ab6c1aa796996da409d3eb1"],
  ["actions/deploy-pages", "d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e"],
  ["actions/download-artifact", "018cc2cf5baa6db3ef3c5f8a56943fffe632ef53"],
  ["actions/setup-node", "820762786026740c76f36085b0efc47a31fe5020"],
  ["actions/upload-artifact", "ea165f8d65b6e75b540449e92b4886f43607fa02"],
  ["actions/upload-pages-artifact", "56afc609e74202658d3ffba0e8f6dda462b719fa"],
  ["azure/login", "7ddb5af1ef8758cf1353cf3b42f940aee27ba21c"],
]);

async function readWorkflow(fileName) {
  return readFile(path.join(WORKFLOW_DIRECTORY, fileName), "utf8");
}

function workflowStepScript(source, stepName) {
  source = source.replaceAll("\r\n", "\n");
  const stepMarker = `      - name: ${stepName}`;
  const stepStart = source.indexOf(stepMarker);
  assert.notEqual(stepStart, -1, `Missing workflow step ${stepName}`);
  const runMarker = "        run: |\n";
  const runStart = source.indexOf(runMarker, stepStart);
  assert.notEqual(runStart, -1, `Missing run block for ${stepName}`);
  const contentStart = runStart + runMarker.length;
  const nextStep = source.indexOf("\n      - name:", contentStart);
  return source.slice(contentStart, nextStep === -1 ? source.length : nextStep)
    .split("\n")
    .map((line) => line.startsWith("          ") ? line.slice(10) : line)
    .join("\n");
}

async function runAuthorizationRouting(rootDirectory, { headRepository, headRef }) {
  const workflow = await readWorkflow("authorize-gallery-change.yml");
  const fullScript = workflowStepScript(
    workflow,
    "Authorize only exact same-repository automation changes",
  );
  const apiBoundary = fullScript.indexOf('if [[ ! "$EXPECTED_APP_SLUG"');
  assert.notEqual(apiBoundary, -1, "Missing authorization API boundary");
  const jqShim = `
jq() {
  node --input-type=module - "$2" "$3" <<'NODE'
import { readFileSync } from "node:fs";
const expression = process.argv[2];
const event = JSON.parse(readFileSync(process.argv[3], "utf8"));
const values = new Map([
  [".pull_request.number | tostring", String(event.pull_request.number)],
  [".pull_request.base.repo.full_name", event.pull_request.base.repo.full_name],
  [".pull_request.head.repo.full_name", event.pull_request.head.repo.full_name],
  [".pull_request.head.ref", event.pull_request.head.ref],
]);
if (!values.has(expression)) process.exit(2);
process.stdout.write(values.get(expression));
NODE
}
`;
  const script = `${jqShim}\n${fullScript.slice(0, apiBoundary)}\nprintf 'VALIDATION_REQUIRED\\n'\nexit 3\n`;
  await writeFile(path.join(rootDirectory, "event.json"), JSON.stringify({
    pull_request: {
      number: 17,
      base: { repo: { full_name: "example/gallery" } },
      head: { repo: { full_name: headRepository }, ref: headRef },
    },
  }));
  const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
  try {
    const result = await execFileAsync(bash, ["-c", script], {
      cwd: rootDirectory,
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: "event.json",
        GITHUB_STEP_SUMMARY: "summary.md",
        GH_REPO: "example/gallery",
      },
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      exitCode: typeof error.code === "number" ? error.code : Number(error.code),
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
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

test("gallery authorization is universal, trusted-default-only, secretless, and strict about automation refs", async () => {
  const workflow = await readWorkflow("authorize-gallery-change.yml");
  const triggers = yamlSection(workflow, "on");
  const authorizeJob = yamlSection(workflow, "authorize", 2);
  const permissions = yamlSection(authorizeJob, "permissions", 4);
  const forkNotApplicable = workflow.indexOf('if [ "$event_head_repository" != "$GH_REPO" ]');
  const ordinaryNotApplicable = workflow.indexOf('if [[ "$event_head_ref" != automation/gallery* ]]');
  const exactValidation = workflow.indexOf(
    'if [[ ! "$event_head_ref" =~ ^automation/gallery/([1-9][0-9]*)-([1-9][0-9]*)$ ]]',
  );

  assert.match(workflow, /^name:\s*Authorize gallery automation change\s*$/m);
  assert.match(triggers, /^  pull_request_target:\s*$/m);
  assert.doesNotMatch(triggers, /pull_request:|push:|workflow_run:|paths:/);
  assert.match(workflow, /^permissions:\s*\{\}\s*$/m);
  assert.match(authorizeJob, /^    name:\s*Authorize gallery automation change\s*$/m);
  assert.match(permissions, /^      actions:\s*read\s*$/m);
  assert.match(permissions, /^      contents:\s*read\s*$/m);
  assert.match(permissions, /^      pull-requests:\s*read\s*$/m);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\.|contents:\s*write|pull-requests:\s*write|id-token:\s*write/);
  assert.doesNotMatch(workflow, /\$\{\{\s*github\.event\.pull_request\.(?:head|title|body)/);
  assert.doesNotMatch(authorizeJob, /environment:|create-github-app-token|github\.head_ref|github\.event\.pull_request\.head\.sha/);

  const references = actionReferences(workflow);
  assert.deepEqual(references.map(({ action }) => action), ["actions/checkout", "actions/setup-node"]);
  assert.match(workflow, /name:\s*Check out exact API-verified default-branch SHA only/);
  assert.match(workflow, /ref:\s*\$\{\{ steps\.metadata\.outputs\.default_sha \}\}/);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.match(workflow, /if:\s*steps\.metadata\.outputs\.applicable == 'true'/g);
  assert.match(workflow, /Install trusted default-branch dependencies/);
  assert.match(workflow, /run:\s*npm ci/);

  assert.notEqual(forkNotApplicable, -1);
  assert.notEqual(ordinaryNotApplicable, -1);
  assert.notEqual(exactValidation, -1);
  assert.ok(forkNotApplicable < ordinaryNotApplicable);
  assert.ok(ordinaryNotApplicable < exactValidation);
  assert.match(workflow, /Not applicable: pull request #\%s is not from a same-repository branch\./);
  assert.match(workflow, /Not applicable: pull request #\%s is an ordinary same-repository change\./);
  assert.match(workflow, /same-repository automation\/gallery lookalike branch is not authorized/);
  assert.match(workflow, /GALLERY_PUBLISHER_APP_SLUG/);
  assert.match(workflow, /expected_app_login="\$\{EXPECTED_APP_SLUG\}\[bot\]"/);
  assert.match(workflow, /\.user\.login == \$appLogin/);
  assert.match(workflow, /\.user\.id == \$appUserId/);
  assert.match(workflow, /\.author\.login == \$appLogin/);
  assert.match(workflow, /\.committer\.login == \$appLogin/);
  assert.doesNotMatch(workflow, /performed_via_github_app/);
  assert.doesNotMatch(workflow, /\(\?:/);
  assert.match(workflow, /\.head_repository\.full_name == \$repository/);
  assert.match(workflow, /\.path == "\.github\/workflows\/propose-gallery-changes\.yml"/);
  assert.match(workflow, /\.head_sha == \$baseSha/);
  assert.match(workflow, /\.run_attempt == \$attempt/);
  assert.match(workflow, /\.conclusion == "success"/);
  assert.match(workflow, /gallery-proposal-\$\{proposal_run_id\}-\$\{proposal_run_attempt\}/);
  assert.match(workflow, /sha256:\[a-f0-9\]\{64\}/);
  assert.match(workflow, /\.parents\[0\]\.sha == \$baseSha/);
  assert.match(workflow, /\[ "\$base_sha" != "\$default_sha" \]/);
  assert.match(workflow, /catalog-change-plan\.json/);
  assert.match(workflow, /static\/catalog-audit\.json/);
  assert.match(workflow, /\.status == "added" or \.status == "modified"/);
  assert.match(workflow, /verify-publication-artifact\.mjs/);
  assert.match(workflow, /--artifact-archive authorization-input\/proposal\.zip/);
  assert.match(workflow, /--output-directory authorization-payload/);
  assert.match(workflow, /git\/trees\/\$\{tree_sha\}\?recursive=1/);
  assert.match(workflow, /jq -r '\.truncated'/);
  assert.doesNotMatch(workflow, /jq -er '\.truncated'/);
  assert.match(workflow, /git\/blobs\/\$\{file_sha\}/);
  assert.match(workflow, /verify-publication-artifact-pr\.mjs/);
  assert.match(workflow, /\.proposal\.artifactDigest == \$artifactDigest/);
  assert.match(workflow, /\.batch\.total == \$batchTotal/);
  assert.match(workflow, /--manifest "\$manifest"/);
  assert.match(workflow, /exact artifact bytes/);
});

test("gallery authorization routing succeeds for ordinary PRs and rejects malformed lookalikes", async (t) => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "gallery-authorization-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));

  const fork = await runAuthorizationRouting(rootDirectory, {
    headRepository: "contributor/gallery",
    headRef: "automation/gallery/33148289100-1",
  });
  assert.equal(fork.exitCode, 0);
  assert.match(await readFile(path.join(rootDirectory, "summary.md"), "utf8"), /Not applicable:.*not from a same-repository branch/);

  const ordinary = await runAuthorizationRouting(rootDirectory, {
    headRepository: "example/gallery",
    headRef: "feature/update-docs",
  });
  assert.equal(ordinary.exitCode, 0);
  assert.match(await readFile(path.join(rootDirectory, "summary.md"), "utf8"), /Not applicable:.*ordinary same-repository change/);

  const exact = await runAuthorizationRouting(rootDirectory, {
    headRepository: "example/gallery",
    headRef: "automation/gallery/33148289100-1",
  });
  assert.equal(exact.exitCode, 3);
  assert.match(exact.stdout, /VALIDATION_REQUIRED/);

  for (const headRef of [
    "automation/gallery",
    "automation/gallery/",
    "automation/gallery/0-1",
    "automation/gallery/01-1",
    "automation/gallery/1-0",
    "automation/gallery/1-01",
    "automation/gallery/1-1-extra",
    "automation/gallery//1-1",
    "automation/galleryish/1-1",
    "automation/gallery-1-1",
  ]) {
    const malformed = await runAuthorizationRouting(rootDirectory, {
      headRepository: "example/gallery",
      headRef,
    });
    assert.equal(malformed.exitCode, 1, `${headRef} must fail closed`);
    assert.match(malformed.stderr, /lookalike branch is not authorized/);
  }
});

test("gallery publisher verifies before protected App access and creates only native-auto-merge PRs", async () => {
  const workflow = await readWorkflow("publish-gallery-changes.yml");
  const triggers = yamlSection(workflow, "on");
  const workflowRun = yamlSection(triggers, "workflow_run", 2);
  const verifyJob = yamlSection(workflow, "verify", 2);
  const publishJob = yamlSection(workflow, "publish", 2);
  const verifyPermissions = yamlSection(verifyJob, "permissions", 4);
  const publishPermissions = yamlSection(publishJob, "permissions", 4);
  const environmentIndex = publishJob.indexOf("    environment: gallery-publication");
  const payloadVerificationIndex = publishJob.indexOf(
    "      - name: Verify sealed payload and new-ref preconditions before token access",
  );
  const tokenIndex = publishJob.indexOf("      - name: Create selected-repository GitHub App token");
  const mutationIndex = publishJob.indexOf(
    "      - name: Create new ref, same-repository pull request, and native auto-merge",
  );

  assert.match(workflow, /^name:\s*Publish verified gallery changes\s*$/m);
  assert.match(workflowRun, /^    workflows:\s*$/m);
  assert.match(workflowRun, /^      - Propose gallery changes \(report only\)\s*$/m);
  assert.match(workflowRun, /^    types:\s*\r?\n\s+- completed\s*$/m);
  assert.doesNotMatch(triggers, /pull_request|push:|workflow_dispatch:/);
  assert.match(workflow, /^permissions:\s*\{\}\s*$/m);
  assert.match(workflow, /cancel-in-progress:\s*false/);

  assert.match(verifyJob, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(verifyPermissions, /^      actions:\s*read\s*$/m);
  assert.match(verifyPermissions, /^      contents:\s*read\s*$/m);
  assert.doesNotMatch(verifyPermissions, /write/);
  assert.doesNotMatch(verifyJob, /environment:|create-github-app-token|\$\{\{\s*secrets\./);
  assert.match(verifyJob, /\.head_repository\.full_name == \$repository/);
  assert.match(verifyJob, /\.path == "\.github\/workflows\/propose-gallery-changes\.yml"/);
  assert.match(verifyJob, /\.head_sha == \$defaultSha/);
  assert.match(verifyJob, /\.run_attempt == \$attempt/);
  assert.match(verifyJob, /\.conclusion == "success"/);
  assert.match(verifyJob, /steps\.policy\.outputs\.enabled == 'true'/);
  assert.match(verifyJob, /actions\/artifacts\/\$\{artifact_id\}\/zip/);
  assert.match(verifyJob, /zipinfo -1/);
  assert.match(verifyJob, /unexpected file path/);
  assert.match(verifyJob, /contains a symbolic link/);
  assert.match(verifyJob, /uncompressed size limit/);
  assert.match(verifyJob, /verify-publication-artifact\.mjs/);
  assert.match(verifyJob, /--artifact-archive publication-input\/proposal\.zip/);
  assert.match(verifyJob, /--api-metadata publication-input\/api-metadata\.json/);
  assert.match(verifyJob, /--output-directory publication-payload/);
  assert.match(verifyJob, /input as \$run \|/);
  assert.doesNotMatch(verifyJob, /event:\s*input\.event|status:\s*input\.status/);
  assert.match(verifyJob, /echo "publishable=\$\{publishable\}"/);
  assert.match(verifyJob, /verified proposal contains no operations/);
  assert.match(verifyJob, /steps\.bundle\.outputs\.publishable == 'true'/);
  assert.match(verifyJob, /payload_digest=\$\{payload_digest\}/);

  assert.match(
    publishJob,
    /needs\.verify\.outputs\.enabled == 'true' && needs\.verify\.outputs\.publishable == 'true'/,
  );
  assert.match(publishPermissions, /^      actions:\s*read\s*$/m);
  assert.match(publishPermissions, /^      contents:\s*read\s*$/m);
  assert.doesNotMatch(publishPermissions, /write/);
  assert.notEqual(environmentIndex, -1);
  assert.notEqual(payloadVerificationIndex, -1);
  assert.notEqual(tokenIndex, -1);
  assert.notEqual(mutationIndex, -1);
  assert.ok(environmentIndex < payloadVerificationIndex);
  assert.ok(payloadVerificationIndex < tokenIndex);
  assert.ok(tokenIndex < mutationIndex);
  assert.match(publishJob, /actual_digest="sha256:\$\(sha256sum/);
  assert.match(publishJob, /\[ "\$actual_digest" != "\$EXPECTED_PAYLOAD_DIGEST" \]/);
  assert.match(publishJob, /default branch advanced after proposal verification/i);
  assert.match(publishJob, /publisher refs are create-only/i);
  assert.match(publishJob, /client-id:\s*\$\{\{ vars\.GALLERY_PUBLISHER_APP_CLIENT_ID \}\}/);
  assert.match(publishJob, /TOKEN_APP_SLUG:\s*\$\{\{ steps\.app-token\.outputs\.app-slug \}\}/);
  assert.match(publishJob, /\[ "\$TOKEN_APP_SLUG" != "\$EXPECTED_APP_SLUG" \]/);
  assert.match(publishJob, /app_login="\$\{EXPECTED_APP_SLUG\}\[bot\]"/);
  assert.match(publishJob, /app_email="\$\{app_user_id\}\+\$\{app_login\}@users\.noreply\.github\.com"/);
  assert.match(publishJob, /repositories:\s*\$\{\{ github\.event\.repository\.name \}\}/);
  assert.match(publishJob, /permission-contents:\s*write/);
  assert.match(publishJob, /permission-pull-requests:\s*write/);
  assert.equal(publishJob.match(/permission-[a-z-]+:\s*write/g)?.length, 2);
  assert.match(publishJob, /\.total_count == 1/);
  assert.match(publishJob, /repos\/\$\{GH_REPO\}\/git\/refs/);
  assert.match(publishJob, /refs\/heads\/\$\{EXPECTED_BRANCH\}/);
  assert.match(publishJob, /repos\/\$\{GH_REPO\}\/pulls/);
  assert.match(publishJob, /maintainer_can_modify:\s*false/);
  assert.match(publishJob, /\.head\.repo\.full_name == \$repository/);
  assert.match(publishJob, /\.user\.login == \$appLogin/);
  assert.match(publishJob, /\.user\.id == \$appUserId/);
  assert.match(publishJob, /enablePullRequestAutoMerge/);
  assert.match(publishJob, /mergeMethod:\s*SQUASH/);
  assert.doesNotMatch(publishJob, /\/merges|gh pr merge|mergePullRequest|--force|force:\s*true/);
  assert.doesNotMatch(workflow, /performed_via_github_app/);
  assert.doesNotMatch(workflow, /\(\?:/);
  assert.doesNotMatch(workflow, /PERSONAL_ACCESS_TOKEN|\bPAT\b|GH_PAT|github\.event\.workflow_run\.head_commit\.message/);
});

test("quarterly portfolio reporting is manual or scheduled, read-only, and artifact-only", async () => {
  const workflow = await readWorkflow("generate-portfolio-report.yml");
  const triggers = yamlSection(workflow, "on");
  const permissions = yamlSection(workflow, "permissions");
  const reportJob = yamlSection(workflow, "report", 2);

  assert.match(triggers, /^  schedule:\s*$/m);
  assert.match(triggers, /cron:\s*"17 6 1 1,4,7,10 \*"/);
  assert.match(triggers, /^  workflow_dispatch:\s*$/m);
  assert.match(triggers, /^      as_of:\s*$/m);
  assert.match(triggers, /^      discovery_metrics_paths:\s*$/m);
  assert.doesNotMatch(triggers, /pull_request|pull_request_target|push:|workflow_run/);

  assert.match(permissions, /^  contents:\s*read\s*$/m);
  assert.doesNotMatch(permissions, /write|issues:|pull-requests:|id-token:/);
  assert.match(reportJob, /npm run gallery:portfolio --/);
  assert.match(reportJob, /--discovery-metrics/);
  assert.match(reportJob, /GITHUB_STEP_SUMMARY/);
  assert.match(reportJob, /portfolio-report\/portfolio-report\.md/);
  assert.match(reportJob, /portfolio-report\//);
  assert.match(reportJob, /persist-credentials:\s*false/);
  assert.doesNotMatch(reportJob, /\bgh\s|createIssue|createPullRequest|issues:\s*write|pull-requests:\s*write/);
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

test("live candidate analysis is trusted, protected, least-privilege, and token-safe", async () => {
  const workflow = await readWorkflow("analyze-gallery-candidates.yml");
  const triggers = yamlSection(workflow, "on");
  const dispatch = yamlSection(triggers, "workflow_dispatch", 2);
  const input = yamlSection(dispatch, "discovery_run_id", 6);
  const analyzeJob = yamlSection(workflow, "analyze", 2);
  const permissions = yamlSection(analyzeJob, "permissions", 4);

  assert.doesNotMatch(triggers, /schedule:|push:|pull_request|workflow_run:/);
  assert.match(input, /^        required:\s*true\s*$/m);
  assert.match(workflow, /^permissions:\s*\{\}\s*$/m);
  assert.match(analyzeJob, /github\.event_name == 'workflow_dispatch'/);
  assert.match(
    analyzeJob,
    /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/,
  );
  assert.match(analyzeJob, /github\.repository == github\.event\.repository\.full_name/);
  assert.match(analyzeJob, /^    environment:\s*gallery-candidate-analysis\s*$/m);
  assert.match(permissions, /^      contents:\s*read\s*$/m);
  assert.match(permissions, /^      actions:\s*read\s*$/m);
  assert.match(permissions, /^      id-token:\s*write\s*$/m);
  assert.equal(workflow.match(/^\s+id-token:\s*write\s*$/gm)?.length, 1);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\.|pull_request_target|gh run download|GITHUB_ENV/);
  assert.match(workflow, /\.repository\.full_name/);
  assert.match(workflow, /\.head_repository\.full_name/);
  assert.match(workflow, /\.workflow_id/);
  assert.match(workflow, /\.path == "\.github\/workflows\/discover-content\.yml"/);
  assert.match(workflow, /\.head_branch/);
  assert.match(workflow, /\.head_sha/);
  assert.match(workflow, /\.run_attempt/);
  assert.match(workflow, /\.conclusion == "success"/);
  assert.match(workflow, /actions\/artifacts\/\$\{artifact_id\}\/zip/);
  assert.match(workflow, /sha256sum/);
  assert.match(workflow, /zipinfo -1/);
  assert.match(workflow, /expected_entries=\("candidate-gates\.json" "discovery\.json"\)/);
  assert.match(workflow, /\[ ! -f "\$report_path" \] \|\| \[ -L "\$report_path" \]/);
  assert.match(workflow, /\.status == "complete"/);
  assert.match(workflow, /\.schemaVersion == "2\.0\.0"/);
  assert.match(workflow, /\.summary\.selectedCandidates == \.summary\.candidates/);
  assert.match(workflow, /\.summary\.executedCandidateChecks == \.summary\.selectedCandidates/);
  assert.match(workflow, /\.summary\.executedAvailabilityChecks == \.summary\.availabilityChecks/);
  assert.match(workflow, /\.summary\.deadlineExceededAvailabilityChecks == 0/);
  assert.match(workflow, /\(\$candidateIds \| unique \| length\) == \.summary\.candidates/);
  assert.match(workflow, /\(\$candidateIds \| sort\) == \(\[\$source\.candidates\[\]\.identityKey\] \| sort\)/);
  assert.match(workflow, /all\(\.automation\.ai\[\]; \. == true\)/);
  assert.match(workflow, /--resource "https:\/\/cognitiveservices\.azure\.com\/"/);
  assert.match(workflow, /echo "::add-mask::\$token"/);
  assert.match(workflow, /AZURE_OPENAI_BEARER_TOKEN="\$token" npm run gallery:analyze:candidates/);
  assert.doesNotMatch(workflow, /AZURE_OPENAI_BEARER_TOKEN:\s*\$\{\{/);
  assert.match(workflow, /model-analysis\.json/);
  assert.match(workflow, /model-analysis-receipt\.json/);
  assert.doesNotMatch(
    workflow,
    /gallery:evaluate:model|labels\.json|evaluation-set|fixtures\/model-evaluation/,
  );
});

test("gallery proposal verification always publishes token-safe diagnostics", async () => {
  const workflow = await readWorkflow("propose-gallery-changes.yml");
  const normalizedWorkflow = workflow.replaceAll("\r\n", "\n");
  const triggers = yamlSection(normalizedWorkflow, "on");
  const dispatch = yamlSection(triggers, "workflow_dispatch", 2);
  const modelInput = yamlSection(dispatch, "model_analysis_run_id", 6);
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
  assert.match(modelInput, /^        required:\s*false\s*$/m);
  assert.match(
    normalizedWorkflow,
    /model_analysis_run_id is required when AI policy flags are enabled/,
  );
  assert.match(normalizedWorkflow, /all\(\.automation\.ai\[\]; \. == true\)/);
  assert.match(normalizedWorkflow, /"analyze-gallery-candidates\.yml"/);
  assert.match(normalizedWorkflow, /"\.github\/workflows\/analyze-gallery-candidates\.yml"/);
  assert.match(normalizedWorkflow, /"gallery-candidate-analysis-"/);
  assert.match(
    normalizedWorkflow,
    /"model-analysis\.json,model-analysis-receipt\.json"\s*\\\n\s+"true"/,
  );
  assert.match(
    normalizedWorkflow,
    /"gallery-health-report\.json,proposed-gallery-health\.json,gallery-health-receipt\.json"\s*\\\n\s*"true"/,
  );
  assert.match(
    normalizedWorkflow,
    /expected_names='\["discovery","freshness","health","modelAnalysis"\]'/,
  );
  assert.match(normalizedWorkflow, /receipt\.reportFileHash !== reportHash/);
  assert.match(
    normalizedWorkflow,
    /isDeepStrictEqual\(report\.provenance\?\.sourceDiscoveryArtifact, discovery\)/,
  );
  assert.match(normalizedWorkflow, /report\.provenance\?\.\[field\] !== model\[field\]/);
  assert.match(normalizedWorkflow, /--model-analysis "\$model_analysis"/);
  assert.match(normalizedWorkflow, /--model-analysis-receipt "\$model_analysis_receipt"/);
  assert.match(
    normalizedWorkflow,
    /health="\$\(single_file proposal-inputs\/health proposed-gallery-health\.json\)"/,
  );
  assert.match(normalizedWorkflow, /--health-report "\$health_report"/);
  assert.match(normalizedWorkflow, /--health-receipt "\$health_receipt"/);

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

test("scheduled discovery is bounded, read-only, and always initializes diagnostics before network work", async () => {
  const workflow = await readWorkflow("discover-content.yml");
  const permissions = yamlSection(workflow, "permissions");
  const discoverJob = yamlSection(workflow, "discover", 2);
  const policy = JSON.parse(await readFile(
    path.join(ROOT_DIRECTORY, ".github", "gallery-pipeline", "policy.json"),
    "utf8",
  ));
  const initializeIndex = discoverJob.indexOf("      - name: Initialize diagnostic report envelopes");
  const installIndex = discoverJob.indexOf("      - name: Install dependencies");
  const discoveryIndex = discoverJob.indexOf("      - name: Discover and gate content in report-only mode");
  const uploadIndex = discoverJob.indexOf("      - name: Upload discovery and candidate gate reports");

  assert.match(permissions, /^  contents:\s*read\s*$/m);
  assert.doesNotMatch(workflow, /contents:\s*write|pull-requests:\s*write|id-token:\s*write|\$\{\{\s*secrets\./);
  assert.match(discoverJob, /^    timeout-minutes:\s*30\s*$/m);
  assert.equal(policy.discovery.operationDeadlineSeconds, 20 * 60);
  assert.ok(
    30 * 60 - policy.discovery.operationDeadlineSeconds >= 5 * 60,
    "the operation deadline must reserve at least five minutes for finalization and upload",
  );
  for (const [name, index] of [
    ["diagnostic initialization", initializeIndex],
    ["dependency installation", installIndex],
    ["discovery", discoveryIndex],
    ["artifact upload", uploadIndex],
  ]) {
    assert.notEqual(index, -1, `Missing ${name}`);
  }
  assert.ok(initializeIndex < installIndex);
  assert.ok(installIndex < discoveryIndex);
  assert.ok(discoveryIndex < uploadIndex);
  const initializerScript = workflowStepScript(
    workflow,
    "Initialize diagnostic report envelopes",
  );
  assert.doesNotMatch(initializerScript, /discover-content\.mjs|from\s+["']\.\.?\//);
  assert.match(initializerScript, /GALLERY_DISCOVERY_DEADLINE_MILLISECONDS/);
  assert.match(discoverJob, /gallery:discover -- --dry-run --report-directory gallery-reports/);
  const uploadStep = discoverJob.slice(uploadIndex);
  assert.match(uploadStep, /^        if:\s*always\(\)\s*$/m);
  assert.match(uploadStep, /gallery-reports\/discovery\.json/);
  assert.match(uploadStep, /gallery-reports\/candidate-gates\.json/);
  assert.match(uploadStep, /^          if-no-files-found:\s*error\s*$/m);
  assert.doesNotMatch(discoverJob, /AZURE_OPENAI|gallery:analyze|--write|--apply|--mutate/);
});

test("pre-install discovery diagnostics initialize without node_modules", async () => {
  const workflow = await readWorkflow("discover-content.yml");
  const initializerScript = workflowStepScript(
    workflow,
    "Initialize diagnostic report envelopes",
  );
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "gallery-diagnostics-clean-"));
  const policyDirectory = path.join(rootDirectory, ".github", "gallery-pipeline");
  const githubEnvironmentPath = path.join(rootDirectory, "github-env.txt");
  const policy = JSON.parse(await readFile(
    path.join(ROOT_DIRECTORY, ".github", "gallery-pipeline", "policy.json"),
    "utf8",
  ));
  const before = Date.now();

  try {
    await mkdir(policyDirectory, { recursive: true });
    await writeFile(
      path.join(policyDirectory, "policy.json"),
      `${JSON.stringify(policy)}\n`,
      "utf8",
    );
    await assert.rejects(access(path.join(rootDirectory, "node_modules")));
    const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
    await execFileAsync(bash, ["-c", initializerScript], {
      cwd: rootDirectory,
      env: { ...process.env, GITHUB_ENV: githubEnvironmentPath },
    });
    const after = Date.now();

    await assert.rejects(access(path.join(rootDirectory, "node_modules")));
    const discovery = JSON.parse(await readFile(
      path.join(rootDirectory, "gallery-reports", "discovery.json"),
      "utf8",
    ));
    const candidateGates = JSON.parse(await readFile(
      path.join(rootDirectory, "gallery-reports", "candidate-gates.json"),
      "utf8",
    ));
    assert.equal(discovery.schemaVersion, "1.0.0");
    assert.equal(discovery.status, "partial");
    assert.equal(candidateGates.schemaVersion, "2.0.0");
    assert.equal(candidateGates.status, "incomplete");
    assert.equal(candidateGates.coverageStatus, "partial");
    assert.equal(discovery.mutationPerformed, false);
    assert.equal(candidateGates.mutationPerformed, false);
    const environmentLine = (await readFile(githubEnvironmentPath, "utf8")).trim();
    const deadlineMilliseconds = Number(environmentLine.split("=")[1]);
    const budgetMilliseconds = policy.discovery.operationDeadlineSeconds * 1000;
    assert.match(environmentLine, /^GALLERY_DISCOVERY_DEADLINE_MILLISECONDS=\d+$/);
    assert.ok(deadlineMilliseconds >= before + budgetMilliseconds);
    assert.ok(deadlineMilliseconds <= after + budgetMilliseconds);
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});