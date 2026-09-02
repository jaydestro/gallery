# Gallery Foundry and Cosmos DB foundation deployment plan

Status: Deployed and Active

## 1. Workload

- Mode: modify an existing GitHub Pages application with new, dedicated Azure infrastructure.
- Repository: `jaydestro/gallery`.
- Environment: development/test bed.
- Region: Central US, selected from the current common availability set for the complete stack.
- Subscription: `CosmosDB-Demos-GeneralUse`.
- Approved budget guardrail: USD 25 per month.

## 2. Scope

Deploy a dedicated Microsoft Foundry resource, one model deployment, and a serverless Azure Cosmos DB for NoSQL account that owns the canonical gallery catalog, candidate review state, and pipeline audit records. Use workload-specific identities and least-privilege data-plane roles so collection, model review, catalog publication, and chatbot reads remain separate operations. Include a phase-two Entra-protected Function API behind API Management so the GitHub Pages chatbot can query approved catalog data without receiving Azure credentials.

Generate the environment configuration contract for the existing `gallery-model-evaluation` and `gallery-candidate-analysis` environments and the new `gallery-pipeline-storage` environment. This branch does not change GitHub environment variables and performs no Azure deployment, live model evaluation, artifact persistence, catalog mutation, or publication.

## 3. Non-goals

- Direct browser access to Cosmos DB or Foundry.
- AI Search, vector indexing, chat history, user profiles, or personalization.
- A separate Azure OpenAI account.
- Unrestricted model access to Cosmos DB or automatic use of stored data outside the approved review/chatbot queries.
- Reuse or modification of unrelated Foundry or Cosmos DB resources.
- GitHub App publisher activation.
- Catalog publication, retirement, or other mutation.
- Merge to a protected or shared branch.

## 4. Architecture decisions

| Area | Decision |
| --- | --- |
| Deployment recipe | Subscription-scope Bicep invoked through Azure CLI |
| Resource isolation | New resource group `rg-cosmos-gallery-dev` |
| Foundry resource | Dedicated `Microsoft.CognitiveServices/accounts` resource with `kind: AIServices`; this is the ARM provider behind Microsoft Foundry, not a separate Azure OpenAI account |
| Selected model | `MAI-Thinking-1`, version `2026-06-01`, ARM SKU `GlobalStandard`, capacity `10`; deployment succeeded in Central US |
| Model lifecycle | Public preview, chat-completions-only; it cannot be activated unless the existing fail-closed benchmark passes |
| Model fallback | `gpt-4o-mini`, version `2024-07-18`, ARM SKU `GlobalStandard`, capacity `10`, only after a reviewed MAI benchmark failure |
| Canonical catalog | Cosmos DB database `gallery`, container `catalog-items`, partition key `/catalogPartition`; TTL is omitted so catalog items cannot expire |
| Review candidates | Container `review-candidates`, partition key `/runKey`; collector has create-only access and reviewer has read-only access |
| Review decisions | Container `review-decisions`, partition key `/runKey`; reviewer has create-only access and publisher has read-only access |
| Public projection | Container `public-catalog`, partition key `/catalogPartition`; stores approved versioned projections and one active-snapshot marker for live Pages/chatbot queries |
| Pipeline audit | Container `pipeline-records`, partition key `/runKey`; stores compact provenance, hashes, and receipts without TTL; GitHub artifacts are corroborating raw evidence subject to GitHub retention |
| Gallery API | `GET /gallery/items` reads the active committed projection through APIM and the managed Function; `static/templates.json` remains migration input and an offline fixture only |
| Chat API | `POST /gallery/chat` reads bounded context from the same committed projection and invokes Foundry |
| Authentication | GitHub OIDC to separate user-assigned identities; local/key authentication disabled |
| Runtime roles | Collector creates candidates/audit records; reviewer reads candidates/catalog and creates review decisions; publisher alone creates/replaces catalog items; chatbot API reads active catalog items and invokes Foundry |
| Network | Public endpoint required for GitHub-hosted runners, restricted to Entra authentication |
| Telemetry | Foundry and Cosmos DB diagnostics to a dedicated Log Analytics workspace; Cosmos `pipeline-records` is the durable audit authority and GitHub artifacts are corroborating evidence |
| Foundry data access | Trusted reviewer and chatbot code query only the records needed for a request and pass bounded context to Foundry; the model receives no Cosmos credentials |

## 5. GitHub trust subjects

- `repo:jaydestro@2974195/gallery@1348841742:environment:gallery-model-evaluation`
- `repo:jaydestro@2974195/gallery@1348841742:environment:gallery-candidate-analysis`
- `repo:jaydestro@2974195/gallery@1348841742:environment:gallery-pipeline-storage`
- `repo:jaydestro@2974195/gallery@1348841742:environment:gallery-publication`

Issuer: `https://token.actions.githubusercontent.com`

Audience: `api://AzureADTokenExchange`

## 6. Execution stages

1. Verify Azure context, providers, exact model/SKU availability, Cosmos DB availability, and unallocated quota.
2. Generate Bicep and deployment parameters.
3. Build, lint, security-scan, and contract-test generated source locally.
4. Mark this plan `Ready for Validation` and complete offline Azure validation.
5. Stop before online Azure validation, what-if, GitHub environment configuration, or deployment until the user gives a post-risk acknowledgement.
6. Keep live model and persistence activation disabled; validate adapters and workflow guards offline.
7. Verify catalog, split candidate/decision, public projection, and audit document contracts, optimistic concurrency, deterministic IDs, provenance hashes, and the item-size ceiling.
8. Verify `GET /gallery/items` preserves the existing UI contract with stable ordering, pagination, ETag/cache headers, and only the committed projection.
9. Seed the current 109 catalog records with create-only writes, then prove source count, Cosmos count, API count, and canonical hash parity before cutover.
10. Verify the Entra-protected chatbot API contract and APIM policies offline; deploy it only in phase two after catalog cutover succeeds.
11. Confirm deterministic workflows and local builds remain available with Foundry and Cosmos integrations disabled.

## 7. Implementation traceability

| Task | Requirement | Files | Executable proof |
| --- | --- | --- | --- |
| A1 | Define the dedicated resource group, Foundry resource, exact MAI model/version/SKU/capacity, serverless Cosmos database and five containers, workload federations, chatbot backend, diagnostics, and USD 25 budget without deploying | `infra/main.bicep`, `infra/main.bicepparam`, `infra/modules/*.bicep` | `az bicep build --file infra/main.bicep`; `node --test scripts/gallery-pipeline/infra-contract.test.mjs`; `checkov -d infra/ --framework bicep` |
| A2 | Enforce least privilege | Identity/RBAC and Cosmos modules | `node --test scripts/gallery-pipeline/infra-contract.test.mjs` asserts exact role data actions, exact OIDC subjects, disabled local auth, and absence of Contributor roles, keys, secrets, and connection strings |
| B1 | Call MAI through its documented endpoint | `scripts/gallery-pipeline/ai-analysis.mjs` | `node --test scripts/gallery-pipeline/ai-analysis.test.mjs` asserts `/mai/v1/chat/completions`, bearer auth, and documented request fields only |
| B2 | Fail closed without provider-side JSON schema | AI analysis and evaluation tests | The same test command rejects malformed JSON, fenced prose, multiple choices, tool calls, empty/truncated output, refusal, and schema mismatch |
| C1 | Make trusted model workflows MAI-aware without activation | Evaluation/candidate workflows and workflow security tests | `node --test scripts/gallery-pipeline/workflow-security.test.mjs` asserts `mai-chat`, exact OIDC boundaries, `${github.run_attempt}` artifact binding, and all enable variables false |
| D1 | Store trusted discovery candidates, review decisions, and all producer receipts after future activation | New Cosmos writers, schemas, workflows, and tests | Collector can create only in `review-candidates`/`pipeline-records`; reviewer can read candidates/catalog and create only in `review-decisions`/`pipeline-records`; conflicting duplicates fail |
| D2 | Publish approved decisions to canonical and public catalogs | Catalog publisher/API tests | Each decision binds `decisionHash`, `catalogSnapshotHash`, policy/model receipt hashes, and `operationId`; canonical create uses `If-None-Match: *`; a 409 succeeds only after a point read matches target hash and operation ID; replace uses planned ETag and any 412 fails stale; versioned public projection is staged and hash-verified before one active-snapshot marker replacement makes it visible |
| D3 | Serve one committed public projection | Function/API Management and tests | `GET /gallery/items` point-reads the active marker then selects that exact `snapshotId`; no mixed or staged snapshot is visible; response is ordered, paginated, schema-valid, and supports conditional GET |
| E1 | Migrate the current catalog without changing behavior | Seed/API scripts and tests | Migration schema `catalog-item/2.0.0`; map each legacy field plus `type`, `catalogPartition`, `publicationStatus`, `schemaVersion`, and `displayOrder`; create only; require source count = Cosmos count = API count and canonical SHA-256 parity before cutover |
| F1 | Provide bounded gallery and chatbot access | Function/API Management/Auth resources, frontend client, and tests | Browser never receives Cosmos/Foundry credentials; `GET /gallery/items` is public read-only; `POST /gallery/chat` uses APIM's overwrite-only client-IP handoff and authenticated Function counters; CORS allows only `https://jaydestro.github.io`; chat body <= 8 KiB; 20 chat requests/minute and 200/day per client IP; 30-second timeout; at most 20 context items and 800 output tokens; no chat history |

All UI layout, styling, and component structure are frozen.

## 8. Validation proof

### All validation checks pass

- [x] Bicep build: `az bicep build --file infra/main.bicep`.
- [x] Bicep parameters build: `az bicep build-params --file infra/main.bicepparam`.
- [x] Bicep lint and architecture contracts: 15 checks passed.
- [x] Compiled ARM security scan: no findings after excluding only `CKV_AZURE_101`, the documented public-endpoint requirement for GitHub-hosted runners. Local authentication remains disabled and data access is container-scoped through Entra RBAC.
- [x] TypeScript: `npx tsc --noEmit`.
- [x] Repository tests: 536 passed serially.
- [x] Function API tests: 17 passed; production dependency audit found zero vulnerabilities.
- [x] Static and live-API frontend builds passed.
- [x] Policy and catalog validation passed: 9 schemas, 5 configs, 109 active records.
- [x] Online subscription deployment validation passed against `CosmosDB-Demos-GeneralUse` (`220fc532-6091-423c-8ba0-66c2397d591b`).
- [x] Online what-if passed: 48 creates, 0 modifications, 0 deletions.
- [x] Static RBAC verification passed: four focused identity/scope checks.
- [x] Azure Policy evaluation passed effectively through full ARM validation and what-if; applicable assignments were inventoried through Azure Policy MCP.

### Validation proof

| Check | Command | Result | Timestamp |
| --- | --- | --- | --- |
| Azure CLI and target | `az account show` | Passed; exact subscription and tenant confirmed | 2026-09-02T14:51:04Z |
| Bicep compile | `az bicep build --file infra/main.bicep` | Passed | 2026-09-02T14:51:04Z |
| ARM validation | `validate-deployment.ps1 -Scope sub -Location eastus2 ...` | Passed | 2026-09-02T14:51:04Z |
| ARM what-if | Same official validation helper | Passed: Create 48, Modify 0, Delete 0 | 2026-09-02T14:51:04Z |
| Production build | `npm run build` with the planned APIM URL | Passed | 2026-09-02T14:51:04Z |
| Static RBAC | Focused `infra-contract.test.mjs` identity/role tests | Passed: 4 of 4 | 2026-09-02T14:51:04Z |
| Full tests | `npm run gallery:test -- --test-concurrency=1` | Passed: 536 of 536 | 2026-09-02T14:51:04Z |
| Function API | `npm run gallery:api:test` | Passed: 17 of 17; runtime audit 0 vulnerabilities | 2026-09-02T14:51:04Z |
| Infrastructure contracts | `node --test scripts/gallery-pipeline/infra-contract.test.mjs` | Passed: 15 of 15 | 2026-09-02T14:51:04Z |
| Compiled ARM security scan | `checkov -f infra/main.json --framework arm --skip-check CKV_AZURE_101` | Passed; only documented GitHub-hosted-runner public-endpoint exception excluded | 2026-09-02T14:51:04Z |
| Azure Policy | Policy MCP assignment inventory plus ARM validation/what-if | Passed effectively; no policy denial. Direct management-group assignment-parameter reads returned 403 with subscription-scoped identity. | 2026-09-02T14:51:04Z |
| Final Central US deployment | `az deployment sub create --name gallery-centralus-final-20260902 ...` | Passed; identity preflight resolved and principal IDs match | 2026-09-02T17:09:00Z |
| Function package | `func azure functionapp publish func-gallery-chat-dev-jgd826 --javascript --no-build` | Passed through Flex One Deploy; Function returned to disabled state | 2026-09-02T17:34:47Z |

The Entra API application and `Chat.Invoke` app-role IDs remain explicit deployment preflight parameters. Function/API activation stays disabled until those values and the deployed APIM identity are verified.

All validation gates passed. The plan is `Validated`; deployment remains separately approval-gated.

## 11. Deployment record

- Deployed 2026-09-02 to `rg-cosmos-gallery-dev` in Central US under subscription `220fc532-6091-423c-8ba0-66c2397d591b`.
- Final subscription deployment `gallery-centralus-final-20260902` succeeded; both API and Graph preflight outputs are resolved and the APIM principal matches.
- Function package deployment succeeded through Flex Consumption One Deploy and the Function was returned to its disabled state.
- Live RBAC verification passed for 11 Cosmos container-scoped assignments, three Foundry inference assignments, Function storage data roles, and Application Insights Metrics Publisher.
- Direct Function and APIM requests return 403 while the Function remains stopped.
- At initial deployment, catalog migration and API activation remained pending until the workflow's exact default-branch provenance checks passed.

### Activation completed

- The create-only migration verified 109 canonical records and 109 public projections at `sha256:5b247fd19cea8033479ef550abaa5e4156bb219907a6d5bd353b56ace75f63e9` before committing the active snapshot marker.
- The Function is enabled and APIM routes `/gallery/items` and `/gallery/chat` to the Entra-protected backend.
- Live checks passed: 109 total items, conditional GET returned 304, direct Function access returned 401, and MAI chat returned a grounded answer with a catalog citation.
- GitHub Pages is deployed in Cosmos mode using `https://apim-gallery-chat-dev-jgd826.azure-api.net` and passed desktop/mobile browser validation without horizontal overflow.
- The Microsoft tenant rejects GitHub OIDC tokens from this personal repository because they lack the required enterprise claim (`AADSTS7002381`). The one-time migration used temporary container-scoped operator roles after the workflow's exact main/SHA/provenance checks passed; both assignments were removed immediately after verification.

## 9. Activation controls

These controls remain false throughout deployment and validation:

```text
GALLERY_AUTOMATION_ENABLED=false
ENABLE_GALLERY_COSMOS_PERSISTENCE=false
ENABLE_GALLERY_COSMOS_CATALOG=false
automation.ai.*=false
automation.mutation.*=false
automation.emergencyDisable=true
```

This implementation does not enable model evaluation, candidate analysis, Cosmos persistence, or Cosmos-backed publication. Those repository variables remain false until a later reviewed activation.

## 10. Rollback

1. Disable model evaluation, candidate analysis, and Cosmos persistence independently.
2. Leave every mutation control false.
3. Remove or disable federated identity credentials if access must stop immediately.
4. Disable the model deployment if abnormal cost or safety signals persist.
5. Preserve catalog API migration evidence, review decisions, durable pipeline receipts, corroborating GitHub artifacts, and Azure diagnostics before any resource removal.
