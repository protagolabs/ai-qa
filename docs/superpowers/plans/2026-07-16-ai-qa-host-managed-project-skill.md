# AI QA Host-Managed Project Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace CLI-authored Project Skills with Codex/host-managed project files while preserving deterministic local QA records, report-gated neutral recording receipts, and per-run Project Skill identity.

**Architecture:** The globally installed `ai-qa` Skill teaches Codex to discuss requirements, use `skill-creator`, validate drafts, display diffs, obtain one confirmation, and write `.ai-qa/config.yaml` plus the target Project Skill. The CLI exposes read-only config validation and installation/readiness diagnostics, snapshots a project-owned Skill's path/hash for `project-skill` runs, and stores only canonical QA state plus neutral recording status/references. The CLI never authors, parses, merges, or executes the target Project Skill.

**Tech Stack:** TypeScript 5.9, Node.js 22/24, Commander 14, Zod 4, YAML 2, Vitest 4, pnpm 11, Codex `skill-creator` validation.

## Global Constraints

- The target Project Skill path is exactly `.agents/skills/ai-qa-project/SKILL.md`.
- Target Project Skills are ordinary project-owned Skills: no AI-QA managed/user markers and no embedded `aiQaManagedChecksum`.
- Codex owns draft generation, pre-write validation, diff presentation, user confirmation, project file writes, and tool permissions.
- `ai-qa` is an on-demand CLI, not a daemon or Skill executor.
- New config is schema v2; stored config v1 remains readable without rewrite and normalizes to `local-only`.
- No existing recording process means `recordingPolicy.mode: local-only`; never infer a provider from installed tools.
- `project-skill` procedures remain arbitrary and provider-neutral; `.ai-qa/` stores only neutral status/references, never provider payloads or credentials.
- A verified report is required before recording; `unknown` has no references and is never retried; recording never changes the QA verdict.
- Global main-Skill installation/update remains CLI-managed and versioned; project Skill generation/sync is removed.
- Filesystem errors expose project-relative paths only and never expose Skill contents or secret values.
- Use TDD and commit each task independently. Every task receives a specification review and a code-quality review before the next task.

---

## File Structure

```text
src/
├── cli/
│   ├── commands/
│   │   ├── config.ts                         Read-only config draft validation
│   │   ├── doctor.ts                         Installation + optional Web readiness CLI
│   │   └── skill.ts                          Global main-Skill management only
│   └── program.ts                            Register config; remove project init/configure
├── core/
│   ├── recording/{schema,repository}.ts      Internally derived receipt idempotency
│   └── runs/schema.ts                        Frozen Project Skill path/hash
├── services/
│   ├── doctor/
│   │   ├── installation-doctor.ts            Local installation/project-file checks
│   │   └── web-doctor.ts                     Web checks combined with installation checks
│   ├── project-skill/project-skill-file.ts   Regular-file snapshot and drift assertion
│   ├── report-generation/
│   │   ├── generate-run-report.ts            Carries frozen recording context
│   │   └── recording-receipt.ts              Report + Skill-drift gate
│   ├── run-protocol/                          Snapshot Project Skill on every project-skill run path
│   └── skill-management/                      Global main-Skill management only
└── skills/global/                             Host-managed workflow instructions

Deleted project-mutation surface:
src/cli/commands/init.ts
src/services/initialization/initialize-project.ts
src/services/initialization/project-file-transaction.ts
src/services/initialization/project-setup.ts
src/services/skill-management/project-skill.ts
```

---

### Task 1: Replace Combined Project Setup with Read-Only Config Validation

**Files:**
- Create: `src/cli/commands/config.ts`
- Create: `tests/integration/config-cli.test.ts`
- Modify: `src/cli/program.ts`
- Modify: `src/cli/commands/skill.ts`
- Modify: `tests/helpers/project-fixture.ts`
- Modify: `tests/cli/help.test.ts`
- Modify: `tests/integration/global-skill.test.ts`
- Delete: `src/cli/commands/init.ts`
- Delete: `tests/integration/init.test.ts`
- Delete: `tests/integration/project-skill.test.ts`
- Delete: `tests/unit/project-skill.test.ts`

**Interfaces:**
- Consumes: `projectConfigV2Schema`, `readJsonInput()`, `writeJson()`, existing global `checkGlobalSkill()/previewGlobalSkillSync()/syncGlobalSkill()`.
- Produces: `registerConfigCommands(program, context): void`; `ai-qa config validate --stdin-json`; host-written test fixtures with a normal target Project Skill.

- [ ] **Step 1: Write failing config-validation CLI tests**

Create `tests/integration/config-cli.test.ts` with these concrete assertions:

```ts
it("validates and returns a schema-v2 config without filesystem mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-qa-config-validate-"));
  const captured = createCapturedCli({
    cwd: root,
    readStdin: () => Promise.resolve(JSON.stringify(projectConfigV2())),
  });
  expect(await runCli(["config", "validate", "--stdin-json"], captured.context)).toBe(0);
  expect(JSON.parse(captured.stdout.join(""))).toEqual({
    status: "valid",
    config: projectConfigV2(),
  });
  expect(await readdir(root)).toEqual([]);
});

it("rejects stored schema-v1 input for new config validation", async () => {
  const captured = createCapturedCli({
    readStdin: () => Promise.resolve(JSON.stringify(projectConfigV1())),
  });
  expect(await runCli(["config", "validate", "--stdin-json"], captured.context)).toBe(1);
  expect(JSON.parse(captured.stderr.join(""))).toMatchObject({
    error: { code: "input.invalid_json" },
  });
});

it.each(["init", "configure"])("does not expose the removed %s command", async (name) => {
  const captured = createCapturedCli();
  expect(await runCli([name], captured.context)).toBe(1);
  expect(JSON.parse(captured.stderr.join(""))).toMatchObject({
    error: { code: "commander.unknownCommand" },
  });
});
```

- [ ] **Step 2: Run the RED tests**

Run:

```bash
pnpm vitest run tests/integration/config-cli.test.ts
```

Expected: FAIL because `config validate` is not registered and `init/configure` still exist.

- [ ] **Step 3: Implement the read-only config command**

Create `src/cli/commands/config.ts`:

```ts
import type { Command } from "commander";
import { projectConfigV2Schema } from "../../core/config/schema.js";
import type { CliContext } from "../context.js";
import { readJsonInput, writeJson } from "../io.js";

export function registerConfigCommands(
  program: Command,
  context: CliContext,
): void {
  const config = program.command("config").description("validate AI QA configuration drafts");
  config
    .command("validate")
    .description("validate a schema-v2 config without writing project files")
    .requiredOption("--stdin-json", "read the complete config object from stdin")
    .action(async () => {
      const parsed = await readJsonInput(context, projectConfigV2Schema);
      writeJson(context, { status: "valid", config: parsed });
    });
}
```

Register it in `src/cli/program.ts` and remove `registerInitCommands()`.

- [ ] **Step 4: Restrict `skill` commands to the global main Skill**

Delete all project mutation imports, schemas, option parsers, and `runProjectMutation()` from `src/cli/commands/skill.ts`. Keep exactly these scopes:

```text
ai-qa skill install --global
ai-qa skill sync --global
ai-qa skill check --global
```

Make `--global` required on all three commands. Preserve `--confirm-managed-replacement` only on install/sync. Add CLI assertions that `skill generate`, project `skill sync`, and project `skill check` return an unknown-command or required-option error without touching a project.

Update the former `skill sync --global --preview` assertion to expect Commander `unknownOption`: `--preview` was project-only and must not remain as a recognized compatibility option on the global command.

Update `tests/cli/help.test.ts` in the same task so the root help describes `config validate`, omits `init` and `configure`, and the `skill` help exposes only the three global-only commands and their supported options.

- [ ] **Step 5: Replace test setup with direct host-owned files**

Add `hostManagedProjectSkillSource()` to `tests/helpers/project-fixture.ts` as the normal Skill fixture:

```ts
export function hostManagedProjectSkillSource(
  recordingProcedure = "Show the verified local report paths and stop.",
): string {
  return `---
name: ai-qa-project
description: Use when performing Web AI QA for this project.
---

# Project AI QA Procedures

## Result recording

${recordingProcedure}
`;
}
```

`initializeTestProject()` must create `.ai-qa/config.yaml`, the four canonical directories, and `.agents/skills/ai-qa-project/SKILL.md` directly with `mkdir()`/`writeFile()` and YAML `stringify()`. It must not call a product initialization service. Keep the old managed `projectSkillSource()` and `projectSetupRequest()` test helpers temporarily because unchanged global-Skill/E2E tests still compile against them; Task 7 removes them after those tests are rewritten.

- [ ] **Step 6: Delete superseded public tests and prove the CLI no longer calls mutation services**

Delete the test files listed above. Keep the now-unreachable setup services until Task 7 so unchanged global-Skill/E2E tests remain green between task commits. Prove no CLI command imports them:

```bash
rg -n "previewProjectSetup|applyProjectSetup|projectSkillRequestSchema|prepareProjectSkill|applyProjectFileTransaction" src/cli
```

Expected: no matches.

- [ ] **Step 7: Run the task gate**

Run:

```bash
pnpm vitest run tests/integration/config-cli.test.ts tests/integration/global-skill.test.ts
pnpm typecheck
pnpm lint
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/cli src/services/initialization src/services/skill-management tests/helpers tests/integration tests/unit
git commit -m "refactor: move project file ownership to host"
```

---

### Task 2: Freeze Project Skill Identity in Project-Skill Work Orders

**Files:**
- Create: `src/services/project-skill/project-skill-file.ts`
- Create: `tests/unit/project-skill-file.test.ts`
- Modify: `src/core/runs/schema.ts`
- Modify: `src/schemas/versions.ts`
- Modify: `tests/unit/work-order.test.ts`

**Interfaces:**
- Consumes: `inspectOptionalProjectLocalRegularFile(projectRoot, segments)` and `AiQaError`.
- Produces `projectSkillSnapshotSchema` and `ProjectSkillSnapshot` from `src/core/runs/schema.ts`, plus:

```ts
export function readProjectSkillSnapshot(projectRoot: string): Promise<ProjectSkillSnapshot>;
export function assertCurrentProjectSkillSnapshot(input: {
  projectRoot: string;
  snapshot: ProjectSkillSnapshot;
}): Promise<void>;
```

- [ ] **Step 1: Write RED filesystem-identity tests**

Cover a regular file, missing file, symlinked ancestor, symlinked `SKILL.md`, byte change, and project-relative error details. The successful expectation is:

```ts
expect(await readProjectSkillSnapshot(projectRoot)).toEqual({
  path: ".agents/skills/ai-qa-project/SKILL.md",
  contentSha256: createHash("sha256").update(source).digest("hex"),
});
```

Every failure must match:

```ts
expect.objectContaining({
  code: "project_skill.integrity_error",
  details: { path: ".agents/skills/ai-qa-project/SKILL.md" },
})
```

and `JSON.stringify(error.details)` must not contain `projectRoot`.

- [ ] **Step 2: Run RED**

```bash
pnpm vitest run tests/unit/project-skill-file.test.ts
```

Expected: FAIL because the narrow snapshot service does not exist.

- [ ] **Step 3: Implement the regular-file snapshot service**

Use the existing project-local no-follow reader. Hash the exact UTF-8 bytes returned by the verified file handle. Map missing/storage failures to one project-relative error:

```ts
const PROJECT_SKILL_PATH = ".agents/skills/ai-qa-project/SKILL.md" as const;
const PROJECT_SKILL_SEGMENTS = [".agents", "skills", "ai-qa-project", "SKILL.md"] as const;

function integrityError(): AiQaError {
  return new AiQaError(
    "project_skill.integrity_error",
    "Project Skill must be a stable project-local regular file",
    { path: PROJECT_SKILL_PATH },
  );
}
```

`assertCurrentProjectSkillSnapshot()` rereads through the same primitive and throws `project_skill.changed` with only `{ path: PROJECT_SKILL_PATH }` when hashes differ.

- [ ] **Step 4: Extend the work-order schema**

Bump `WORK_PROTOCOL_VERSION` to `1.2.0` and allow stored versions `1.0.0`, `1.1.0`, and `1.2.0`. Add:

```ts
export const projectSkillSnapshotSchema = z.object({
  path: z.literal(".agents/skills/ai-qa-project/SKILL.md"),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
```

Add optional `projectSkill` to the base stored schema. Require it when protocol 1.2 uses `recordingPolicy.mode: project-skill`; forbid it for `local-only`. Stored 1.0/1.1 local-only work orders remain valid, and stored 1.1 project-skill work orders may parse without the new field for historical receipt readability. Add `projectSkill?: ProjectSkillSnapshot` to `createExploratoryWorkOrder()` and include it in the parsed value.

- [ ] **Step 5: Add work-order compatibility tests**

Prove:

- old 1.0/1.1 local-only work orders without the field still parse;
- a new 1.2 project-skill work order requires the snapshot;
- local-only rejects an injected snapshot;
- `deepFreezeWorkOrder()` freezes the nested snapshot.

- [ ] **Step 6: Run and commit**

```bash
pnpm vitest run tests/unit/project-skill-file.test.ts tests/unit/work-order.test.ts
pnpm typecheck
git add src/services/project-skill src/core/runs/schema.ts src/schemas/versions.ts tests/unit
git commit -m "feat: snapshot project skill identity per run"
```

Expected: PASS.

---

### Task 3: Wire Skill Snapshots into Every Run and Recording Path

**Files:**
- Modify: `src/services/run-protocol/start-exploratory-run.ts`
- Modify: `src/services/run-protocol/start-regression-run.ts`
- Modify: `src/services/run-protocol/create-preflight-result-run.ts`
- Modify: `src/services/report-generation/generate-run-report.ts`
- Modify: `src/services/report-generation/recording-receipt.ts`
- Modify: `tests/integration/run-journal.test.ts`
- Modify: `tests/integration/recording-receipt.test.ts`
- Modify: `tests/integration/report-generation.test.ts`

**Interfaces:**
- Consumes: `readProjectSkillSnapshot()`, `assertCurrentProjectSkillSnapshot()`, `ProjectSkillSnapshot` from Task 2.
- Produces: every new project-skill work order carries the snapshot; receipt/status verify it after the verified-report gate.

- [ ] **Step 1: Add failing run-start tests**

For exploratory, regression, and not-ready preflight-result paths, initialize `project-skill`, start the run, and assert:

```ts
expect(workOrder.projectSkill).toEqual({
  path: ".agents/skills/ai-qa-project/SKILL.md",
  contentSha256: createHash("sha256").update(projectSkillSource()).digest("hex"),
});
```

Also prove local-only work orders omit `projectSkill` and do not require a target Skill for legacy config v1.

- [ ] **Step 2: Run RED**

```bash
pnpm vitest run tests/integration/run-journal.test.ts
```

Expected: FAIL because run factories do not pass a snapshot.

- [ ] **Step 3: Snapshot before work-order creation**

In each run-start service, compute exactly once:

```ts
const projectSkill =
  config.recordingPolicy.mode === "project-skill"
    ? await readProjectSkillSnapshot(trusted.projectRoot)
    : undefined;
```

Pass it to exploratory/regression work-order construction. The preflight-result path follows the same rule; a missing Project Skill blocks run creation instead of producing a misleading tool-blocked run.

- [ ] **Step 4: Add failing recording drift tests**

After generating a verified report, hash report JSON, report Markdown, and run journal. Change only Project Skill bytes, then assert both operations reject:

```ts
await expect(readRecordingStatus(input)).rejects.toMatchObject({
  code: "project_skill.changed",
});
await expect(registerRecordingReceipt({
  ...input,
  receipt: { status: "recorded", references: ["docs/qa-results.md#run-sample"] },
})).rejects.toMatchObject({ code: "project_skill.changed" });
```

Re-hash the report and run files and prove all bytes and the verdict remain unchanged.

- [ ] **Step 5: Carry and verify the frozen context**

Extend the internal verified-report result with:

```ts
projectSkill?: ProjectSkillSnapshot;
```

For a current project-skill receipt/status, require the snapshot and call `assertCurrentProjectSkillSnapshot()` inside the report lock after report integrity succeeds and before reading/writing recording files. A stored 1.1 project-skill work order without a snapshot may read an existing receipt and exactly replay it, but it cannot create a new receipt or report `pending`; return `project_skill.snapshot_missing` instead. Local-only returns `not_applicable` without a Skill check.

- [ ] **Step 6: Run and commit**

```bash
pnpm vitest run tests/integration/run-journal.test.ts tests/integration/report-generation.test.ts tests/integration/recording-receipt.test.ts
pnpm typecheck
git add src/services/run-protocol src/services/report-generation tests/integration
git commit -m "feat: gate recording on frozen project skill"
```

Expected: PASS.

---

### Task 4: Derive Receipt Idempotency Internally

**Files:**
- Modify: `src/core/recording/schema.ts`
- Modify: `src/core/recording/repository.ts`
- Modify: `src/cli/commands/report.ts`
- Modify: `tests/helpers/project-fixture.ts`
- Modify: `tests/unit/recording-schema.test.ts`
- Modify: `tests/integration/recording-receipt.test.ts`

**Interfaces:**
- Consumes: run ID already owned by `RecordingRepository`.
- Produces: public `RecordingReceiptInput = { status, references }`; stored events keep an internal `idempotencyKey` for backward readability.

- [ ] **Step 1: Write RED public-schema tests**

```ts
expect(recordingReceiptInputSchema.parse({
  status: "recorded",
  references: ["docs/qa-results.md#run-sample"],
})).toEqual({
  status: "recorded",
  references: ["docs/qa-results.md#run-sample"],
});

expect(() => recordingReceiptInputSchema.parse({
  idempotencyKey: "caller-owned",
  status: "recorded",
  references: ["docs/qa-results.md#run-sample"],
})).toThrow();

expect(() => recordingReceiptInputSchema.parse({
  status: "unknown",
  references: ["must-be-empty"],
})).toThrow();
```

- [ ] **Step 2: Run RED**

```bash
pnpm vitest run tests/unit/recording-schema.test.ts
```

Expected: FAIL because callers still supply `idempotencyKey` and unknown references are accepted.

- [ ] **Step 3: Separate public receipt fields from stored event fields**

Keep `recordingIdempotencyKeySchema` and the stored event/history field for compatibility, but define public input from only:

```ts
const receiptPayloadFields = {
  status: z.enum(["recorded", "not_recorded", "unknown"]),
  references: z.array(recordingReferenceSchema).max(20),
};
```

Require references only for `recorded`; both `not_recorded` and `unknown` require `[]`.

- [ ] **Step 4: Make repository registration single-receipt idempotent**

Derive the stored key:

```ts
function idempotencyKeyForRun(runId: string): string {
  return `recording:${runId}:v1`;
}
```

If any existing event is present, compare its `{status, references}` to the incoming payload. Return the existing event for an exact retry; otherwise throw `recording.idempotency_conflict` with `{ runId }`. This also makes historical events with caller-provided keys readable and replayable without asking the caller to know the old key.

- [ ] **Step 5: Update CLI and integration tests**

The only accepted receipt stdin is:

```json
{"status":"recorded","references":["docs/qa-results.md#run-sample"]}
```

Prove exact retry writes no journal bytes, a different payload conflicts, and crash recovery still re-materializes `recording.json` from unchanged `recording.jsonl`.

- [ ] **Step 6: Run and commit**

```bash
pnpm vitest run tests/unit/recording-schema.test.ts tests/integration/recording-receipt.test.ts
pnpm typecheck
git add src/core/recording src/cli/commands/report.ts tests/helpers/project-fixture.ts tests/unit/recording-schema.test.ts tests/integration/recording-receipt.test.ts
git commit -m "refactor: derive recording receipt identity"
```

Expected: PASS.

---

### Task 5: Make Doctor Report Installation and Project Readiness

**Files:**
- Create: `src/services/doctor/installation-doctor.ts`
- Create: `tests/unit/installation-doctor.test.ts`
- Modify: `src/cli/commands/doctor.ts`
- Modify: `src/services/doctor/web-doctor.ts`
- Modify: `src/cli/commands/run.ts`
- Modify: `tests/unit/web-doctor.test.ts`
- Modify: `tests/integration/doctor-cli.test.ts`

**Interfaces:**
- Consumes: `checkGlobalSkill()`, `readStoredProjectConfig()`, project-local file/directory inspection.
- Produces:

```ts
export type InstallationStatus = "ready" | "not_ready" | "uninitialized";
export interface InstallationCheck {
  code: "runtime.node" | "agent.global_skill" | "project.config" |
    "agent.project_skill" | "project.storage";
  status: "pass" | "fail" | "advisory" | "missing";
  message: string;
}
```

- [ ] **Step 1: Write RED installation-doctor tests**

Cover:

- missing config returns `uninitialized` and does not require trust;
- installed v2 local-only requires a regular Project Skill;
- installed v2 project-skill requires the same;
- missing Project Skill on stored v1 is `advisory`, not blocking;
- symlinked Skill is `fail`;
- missing/stale/conflicting global main Skill is `fail`;
- canonical directories missing or non-writable are `fail`;
- no check mutates project files.

- [ ] **Step 2: Run RED**

```bash
pnpm vitest run tests/unit/installation-doctor.test.ts tests/integration/doctor-cli.test.ts
```

Expected: FAIL because doctor currently requires initialized/trusted Web config and reports only Web readiness.

- [ ] **Step 3: Implement report-only installation checks**

Use `resolveProjectRoot({ command: "init", ... })` so explicit non-Git targets and uninitialized Git roots work. Do not read initialized project content before trust resolution. Return messages with project-relative names only.

The `doctor` CLI options become:

```text
ai-qa --project /workspace/sample doctor --json
ai-qa --project /workspace/sample doctor --platform web --json --stdin-json
```

`--platform` and `--stdin-json` are optional as a pair. Without them, return installation checks only. With them, prepend installation checks to existing Web readiness checks. If config is absent, return `uninitialized` without Web checks.

- [ ] **Step 4: Extend Web and run readiness schemas**

Add installation codes to `DoctorCheck`. Installation `fail` maps to Web `fail`; `advisory` does not block. `run start` accepts the expanded check enum but still requires overall `ready` for normal execution.

- [ ] **Step 5: Prove host-visible checks remain Codex-owned**

Keep the stdin observation schema for `chromeDevtoolsMcp` and optional `entryPage`. The CLI reports supplied observations but never installs a plugin, starts a browser, authenticates, or edits config/Skill. Assert before/after file lists are identical.

- [ ] **Step 6: Run and commit**

```bash
pnpm vitest run tests/unit/installation-doctor.test.ts tests/unit/web-doctor.test.ts tests/integration/doctor-cli.test.ts tests/integration/run-journal.test.ts
pnpm typecheck
pnpm lint
git add src/services/doctor src/cli/commands/doctor.ts src/cli/commands/run.ts tests/unit tests/integration/doctor-cli.test.ts tests/integration/run-journal.test.ts
git commit -m "feat: report ai qa installation readiness"
```

Expected: PASS.

---

### Task 6: Rewrite the Global Main Skill for Host-Managed Project Files

**Files:**
- Modify: `src/skills/global/SKILL.md`
- Modify: `src/skills/global/references/web-work-protocol.md`
- Modify: `src/services/skill-management/global-skill.ts`
- Modify: `tests/integration/global-skill.test.ts`
- Modify: `tests/integration/doctor-cli.test.ts`
- Modify: `tests/e2e/web-vertical-slice.test.ts`
- Modify: `src/schemas/versions.ts`

**Interfaces:**
- Consumes: Task 1 `config validate`, Task 5 doctor behavior, existing global Skill installer.
- Produces: bundled main Skill version `1.2.0`, protocol range `^1.2.0`, host-managed initialization/update instructions.

- [ ] **Step 1: Write failing current-Skill assertions**

Require the current global Skill/reference to state all of these exact mechanical facts:

```text
Use `skill-creator` to create or update `.agents/skills/ai-qa-project/SKILL.md` in scratch space before target write.
Codex validates the config and Project Skill, displays both complete diffs, obtains one confirmation, then writes both project files.
When no existing result-management procedure exists, use `recordingPolicy.mode: local-only`; do not choose a provider from available tools.
The target Project Skill is project-owned; do not add AI-QA managed/user markers or an embedded AI-QA checksum.
Run `ai-qa config validate --stdin-json` as a read-only config check.
Run `ai-qa doctor --json` after the host-managed write.
For project-skill runs, execute the exact Project Skill procedure only after a verified report and submit only status/references.
Permissions, authentication, file writes, and external tools remain host-owned.
```

Also assert absence of `InitializationRequest`, `projectSkill.content`, checksum algorithm instructions, `--confirm-checksum`, project `skill generate`, and project `skill sync`.

- [ ] **Step 2: Run RED**

```bash
pnpm vitest run tests/integration/global-skill.test.ts
```

Expected: FAIL because the 1.1 Skill still teaches the superseded wire artifact and manual checksum.

- [ ] **Step 3: Rewrite current Skill and reference**

Keep the global service-managed markers/checksum used by the product-distributed main Skill. Replace only its instructions and reference content. Set metadata:

```yaml
metadata:
  aiQaSkillVersion: 1.2.0
  aiQaProtocolRange: ^1.2.0
  aiQaRecordingReceipt: true
```

Do not copy project-specific provider examples into the main Skill. The reference may show a local Markdown procedure only as an arbitrary Project Skill body example, not as a provider contract.

- [ ] **Step 4: Tighten global compatibility**

New runs require the current 1.2 main Skill. Remove recording-mode-dependent acceptance from `checkGlobalSkillForProject()` and route current doctor/run preflight through `checkGlobalSkill()`. Historical run/report parsing continues to accept protocol 1.0/1.1.

- [ ] **Step 5: Validate packaged Skill**

```bash
pnpm vitest run tests/integration/global-skill.test.ts tests/integration/doctor-cli.test.ts tests/e2e/web-vertical-slice.test.ts
pnpm build
rg -n "aiQaSkillVersion: 1.2.0|aiQaProtocolRange: \^1.2.0|aiQaRecordingReceipt: true" dist/skills/global/SKILL.md
validator="${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-creator/scripts/quick_validate.py"
if [[ -f "$validator" ]]; then python3 "$validator" src/skills/global; fi
```

Expected: tests PASS; packaged metadata matches; optional validator prints `Skill is valid!`.

- [ ] **Step 6: Commit**

```bash
git add src/skills/global src/services/skill-management/global-skill.ts src/schemas/versions.ts tests/integration/global-skill.test.ts tests/integration/doctor-cli.test.ts tests/e2e/web-vertical-slice.test.ts
git commit -m "feat: teach host-managed project skills"
```

---

### Task 7: Rebuild End-to-End Recording and Documentation Around Host Ownership

**Files:**
- Modify: `tests/e2e/project-recording-flow.test.ts`
- Modify: `tests/e2e/cli-web-vertical-slice.test.ts`
- Modify: `README.md`
- Modify: `docs/validation/web-live-acceptance.md`
- Modify: `docs/validation/project-recording-skill-eval.md`
- Modify: `docs/superpowers/specs/2026-07-15-ai-qa-project-recording-skill-design.md`
- Modify: `tests/helpers/project-fixture.ts`
- Delete: `src/services/initialization/initialize-project.ts`
- Delete: `src/services/initialization/project-file-transaction.ts`
- Delete: `src/services/initialization/project-setup.ts`
- Delete: `src/services/skill-management/project-skill.ts`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: user-facing workflow, current E2E proof, append-only fresh-context evaluation evidence.

- [ ] **Step 1: Rewrite E2E setup as a host-managed change**

Tests create config and a normal Project Skill through the host fixture, run `config validate`, then run report/recording commands. They must not call removed init/project Skill mutation commands or inspect embedded metadata.

After rewriting all remaining callers, rename `hostManagedProjectSkillSource()` to `projectSkillSource()`, remove `projectSetupRequest()`, and delete the four unreachable superseded service files listed for this task. Run `rg` to prove no source/test import remains before deletion.

Local-only E2E proves:

```ts
expect(status).toEqual({ runId, status: "not_applicable", references: [] });
await expect(access(join(reportDirectory, "recording.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
await expect(access(join(reportDirectory, "recording.json"))).rejects.toMatchObject({ code: "ENOENT" });
```

Project-skill E2E reads the exact arbitrary `docs/qa-results.md` procedure from the normal Skill, performs the host-side file update, registers `{status, references}`, verifies internal idempotent replay, and proves the verdict/report/run bytes do not change.

- [ ] **Step 2: Add Skill-drift and mode-switch E2E coverage**

Create a project-skill run, generate its report, edit the Skill, and prove receipt/status stop with `project_skill.changed`. Start a new run and prove the new hash is used. Retain bidirectional config mode-switch tests showing historical work orders use their frozen mode.

- [ ] **Step 3: Rewrite README and acceptance docs**

Document this exact initialization sequence:

```text
Codex loads global ai-qa Skill
Codex runs doctor
Codex discusses requirements
Codex drafts config and uses skill-creator in scratch space
Codex validates both drafts
Codex displays complete diffs and obtains one confirmation
Codex writes .ai-qa/config.yaml and .agents/skills/ai-qa-project/SKILL.md
Codex runs doctor again
```

State that `ai-qa` is not a runtime, Project Skill is project-owned, Git/GitHub are optional, and doctor never auto-installs. Mark the July 15 authoring/transaction sections as superseded by the July 16 design rather than silently rewriting history.

- [ ] **Step 4: Run fresh-context global Skill evaluation**

Run five isolated Family A repetitions and five isolated Family B repetitions. Each worker reads only final `SKILL.md` and its reference, writes an append-only raw prompt/answer envelope, and is scored on:

- host-managed config/Skill drafts and one confirmation;
- `skill-creator` use without pre-approval target write;
- local-only default and no provider invention;
- exact arbitrary project procedure;
- verified-report boundary;
- neutral status/references;
- no retry after unknown;
- unchanged verdict;
- no manual checksum or combined initialization JSON.

Any failure invalidates the full affected five-repetition family. Preserve failed raw evidence; minimally fix the main Skill and rerun the whole family.

- [ ] **Step 5: Run E2E/docs gate and commit**

```bash
pnpm vitest run tests/e2e/project-recording-flow.test.ts tests/e2e/cli-web-vertical-slice.test.ts
pnpm format:check
git diff --check
git add tests/e2e README.md docs/validation docs/superpowers/specs/2026-07-15-ai-qa-project-recording-skill-design.md
git commit -m "docs: explain host-managed project recording"
```

Expected: PASS and fresh evaluation 10/10.

---

### Task 8: Run the Terminal Quality and Review Gate

**Files:**
- Modify only files required by review findings.
- Verify: all source, tests, docs, and packaged assets changed by Tasks 1-7.

**Interfaces:**
- Consumes: completed Tasks 1-7.
- Produces: review-clean integrated branch and completion evidence.

- [ ] **Step 1: Prove superseded product surface is gone**

```bash
rg -n "InitializationRequest|projectSkill\.content|prepareProjectSkill|projectSkillRequestSchema|applyProjectSetup|previewProjectSetup|applyProjectFileTransaction|aiQaManagedChecksum" src tests README.md
```

Expected: no target Project Skill authoring/wire matches. Matches inside the global main-Skill's own service-managed metadata implementation are allowed only for the product-distributed global Skill and must be manually classified.

- [ ] **Step 2: Run focused feature suites**

```bash
pnpm vitest run \
  tests/unit/config-migration.test.ts \
  tests/unit/project-skill-file.test.ts \
  tests/unit/recording-schema.test.ts \
  tests/unit/work-order.test.ts \
  tests/unit/installation-doctor.test.ts \
  tests/integration/config-cli.test.ts \
  tests/integration/doctor-cli.test.ts \
  tests/integration/global-skill.test.ts \
  tests/integration/run-journal.test.ts \
  tests/integration/report-generation.test.ts \
  tests/integration/recording-receipt.test.ts \
  tests/e2e/project-recording-flow.test.ts \
  tests/e2e/cli-web-vertical-slice.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run the full TypeScript quality gate**

Use the repository `quality-gate` skill and run:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm exec vitest run --coverage
git diff --check
```

Expected: every command exits 0; changed branches have meaningful coverage.

- [ ] **Step 4: Run two-stage whole-branch review**

Ask a fresh specification reviewer to compare the branch against `2026-07-16-ai-qa-host-managed-project-skill-design.md`, then ask a fresh code-quality reviewer to inspect correctness, filesystem safety, compatibility, stale API surface, and test sufficiency. Fix findings with TDD and rerun the affected task plus the full gate.

- [ ] **Step 5: Capture final state and commit gate fixes**

```bash
git status --short
git log --oneline --decorate -15
git diff --stat a6ea8c40e891115c0470f7e325a16b7950d03cf3..HEAD
```

The worktree must be clean. If review/gate fixes changed tracked files:

```bash
git add src tests README.md docs
git commit -m "fix: close host-managed skill review findings"
```

Completion evidence must include config v1 unchanged-byte compatibility, doctor installation states, local-only absence of recording files, project-skill hash drift, receipt recovery/idempotency, report/verdict immutability, packaged main-Skill 1.2 metadata, fresh evaluation 10/10, full test/coverage counts, and clean status.
