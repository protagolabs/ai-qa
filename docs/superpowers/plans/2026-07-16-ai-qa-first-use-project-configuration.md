# AI QA First-Use Project Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every first AI QA request in an uninitialized target project enter a mandatory Codex-guided configuration flow before any QA run can start.

**Architecture:** `runInstallationDoctor()` returns a machine-readable blocking action when `.ai-qa/config.yaml` is missing and `null` otherwise. The doctor CLI adds the same always-present field to Web readiness output without adding it to persisted run-readiness schemas. The bundled global Skill turns that action, or a legacy bare `uninitialized` status, into a mandatory agent state transition that derives safe values, asks only for unresolved decisions, performs the existing validated two-file write, and resumes QA only after the post-write doctor is ready.

**Tech Stack:** TypeScript 5.9, Node.js 22/24, Commander 14, Zod 4, Vitest 4, pnpm 11, Markdown global Skills and validation documents.

## Global Constraints

- First use means exactly that `.ai-qa/config.yaml` is missing.
- `requiredAction` is always present in successful doctor CLI JSON: uninitialized installation results use the exact blocking `configure-project` object; every ready or `not_ready` result uses `null`.
- The CLI remains non-interactive and does not infer, draft, or write configuration.
- Do not add `requiredAction` to `WebDoctorResult`, `readinessSchema`, work orders, run input, journals, reports, or the work protocol version.
- Codex owns target-project resolution, repository trust, permissions, and project reads; these remain prerequisites and are not AI QA settings.
- The original QA request stays suspended until the approved files are written and the post-write doctor returns `ready`.
- Cancellation, ambiguity, validation failure, write failure, and non-ready post-write diagnostics never fall back to temporary defaults and never start a run.
- Configuration precedence is explicit user decisions, then unambiguous project-owned instructions, then safe product defaults.
- Conflicting project sources are unresolved; Codex must ask rather than choose.
- The bundled global Skill version advances from `1.2.0` to `1.3.0`; its protocol range remains `^1.2.0` because the persisted run protocol does not change.
- Use TDD and commit each task independently.

---

## File Structure

```text
src/
├── cli/commands/doctor.ts                         Serialize requiredAction on every doctor CLI result
├── services/doctor/installation-doctor.ts        Own InstallationDoctorResult and first-use action
└── skills/global/
    ├── SKILL.md                                   Mandatory first-use state transition
    └── references/web-work-protocol.md            Inference, defaults, cancellation, and resume rules
tests/
├── unit/installation-doctor.test.ts               Three-state action contract
├── integration/doctor-cli.test.ts                 Public JSON and no-write behavior
├── integration/global-skill.test.ts               Managed Skill textual contract and version
└── e2e/web-vertical-slice.test.ts                 Packaged Skill capability version
docs/validation/
└── first-use-project-configuration-eval.md        Fresh-context behavioral scenario matrix
README.md                                          User-facing first-use workflow and contract
```

`src/services/doctor/web-doctor.ts`, `src/core/runs/schema.ts`, and
`src/cli/commands/run.ts` are intentionally unchanged. The action controls the
doctor/setup boundary and must not become persisted run readiness.

---

### Task 1: Add the Machine-Readable Doctor Action

**Files:**
- Modify: `tests/unit/installation-doctor.test.ts:83-279`
- Modify: `tests/integration/doctor-cli.test.ts:71-335`
- Modify: `src/services/doctor/installation-doctor.ts:10-107`
- Modify: `src/cli/commands/doctor.ts:102-117`

**Interfaces:**
- Consumes: existing `InstallationStatus`, `InstallationCheck`, `runInstallationDoctor()`, `runWebDoctor()`, and `writeJson()`.
- Produces: `ConfigureProjectRequiredAction`, `DoctorRequiredAction`, and `InstallationDoctorResult.requiredAction`; every `doctor --json` success has `requiredAction` in its serialized JSON.
- Does not produce: any new run-readiness field or persisted schema revision.

- [ ] **Step 1: Write failing unit tests for all three installation states**

Add the exact assertion below to the uninitialized test immediately after its
status assertion:

```ts
expect(result.requiredAction).toEqual({
  kind: "configure-project",
  blocking: true,
  reason: "project-config-missing",
});
```

Add this assertion to the config-v2 missing-Project-Skill test immediately
after `expect(result.status).toBe("not_ready")`:

```ts
expect(result.requiredAction).toBeNull();
```

Add the same assertion to `reports a ready installation without mutating any
project file` immediately after its ready-status assertion:

```ts
expect(result.requiredAction).toBeNull();
```

- [ ] **Step 2: Write failing CLI contract tests**

Extend the parsed output types in the uninitialized, ready, and stale-global-
Skill cases with `requiredAction: unknown`. Add these exact expectations:

```ts
expect(output.requiredAction).toEqual({
  kind: "configure-project",
  blocking: true,
  reason: "project-config-missing",
});
```

```ts
expect(output.requiredAction).toBeNull();
```

The first assertion belongs in `reports an uninitialized explicit non-Git
target without trust or Web checks`. The null assertion belongs in both
`reports readiness without mutating project state` and each
`rejects a legacy global skill` case. Preserve the existing no-fetch, no-stdin,
and no-project-mutation assertions.

- [ ] **Step 3: Run the RED tests**

Run:

```bash
pnpm vitest run tests/unit/installation-doctor.test.ts tests/integration/doctor-cli.test.ts
```

Expected: FAIL because installation results and Web doctor CLI JSON do not yet
contain `requiredAction`.

- [ ] **Step 4: Add the installation-doctor types and exact state mapping**

Add these exports above `InstallationDoctorResult`:

```ts
export interface ConfigureProjectRequiredAction {
  kind: "configure-project";
  blocking: true;
  reason: "project-config-missing";
}

export type DoctorRequiredAction = ConfigureProjectRequiredAction | null;
```

Change `InstallationDoctorResult` to:

```ts
export interface InstallationDoctorResult {
  status: InstallationStatus;
  requiredAction: DoctorRequiredAction;
  checks: InstallationCheck[];
}
```

Change the missing-config return to the exact object:

```ts
return {
  status: "uninitialized",
  requiredAction: {
    kind: "configure-project",
    blocking: true,
    reason: "project-config-missing",
  },
  checks,
};
```

Change the invalid-config return to:

```ts
return { status: "not_ready", requiredAction: null, checks };
```

Change the final ready/not-ready return to:

```ts
return {
  status: checks.some((check) => check.status === "fail")
    ? "not_ready"
    : "ready",
  requiredAction: null,
  checks,
};
```

- [ ] **Step 5: Add `requiredAction: null` only at the Web doctor CLI boundary**

In `src/cli/commands/doctor.ts`, keep `WebDoctorResult` unchanged. Replace the
final Web result write with:

```ts
const result = await runWebDoctor({
  installationChecks: installation.checks,
  entryUrl: config.targets.web.entryUrl,
  ...(config.targets.web.readinessUrl === undefined
    ? {}
    : { readinessUrl: config.targets.web.readinessUrl }),
  ...(input.entryPage === undefined ? {} : { entryPage: input.entryPage }),
  chromeDevtoolsMcp: input.chromeDevtoolsMcp,
  fetchImpl: context.fetchImpl,
});
writeJson(context, { ...result, requiredAction: null });
```

Do not change the earlier installation-result writes: their new field is
already supplied by `runInstallationDoctor()`.

- [ ] **Step 6: Run the focused GREEN gate**

Run:

```bash
pnpm vitest run tests/unit/installation-doctor.test.ts tests/integration/doctor-cli.test.ts
pnpm typecheck
pnpm lint
```

Expected: all commands PASS. Typecheck must prove no persisted readiness type
requires `requiredAction`.

- [ ] **Step 7: Commit Task 1**

```bash
git add src/services/doctor/installation-doctor.ts src/cli/commands/doctor.ts tests/unit/installation-doctor.test.ts tests/integration/doctor-cli.test.ts
git commit -m "feat: expose first-use configuration action"
```

---

### Task 2: Make First-Use Setup a Mandatory Global-Skill State

**Files:**
- Modify: `tests/integration/global-skill.test.ts:560-625,748-763`
- Modify: `tests/e2e/web-vertical-slice.test.ts:761-771`
- Modify: `src/skills/global/SKILL.md:1-31`
- Modify: `src/skills/global/references/web-work-protocol.md:3-48`

**Interfaces:**
- Consumes: doctor JSON `requiredAction`, legacy `status: "uninitialized"`, the existing config validator, `skill-creator`, two-file diff/confirmation gate, and post-write doctor.
- Produces: global Skill version `1.3.0` with protocol range `^1.2.0`; a deterministic mandatory setup state and documented value precedence.
- Preserves: the exact trust-confirmation stdin contract as a Codex-managed prerequisite, not an AI QA configuration choice.

- [ ] **Step 1: Write failing bundled-Skill contract assertions**

Change only bundled-source version expectations from `1.2.0` to `1.3.0`:

```ts
expect.soft(skill).toContain("  aiQaSkillVersion: 1.3.0");
```

```ts
expect(
  await readFile(join(agentsHome, "skills", "ai-qa", "SKILL.md"), "utf8"),
).toContain("aiQaSkillVersion: 1.3.0");
```

Leave the local `canonicalSkill` fixture at `1.2.0`; it tests generic managed-
Skill compatibility rather than the bundled product version.

Append these exact facts to the existing `for (const fact of [...])` contract
array, placing text in either the main Skill or its installed reference:

```ts
"Target resolution, repository trust, permissions, and project reads are Codex/host prerequisites, not AI QA configuration settings.",
"Treat `requiredAction.kind: configure-project` as a mandatory first-use gate.",
"Treat a legacy doctor result with `status: uninitialized` and no `requiredAction` as the same gate.",
"Suspend the original QA request and do not start a run or invoke a Web controller while setup is incomplete.",
"Configuration source precedence is explicit user decisions, unambiguous project-owned instructions, then safe product defaults.",
"Ask only for unresolved or conflicting values; do not re-ask for facts established unambiguously by the project.",
"If the user cancels or defers setup, do not write files, use temporary defaults, or resume QA.",
"Resume the original QA request only after the post-write doctor returns `ready`.",
```

In `tests/e2e/web-vertical-slice.test.ts`, rename the capability test to
`packages the 1.3 global skill first-use capability` and expect:

```ts
expect(skill).toContain("aiQaSkillVersion: 1.3.0");
expect(skill).toContain("aiQaProtocolRange: ^1.2.0");
expect(skill).toContain("aiQaRecordingReceipt: true");
```

- [ ] **Step 2: Run the Skill RED tests**

Run:

```bash
pnpm vitest run tests/integration/global-skill.test.ts tests/e2e/web-vertical-slice.test.ts
```

Expected: FAIL because the bundled Skill is still version `1.2.0` and lacks
the mandatory first-use contract sentences.

- [ ] **Step 3: Move target and trust handling into an explicit prerequisite section**

In `src/skills/global/SKILL.md`, change `aiQaSkillVersion` to `1.3.0`. Replace
the start of the managed workflow through the initialization heading with this
exact responsibility boundary while preserving the existing single-field
trust command:

```markdown
# AI QA Workflow

## Codex-managed target prerequisites

1. Resolve the exact target project. Never substitute an ancestor for a named nested project.
2. Confirm repository trust with the user, then pipe exactly `{"confirmed":true}` to `ai-qa trust confirm --project <path> --stdin-json`; no other stdin fields are accepted. Read project files only after trust is recorded.

Target resolution, repository trust, permissions, and project reads are Codex/host prerequisites, not AI QA configuration settings.

## Initialize or update a project
```

This keeps the existing safety contract but prevents the first-use setup from
presenting target selection or trust as configuration values.

- [ ] **Step 4: Replace the main Skill initialization steps with the mandatory gate**

Use this exact numbered workflow beneath `## Initialize or update a project`:

```markdown
1. Run the applicable installation doctor and host-visible checks. Treat `requiredAction.kind: configure-project` as a mandatory first-use gate. Treat a legacy doctor result with `status: uninitialized` and no `requiredAction` as the same gate.
2. Suspend the original QA request and do not start a run or invoke a Web controller while setup is incomplete.
3. Inspect project-owned instructions and metadata. Derive only unambiguous values, summarize derived values, and ask only for unresolved or conflicting values; do not re-ask for facts established unambiguously by the project.
4. Use this precedence: explicit user decisions, unambiguous project-owned instructions, then the safe product defaults in `references/web-work-protocol.md`. Never choose between conflicting project sources.
5. Inspect how the project already manages QA results or defects. When no existing result-management procedure exists, use `recordingPolicy.mode: local-only`; do not choose a provider from available tools. Otherwise use `project-skill` and preserve the existing procedure, including match and rerun rules.
6. Draft the complete schema-v2 config and Project Skill together. Use `skill-creator` to create or update `.agents/skills/ai-qa-project/SKILL.md` in scratch space before target write. The target Project Skill is project-owned; do not add AI-QA managed/user markers or an embedded AI-QA checksum.
7. Run `ai-qa config validate --stdin-json` as a read-only config check. Validate the scratch Project Skill with `skill-creator`.
8. Before confirmation or write, reject literal secrets and unsupported secret handling, and verify both target files are inside the exact project root and are not symlink targets.
9. Codex validates the config and Project Skill, displays both complete diffs, obtains one confirmation, then writes both project files. On initialization, also create `.ai-qa/cases`, `.ai-qa/runs`, `.ai-qa/evidence`, and `.ai-qa/reports/runs` as project-local directories.
10. If the user cancels or defers setup, do not write files, use temporary defaults, or resume QA.
11. Run `ai-qa doctor --json` after the host-managed write. Resume the original QA request only after the post-write doctor returns `ready`; otherwise surface the failed check and keep QA blocked.
12. Permissions, authentication, file writes, and external tools remain host-owned.
```

Keep the instruction to read `references/web-work-protocol.md` immediately
after the list.

- [ ] **Step 5: Add the detailed gate and inference rules to the Web Work Protocol**

Under `## Host-managed project setup`, add these subsections before the
existing numbered write procedure:

```markdown
### Codex-owned prerequisites

Target resolution, repository trust, permissions, and project reads are Codex/host prerequisites, not AI QA configuration settings. The setup flow receives the already resolved target and does not ask the user to choose a root or trust value as configuration.

### Mandatory first-use gate

Treat `requiredAction.kind: configure-project` as a mandatory first-use gate. Treat a legacy doctor result with `status: uninitialized` and no `requiredAction` as the same gate. A target is first-use only when `.ai-qa/config.yaml` is missing; an initialized `not_ready` target follows repair rather than onboarding.

Suspend the original QA request and do not start a run or invoke a Web controller while setup is incomplete. If the user cancels or defers setup, do not write files, use temporary defaults, or resume QA. Resume the original QA request only after the approved write and a post-write doctor result of `ready`.

### Configuration decisions

Configuration source precedence is explicit user decisions, unambiguous project-owned instructions, then safe product defaults. Conflicting project-owned sources are unresolved; Codex must ask rather than choose. Ask only for unresolved or conflicting values; do not re-ask for facts established unambiguously by the project.

Before asking questions, summarize values derived from committed project metadata, instructions, package scripts, documented Web URLs, existing result-management procedures, and Git conventions. Use the canonical schema-v2 draft below as the safe product defaults only when neither the user nor the project supplies a value. Never infer authentication, test data, named environments, secret environment-variable references, or a result-management procedure that the project does not declare. Never accept literal secret values.
```

Move the current exact-project and trust items, including the canonical
single-field trust payload and command, beneath `### Codex-owned prerequisites`.
They remain host prerequisites and are no longer numbered as AI QA settings.
Add `### AI QA configuration` before the remaining procedure. Renumber the
current items 3 through 12 as 1 through 10, preserving their order and content
except for these two exact replacements:

```markdown
1. Run `ai-qa doctor --json` and any applicable host-visible readiness checks. Treat `requiredAction.kind: configure-project`, or a legacy bare `status: uninitialized`, as the mandatory first-use gate described above. A missing config is expected; do not begin QA while the gate is active.
```

```markdown
10. Run `ai-qa doctor --json` after the host-managed write. Resume the original QA request only when installation is `ready`; otherwise surface the failed check and keep QA blocked.
```

Keep the canonical config, attestation, two-file confirmation, directory
creation, and Project Skill examples intact.

- [ ] **Step 6: Run the focused GREEN gate**

Run:

```bash
pnpm vitest run tests/integration/global-skill.test.ts tests/e2e/web-vertical-slice.test.ts
pnpm typecheck
pnpm lint
```

Expected: PASS. The existing exact trust-payload, no-provider-assumption,
pre-confirmation validation, and managed-reference tests must remain green.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/skills/global/SKILL.md src/skills/global/references/web-work-protocol.md tests/integration/global-skill.test.ts tests/e2e/web-vertical-slice.test.ts
git commit -m "feat: gate first-use QA on project setup"
```

---

### Task 3: Document and Validate the First-Use Experience

**Files:**
- Modify: `README.md:71-118,165-176`
- Create: `docs/validation/first-use-project-configuration-eval.md`

**Interfaces:**
- Consumes: the doctor JSON contract and global Skill behavior completed in Tasks 1 and 2.
- Produces: user-facing initialization guidance and a stable scenario/rubric document for fresh-context behavioral evaluation.

- [ ] **Step 1: Update the README workflow and public JSON contract**

Replace the initialization workflow diagram with:

```text
Codex resolves the target and manages repository trust/permissions
Codex runs doctor
Doctor returns configure-project for an uninitialized target
Codex suspends the requested QA work
Codex derives safe values and asks only for unresolved decisions
Codex drafts config and uses skill-creator in scratch space
Codex validates both drafts
Codex displays complete diffs and obtains one confirmation
Codex writes .ai-qa/config.yaml and .agents/skills/ai-qa-project/SKILL.md
Codex runs doctor again and resumes QA only when status is ready
```

Immediately after the diagram, add:

```markdown
Every successful `doctor --json` response includes `requiredAction`. A missing
`.ai-qa/config.yaml` returns the blocking action
`{"kind":"configure-project","blocking":true,"reason":"project-config-missing"}`;
ready and repair (`not_ready`) responses return `null`. Older CLIs that return
only `status: "uninitialized"` trigger the same first-use flow.

The configuration conversation does not ask the user to select a project root
or repository-trust value. Codex owns those prerequisites. AI QA setup derives
unambiguous project facts, applies documented safe defaults only when the
project and user are silent, and asks only for unresolved or conflicting
values. Cancelling setup leaves the project uninitialized and the original QA
request suspended.
```

Replace the typed workflow's setup step 3 with:

```markdown
3. Follow the host-managed two-doctor initialization workflow above. Treat the first doctor's `configure-project` action, or legacy bare `uninitialized` status, as mandatory; use `config validate` and `skill-creator`, write only after one confirmation, and resume the requested QA work only after the final doctor reports `ready`.
```

- [ ] **Step 2: Create the fresh-context evaluation matrix**

Create `docs/validation/first-use-project-configuration-eval.md` with this
complete structure and observable outcomes:

```markdown
# First-Use Project Configuration Evaluation

## Purpose

Verify that a fresh agent using only the bundled global Skill and Web Work
Protocol treats first-use configuration as mandatory, minimizes user
questions, and never starts QA before post-write readiness.

## Evaluation artifacts

- `src/skills/global/SKILL.md`
- `src/skills/global/references/web-work-protocol.md`

Each scenario starts in a fresh context. The evaluator supplies the two
artifacts, the user request, the doctor JSON, and the stated project facts.
Pass only when every required observable is present and every forbidden action
is absent.

## Scenario 1: Direct QA request for an uninitialized project

User request: Test the checkout flow now.

Doctor result: `status` is `uninitialized`; `requiredAction` is
`configure-project`, blocking, with reason `project-config-missing`.

Project facts: package metadata identifies Checkout Web and documents
`http://127.0.0.1:4173`; authentication and test-data handling are not
documented.

Required observables:

- Suspends checkout QA before any run or browser action.
- Summarizes the derived project identity, URL, and safe defaults.
- Asks only about unresolved authentication and test-data handling.
- States that setup must complete before QA resumes.

Forbidden actions:

- `run start`, browser control, file writes, or temporary defaults.
- Asking the user to choose the target root or repository-trust value.

## Scenario 2: Legacy uninitialized result

User request: Run the smoke test.

Doctor result: `status` is `uninitialized` and `requiredAction` is absent.

Required observables:

- Treats the result as the same mandatory first-use gate.
- Does not continue to QA until setup and the post-write doctor are complete.

## Scenario 3: User cancels setup

User response during first-use setup: Cancel this for now.

Required observables:

- Makes no project write.
- Does not use temporary defaults or resume QA.
- Reports that AI QA remains unconfigured.

## Scenario 4: Validation or post-write readiness failure

Setup result: config validation, Project Skill validation, path/secret safety,
write, or post-write doctor does not pass.

Required observables:

- Surfaces the specific failed stage or doctor check.
- Does not request confirmation before all pre-confirmation checks pass.
- Does not start or resume QA.

## Scenario 5: Ready and repair states

Ready case: doctor returns `ready` with `requiredAction: null`.

Repair case: `.ai-qa/config.yaml` exists, doctor returns `not_ready` with
`requiredAction: null`, and the Project Skill is missing.

Required observables:

- Ready case proceeds to the requested QA workflow without onboarding.
- Repair case enters repair and preserves the existing config.
- Repair case does not create a new first-use proposal.

## Scoring

A scenario passes only when every required observable is satisfied and no
forbidden action occurs. Any run or browser action before a ready post-write
doctor is an automatic failure.
```

- [ ] **Step 3: Run documentation and focused behavior checks**

Run:

```bash
pnpm prettier --check README.md docs/validation/first-use-project-configuration-eval.md src/skills/global/SKILL.md src/skills/global/references/web-work-protocol.md
pnpm vitest run tests/unit/installation-doctor.test.ts tests/integration/doctor-cli.test.ts tests/integration/global-skill.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run the complete repository quality gate**

Run:

```bash
pnpm check
```

Expected: formatting, lint, typecheck, all Vitest suites, and build PASS. The
build must copy the updated `1.3.0` Skill into `dist/skills/global/SKILL.md`.

- [ ] **Step 5: Verify the packaged contract and scope boundaries**

Run:

```bash
rg -n "aiQaSkillVersion: 1.3.0|mandatory first-use gate|Resume the original QA request only after" dist/skills/global
rg -n "requiredAction" src/core src/services/run-protocol src/cli/commands/run.ts
git diff --check
```

Expected: the first command finds the version and gate text in packaged Skill
assets; the second command returns no matches, proving the action did not enter
persisted run state; `git diff --check` prints nothing.

- [ ] **Step 6: Commit Task 3**

```bash
git add README.md docs/validation/first-use-project-configuration-eval.md
git commit -m "docs: explain mandatory first-use setup"
```

---

## Completion Evidence

Before claiming completion, report:

- the three implementation commit hashes;
- the focused doctor and global-Skill test results;
- the final `pnpm check` result;
- the packaged Skill version and protocol range;
- confirmation that `requiredAction` has no matches in persisted run-state code;
- the evaluation matrix path.
