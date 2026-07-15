# AI QA Project Recording Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add config v2, a preview-and-confirm target-project Skill workflow, and provider-neutral recording receipts while preserving `.ai-qa/` as the canonical QA workspace and keeping existing config v1 projects usable without silent migration.

**Architecture:** The global `ai-qa` Skill conducts an open-ended initialization conversation and submits a complete config plus target-project Skill. The CLI validates and previews that request, binds confirmation to repository and destination snapshots, and transactionally publishes `.ai-qa/config.yaml` with `.agents/skills/ai-qa-project/SKILL.md`. Verified reports remain immutable; a separate per-report recording journal stores only neutral status and opaque references after the host Agent executes the project procedure.

**Tech Stack:** Node.js 22 and 24, TypeScript strict mode, ESM, pnpm 11.9.0, Commander, Zod, YAML, `proper-lockfile`, `diff`, `semver`, Vitest, ESLint, and Prettier.

**Design Spec:** `docs/superpowers/specs/2026-07-15-ai-qa-project-recording-skill-design.md`

## Global Constraints

- Do not add provider enums, provider SDKs, connector credentials, command adapters, or external report-storage adapters.
- Keep `.ai-qa/` authoritative. A target-project Skill describes collaboration procedure only; receipt events never enter a terminal run journal.
- New initialization writes config schema v2 and a complete `.agents/skills/ai-qa-project/SKILL.md` together. Config v1 remains readable as effective `local-only` and is never rewritten during reads.
- Preview is read-only. Apply must receive the same stdin request plus the preview checksum, acquire the project setup lock, recompute the preview, reject stale state, stage every file, and roll back already-published files on any caught publish failure.
- Resolve and verify every target-project Skill and report path through `lstat`/`realpath`; reject symlinks, non-regular files, and non-canonical ancestors.
- Preserve the Project Skill user region byte-for-byte. Replacing an edited managed region is allowed only through a checksum-confirmed preview that shows the unified diff.
- Keep each generated Project Skill concise and project-specific: its description states only triggering conditions, its body uses imperative procedures, and it does not duplicate the global QA protocol or add auxiliary Skill files.
- Never place literal credentials in Project Skill content. The Skill may name only the environment-variable references already confirmed in config.
- The host Agent, not this CLI, owns tool selection, authentication, approvals, and external side effects.
- Once the user confirms the generated Project Skill, later runs may follow matching stable procedures without an additional `ai-qa` approval prompt; any tool/sandbox approval still comes from the host Agent.
- `local-only` creates no receipt obligation or recording files. `project-skill` begins at `pending` after a verified local report and changes only through a neutral receipt.
- `recorded` requires at least one reference; `not_recorded` requires none; `unknown` permits zero to twenty. References remain opaque and are never opened or classified.
- Receipt registration must verify a terminal run and the already generated local report while holding the same per-run report lock used for `recording.jsonl` and `recording.json`.
- A receipt must not rewrite `report.json`, `report.md`, run events, verdicts, evidence, or cases. Recording errors never change the QA verdict.
- Keep `report export --adapter project-local` backward compatible.
- Use TDD for every task. Run the focused failing test first, implement only the stated behavior, rerun the focused suite, then commit.
- Before completion run the repository TypeScript/Node quality gate and build the packaged Skill assets.

## File Map

```text
src/
|-- cli/commands/
|   |-- init.ts                              Preview/confirm init and configure
|   |-- report.ts                            Receipt and recording-status commands
|   `-- skill.ts                             Existing global plus project Skill commands
|-- core/
|   |-- config/
|   |   |-- schema.ts                        v1/v2 stored and effective config schemas
|   |   `-- repository.ts                    Read-without-rewrite migration boundary
|   |-- runs/schema.ts                       Immutable recording-mode snapshot
|   |-- recording/
|   |   |-- schema.ts                        Receipt event/artifact/status schemas
|   |   `-- repository.ts                    Locked JSONL and materialized parity
|   `-- reports/
|       `-- storage.ts                       Canonical directory/file and report lock
|-- schemas/versions.ts                      Config/protocol version constants
|-- services/
|   |-- initialization/
|   |   |-- project-setup.ts                 Request preview and checksum-confirm apply
|   |   `-- project-file-transaction.ts      Stage/publish/rollback primitive
|   |-- report-generation/
|   |   |-- generate-run-report.ts           Build plus verified persisted-report API
|   |   `-- recording-receipt.ts             Receipt registration and status service
|   `-- skill-management/
|       |-- managed-skill.ts                 Reusable metadata/region inspection
|       `-- project-skill.ts                 Project Skill validation, merge, and status
|-- skills/global/
|   |-- SKILL.md                             Work protocol 1.1 orchestration
|   `-- references/web-work-protocol.md      Local-only/project-skill completion flow
tests/
|-- helpers/project-fixture.ts                Shared config v2 and Project Skill builders
|-- unit/
|   |-- config-migration.test.ts
|   |-- project-skill.test.ts
|   |-- recording-schema.test.ts
|   `-- work-order.test.ts                   Legacy/current snapshot compatibility
|-- integration/
|   |-- init.test.ts
|   |-- project-skill.test.ts
|   |-- report-generation.test.ts
|   `-- recording-receipt.test.ts
`-- e2e/project-recording-flow.test.ts
docs/
`-- validation/project-recording-skill-eval.md Isolated RED/GREEN Skill eval evidence
```

---

### Task 1: Introduce Config v2 and Freeze Per-Run Recording Policy

**Files:**
- Modify: `src/core/config/schema.ts`
- Modify: `src/core/config/repository.ts`
- Modify: `src/core/runs/schema.ts`
- Modify: `src/schemas/versions.ts`
- Modify: `src/services/run-protocol/start-exploratory-run.ts`
- Modify: `src/services/run-protocol/start-regression-run.ts`
- Modify: `src/services/run-protocol/create-preflight-result-run.ts`
- Create: `tests/unit/config-migration.test.ts`
- Create: `tests/helpers/project-fixture.ts`
- Modify: `tests/e2e/cli-web-vertical-slice.test.ts`
- Modify: `tests/e2e/web-vertical-slice.test.ts`
- Modify: `tests/integration/case-promotion.test.ts`
- Modify: `tests/integration/doctor-cli.test.ts`
- Modify: `tests/integration/init.test.ts`
- Modify: `tests/integration/regression-replay.test.ts`
- Modify: `tests/integration/report-generation.test.ts`
- Modify: `tests/integration/run-finalize.test.ts`
- Modify: `tests/integration/run-hardening.test.ts`
- Modify: `tests/integration/run-journal.test.ts`
- Modify: `tests/unit/work-order.test.ts`

**Interfaces:**
- Consumes: On-disk config schema v1 or v2.
- Produces: `ProjectConfigV1`, `ProjectConfigV2`, `StoredProjectConfig`, `EffectiveProjectConfig`, `normalizeProjectConfig()`, `readStoredProjectConfig()`, a v2-only `projectConfigSchema` compatibility export, a non-mutating `readProjectConfig()` that always returns effective v2 semantics, and an immutable per-run recording-mode snapshot.

- [ ] **Step 1: Write the failing migration and schema tests**

Create `tests/unit/config-migration.test.ts` with complete cases for:

```ts
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import {
  normalizeProjectConfig,
  projectConfigV2Schema,
  storedProjectConfigSchema,
} from "../../src/core/config/schema.js";
import {
  readProjectConfig,
  readStoredProjectConfig,
} from "../../src/core/config/repository.js";
import { projectConfigV1, projectConfigV2 } from "../helpers/project-fixture.js";

describe("config v2 migration boundary", () => {
  it("adds local-only semantics to v1 in memory", () => {
    expect(normalizeProjectConfig(projectConfigV1())).toMatchObject({
      schemaVersion: 2,
      recordingPolicy: { mode: "local-only" },
    });
  });

  it("accepts only provider-neutral recording modes", () => {
    expect(projectConfigV2Schema.parse(projectConfigV2())).toMatchObject({
      recordingPolicy: { mode: "local-only" },
    });
    expect(() =>
      projectConfigV2Schema.parse({
        ...projectConfigV2(),
        recordingPolicy: { mode: "github" },
      }),
    ).toThrow();
  });

  it("reads v1 as effective v2 without rewriting disk bytes", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-config-v1-"));
    await mkdir(join(projectRoot, ".ai-qa"));
    const path = join(projectRoot, ".ai-qa", "config.yaml");
    const bytes = stringify(projectConfigV1(), { sortMapEntries: true });
    await writeFile(path, bytes);

    await expect(readStoredProjectConfig(projectRoot)).resolves.toMatchObject({
      schemaVersion: 1,
    });
    await expect(readProjectConfig(projectRoot)).resolves.toMatchObject({
      schemaVersion: 2,
      recordingPolicy: { mode: "local-only" },
    });
    expect(await readFile(path, "utf8")).toBe(bytes);
  });

  it("rejects unknown stored schema versions", () => {
    expect(() =>
      storedProjectConfigSchema.parse({
        ...projectConfigV2(),
        schemaVersion: 3,
      }),
    ).toThrow();
  });
});
```

Add `tests/helpers/project-fixture.ts` with builders returning fresh objects. The exact config type surface is:

```ts
export const recordingModeSchema = z.enum(["local-only", "project-skill"]);

export const projectConfigV1Schema = projectConfigFields.extend({
  schemaVersion: z.literal(1),
});

export const projectConfigV2Schema = projectConfigFields.extend({
  schemaVersion: z.literal(2),
  recordingPolicy: z.object({ mode: recordingModeSchema }),
});

export const storedProjectConfigSchema = z.discriminatedUnion(
  "schemaVersion",
  [projectConfigV1Schema, projectConfigV2Schema],
);

export const projectConfigSchema = projectConfigV2Schema;

export type ProjectConfigV1 = z.infer<typeof projectConfigV1Schema>;
export type ProjectConfigV2 = z.infer<typeof projectConfigV2Schema>;
export type StoredProjectConfig = z.infer<typeof storedProjectConfigSchema>;
export type EffectiveProjectConfig = ProjectConfigV2;
export type ProjectConfig = ProjectConfigV2;
```

The shared fixture builders are complete, fresh-object factories rather than exported mutable constants:

```ts
import type {
  ProjectConfigV1,
  ProjectConfigV2,
} from "../../src/core/config/schema.js";

function projectFields() {
  return {
    project: { id: "sample-web", name: "Sample Web" },
    targets: { web: { entryUrl: "http://127.0.0.1:3000" } },
    environments: {},
    tools: { web: { controller: "chrome-devtools-mcp" as const } },
    evidencePolicy: {
      screenshots: "required" as const,
      defaultSensitivity: "internal" as const,
      retentionDays: 30,
    },
    reportPolicy: {
      formats: ["markdown", "json"] as ("markdown" | "json")[],
      audience: "engineering",
      detail: "full" as const,
    },
    storagePolicy: { adapter: "project-local" as const },
    gitPolicy: { config: "track" as const, artifacts: "ignore" as const },
    ciPolicy: { nonPassExit: "failure" as const },
    secretReferences: { login: "QA_TEST_PASSWORD" },
  };
}

export function projectConfigV1(): ProjectConfigV1 {
  return { schemaVersion: 1, ...projectFields() };
}

export function projectConfigV2(
  mode: "local-only" | "project-skill" = "local-only",
): ProjectConfigV2 {
  return {
    schemaVersion: 2,
    ...projectFields(),
    recordingPolicy: { mode },
  };
}
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run:

```bash
pnpm vitest run tests/unit/config-migration.test.ts
```

Expected: FAIL because the v2 schemas, normalization function, repository reader, and fixture builders do not exist.

- [ ] **Step 3: Implement schemas and the read-only migration boundary**

Factor the unchanged config fields into `projectConfigFields`. Implement normalization exactly as:

```ts
export function normalizeProjectConfig(
  config: StoredProjectConfig,
): EffectiveProjectConfig {
  if (config.schemaVersion === 2) return config;
  const { schemaVersion, ...fields } = config;
  void schemaVersion;
  return projectConfigV2Schema.parse({
    ...fields,
    schemaVersion: 2,
    recordingPolicy: { mode: "local-only" },
  });
}
```

`readStoredProjectConfig()` must parse the exact disk representation. `readProjectConfig()` must call it and normalize in memory. `createProjectConfig()` and `writeProjectConfig()` must serialize only `ProjectConfigV2`. Keep the existing `projectConfigSchema` export as an explicit alias of `projectConfigV2Schema`; it must never alias the stored v1/v2 union. This makes all existing imports v2-only immediately and ensures public init cannot accept v1 after Task 1.

Update `CONFIG_SCHEMA_VERSION` to `2`. Leave `WORK_PROTOCOL_VERSION` at `1.0.0` only to keep run/work-order protocol tests and the installed 1.0.0 runtime flow coherent during intermediate commits. This is not a claim that the old Skill can drive the new v2 init/configure request surface; Task 4 replaces that public workflow.

- [ ] **Step 4: Freeze recording mode in every new work order**

Add an optional provider-neutral snapshot to the strict work-order schema without changing `WORK_ORDER_SCHEMA_VERSION`:

```ts
recordingPolicy: z
  .object({ mode: z.enum(["local-only", "project-skill"]) })
  .strict()
  .optional(),
```

Every new exploratory, regression, and preflight work order must include `recordingPolicy: config.recordingPolicy`. Add:

```ts
export function effectiveWorkOrderRecordingMode(
  workOrder: WorkOrder,
): "local-only" | "project-skill" {
  return workOrder.recordingPolicy?.mode ?? "local-only";
}
```

The optional field preserves the canonical hash of old work orders: parsing an absent optional field must not insert a default. Unit tests must prove a legacy work order without the field remains byte/hash stable and derives `local-only`, while new work orders retain the config mode even after config changes.

- [ ] **Step 5: Move all active test fixtures to config v2**

Replace every config fixture found by:

```bash
rg -n "schemaVersion:\s*1|storagePolicy" tests --glob '*.ts'
```

Only project config literals change to `schemaVersion: 2` plus `recordingPolicy: { mode: "local-only" }`. Case, event, evidence, report, trust, and work-order schema versions remain `1`. Use `projectConfigV2()` in new tests; retain `projectConfigV1()` only for explicit migration coverage.

- [ ] **Step 6: Verify config and snapshot behavior**

Run:

```bash
pnpm vitest run tests/unit/config-migration.test.ts tests/unit/work-order.test.ts tests/integration/init.test.ts tests/integration/doctor-cli.test.ts tests/integration/run-journal.test.ts
pnpm typecheck
```

Expected: PASS. The v1 test must also prove unchanged on-disk bytes.

- [ ] **Step 7: Commit**

```bash
git add src/core/config src/core/runs/schema.ts src/schemas/versions.ts src/services/run-protocol/start-exploratory-run.ts src/services/run-protocol/start-regression-run.ts src/services/run-protocol/create-preflight-result-run.ts tests/helpers/project-fixture.ts tests/unit/config-migration.test.ts tests/unit/work-order.test.ts tests/e2e tests/integration
git commit -m "feat: add provider-neutral config v2"
```

---

### Task 2: Validate and Merge the Target-Project Skill

**Files:**
- Modify: `src/services/skill-management/managed-skill.ts`
- Create: `src/services/skill-management/project-skill.ts`
- Create: `tests/unit/project-skill.test.ts`
- Modify: `tests/unit/managed-skill.test.ts`

**Interfaces:**
- Consumes: A host-generated complete `SKILL.md`, optional installed bytes, and config secret-reference names.
- Produces: `projectSkillRequestSchema`, `prepareProjectSkill()`, `inspectProjectSkill()`, `projectSkillDestination()`, and `ProjectSkillStatus` without reading untrusted project content.

- [ ] **Step 1: Write failing Project Skill validation tests**

Cover these exact behaviors in `tests/unit/project-skill.test.ts`:

- fixed frontmatter name `ai-qa-project`;
- `aiQaProjectSkillVersion: 1.0.0` and a semver `aiQaProtocolRange` containing `1.1.0`;
- exactly one ordered managed/user marker pair;
- byte-for-byte preservation of an installed CRLF user region;
- edited managed content returns `requiresManagedReplacement: true` and a unified diff;
- `password: literal-value`, embedded URL credentials, bearer tokens, and PEM private keys are rejected;
- `${QA_TEST_PASSWORD}` is accepted only when `QA_TEST_PASSWORD` occurs in `config.secretReferences` values;
- no provider name or provider enum is required; passing an arbitrary local Markdown-table procedure to `projectSkillSource()` is accepted.
- a trigger-only `Use when ...` description is required, and bodies over 500 lines or 5,000 words are rejected.

Use this complete valid fixture shape:

```ts
export function projectSkillSource(
  recordingProcedure: string =
    "No additional project record is required; the verified local report completes the workflow.",
): string {
  return `---
name: ai-qa-project
description: Use when performing AI QA work in this target project, including startup, authentication, evidence, reports, or result recording.
metadata:
  aiQaProjectSkillVersion: 1.0.0
  aiQaProtocolRange: ^1.1.0
  aiQaManagedChecksum: generated
---
<!-- ai-qa:managed:start -->
# Project AI QA Procedures

## Startup and environment

Run the existing local development command documented by the project.

## Authentication and test data

Read credentials only from \${QA_TEST_PASSWORD}; never persist the value.

## Navigation and platform constraints

Start at the configured Web entry URL and prefer stable test IDs.

## Evidence, privacy, and reports

Follow config sensitivity, retention, and local report policy.

## Project result recording

${recordingProcedure}
<!-- ai-qa:managed:end -->
<!-- ai-qa:user:start -->
<!-- ai-qa:user:end -->
`;
}
```

- [ ] **Step 2: Confirm the focused test fails**

Run:

```bash
pnpm vitest run tests/unit/project-skill.test.ts tests/unit/managed-skill.test.ts
```

Expected: FAIL because project-specific validation and reusable managed-skill inspection do not exist.

- [ ] **Step 3: Expose safe managed-skill inspection**

Export an immutable metadata/region view from `managed-skill.ts` rather than parsing YAML twice:

```ts
export interface ManagedSkillInspection {
  name: string;
  description: string;
  metadata: Readonly<Record<string, unknown>>;
  managed: string;
  user: string;
  managedChecksum: string;
  recordedManagedChecksum: unknown;
}

export function inspectManagedSkill(content: string): ManagedSkillInspection;
```

The common managed-skill frontmatter parser must require only valid `name`, `description`, a metadata mapping, and `aiQaManagedChecksum`; it must not require `aiQaSkillVersion`, because target-project Skills use `aiQaProjectSkillVersion`. Global and project validators separately enforce their own version/capability fields.

Keep `mergeManagedSkill()` behavior compatible with the global Skill tests. The computed checksum excludes `aiQaManagedChecksum`, normalizes managed-region CRLF for hashing, and never normalizes installed user bytes.

- [ ] **Step 4: Implement Project Skill validation and merge preparation**

Use these public types:

```ts
export const projectSkillRequestSchema = z.object({
  reason: z.string().trim().min(1).max(4096),
  content: z.string().min(1).max(262144),
});

export interface PreparedProjectSkill {
  content: string;
  managedChecksum: string;
  changed: boolean;
  requiresManagedReplacement: boolean;
  unifiedDiff: string;
}

export type ProjectSkillStatus =
  | { status: "compatible"; destination: string }
  | { status: "missing"; destination: string }
  | { status: "conflict"; destination: string }
  | { status: "incompatible"; destination: string };
```

`prepareProjectSkill()` must validate source metadata, protocol compatibility, fixed name, markers, and high-confidence literal-secret signals before calling `mergeManagedSkill()`. Secret-assignment values are accepted only as `${ENV_NAME}` where `ENV_NAME` is one of the supplied config values. Return a diff from installed bytes to proposed bytes. `inspectProjectSkill()` validates the installed recorded checksum and protocol without writing.

Also require the description to begin with `Use when`, stay within the Agent Skills 1,024-character frontmatter limit, and describe triggering contexts rather than command steps. Reject a generated body over 500 lines or 5,000 words so project-specific detail cannot crowd out the host task. The approved artifact contract is exactly one `SKILL.md`; do not generate `README.md`, `agents/openai.yaml`, scripts, assets, or references for the target project.

Do not call the personal-skill `init_skill.py` from product runtime: the user fixed the destination and approved a host-generated, project-specific file plus CLI preview/transaction semantics. The repository's parser and tests are the deterministic scaffold/validator for this dynamic artifact.

`projectSkillDestination(projectRoot)` returns the canonical relative destination `.agents/skills/ai-qa-project/SKILL.md`; filesystem verification is added in Task 3.

- [ ] **Step 5: Verify and commit**

Run:

```bash
pnpm vitest run tests/unit/project-skill.test.ts tests/unit/managed-skill.test.ts tests/integration/global-skill.test.ts
pnpm typecheck
```

Expected: PASS, including all unchanged global Skill merge tests.

```bash
git add src/services/skill-management tests/unit/project-skill.test.ts tests/unit/managed-skill.test.ts
git commit -m "feat: validate target project skills"
```

---

### Task 3: Build Read-Only Preview, Checksum Binding, and File Transaction

**Files:**
- Create: `src/services/initialization/project-file-transaction.ts`
- Create: `src/services/initialization/project-setup.ts`
- Create: `tests/integration/project-skill.test.ts`
- Modify: `src/core/fs/project-storage.ts`

**Interfaces:**
- Consumes: A trusted canonical project root, operation, complete v2 config and Project Skill request, optional installed config/Skill, and confirmation checksum.
- Produces: A full read-only `ProjectSetupPreview` and an apply operation that revalidates and either publishes every requested file or restores original bytes.

- [ ] **Step 1: Write failing preview and transaction tests**

Add integration cases for:

1. preview creates no `.ai-qa`, `.agents`, temp, backup, or lock residue;
2. preview returns the full normalized config, full merged Skill, exact paths, unified diffs, destination snapshots, and `sha256:` checksum;
3. changing request content after preview causes `setup.checksum_mismatch` and no writes;
4. changing either destination after preview causes the same stale-preview error;
5. a symlink at `.agents`, `skills`, `ai-qa-project`, or `SKILL.md` is rejected before reading or writing outside the project;
6. a fault injected before the second publish restores the exact original config and user-region bytes and removes the first newly published file;
7. concurrent apply attempts serialize; exactly one wins and the other receives stale/already-initialized state;
8. transaction cleanup removes only owned staging/backup files and never an identically named unowned fixture.

The checksum payload must be asserted against this public shape:

```ts
export interface DestinationSnapshot {
  relativePath: string;
  state: "missing" | "regular";
  identity?: {
    device: string;
    inode: string;
    size: string;
    modifiedNanoseconds: string;
  };
  contentSha256?: string;
}

export interface ProjectSetupPreview {
  schemaVersion: 1;
  operation: "init" | "configure" | "skill-generate" | "skill-sync";
  projectRoot: string;
  configPath: ".ai-qa/config.yaml";
  projectSkillPath: ".agents/skills/ai-qa-project/SKILL.md";
  writePaths: (
    | ".ai-qa/config.yaml"
    | ".agents/skills/ai-qa-project/SKILL.md"
  )[];
  config: ProjectConfigV2;
  projectSkill: {
    reason: string;
    content: string;
    requiresManagedReplacement: boolean;
  };
  destinations: DestinationSnapshot[];
  unifiedDiff: string;
  checksum: string;
}
```

- [ ] **Step 2: Run the focused suite and confirm failure**

Run:

```bash
pnpm vitest run tests/integration/project-skill.test.ts
```

Expected: FAIL because preview and transaction services do not exist.

- [ ] **Step 3: Add optional canonical path inspection without mutation**

Extend `project-storage.ts` with functions that distinguish missing from unsafe without creating ancestors:

```ts
export interface OptionalProjectLocalFile {
  path: string;
  state: "missing" | "regular";
  content?: string;
  stats?: {
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
  };
}

export function inspectOptionalProjectLocalRegularFile(
  projectRoot: string,
  segments: readonly string[],
): Promise<OptionalProjectLocalFile>;
```

Walk existing ancestors with `lstat` and `realpath`. A missing ancestor means `missing`; any symlink or non-directory means `storage.integrity_error`. Never call `mkdir` from this read path.

- [ ] **Step 4: Implement deterministic preview**

Define the request schema and checksum input exactly:

```ts
export const initializationRequestSchema = z.object({
  config: projectConfigV2Schema,
  projectSkill: projectSkillRequestSchema,
});

export interface InitializationRequest {
  config: ProjectConfigV2;
  projectSkill: z.infer<typeof projectSkillRequestSchema>;
}

const checksum = sha256Canonical({
  schemaVersion: 1,
  operation,
  repository: {
    canonicalPath: identity.canonicalPath,
    fingerprint: identity.fingerprint,
  },
  request: effectiveRequest,
  targetPaths: [configRelativePath, projectSkillRelativePath],
  destinations,
});
```

For `configure`, replace the submitted project ID with the stored project ID before displaying or hashing the effective request. Preview must include complete proposed bytes and a unified diff for every changed existing file. It must not include absolute paths inside the canonical request except the separately displayed canonical project root.

- [ ] **Step 5: Implement staged publish and caught-failure rollback**

Use this narrow transaction surface so integration tests can inject one deterministic publish fault:

```ts
export interface ProjectFileWrite {
  relativeSegments: readonly string[];
  content: string;
}

export interface ProjectFileTransactionHooks {
  beforePublish?: (input: {
    relativePath: string;
    publishIndex: number;
  }) => Promise<void>;
}

export async function applyProjectFileTransaction(input: {
  projectRoot: string;
  writes: readonly ProjectFileWrite[];
  hooks?: ProjectFileTransactionHooks;
}): Promise<void>;
```

`applyProjectSetup()` creates/verifies `.ai-qa`, acquires `proper-lockfile` on that real directory, and retains the lock through preview recomputation and transaction cleanup. With that caller-held lock, `applyProjectFileTransaction()` validates all destinations, creates required real directories, writes and `fsync`s owned stage files, creates owned backups for existing regular files, then publishes in deterministic path order. On a caught error, it restores published destinations in reverse order from backups or removes files created by this transaction. It always removes owned stage/backup files in `finally`. It never uses `rm` on a path not recorded as transaction-owned.

`applyProjectSetup()` must recompute the entire preview under the lock, compare with `confirmChecksum`, then call the transaction. Init also creates canonical `cases`, `runs`, `evidence`, and `reports/runs` directories before publish; directory residue is allowed, but partial config or Skill files are not.

- [ ] **Step 6: Verify and commit**

Run:

```bash
pnpm vitest run tests/integration/project-skill.test.ts tests/unit/project-storage.test.ts tests/unit/fs-integrity.test.ts
pnpm typecheck
```

Expected: PASS. The injected second-publish failure must leave both destination bytes exactly as they were before apply.

```bash
git add src/core/fs/project-storage.ts src/services/initialization tests/integration/project-skill.test.ts
git commit -m "feat: add checksum confirmed project setup"
```

---

### Task 4: Wire Init, Configure, Generate, Check, and Sync Commands

**Files:**
- Modify: `src/cli/commands/init.ts`
- Modify: `src/cli/commands/skill.ts`
- Modify: `src/services/initialization/initialize-project.ts`
- Modify: `tests/helpers/project-fixture.ts`
- Modify: `tests/e2e/web-vertical-slice.test.ts`
- Modify: `tests/integration/case-promotion.test.ts`
- Modify: `tests/integration/doctor-cli.test.ts`
- Modify: `tests/integration/init.test.ts`
- Modify: `tests/integration/project-skill.test.ts`
- Modify: `tests/integration/regression-replay.test.ts`
- Modify: `tests/integration/report-generation.test.ts`
- Modify: `tests/integration/run-finalize.test.ts`
- Modify: `tests/integration/run-hardening.test.ts`
- Modify: `tests/integration/run-journal.test.ts`
- Modify: `tests/cli/help.test.ts`

**Interfaces:**
- Consumes: Global `--project`, `--stdin-json`, and exactly one of `--preview` or `--confirm-checksum <sha256>`.
- Produces: JSON previews/applied results for init/configure/project Skill mutations while preserving all existing `skill ... --global` behavior.

- [ ] **Step 1: Add failing CLI contract tests**

Test the exact command surface:

```text
ai-qa --project <target> init --stdin-json --preview
ai-qa --project <target> init --stdin-json --confirm-checksum <sha256>
ai-qa --project <target> configure --stdin-json --preview
ai-qa --project <target> configure --stdin-json --confirm-checksum <sha256>
ai-qa --project <target> skill generate --stdin-json --preview
ai-qa --project <target> skill generate --stdin-json --confirm-checksum <sha256>
ai-qa --project <target> skill check
ai-qa --project <target> skill sync --stdin-json --preview
ai-qa --project <target> skill sync --stdin-json --confirm-checksum <sha256>
```

Assert:

- neither confirmation option returns `setup.confirmation_required`;
- both options are rejected by Commander as conflicting;
- confirmation resubmits and validates stdin rather than loading hidden preview state;
- init rejects config v1 input;
- configure migrates v1 only after preview/confirm and preserves project ID;
- refusing migration leaves original v1 config bytes and all existing artifacts unchanged;
- `skill generate` is create-only and `skill sync` is update-only;
- `skill check` is read-only and returns `compatible`, `missing`, `conflict`, or `incompatible` with a nonzero exit for non-compatible states;
- existing `skill install|sync|check --global` tests remain unchanged in behavior.

- [ ] **Step 2: Confirm CLI tests fail**

Run:

```bash
pnpm vitest run tests/integration/init.test.ts tests/integration/project-skill.test.ts tests/integration/global-skill.test.ts tests/cli/help.test.ts
```

Expected: FAIL because the new flags and project Skill commands are not registered.

- [ ] **Step 3: Implement a shared confirmation-option guard**

Use this exact option model in both command modules:

```ts
interface PreviewConfirmationOptions {
  stdinJson: boolean;
  preview?: boolean;
  confirmChecksum?: string;
}

function requestedSetupAction(
  options: PreviewConfirmationOptions,
): { kind: "preview" } | { kind: "apply"; checksum: string } {
  if (options.preview === true && options.confirmChecksum !== undefined) {
    throw new AiQaError(
      "setup.conflicting_confirmation",
      "Use either --preview or --confirm-checksum, not both",
    );
  }
  if (options.preview === true) return { kind: "preview" };
  if (options.confirmChecksum !== undefined) {
    return { kind: "apply", checksum: options.confirmChecksum };
  }
  throw new AiQaError(
    "setup.confirmation_required",
    "Preview the complete change or provide its confirmed checksum",
  );
}
```

The checksum parser must require `^sha256:[a-f0-9]{64}$`. All commands resolve and verify machine trust before reading existing config or Project Skill.

- [ ] **Step 4: Route init/configure through project setup**

Replace direct config writes in public CLI commands. Preview prints `ProjectSetupPreview`. Apply prints:

```ts
interface AppliedProjectChange {
  projectRoot: string;
  operation: "init" | "configure" | "skill-generate" | "skill-sync";
  configPath: ".ai-qa/config.yaml";
  projectSkillPath: ".agents/skills/ai-qa-project/SKILL.md";
  writePaths: (
    | ".ai-qa/config.yaml"
    | ".agents/skills/ai-qa-project/SKILL.md"
  )[];
  checksum: string;
  recordingMode: "local-only" | "project-skill";
  createdDirectories: string[];
}
```

For init, `writePaths` contains config then Project Skill and `createdDirectories` contains `cases`, `runs`, `evidence`, and `reports/runs`. Configure writes both files with an empty created-directory list. Skill generate/sync writes only the Project Skill.

Retire direct production use of config-only `initializeProject()`. Keep one typed initialization service that requires the complete request so no production API can initialize config v2 without its target-project Skill.

Configure is intentionally full-state, not PATCH-like: it must receive complete config plus complete Project Skill request on every preview/apply. This keeps cross-file invariants, checksum binding, and managed/user merge inside one transaction; do not add a config-only compatibility branch.

Add this test-only convenience wrapper to `tests/helpers/project-fixture.ts` and replace every direct config-only setup in the listed E2E/integration files:

```ts
export async function initializeTestProject(input: {
  projectRoot: string;
  aiQaHome: string;
  config?: ProjectConfigV2;
}): Promise<void> {
  const request = {
    config: input.config ?? projectConfigV2(),
    projectSkill: {
      reason: "Test fixture project procedures",
      content: projectSkillSource(),
    },
  };
  const preview = await previewProjectSetup({
    operation: "init",
    projectRoot: input.projectRoot,
    aiQaHome: input.aiQaHome,
    request,
  });
  await applyProjectSetup({
    operation: "init",
    projectRoot: input.projectRoot,
    aiQaHome: input.aiQaHome,
    request,
    confirmChecksum: preview.checksum,
  });
}
```

Move `projectSkillSource()` from the Task 2 unit fixture into the shared helper and import it from the unit test. Keep explicit low-level transaction tests on `previewProjectSetup()`/`applyProjectSetup()` rather than the convenience wrapper.

- [ ] **Step 5: Route project Skill commands through the same preview/checksum primitive**

Project-only request stdin is:

```ts
const projectSkillMutationRequestSchema = z.object({
  projectSkill: projectSkillRequestSchema,
});
```

For project `generate` and `sync`, bind the preview checksum to the current effective config and Skill destination snapshot even though only `SKILL.md` is written. `generate` requires missing destination; `sync` requires an installed destination. The project `check` command performs no stdin read and no write.

- [ ] **Step 6: Verify and commit**

Run:

```bash
pnpm vitest run tests/integration/init.test.ts tests/integration/project-skill.test.ts tests/integration/global-skill.test.ts tests/cli/help.test.ts
pnpm typecheck
```

Expected: PASS.

```bash
git add src/cli/commands/init.ts src/cli/commands/skill.ts src/services/initialization/initialize-project.ts tests/helpers/project-fixture.ts tests/e2e/web-vertical-slice.test.ts tests/integration/case-promotion.test.ts tests/integration/doctor-cli.test.ts tests/integration/init.test.ts tests/integration/project-skill.test.ts tests/integration/regression-replay.test.ts tests/integration/report-generation.test.ts tests/integration/run-finalize.test.ts tests/integration/run-hardening.test.ts tests/integration/run-journal.test.ts tests/cli/help.test.ts
git commit -m "feat: preview and confirm project skill setup"
```

---

### Task 5: Extract the Per-Run Report Storage and Verification Boundary

**Files:**
- Create: `src/core/reports/storage.ts`
- Modify: `src/services/report-generation/generate-run-report.ts`
- Modify: `tests/integration/report-generation.test.ts`

**Interfaces:**
- Consumes: Trusted project root, validated run ID, and generated report artifacts.
- Produces: One canonical report-directory resolver, one per-run report lock, and a callback API that verifies an existing generated report while holding that lock.

- [ ] **Step 1: Add failing refactor-characterization tests**

Add tests proving:

- `generateRunReport()` and `exportProjectLocalRunReport()` still reject symlinked report ancestors/artifacts;
- export still returns `report.not_generated` before attempting a lock on a missing directory;
- `withVerifiedGeneratedRunReport()` calls its callback only after JSON/Markdown bytes match current terminal run state;
- a callback sees the canonical report directory and effective config;
- existing generated JSON/Markdown bytes are unchanged by a read-only verified callback.

- [ ] **Step 2: Confirm the new API is missing**

Run:

```bash
pnpm vitest run tests/integration/report-generation.test.ts -t "verified generated report boundary"
```

Expected: FAIL because the callback API does not exist.

- [ ] **Step 3: Extract storage without changing report semantics**

Move the existing `verifiedReportDirectory()`, `requireRegularReportFile()`, and `withReportLock()` logic to `src/core/reports/storage.ts` under these names:

```ts
export function resolveRunReportDirectory(input: {
  projectRoot: string;
  runId: string;
  create: boolean;
}): Promise<string>;

export function requireRunReportRegularFile(input: {
  directory: string;
  filename: "report.json" | "report.md" | "recording.jsonl" | "recording.json";
  runId: string;
  missingCode: "report.not_generated" | "recording.not_found";
}): Promise<string>;

export function withRunReportLock<T>(
  directory: string,
  operation: () => Promise<T>,
): Promise<T>;
```

Keep report-specific error messages in `generate-run-report.ts`; storage errors retain stable codes.

- [ ] **Step 4: Expose verified persisted-report callback**

Add:

```ts
export interface VerifiedGeneratedRunReport {
  projectRoot: string;
  config: EffectiveProjectConfig;
  recordingMode: "local-only" | "project-skill";
  report: RunReport;
  directory: string;
  paths: ProjectLocalReportPaths;
}

export async function withVerifiedGeneratedRunReport<T>(
  input: ReportOperationInput,
  operation: (verified: VerifiedGeneratedRunReport) => Promise<T>,
): Promise<T>;
```

It must build and verify current terminal state, derive `recordingMode` only from `effectiveWorkOrderRecordingMode(workOrder)`, require an existing report directory, acquire the per-run report lock, compare configured report artifacts, then invoke the callback before releasing the lock. Current config remains available for report formats/audience but must not reclassify an existing run's recording obligation. Refactor export to call this boundary. Generation uses the extracted directory/lock but still creates configured report files.

`report export --adapter project-local` remains report-only: it verifies and returns configured `report.json`/`report.md` paths and never includes `recording.jsonl` or `recording.json`. Recording state is queried only through `report recording-status`.

- [ ] **Step 5: Verify no behavior regression and commit**

Run:

```bash
pnpm vitest run tests/integration/report-generation.test.ts tests/e2e/web-vertical-slice.test.ts
pnpm typecheck
```

Expected: PASS.

```bash
git add src/core/reports/storage.ts src/services/report-generation/generate-run-report.ts tests/integration/report-generation.test.ts
git commit -m "refactor: expose verified report storage boundary"
```

---

### Task 6: Add Neutral Receipt Schemas and Recoverable Materialization

**Files:**
- Create: `src/core/recording/schema.ts`
- Create: `src/core/recording/repository.ts`
- Modify: `src/core/ids.ts`
- Create: `tests/unit/recording-schema.test.ts`
- Create: `tests/integration/recording-receipt.test.ts`

**Interfaces:**
- Consumes: Validated receipt payloads and an already-held canonical report directory lock.
- Produces: Append-only canonical `RecordingEvent` history, deterministic/recoverable `RecordingArtifact` materialization, idempotent registration, and integrity-checked reads.

- [ ] **Step 1: Write failing schema tests**

Test all boundaries:

- idempotency key regex `^[A-Za-z0-9._:-]{1,128}$`;
- zero, one, and 128 character key edges;
- an empty reference string rejected and a one-code-point reference accepted;
- 20 references accepted and 21 rejected;
- 2,048 Unicode code points accepted and 2,049 rejected, including astral characters counted as one code point;
- C0, DEL, C1, CR, and LF rejected;
- `recorded` requires one or more references;
- `not_recorded` requires an empty array;
- `unknown` accepts empty or populated references;
- unknown object keys are rejected.

Use these exact schemas and types:

```ts
export const recordingIdempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,128}$/u);
export const recordingEventIdSchema = z
  .string()
  .regex(/^recording-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
export const recordingReferenceSchema = z.string().superRefine((value, context) => {
  const codePointLength = [...value].length;
  if (
    codePointLength < 1 ||
    codePointLength > 2048 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    context.addIssue({
      code: "custom",
      message: "Recording references require 1-2048 non-control Unicode code points",
    });
  }
});

const receiptFields = {
  idempotencyKey: recordingIdempotencyKeySchema,
  status: z.enum(["recorded", "not_recorded", "unknown"]),
  references: z.array(recordingReferenceSchema).max(20),
};

export const recordingReceiptInputSchema = z
  .object(receiptFields)
  .strict()
  .superRefine(validateStatusReferences);

export const recordingEventSchema = z
  .object({
    ...receiptFields,
    schemaVersion: z.literal(1),
    eventId: recordingEventIdSchema,
    runId: runIdSchema,
    recordedAt: z.string().datetime(),
  })
  .strict()
  .superRefine(validateStatusReferences);

export const recordingArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  runId: runIdSchema,
  current: z.object({
    eventId: recordingEventIdSchema,
    status: z.enum(["recorded", "not_recorded", "unknown"]),
    references: z.array(recordingReferenceSchema).max(20),
  }),
  history: z.array(
    z.object({
      eventId: recordingEventIdSchema,
      recordedAt: z.string().datetime(),
      idempotencyKey: recordingIdempotencyKeySchema,
      status: z.enum(["recorded", "not_recorded", "unknown"]),
      references: z.array(recordingReferenceSchema).max(20),
    }),
  ),
  materializedAt: z.string().datetime(),
});
```

- [ ] **Step 2: Confirm schema/repository tests fail**

Run:

```bash
pnpm vitest run tests/unit/recording-schema.test.ts tests/integration/recording-receipt.test.ts -t "recording repository"
```

Expected: FAIL because recording files and APIs do not exist.

- [ ] **Step 3: Implement pure validation and materialization**

Use `/[\u0000-\u001f\u007f-\u009f]/u` for forbidden controls and `[...value].length` for Unicode code points. Add `"recording"` to `createId()` prefixes.

Implement:

```ts
export function materializeRecordingArtifact(input: {
  runId: string;
  events: readonly RecordingEvent[];
}): RecordingArtifact;

export function classifyRecordingMaterialization(input: {
  events: readonly RecordingEvent[];
  artifact: RecordingArtifact;
}): "current" | "recoverable" | "conflict";
```

Materialization rejects an empty event list. History preserves journal order exactly; current is the final event. The repository uses the final event's `recordedAt` as `materializedAt`. Classification is `current` only when the artifact is canonical-equal to a fresh materialization, `recoverable` when journal history is a strict extension or only derived fields differ, and `conflict` when artifact history is ahead of or not an exact prefix of canonical journal events.

- [ ] **Step 4: Implement the lock-aware repository**

The service in Task 7 owns report verification and locking. The repository therefore exposes only explicitly unlocked methods whose names make the precondition visible:

```ts
export class RecordingRepository {
  constructor(
    private readonly directory: string,
    private readonly runId: string,
    private readonly now: () => Date,
  ) {}

  readOrRecoverUnlocked(): Promise<
    | { state: "missing" }
    | { state: "present"; events: RecordingEvent[]; artifact: RecordingArtifact }
  >;

  registerUnlocked(
    receipt: RecordingReceiptInput,
  ): Promise<{
    event: RecordingEvent;
    artifact: RecordingArtifact;
    replayed: boolean;
  }>;
}
```

Treat `recording.jsonl` as canonical and `recording.json` as a deterministic materialized view:

- both missing returns `missing`;
- a valid journal with a missing, invalid, or strictly lagging materialized view rewrites `recording.json` from journal events and returns `present`;
- a journal missing while a materialized view exists is `recording.integrity_error`;
- an invalid journal, run-ID mismatch, materialized history ahead of the journal, or any shared-event content/order contradiction is `recording.integrity_error`.

Recovery occurs only inside the caller-held per-run report lock. It does not infer external success: it reproduces only events already present in the valid canonical journal. Add repository tests that manually create the normal crash state—valid `recording.jsonl` with no `recording.json`—then prove `readOrRecoverUnlocked()` materializes the exact view. Add a second test where retrying the same receipt after that recovery returns the original event with `replayed: true`. Also cover a one-event-lagging view recovery and ahead/conflicting views as integrity failures.

This makes `recording-status` logically read-only but permits one deterministic local repair side effect under lock. Tests must prove recovery changes only `recording.json`; it never changes `recording.jsonl`, report bytes, run journal bytes, verdict, or external state.

On register, call `readOrRecoverUnlocked()` first. Same key and canonical-equal payload returns the original event/artifact with `replayed: true` and no journal write. Same key with different status/references throws `recording.idempotency_conflict`. A new key appends one event, atomically writes newline-terminated `recording.jsonl`, then atomically writes `recording.json` while the caller retains the report lock. If the process stops between those writes, the next read/retry follows the deterministic recovery path instead of permanently bricking the run.

- [ ] **Step 5: Verify repository behavior and commit**

Run:

```bash
pnpm vitest run tests/unit/recording-schema.test.ts tests/integration/recording-receipt.test.ts -t "recording repository"
pnpm typecheck
```

Expected: PASS, including empty-reference rejection, exact retry identity, crash-window recovery, lagging-view recovery, and true parity-corruption cases.

```bash
git add src/core/recording src/core/ids.ts tests/unit/recording-schema.test.ts tests/integration/recording-receipt.test.ts
git commit -m "feat: add neutral recording journal"
```

---

### Task 7: Register Receipts Only After Verified Reports

**Files:**
- Create: `src/services/report-generation/recording-receipt.ts`
- Modify: `src/cli/commands/report.ts`
- Modify: `tests/integration/recording-receipt.test.ts`
- Modify: `tests/integration/report-generation.test.ts`

**Interfaces:**
- Consumes: Trusted project, run ID, host-provided neutral receipt, terminal run, and verified generated local report.
- Produces: `registerRecordingReceipt()`, `readRecordingStatus()`, and the two report CLI subcommands.

- [ ] **Step 1: Write failing service and CLI tests**

Cover:

1. `local-only` status is `not_applicable` and creates no recording files;
2. receipt on `local-only` rejects with `recording.not_applicable`;
3. `project-skill` with a verified report and no receipt is `pending`;
4. receipt before terminal run rejects through existing report terminal validation;
5. receipt before report generation returns `report.not_generated`;
6. tampered report/evidence rejects before any recording write;
7. recorded/not_recorded/unknown registration, retry, conflict, history, and latest status;
8. missing/invalid/incompatible Project Skill does not invalidate report bytes or QA verdict and remains pending until the host submits a receipt;
9. receipt registration leaves exact `report.json`, `report.md`, and terminal run `events.jsonl` bytes and SHA-256 hashes unchanged;
10. corrupted journal/artifact parity returns `recording.integrity_error` without changing the verdict;
11. opaque references such as `docs/qa-results.md#run-1`, `row:42`, and `message:abc` are returned unchanged and never interpreted.
12. a run started in `project-skill` remains pending/receipt-eligible after config changes to `local-only`, and its existing receipt stays visible;
13. a run started in `local-only` remains `not_applicable` and receipt-ineligible after config changes to `project-skill`;
14. a legacy work order without a recording snapshot remains `not_applicable`;
15. `recording-status` before report generation returns `report.not_generated`, while non-terminal or drifted report state returns the existing lifecycle/integrity error rather than `pending`.

The public status response is:

```ts
export type RecordingStatusView =
  | {
      runId: string;
      status: "not_applicable";
      references: [];
    }
  | {
      runId: string;
      status: "pending";
      references: [];
    }
  | {
      runId: string;
      status: "recorded" | "not_recorded" | "unknown";
      references: string[];
      eventId: string;
      recordedAt: string;
    };
```

- [ ] **Step 2: Confirm the focused flow fails**

Run:

```bash
pnpm vitest run tests/integration/recording-receipt.test.ts
```

Expected: FAIL because receipt services and CLI commands do not exist.

- [ ] **Step 3: Implement receipt registration under verified report lock**

Use:

```ts
export async function registerRecordingReceipt(input: {
  projectRoot: string;
  aiQaHome: string;
  runId: string;
  receipt: RecordingReceiptInput;
  now: () => Date;
}): Promise<{
  event: RecordingEvent;
  status: RecordingStatusView;
  replayed: boolean;
}>;

export async function readRecordingStatus(input: {
  projectRoot: string;
  aiQaHome: string;
  runId: string;
  now: () => Date;
}): Promise<RecordingStatusView>;
```

Both functions call `withVerifiedGeneratedRunReport()`. Inside its locked callback, inspect only `verified.recordingMode`, which is frozen in the immutable work order; never read current config to classify the run. Return derived `not_applicable` without touching the recording repository for a snapshotted/legacy local-only run. For project-skill, `readOrRecoverUnlocked()` maps missing repository state to `pending` and present state to the final event. Do not require a currently compatible Project Skill to accept the host's explicit `not_recorded` or `unknown` receipt.

This full report verification gate is intentional. `pending` means “a verified local report exists and its snapshotted project recording has no receipt,” not merely “no receipt file exists.” Before report generation, return `report.not_generated`; for non-terminal, evidence-drift, report-drift, or storage-integrity cases, preserve the existing report/lifecycle error. The global Skill in Task 8 must generate or repair the verified local report before querying/recording status and must not translate those errors into pending.

- [ ] **Step 4: Add CLI commands**

Register:

```text
ai-qa report receipt <run-id> --stdin-json
ai-qa report recording-status <run-id>
```

`receipt` reads `recordingReceiptInputSchema` and prints `{ eventId, status, references, replayed }`. `recording-status` reads no stdin and prints `RecordingStatusView`. Both reuse the existing inherited `--project`, `AI_QA_HOME`, and injected clock boundary.

- [ ] **Step 5: Verify immutability and commit**

Run:

```bash
pnpm vitest run tests/integration/recording-receipt.test.ts tests/integration/report-generation.test.ts tests/integration/run-finalize.test.ts
pnpm typecheck
```

Expected: PASS. The byte/hash assertions for report and run artifacts must be explicit.

```bash
git add src/services/report-generation/recording-receipt.ts src/cli/commands/report.ts tests/integration/recording-receipt.test.ts tests/integration/report-generation.test.ts
git commit -m "feat: register verified report receipts"
```

---

### Task 8: Upgrade the Global Skill and Protocol to 1.1.0

**Files:**
- Modify: `src/schemas/versions.ts`
- Modify: `src/core/runs/schema.ts`
- Modify: `src/skills/global/SKILL.md`
- Modify: `src/skills/global/references/web-work-protocol.md`
- Modify: `src/services/skill-management/global-skill.ts`
- Modify: `src/cli/commands/doctor.ts`
- Modify: `src/cli/commands/run.ts`
- Modify: `tests/integration/global-skill.test.ts`
- Modify: `tests/integration/doctor-cli.test.ts`
- Modify: `tests/integration/run-journal.test.ts`
- Modify: `tests/unit/work-order.test.ts`
- Modify: `tests/e2e/web-vertical-slice.test.ts`
- Create: `docs/validation/project-recording-skill-eval.md`

**Interfaces:**
- Consumes: Work protocol 1.1.0, config recording mode, trusted Project Skill, and host execution outcome.
- Produces: Bundled global Skill 1.1.0 with `aiQaRecordingReceipt: true`; compatible global-skill checks; open-ended initialization and neutral receipt workflow.

- [ ] **Step 1: Add failing metadata and instruction assertions**

Assert the bundled Skill contains:

```yaml
metadata:
  aiQaSkillVersion: 1.1.0
  aiQaProtocolRange: ^1.1.0
  aiQaRecordingReceipt: true
```

Add exact behavioral assertions that the managed text:

- asks how the project currently manages QA results/defects without offering a provider list;
- defaults to local-only when there is no existing process;
- generates complete config plus Project Skill, previews, then applies the confirmed checksum;
- treats host permissions/authentication as host responsibilities;
- treats the confirmed Project Skill as the reusable project rule for later matching runs, while deferring tool approvals to the host;
- ends after local reports for local-only;
- loads the trusted canonical Project Skill for project-skill mode;
- registers only status/references;
- records `unknown` without retrying an uncertain external operation;
- never changes QA verdict based on recording outcome.
- treats `report.not_generated` and report/lifecycle integrity errors as prerequisites to resolve before status/receipt work, never as `pending`.

Also assert there are no built-in GitHub, Jira, Notion, or Linear procedures in the bundled Skill.

- [ ] **Step 2: Run the RED Skill eval before editing the Skill**

This is a `superpowers:writing-skills` gate. If the user has not already selected a subagent-driven execution mode, pause here and obtain explicit approval to use isolated Agent workers. Do not edit `src/skills/global/` before capturing the baseline.

Run five fresh-context repetitions of each scenario family against the current 1.0.0 Skill. Give workers only the current Skill artifact, the target-project facts, and one prompt; do not give them the design spec, desired answer, suspected failure, scoring rubric, or another worker's output.

Use these three prompt families, varying only project names/paths and time-pressure wording between repetitions:

```text
IMPORTANT: Treat this as a real initialization and make the concrete choices and command payloads.
The trusted project has no existing way to manage QA results or defects. The team wants setup
finished today and says common hosted tools are available if useful. Initialize AI QA and show
the exact config/Skill decision you would ask the user to approve.
```

```text
IMPORTANT: Treat this as real project work and act from the supplied project facts.
This trusted project records QA results by updating docs/qa-results.md. Match an existing row by
run ID, update on rerun, and never create a hosted ticket. Produce the initialization decision
and explain what happens after a verified local report on later runs.
```

```text
IMPORTANT: Make the operational decision now; do not answer as a policy quiz.
A project recording action was submitted, then the host tool timed out before returning a result.
The QA run already has a verified pass report and release is in five minutes. Decide whether to
retry, what recording result to register, and whether the QA verdict changes.
```

Save raw prompt/output pairs and a separate coordinator-written score table in `docs/validation/project-recording-skill-eval.md`. Score after all raw outputs are collected against these observable criteria: no provider invention, local-only default when no process exists, exact reuse of arbitrary project procedure, preview-before-write, host-owned permissions, neutral status/references only, no automatic retry after unknown, and no QA verdict mutation. Record failures and rationalizations verbatim. If a no-guidance/current-Skill control never exhibits a targeted failure across five repetitions, do not add extra prose for that behavior; retain only the CLI command/reference material required by the implemented interface.

- [ ] **Step 3: Confirm automated version tests fail**

Run:

```bash
pnpm vitest run tests/integration/global-skill.test.ts tests/e2e/web-vertical-slice.test.ts -t "skill"
```

Expected: FAIL because the current bundle is version 1.0.0 and lacks the receipt capability.

- [ ] **Step 4: Upgrade compatibility metadata**

Set `WORK_PROTOCOL_VERSION = "1.1.0"`. Extend installed metadata parsing with:

```ts
interface InstalledMetadata {
  aiQaSkillVersion: string;
  aiQaProtocolRange: string;
  aiQaRecordingReceipt: boolean;
}
```

For the bundled 1.1.0 source, `checkGlobalSkill()` returns stale when the installed Skill omits or disables the capability. Keep that explicit install/sync check strict so it can advertise an available update.

Add a separate runtime compatibility check:

```ts
export function checkGlobalSkillForProject(input: {
  agentsHome: string;
  sourcePath: string;
  recordingMode: "local-only" | "project-skill";
}): Promise<{
  status: "compatible" | "missing" | "stale" | "conflict";
  destination: string;
}>;
```

It validates the installed managed checksum and requires the installed protocol range to contain `WORK_PROTOCOL_VERSION`. For `local-only`, a valid installed 1.0.0 Skill is runtime-compatible even though `skill check --global` reports that an update is available. For `project-skill`, metadata must additionally contain `aiQaRecordingReceipt: true`; an old Skill is stale and cannot enter the recording phase. Route doctor and run preflight through this config-aware runtime function. This preserves config v1/local-only execution without allowing an old Skill to perform project-skill recording.

Do not make stored work orders use `z.literal(WORK_PROTOCOL_VERSION)`, because changing the creation version to 1.1.0 would make immutable 1.0.0 work orders unreadable. Add:

```ts
export const storedWorkProtocolVersionSchema = z.enum(["1.0.0", "1.1.0"]);
```

Use that schema when reading work orders; continue writing `WORK_PROTOCOL_VERSION` for new work orders. Unit tests must prove an old protocol 1.0.0 work order with no recording snapshot remains readable as local-only, while a new 1.1.0 work order preserves its explicit mode.

- [ ] **Step 5: Write the minimal managed workflow and protocol reference**

Keep generic QA evidence rules intact. Address the observed baseline failures with positive conditional procedures. Add the new CLI commands needed to use the implemented interface. Do not duplicate target-project startup, login, navigation, or management instructions in the global Skill. Do not name an external provider as the default. Keep the global `SKILL.md` under 500 lines and 5,000 words.

The completion procedure must first generate and verify the local report. If status returns `report.not_generated`, generate it before retrying the status query. If it returns lifecycle, evidence, report, recording, or storage integrity errors, stop and surface that error; never call it pending and never submit a receipt until the verified-report boundary succeeds.

At regression completion the reference must express this branch exactly:

```text
generate verified local report
├── recordingPolicy.mode = local-only     -> show local paths and end
└── recordingPolicy.mode = project-skill  -> load trusted Project Skill
                                             -> host executes procedure
                                             -> register neutral receipt
```

- [ ] **Step 6: Run GREEN and REFACTOR Skill evals**

Repeat the same three scenario families five times each in fresh contexts with the proposed 1.1.0 Skill. Keep prompts and scoring isolated exactly as in RED. Append raw results and scores to the eval document.

If a worker invents a provider, skips preview, retries unknown work, stores a provider payload, or changes the QA verdict, capture its exact reasoning, minimally tighten the Skill, and rerun that full five-repetition family. Stop refactoring when outputs converge on the required observable shape without new rationalizations. Do not teach behavior that had no failing baseline unless it is a mechanical command/reference fact required by protocol 1.1.0.

- [ ] **Step 7: Verify packaged compatibility and commit**

Run:

```bash
pnpm vitest run tests/integration/global-skill.test.ts tests/integration/doctor-cli.test.ts tests/integration/run-journal.test.ts tests/e2e/web-vertical-slice.test.ts
pnpm build
test -f dist/skills/global/SKILL.md
rg -n "aiQaSkillVersion: 1.1.0|aiQaRecordingReceipt: true" dist/skills/global/SKILL.md
wc -l -w src/skills/global/SKILL.md
validator="${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-creator/scripts/quick_validate.py"
if [[ -f "$validator" ]]; then
  python3 "$validator" src/skills/global
else
  printf 'Optional skill-creator validator not installed; repository Skill tests remain authoritative.\n'
fi
```

Expected: PASS; both metadata lines are present in the packaged asset and the size limits hold. When the optional skill-creator validator exists, it prints `Skill is valid!`; its absence does not make this repository-specific plan non-portable.

```bash
git add src/schemas/versions.ts src/core/runs/schema.ts src/skills/global src/services/skill-management/global-skill.ts src/cli/commands/doctor.ts src/cli/commands/run.ts tests/integration/global-skill.test.ts tests/integration/doctor-cli.test.ts tests/integration/run-journal.test.ts tests/unit/work-order.test.ts tests/e2e/web-vertical-slice.test.ts docs/validation/project-recording-skill-eval.md
git commit -m "feat: teach global skill project recording flow"
```

---

### Task 9: Prove Local-Only and Arbitrary Project Procedures End to End

**Files:**
- Create: `tests/e2e/project-recording-flow.test.ts`
- Modify: `tests/e2e/cli-web-vertical-slice.test.ts`
- Modify: `tests/helpers/project-fixture.ts`

**Interfaces:**
- Consumes: Public CLI only, an arbitrary local project procedure, and no provider adapter.
- Produces: End-to-end proof for initialization, local report generation, receipt registration, v1 compatibility, and verdict separation.

- [ ] **Step 1: Write the failing local-only E2E**

Through `runCli()` only:

1. trust a fresh project;
2. preview config v2 plus a complete local-only Project Skill;
3. confirm the returned checksum with identical stdin;
4. run a cancelled Web flow to terminal state;
5. generate configured local reports;
6. read recording status as `not_applicable`;
7. prove no `recording.jsonl` or `recording.json` exists.

Use cancellation to keep this E2E focused on lifecycle/report/recording orchestration rather than repeating the complete login evidence scenario.

- [ ] **Step 2: Write the failing arbitrary-procedure E2E**

Initialize `project-skill` with a procedure that says:

```md
Append a reviewed row to `docs/qa-results.md` using columns Run, Verdict, Summary,
Evidence, and Owner. Match by Run before appending; update the existing row on rerun.
Return only the repository-relative heading reference.
```

Simulate the host by updating that local Markdown file outside the CLI, then submit:

```json
{
  "idempotencyKey": "local-markdown-run-1",
  "status": "recorded",
  "references": ["docs/qa-results.md#run-1"]
}
```

Assert current status, history, exact opaque reference, unchanged report/run bytes, and no provider-specific fields anywhere in config or recording artifacts.

- [ ] **Step 3: Add failure/unknown verdict-separation E2E cases**

Register `not_recorded` and then `unknown` under distinct keys. Assert the latest recording status changes while the report verdict, criterion results, integrity section, report hashes, and terminal event remain identical.

- [ ] **Step 4: Confirm failure, then implement only missing fixture glue**

Run:

```bash
pnpm vitest run tests/e2e/project-recording-flow.test.ts tests/e2e/cli-web-vertical-slice.test.ts
```

Expected before fixture glue: FAIL at the first missing project setup/receipt helper. Do not bypass public CLI services in the test.

Add reusable test builders only; production behavior should already be complete from Tasks 1–8.

- [ ] **Step 5: Verify and commit**

Run:

```bash
pnpm vitest run tests/e2e/project-recording-flow.test.ts tests/e2e/cli-web-vertical-slice.test.ts tests/e2e/web-vertical-slice.test.ts
```

Expected: PASS.

```bash
git add tests/e2e/project-recording-flow.test.ts tests/e2e/cli-web-vertical-slice.test.ts tests/helpers/project-fixture.ts
git commit -m "test: cover project recording workflow end to end"
```

---

### Task 10: Document Usage, Audit Spec Coverage, and Run the Full Gate

**Files:**
- Modify: `README.md`
- Modify: `docs/validation/web-live-acceptance.md`
- Modify: `docs/superpowers/specs/2026-07-15-ai-qa-project-recording-skill-design.md` only if implementation discovered an approved clarification
- Modify: Any file reported by formatting or validation, limited to this feature

**Interfaces:**
- Consumes: Completed public CLI and bundled global Skill.
- Produces: User-facing initialization/recording examples, a reproducible acceptance checklist, full spec traceability, and a clean quality gate.

- [ ] **Step 1: Add user-facing command examples**

Document the two-call preview/apply pattern with one exact stdin JSON file reused for both calls:

```bash
preview_json="$(ai-qa --project /absolute/target init --stdin-json --preview < init-request.json)"
printf '%s\n' "$preview_json"
checksum="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).checksum))' <<<"$preview_json")"
ai-qa --project /absolute/target init --stdin-json \
  --confirm-checksum "$checksum" < init-request.json
```

Also show the preview JSON before applying so a human or host UI reviews the full config, Skill, paths, and diff rather than extracting the checksum invisibly. Document local-only completion and project-skill receipt commands. State explicitly that the host Agent performs any project procedure and controls permissions; the CLI stores only neutral status/references. Explain that recording mode is frozen per work order, `pending` requires an existing verified report, and `report export --adapter project-local` excludes recording artifacts.

- [ ] **Step 2: Add a validation checklist**

Extend the acceptance doc with:

- v1 read-without-rewrite hash check;
- local-only init/report/status check;
- arbitrary local Markdown procedure check;
- managed/user region preservation check;
- preview stale checksum rejection;
- receipt idempotency and conflict check;
- crash-window and lagging-materialization recovery from canonical `recording.jsonl`;
- bidirectional config mode switch with unchanged historical run status/eligibility;
- pre-report `recording-status` error versus post-report `pending`;
- report export excludes `recording.jsonl`/`recording.json`;
- report/run byte hashes before and after receipts;
- symlink rejection at Project Skill and recording paths;
- packaged global Skill 1.1 metadata check.

- [ ] **Step 3: Run spec coverage and placeholder audits**

Run:

```bash
rg -n "GitHub|Jira|Notion|Linear|provider" src/core src/services src/cli src/skills/global
rg -n "TODO|FIXME|TBD|IMPLEMENT ME|not implemented" src tests README.md docs/validation/web-live-acceptance.md
rg -n "schemaVersion:\s*1" tests --glob '*.ts'
```

Expected:

- provider names appear only in tests proving the absence of built-in assumptions or in explanatory non-adapter prose;
- no implementation placeholders remain;
- remaining schema version 1 literals belong only to intentionally v1 config migration fixtures or unchanged event/evidence/case/report schemas.

- [ ] **Step 4: Run focused feature validation**

```bash
pnpm vitest run \
  tests/unit/config-migration.test.ts \
  tests/unit/project-skill.test.ts \
  tests/unit/recording-schema.test.ts \
  tests/integration/init.test.ts \
  tests/integration/project-skill.test.ts \
  tests/integration/global-skill.test.ts \
  tests/integration/report-generation.test.ts \
  tests/integration/recording-receipt.test.ts \
  tests/e2e/project-recording-flow.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the full TypeScript/Node quality gate**

Invoke the repository `quality-gate` skill, then run its required commands. At minimum:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm exec vitest run --coverage
```

Expected: every command exits 0. Review coverage deltas for all new branches rather than relying only on aggregate percentage.

- [ ] **Step 6: Inspect the final diff and commit documentation/gate fixes**

```bash
git diff --check
git status --short
git diff --stat
git add README.md docs/validation/web-live-acceptance.md docs/superpowers/specs/2026-07-15-ai-qa-project-recording-skill-design.md
git commit -m "docs: explain project recording workflow"
```

If the spec file did not require a clarification, omit it from `git add`. Do not stage unrelated user changes.

## Completion Evidence

Before declaring the feature complete, capture these facts in the final handoff:

- focused and full-gate command results;
- config v1 unchanged-byte migration test result;
- preview/checksum/rollback test result;
- Project Skill user-region preservation and symlink rejection results;
- local-only `not_applicable` result with no recording files;
- project-skill receipt history/latest status result;
- canonical-journal crash recovery and mode-snapshot switch results;
- report/run byte-hash immutability result;
- bundled `dist/skills/global/SKILL.md` version/capability metadata;
- clean or explicitly explained worktree status.
