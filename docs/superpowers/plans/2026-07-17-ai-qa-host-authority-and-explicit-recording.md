# AI QA Host Authority and Explicit Recording Implementation Plan

> **Execution profile: single-pass inline.** Tasks 1–4 are the complete change
> specification, not separate execution checkpoints. Apply all source, test,
> Skill, and documentation edits in one implementation pass. Do not run the
> per-task RED/GREEN commands or create per-task commits. After all edits are
> complete, format once and run `pnpm check` once. Only rerun a focused test
> file when the final check identifies a failure. Perform one final commit.
> Do not dispatch implementation or review subagents unless the user explicitly
> requests them.

**Goal:** Remove AI QA's repository-trust authority layer and require an explicit user choice for `recordingPolicy.mode` during first-use configuration.

**Architecture:** Introduce a host-authorized project resolver that wraps the existing exact-root resolver without machine state, then migrate every CLI and runtime service to it while removing `aiQaHome` parameters that existed only for trust. Keep recording-policy enforcement in the existing config/work-order schemas, but make the current bundled Skill require an explicit user decision before it drafts or writes first-use configuration.

**Tech Stack:** TypeScript 5.9, Node.js 22/24, Commander, Zod, Vitest, pnpm, Markdown-managed Codex Skills.

## Global Constraints

- Do not preserve compatibility for `ai-qa trust confirm`, `ai-qa trust status`, `trust.json`, or `trust.*` errors.
- Codex and the host remain the only owners of filesystem authorization, sandboxing, approvals, authentication, and external-tool permissions.
- Preserve exact project-root selection and nested-project-over-ancestor behavior.
- First-use setup must always obtain an explicit `local-only` or `project-skill` choice; there is no recording-mode default.
- `project-skill` is valid only with an identified, user-confirmed existing procedure; tool availability is never a procedure.
- Keep config validation, Project Skill validation, complete diff review, host write approval, and post-write doctor gates unchanged.
- Historical design, plan, and captured evaluation documents remain historical records; update active source, current Skill/reference, tests, README, and current acceptance instructions.
- Update tests in the same implementation pass so they assert the new behavior;
  a separate pre-implementation RED run is not required by this plan.

## Fast Execution Order

1. Read the task specifications and resolve all listed call sites before editing.
2. Apply Tasks 1–4 as one coherent patch, including production code, tests,
   current Skill/reference content, README, and current validation guidance.
3. Run the contract searches from Task 5 and correct any remaining current
   trust/default references.
4. Run `pnpm --filter ai-qa run format -- --write` once.
5. Run `pnpm check` once. If it fails, rerun only the reported test file or
   failing validation command while fixing it, then rerun `pnpm check` once.
6. Review the final diff inline and create one commit for the complete change.

The detailed test and commit commands inside Tasks 1–4 document expected
behavior and useful diagnostics. They are intentionally skipped during a
normal successful execution under this profile.

---

## File Structure

- `src/services/project-root/resolve-project.ts`: host-authorized project resolver; no trust or machine-home inputs.
- `src/services/project-root/resolve-project-root.ts`: existing canonical root-selection implementation; behavior remains unchanged.
- `src/cli/program.ts`: current CLI command registration; remove `trust` registration.
- `src/cli/commands/*.ts`: resolve host-authorized projects and stop constructing trust-only machine-home values.
- `src/services/run-protocol/*.ts`: operate directly on the resolved project root and remove trust-only service inputs.
- `src/services/report-generation/generate-run-report.ts`: verify reports from the host-authorized root without trust state.
- `src/skills/global/SKILL.md`: current first-use orchestration and explicit recording-choice contract.
- `src/skills/global/references/web-work-protocol.md`: canonical setup sequence and schema-v2 drafting guidance.
- `tests/helpers/project-fixture.ts`: project state fixture with no machine-trust concern.
- `tests/unit/project-root.test.ts`: exact-root and host-authorized resolution tests.
- `tests/integration/host-authority.test.ts`: CLI-level proof that trust commands are absent and trust state is unnecessary.
- Existing integration/e2e tests: remove trust setup and assert normal config/state validation instead of trust errors.
- `README.md`, `docs/validation/first-use-project-configuration-eval.md`, and `docs/validation/web-live-acceptance.md`: current user and acceptance guidance.

---

### Task 1: Add the Host-Authorized Resolver and Remove the Trust CLI Surface

**Files:**

- Create: `src/services/project-root/resolve-project.ts`
- Create: `tests/integration/host-authority.test.ts`
- Modify: `tests/unit/project-root.test.ts`
- Modify: `src/cli/program.ts`
- Delete after Task 2 migration: `src/cli/commands/trust.ts`

**Interfaces:**

- Consumes: `resolveProjectRoot({ command: "other", cwd, explicitProject? })`.
- Produces: `resolveProject(input: { cwd: string; explicitProject?: string }): Promise<{ projectRoot: string }>`.
- Preserves: canonicalization and exact nested project selection.
- Removes: all supported `ai-qa trust ...` command paths.

- [ ] **Step 1: Write the failing host-authority tests**

Add this unit test to `tests/unit/project-root.test.ts`:

```ts
import { resolveProject } from "../../src/services/project-root/resolve-project.js";

it("resolves a host-authorized project without machine trust input", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-qa-host-project-"));

  await expect(
    resolveProject({ cwd: root, explicitProject: root }),
  ).resolves.toEqual({ projectRoot: await realpath(root) });
});
```

Create `tests/integration/host-authority.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/program.js";
import { createCapturedCli } from "../helpers/cli-context.js";

describe("host-owned project authority", () => {
  it("does not expose an AI QA repository-trust command", async () => {
    const captured = createCapturedCli();

    expect(await runCli(["trust", "status"], captured.context)).toBe(1);
    expect(JSON.parse(captured.stderr.join(""))).toMatchObject({
      error: { code: "commander.unknownCommand" },
    });
  });
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
pnpm test tests/unit/project-root.test.ts tests/integration/host-authority.test.ts
```

Expected: FAIL because `resolve-project.ts` does not exist and `trust` is still registered.

- [ ] **Step 3: Implement the pure project resolver**

Create `src/services/project-root/resolve-project.ts`:

```ts
import { resolveProjectRoot } from "./resolve-project-root.js";

export async function resolveProject(input: {
  cwd: string;
  explicitProject?: string;
}): Promise<{ projectRoot: string }> {
  const resolved = await resolveProjectRoot({
    command: "other",
    cwd: input.cwd,
    ...(input.explicitProject === undefined
      ? {}
      : { explicitProject: input.explicitProject }),
  });
  return { projectRoot: resolved.root };
}
```

- [ ] **Step 4: Unregister the trust command without adding a compatibility handler**

In `src/cli/program.ts`, remove:

```ts
import { registerTrustCommands } from "./commands/trust.js";
```

and:

```ts
registerTrustCommands(program, context);
```

Do not add a deprecated command, warning, alias, or no-op.

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run:

```bash
pnpm test tests/unit/project-root.test.ts tests/integration/host-authority.test.ts
```

Expected: PASS; `trust` follows ordinary unknown-command handling and the resolver requires no `AI_QA_HOME`.

- [ ] **Step 6: Commit the resolver boundary**

```bash
git add src/services/project-root/resolve-project.ts src/cli/program.ts tests/unit/project-root.test.ts tests/integration/host-authority.test.ts
git commit -m "refactor: move project authority to host"
```

---

### Task 2: Remove Runtime Trust State and Trust-Only Parameters

**Files:**

- Delete: `src/cli/commands/trust.ts`
- Delete: `src/services/project-root/resolve-trusted-project.ts`
- Delete: `src/services/trust/confirm-project-trust.ts`
- Delete: `src/services/trust/repository-identity.ts`
- Delete: `src/services/trust/trust-store.ts`
- Modify: `src/cli/commands/blocker.ts`
- Modify: `src/cli/commands/case.ts`
- Modify: `src/cli/commands/doctor.ts`
- Modify: `src/cli/commands/evidence.ts`
- Modify: `src/cli/commands/protocol-helpers.ts`
- Modify: `src/cli/commands/report.ts`
- Modify: `src/cli/commands/run.ts`
- Modify: `src/cli/commands/verdict.ts`
- Modify: `src/services/report-generation/generate-run-report.ts`
- Modify: `src/services/run-protocol/create-preflight-result-run.ts`
- Modify: `src/services/run-protocol/finalize-run.ts`
- Modify: `src/services/run-protocol/read-run-state.ts`
- Modify: `src/services/run-protocol/register-evidence.ts`
- Modify: `src/services/run-protocol/run-lifecycle.ts`
- Modify: `src/services/run-protocol/run-protocol-service.ts`
- Modify: `src/services/run-protocol/start-exploratory-run.ts`
- Modify: `src/services/run-protocol/start-regression-run.ts`
- Modify: `src/services/run-protocol/verdict-service.ts`
- Modify: `tests/helpers/project-fixture.ts`
- Modify: `tests/e2e/project-recording-flow.test.ts`
- Modify: `tests/e2e/web-vertical-slice.test.ts`
- Modify: `tests/integration/case-promotion.test.ts`
- Modify: `tests/integration/doctor-cli.test.ts`
- Modify: `tests/integration/evidence.test.ts`
- Modify: `tests/integration/recording-receipt.test.ts`
- Modify: `tests/integration/regression-replay.test.ts`
- Modify: `tests/integration/report-generation.test.ts`
- Modify: `tests/integration/run-finalize.test.ts`
- Modify: `tests/integration/run-hardening.test.ts`
- Modify: `tests/integration/run-journal.test.ts`
- Modify: `tests/integration/typed-protocol.test.ts`
- Modify: `tests/integration/verdict-service.test.ts`

**Interfaces:**

- `RunProtocolService(projectRoot: string, runId: string, now: () => Date)`.
- `VerdictService(projectRoot: string, runId: string, now: () => Date)`.
- Run/report/evidence/lifecycle function inputs retain `projectRoot`, run-specific inputs, and `now`; remove `aiQaHome`.
- `initializeTestProject(input)` retains `projectRoot`, optional config, and optional Project Skill; remove `aiQaHome`.
- All project access goes through `resolveProject`, never through machine-local state.

- [ ] **Step 1: Change the old trust-boundary tests to describe the new behavior**

Update `tests/integration/run-hardening.test.ts` so a direct call with malformed config and no trust state reaches config validation:

```ts
it("validates project config without an AI QA trust prerequisite", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-host-service-"));
  await mkdir(join(projectRoot, ".ai-qa"), { recursive: true });
  await writeFile(join(projectRoot, ".ai-qa", "config.yaml"), "invalid: [");

  await expect(
    startExploratoryRun({
      projectRoot,
      payload: readyPayload,
      now: fixedNow,
    }),
  ).rejects.toMatchObject({ name: "YAMLParseError", code: "BAD_INDENT" });
  await expectMissing(join(projectRoot, ".ai-qa", "runs"));
});
```

Replace the trust-priority cases in these files with equivalent malformed-state assertions:

- `tests/integration/typed-protocol.test.ts`: `RunProtocolService` reaches work-order parsing and rejects with `work_order.integrity_error` rather than `trust.not_trusted`.
- `tests/integration/verdict-service.test.ts`: `effectiveVerdict()` rejects malformed work-order state with `work_order.integrity_error` rather than `trust.not_trusted`.
- `tests/integration/evidence.test.ts`: `registerEvidence()` rejects malformed work-order state with `work_order.integrity_error` and still does not create evidence output.

Use `{ code: "work_order.integrity_error" }` for all three malformed work-order assertions; never weaken them to generic rejections.

- [ ] **Step 2: Run the changed boundary tests and verify RED**

Run:

```bash
pnpm test tests/integration/run-hardening.test.ts tests/integration/typed-protocol.test.ts tests/integration/verdict-service.test.ts tests/integration/evidence.test.ts
```

Expected: FAIL because the runtime still returns `trust.not_trusted` before reading project state.

- [ ] **Step 3: Migrate runtime services to `resolveProject`**

In every service listed above, replace:

```ts
const trusted = await resolveTrustedProject({
  cwd: input.projectRoot,
  explicitProject: input.projectRoot,
  aiQaHome: input.aiQaHome,
});
```

with:

```ts
const project = await resolveProject({
  cwd: input.projectRoot,
  explicitProject: input.projectRoot,
});
```

Then replace `trusted.projectRoot` with `project.projectRoot`, update imports to `../project-root/resolve-project.js`, and remove `aiQaHome` from service input types when it has no remaining non-trust use.

Apply the same constructor simplification:

```ts
export class RunProtocolService {
  private readonly runId: string;

  constructor(
    private readonly projectRoot: string,
    runId: string,
    private readonly now: () => Date,
  ) {
    this.runId = runIdSchema.parse(runId);
  }
}
```

```ts
export class VerdictService {
  private readonly runId: string;

  constructor(
    private readonly projectRoot: string,
    runId: string,
    private readonly now: () => Date,
  ) {
    this.runId = runIdSchema.parse(runId);
  }

  private async repository(): Promise<RunRepository> {
    const project = await resolveProject({
      cwd: this.projectRoot,
      explicitProject: this.projectRoot,
    });
    return new RunRepository(project.projectRoot, this.now);
  }
}
```

Rename private helpers such as `trustedRepository` and local variables such as `trusted` to `repository`/`project`; no trust terminology remains in current runtime code.

- [ ] **Step 4: Migrate CLI commands and remove trust-only `AI_QA_HOME` plumbing**

Use this CLI resolution pattern:

```ts
const project = await resolveProject({
  cwd: context.cwd,
  ...(typeof projectOption === "string"
    ? { explicitProject: projectOption }
    : {}),
});
```

Return or pass only:

```ts
{ projectRoot: project.projectRoot }
```

Remove `join` imports and `aiQaHome()` helpers only where they become unused. Keep `AI_QA_AGENTS_HOME` and `agentsHome()` because current global Skill discovery still needs them.

`doctor.ts` must run installation and Web checks directly against `root.root`; it must not perform a second authorization resolution after finding config.

- [ ] **Step 5: Simplify test fixtures and all service calls**

Change `tests/helpers/project-fixture.ts` to:

```ts
export async function initializeTestProject(input: {
  projectRoot: string;
  config?: ProjectConfigV2;
  projectSkill?: string;
}): Promise<void> {
  // Existing project-local directory and file creation body is unchanged.
}
```

Across the listed tests:

- delete `confirmProjectTrust` imports and calls;
- remove trust-only `aiQaHome` fixture fields and temporary directories;
- call `new RunProtocolService(projectRoot, runId, now)`;
- call `new VerdictService(projectRoot, runId, now)`;
- remove `aiQaHome` properties from run/report/evidence/lifecycle inputs;
- rename `createTrustedRun`/`initializeTrustedProject` helpers to `createRun`/`initializeProject` when no naming collision exists;
- preserve `AI_QA_HOME` only in a test explicitly proving that changing it has no authorization effect, and assert no `trust.json` is created.

Add this initialized-project proof to `tests/integration/doctor-cli.test.ts` after its project setup and doctor call:

```ts
await expect(
  access(join(aiQaHome, "trust.json")),
).rejects.toMatchObject({ code: "ENOENT" });
```

Import `access` from `node:fs/promises`. The doctor must still return `ready`.

- [ ] **Step 6: Delete the trust subsystem**

Delete the five trust implementation files and old trusted resolver listed in this task. Do not add migration code and do not delete existing user-owned `$AI_QA_HOME/trust.json` files at runtime.

- [ ] **Step 7: Verify no current runtime trust references remain**

Run:

```bash
rg -n "resolveTrustedProject|confirmProjectTrust|TrustStore|readRepositoryIdentity|trust\\.not_trusted|trust\\.confirmation_required|registerTrustCommands" src tests
```

Expected: no output. If released legacy Skill fixtures intentionally retain historical prose, scope this check to `src/**/*.ts` and current `src/skills/global/SKILL.md`/`references`; do not edit historical capture documents.

- [ ] **Step 8: Run focused and full runtime tests**

Run:

```bash
pnpm test tests/unit/project-root.test.ts tests/integration/host-authority.test.ts tests/integration/doctor-cli.test.ts tests/integration/run-hardening.test.ts tests/integration/typed-protocol.test.ts tests/integration/verdict-service.test.ts tests/integration/evidence.test.ts
```

Expected: PASS.

Then run:

```bash
pnpm test
```

Expected: PASS across unit, integration, and e2e tests with no trust setup.

- [ ] **Step 9: Commit runtime trust removal**

```bash
git add src tests
git commit -m "refactor: remove ai qa repository trust"
```

---

### Task 3: Require an Explicit Recording Decision in the Current Global Skill

**Files:**

- Modify: `tests/integration/global-skill.test.ts`
- Modify: `tests/e2e/web-vertical-slice.test.ts`
- Modify: `src/skills/global/SKILL.md`
- Modify: `src/skills/global/references/web-work-protocol.md`

**Interfaces:**

- Produces current Skill metadata `aiQaSkillVersion: 1.4.0` with the existing protocol range and receipt capability.
- Requires one explicit user choice: `recordingPolicy.mode: local-only | project-skill`.
- Requires a confirmed existing procedure before completing `project-skill` setup.
- Forbids a silent `local-only` default and forbids AI QA trust instructions.

- [ ] **Step 1: Replace the current Skill contract assertions first**

In `tests/integration/global-skill.test.ts`:

- rename `describe("bundled global skill 1.3", ...)` to `1.4`;
- expect `aiQaSkillVersion: 1.4.0`;
- delete the test named `ships the exact trust confirmation stdin accepted by the CLI`;
- replace the old automatic local-only fact with these required facts:

```ts
for (const fact of [
  "Always ask the user to explicitly choose `recordingPolicy.mode`; neither `local-only` nor `project-skill` has a default.",
  "Use `local-only` only after the user explicitly selects it.",
  "Use `project-skill` only after the user explicitly selects it and confirms the exact existing result-management procedure.",
  "Tool availability alone is not a result-management procedure.",
  "Do not validate a final config, request write confirmation, write project files, or resume QA until the recording decision is complete.",
  "Target resolution and project access are Codex/host prerequisites; AI QA does not grant repository access.",
]) {
  expect.soft(guidance).toContain(fact);
}
expect.soft(guidance).not.toContain("ai-qa trust");
expect.soft(guidance).not.toContain("repository trust");
expect.soft(guidance).not.toContain(
  "When no existing result-management procedure exists, use `recordingPolicy.mode: local-only`",
);
```

Update the e2e bundled Skill version assertion in `tests/e2e/web-vertical-slice.test.ts` to `1.4.0`.

- [ ] **Step 2: Run the Skill contract tests and verify RED**

Run:

```bash
pnpm test tests/integration/global-skill.test.ts tests/e2e/web-vertical-slice.test.ts
```

Expected: FAIL on version, trust prose, and automatic `local-only` behavior.

- [ ] **Step 3: Update the current Skill metadata and initialization sequence**

In `src/skills/global/SKILL.md`:

```yaml
metadata:
  aiQaSkillVersion: 1.4.0
  aiQaProtocolRange: ^1.2.0
  aiQaRecordingReceipt: true
  aiQaManagedChecksum: bundled
```

Replace the target prerequisite section with:

```markdown
## Host-managed target prerequisites

1. Resolve the exact target project. Never substitute an ancestor for a named nested project.
2. Use only project access already granted by Codex and the host. AI QA does not grant repository access or maintain repository trust.

Target resolution and project access are Codex/host prerequisites; AI QA does not grant repository access.
```

Replace the recording-decision step with the exact five contract sentences asserted above. Keep project inspection first so Codex can summarize an existing procedure, but explicitly state that inspection provides context and never selects the mode.

Change the general source precedence paragraph so recording mode is the explicit exception: other unambiguous fields may still be derived/defaulted, but `recordingPolicy.mode` may not.

- [ ] **Step 4: Update the Web Work Protocol and canonical draft guidance**

Remove the entire canonical trust payload/comment block and trust command. Replace `### Codex-owned prerequisites` with host-owned project access language matching the current Skill.

Replace configuration step 2 with:

```markdown
2. Inspect the available config, Project Skill, project instructions, and documented QA result- or defect-management procedures. Summarize whether an existing procedure was found, then always ask the user to explicitly choose `recordingPolicy.mode`; neither `local-only` nor `project-skill` has a default. Use `local-only` only after the user explicitly selects it. Use `project-skill` only after the user explicitly selects it and confirms the exact existing result-management procedure, including match, rerun, idempotency, and uncertain-result rules. Tool availability alone is not a result-management procedure. Do not validate a final config, request write confirmation, write project files, or resume QA until the recording decision is complete.
```

Immediately before the canonical YAML block, state:

```markdown
The `recordingPolicy.mode` line below is illustrative syntax, not a default. Replace it with the user's explicit confirmed choice before validation.
```

Change the Project Skill example match sentence from `trusted project root` to `exact project root`.

- [ ] **Step 5: Validate the Skill as a Skill artifact**

Invoke `skill-creator` for the current `src/skills/global/SKILL.md` and its referenced `web-work-protocol.md`. Apply any required structural corrections without weakening the explicit-choice contract.

- [ ] **Step 6: Run the Skill tests and verify GREEN**

Run:

```bash
pnpm test tests/integration/global-skill.test.ts tests/e2e/web-vertical-slice.test.ts
```

Expected: PASS; current Skill contains no AI QA trust prerequisite and always asks for recording mode.

- [ ] **Step 7: Commit the current Skill behavior**

```bash
git add src/skills/global tests/integration/global-skill.test.ts tests/e2e/web-vertical-slice.test.ts
git commit -m "feat: require explicit recording mode"
```

---

### Task 4: Update Current Documentation and Acceptance Instructions

**Files:**

- Modify: `README.md`
- Modify: `docs/validation/first-use-project-configuration-eval.md`
- Modify: `docs/validation/web-live-acceptance.md`

**Interfaces:**

- Documents: host-owned authority, unsupported trust CLI, explicit recording choice, and unchanged post-write readiness gate.
- Preserves: historical design/plans and raw past evaluation captures.

- [ ] **Step 1: Write documentation assertions as executable searches**

Run these searches before editing:

```bash
rg -n "ai-qa trust|trust.json|repository trust|machine trust|When no existing result-management procedure exists, use" README.md docs/validation/first-use-project-configuration-eval.md docs/validation/web-live-acceptance.md
```

Expected: matches showing obsolete current guidance.

- [ ] **Step 2: Update README authority and setup flow**

Make these exact conceptual replacements:

- Rename `State and trust boundary` to `State and authority boundary`.
- Remove the machine `trust.json` paragraph.
- Change the flow's first line to `Codex resolves the target and uses host-granted project access`.
- State that AI QA stores no repository authorization state.
- Replace automatic local-only selection with: project inspection is summarized, then the user explicitly chooses `local-only` or `project-skill`; neither is a default.
- In the typed workflow, delete the machine-trust step and renumber the remaining steps.

- [ ] **Step 3: Strengthen first-use evaluation scenarios**

In `docs/validation/first-use-project-configuration-eval.md`, add to Scenario 1 required observables:

```markdown
- Explicitly asks the user to choose `recordingPolicy.mode` even when no existing result-management procedure is documented.
- Does not present `local-only` as already selected or as a default.
```

Add to forbidden actions:

```markdown
- Calling `ai-qa trust`, writing machine trust state, or asking for an AI QA trust decision.
- Validating or writing final configuration before the recording choice is explicit.
```

Add a scenario where an existing procedure is found: Codex summarizes it but still asks the user to select `project-skill`; only after selection does it confirm the exact procedure.

- [ ] **Step 4: Update live acceptance setup and proof**

In `docs/validation/web-live-acceptance.md`:

- remove explicit trust confirmation;
- make the replay explicitly choose `recordingPolicy.mode: local-only` as a user decision;
- replace the final trust-location check with proof that no `$AI_QA_HOME/trust.json` is created or read;
- retain all project-local state, evidence, credential, and report integrity checks.

- [ ] **Step 5: Verify current docs contain no obsolete authority contract**

Run:

```bash
rg -n "ai-qa trust|trust.json|repository trust|machine trust|When no existing result-management procedure exists, use" README.md docs/validation/first-use-project-configuration-eval.md docs/validation/web-live-acceptance.md
```

Expected: no obsolete instruction. A sentence explicitly saying `trust.json` is not created is allowed only in acceptance proof; review that match manually.

Run:

```bash
rg -n "explicitly choose|neither.*default|host-granted|host-owned" README.md docs/validation/first-use-project-configuration-eval.md docs/validation/web-live-acceptance.md
```

Expected: matches in README, first-use evaluation, and live acceptance guidance.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md docs/validation/first-use-project-configuration-eval.md docs/validation/web-live-acceptance.md
git commit -m "docs: align setup with host authority"
```

---

### Task 5: Run One Final Format, Review, and Quality Gate

**Files:**

- Modify: review corrections are restricted to the files already listed in Tasks 1–4; do not add unrelated files.

**Interfaces:**

- Produces: a formatted, reviewed, fully validated TypeScript/Node change.
- Uses: repository scripts only; no ad hoc formatter substitution.

- [ ] **Step 1: Confirm the final diff is scoped**

Run:

```bash
git status --short
git diff --stat
git diff --check
```

Expected: only trust removal, resolver migration, explicit recording-choice Skill behavior, current docs, and their tests; no whitespace errors.

- [ ] **Step 2: Format through the shared package script**

Run:

```bash
pnpm --filter ai-qa run format -- --write
```

Expected: Prettier completes successfully. Review any formatter changes and keep them limited to affected files.

- [ ] **Step 3: Review the complete diff inline once**

Review the complete working-tree diff once. Do not run a separate review
workflow or dispatch a review subagent unless the user explicitly requests it.

Review specifically for:

- any remaining runtime read/write of `trust.json`;
- any `aiQaHome` parameter that exists only for removed trust behavior;
- accidental loss of exact-root or path/symlink safety;
- current Skill wording that still silently selects `local-only`;
- tests that merely remove assertions instead of proving host-authorized behavior.

Fix confirmed findings without speculative refactors. Do not run tests at this
step; validation is consolidated in Step 4.

- [ ] **Step 4: Run the complete repository check**

Run:

```bash
pnpm check
```

Expected sequence and result: `format:check`, ESLint, TypeScript typecheck, full
Vitest suite, and production build all PASS. If it fails, run only the failing
test file or validation command while correcting the issue, then rerun
`pnpm check` once.

- [ ] **Step 5: Run final contract searches**

Run:

```bash
rg -n "resolveTrustedProject|confirmProjectTrust|TrustStore|readRepositoryIdentity|trust\\.not_trusted|trust\\.confirmation_required|registerTrustCommands" src tests
```

Expected: no current runtime/test matches.

Run:

```bash
rg -n "ai-qa trust|When no existing result-management procedure exists, use `recordingPolicy.mode: local-only`" src/skills/global/SKILL.md src/skills/global/references/web-work-protocol.md README.md
```

Expected: no matches.

- [ ] **Step 6: Create the single implementation commit**

After the final check passes:

```bash
git add src tests README.md docs/validation
git commit -m "refactor: move project authority to host"
```

- [ ] **Step 7: Report completion evidence**

Report:

- the removed trust command/state/runtime surfaces;
- the new `resolveProject` interface;
- the explicit recording-choice behavior;
- focused test results and final `pnpm check` result;
- code-review findings and fixes, if any;
- resulting commit hashes.
