# AI QA Three-Platform Vertical Slices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver complete Web, iOS Simulator, and Android Emulator QA vertical slices, user-selected multi-platform regression, and aggregate evidence-backed reporting.

**Architecture:** Replace Web literals with a closed typed platform registry and keep one shared run/evidence/verdict protocol. Platform-specific config and doctor adapters feed that core; immutable case variants and RunGroup manifests preserve platform identity and coverage without copying pipelines.

**Tech Stack:** Node.js 22/24, TypeScript strict ESM, pnpm 11.9.0, Commander, Zod, YAML, proper-lockfile, Vitest, ESLint, and Prettier.

**Design Spec:** `docs/superpowers/specs/2026-07-17-ai-qa-three-platform-vertical-slices-design.md`

## Global Constraints

- Formal platforms are exactly `web`, `ios-simulator`, and `android-emulator`.
- Controller mapping is exactly Web → `chrome-devtools-mcp`, iOS Simulator → `pepper`, Android Emulator → `appium` with `uiautomator2`.
- Real devices are unsupported and rejected.
- A project configures any non-empty platform subset; `targets` and `tools` keys must match exactly.
- Execution platforms are selected per invocation; configuration never means “run all.”
- The CLI records controller calls but never embeds or invokes Chrome DevTools MCP, Pepper, Appium, or UiAutomator2.
- Config schema `3`, work protocol `2.0.0`, and the new current-only persisted schemas do not preserve Web-only compatibility.
- One run owns one platform, work order, journal, evidence directory, verdict, and report.
- One logical case shares acceptance criteria and stores a non-empty subset of immutable platform variants.
- RunGroup freezes case/platform selection and exposes missing selected variants as coverage gaps.
- Group reports retain the complete result matrix and never synthesize a QA verdict.
- Host authority, explicit recording choice, evidence integrity, two-phase actions, finite budgets, and exact project-root rules remain unchanged.
- Execution uses the agreed fast profile: implement tests and production changes task by task, do not run intermediate validation commands, format once, and run `pnpm check` once in Task 9. Rerun only a focused failing command after a failure.
- Each implementation subagent commits only its task. Review uses diffs and supplied final validation evidence instead of rerunning the full suite.

## File Structure

Create focused platform, readiness, run-group, and aggregate-report modules:

```text
src/core/platforms/schema.ts                  Closed platform/controller domain
src/core/platforms/registry.ts                Typed target/tool schemas and mappings
src/core/readiness/schema.ts                  Shared doctor observations/results
src/services/doctor/platform-doctor.ts        Web/iOS/Android read-only adapters
src/core/run-groups/schema.ts                 Immutable manifest and group events
src/core/run-groups/paths.ts                  Contained group storage paths
src/core/run-groups/repository.ts             Manifest/journal integrity and locks
src/services/run-groups/start-run-group.ts    Frozen matrix and child work orders
src/services/run-groups/finish-run-group.ts   Terminal-member verification
src/services/run-groups/cancel-run-group.ts   Canonical child cancellation
src/core/reports/group-schema.ts              Aggregate matrix report contract
src/services/report-generation/generate-group-report.ts
src/services/report-generation/render-group-markdown.ts
src/cli/commands/run-group.ts                 Public group lifecycle commands
src/skills/global/references/shared-work-protocol.md
src/skills/global/references/web-controller.md
src/skills/global/references/ios-simulator-controller.md
src/skills/global/references/android-emulator-controller.md
tests/unit/platform-registry.test.ts
tests/unit/platform-doctor.test.ts
tests/integration/run-group.test.ts
tests/integration/group-report.test.ts
tests/e2e/three-platform-vertical-slices.test.ts
docs/validation/ios-simulator-live-acceptance.md
docs/validation/android-emulator-live-acceptance.md
docs/validation/multi-platform-live-acceptance.md
```

Keep existing modules focused by replacing Web-specific types in place. Delete
`src/services/doctor/web-doctor.ts`, `tests/unit/web-doctor.test.ts`, and the
active `src/skills/global/references/web-work-protocol.md` after their current
rules have moved to the new shared/controller references. Historical design
and plan documents remain untouched.

---

### Task 1: Platform Registry and Schema-v3 Configuration

**Files:**
- Create: `src/core/platforms/schema.ts`
- Create: `src/core/platforms/registry.ts`
- Modify: `src/core/tools.ts`
- Modify: `src/core/config/schema.ts`
- Modify: `src/core/config/repository.ts`
- Modify: `src/schemas/versions.ts`
- Modify: `src/cli/commands/config.ts`
- Modify: `src/services/doctor/installation-doctor.ts`
- Modify: `tests/helpers/project-fixture.ts`
- Create: `tests/unit/platform-registry.test.ts`
- Modify: `tests/unit/installation-doctor.test.ts`
- Modify: `tests/integration/config-cli.test.ts`
- Delete: `tests/unit/config-migration.test.ts`

**Interfaces:**
- Consumes: Existing Zod, canonical configuration repository, and secret-reference policy.
- Produces: `Platform`, `Controller`, `platformSchema`, `controllerSchema`, `targetSchemas`, `toolSchemas`, `controllerForPlatform(platform)`, `configuredPlatforms(config)`, and `ProjectConfigV3`.

- [ ] **Step 1: Add failing registry and config tests without running them**

Create table-driven assertions with these exact cases:

```ts
const expectedControllers = {
  web: "chrome-devtools-mcp",
  "ios-simulator": "pepper",
  "android-emulator": "appium",
} as const;

it.each(Object.entries(expectedControllers))(
  "%s owns controller %s",
  (platform, controller) => {
    expect(controllerForPlatform(platformSchema.parse(platform))).toBe(
      controller,
    );
  },
);

it.each([
  ["web"],
  ["ios-simulator"],
  ["android-emulator"],
  ["web", "ios-simulator"],
  ["web", "ios-simulator", "android-emulator"],
] as const)("accepts configured subset %j", (platforms) => {
  expect(projectConfigSchema.parse(projectConfigFor(platforms))).toBeDefined();
});

it("rejects empty and target/tool-mismatched platform sets", () => {
  expect(() => projectConfigSchema.parse(projectConfigFor([]))).toThrow();
  const mismatched = projectConfigFor(["web"]);
  mismatched.tools = { "ios-simulator": { controller: "pepper" } };
  expect(() => projectConfigSchema.parse(mismatched)).toThrow();
});
```

Update config CLI coverage to accept schema `3` and reject schema `1` and `2`.

- [ ] **Step 2: Implement the closed platform/controller domain**

Create these exact public definitions:

```ts
export const platformSchema = z.enum([
  "web",
  "ios-simulator",
  "android-emulator",
]);
export type Platform = z.infer<typeof platformSchema>;

export const controllerSchema = z.enum([
  "chrome-devtools-mcp",
  "pepper",
  "appium",
]);
export type Controller = z.infer<typeof controllerSchema>;

export const PLATFORM_CONTROLLERS = {
  web: "chrome-devtools-mcp",
  "ios-simulator": "pepper",
  "android-emulator": "appium",
} as const satisfies Record<Platform, Controller>;

export function controllerForPlatform(platform: Platform): Controller {
  return PLATFORM_CONTROLLERS[platform];
}

export function controllerMatchesPlatform(
  platform: Platform,
  controller: Controller,
): boolean {
  return controllerForPlatform(platform) === controller;
}
```

Keep `src/core/tools.ts` as a compatibility-free re-export boundary for the
new current types; remove `WebController` and `webControllerSchema`.

- [ ] **Step 3: Implement strict per-platform target and tool schemas**

The registry exports these shapes:

```ts
export const targetSchemas = {
  web: z.object({
    entryUrl: z.string().url(),
    readinessUrl: z.string().url().optional(),
  }).strict(),
  "ios-simulator": z.object({
    bundleId: z.string().trim().min(1),
    simulator: z.discriminatedUnion("selection", [
      z.object({ selection: z.literal("booted") }).strict(),
      z.object({
        selection: z.literal("device-name"),
        deviceName: z.string().trim().min(1),
      }).strict(),
    ]),
    launch: z.object({
      buildCommand: z.string().trim().min(1).optional(),
      arguments: z.array(z.string()).optional(),
    }).strict().optional(),
  }).strict(),
  "android-emulator": z.object({
    appPackage: z.string().trim().min(1),
    appActivity: z.string().trim().min(1),
    emulator: z.discriminatedUnion("selection", [
      z.object({ selection: z.literal("running") }).strict(),
      z.object({
        selection: z.literal("avd-name"),
        avdName: z.string().trim().min(1),
      }).strict(),
    ]),
  }).strict(),
} as const;

export const toolSchemas = {
  web: z.object({ controller: z.literal("chrome-devtools-mcp") }).strict(),
  "ios-simulator": z.object({ controller: z.literal("pepper") }).strict(),
  "android-emulator": z.object({
    controller: z.literal("appium"),
    automationName: z.literal("uiautomator2"),
    endpoint: z.string().url(),
  }).strict(),
} as const;
```

Build strict partial platform maps, require at least one target, and use
`superRefine` to require identical sorted keys in `targets` and `tools`.
Export configured keys in canonical registry order:

```ts
export function configuredPlatforms(config: ProjectConfigV3): Platform[] {
  return platformSchema.options.filter(
    (platform) => config.targets[platform] !== undefined,
  );
}
```

- [ ] **Step 4: Replace config persistence with current-only schema 3**

Set `CONFIG_SCHEMA_VERSION = 3`, export only `projectConfigV3Schema`,
`projectConfigSchema`, `ProjectConfigV3`, and `ProjectConfig`. Remove stored
v1/v2 unions and `normalizeProjectConfig`. `readProjectConfig`, create, write,
and `config validate` parse schema 3 directly.

Update the project fixture to expose:

```ts
export function projectConfig(
  platforms: readonly Platform[] = ["web"],
  mode: "local-only" | "project-skill" = "local-only",
): ProjectConfig
```

The helper constructs only requested target/tool entries and retains all
shared evidence, report, recording, Git, CI, and secret-reference policies.
Update installation doctor config messaging and validation expectations to
name schema 3 without changing its installation-only behavior.

- [ ] **Step 5: Commit the platform/config foundation**

```bash
git add src/core/platforms src/core/tools.ts src/core/config src/schemas/versions.ts src/cli/commands/config.ts src/services/doctor/installation-doctor.ts tests/helpers/project-fixture.ts tests/unit/platform-registry.test.ts tests/unit/installation-doctor.test.ts tests/integration/config-cli.test.ts tests/unit/config-migration.test.ts
git commit -m "feat: add typed three-platform configuration"
```

---

### Task 2: Platform Doctors and Readiness CLI

**Files:**
- Create: `src/core/readiness/schema.ts`
- Create: `src/services/doctor/platform-doctor.ts`
- Delete: `src/services/doctor/web-doctor.ts`
- Modify: `src/cli/commands/doctor.ts`
- Modify: `src/cli/commands/run.ts`
- Modify: `tests/integration/doctor-cli.test.ts`
- Create: `tests/unit/platform-doctor.test.ts`
- Delete: `tests/unit/web-doctor.test.ts`

**Interfaces:**
- Consumes: `Platform`, `ProjectConfig`, installation checks, and host-supplied observations.
- Produces: `agentCapabilityObservationSchema`, `platformDoctorInputSchema`, `platformReadinessSchema`, `PlatformReadiness`, and `runPlatformDoctor(input)`.

- [ ] **Step 1: Add doctor contract tests without running them**

Cover these exact ready inputs and one missing-controller case per platform:

```ts
const ready = (evidence: string) => ({
  status: "ready" as const,
  observedAt: "2026-07-17T00:00:00.000Z",
  evidence,
});

expect(await runPlatformDoctor({
  platform: "ios-simulator",
  target: iosTarget,
  installationChecks: [],
  observations: {
    simulator: ready("iPhone 16 Pro is booted"),
    app: ready("com.example.app is installed and launchable"),
    pepper: ready("Pepper UI and screenshot capabilities are available"),
  },
  fetchImpl: fetch,
})).toMatchObject({ platform: "ios-simulator", status: "ready" });

expect(await runPlatformDoctor({
  platform: "android-emulator",
  target: androidTarget,
  tool: androidTool,
  installationChecks: [],
  observations: {
    emulator: ready("Pixel_9_API_36 is running"),
    app: ready("package/activity are launchable"),
    appium: { ...ready("missing"), status: "missing" },
    uiautomator2: ready("driver capability is installed"),
  },
  fetchImpl: fetch,
})).toMatchObject({ platform: "android-emulator", status: "not_ready" });
```

CLI tests must reject an unconfigured platform before consuming platform
observations and must keep installation-only doctor behavior when no platform
is supplied.

- [ ] **Step 2: Implement shared readiness schemas**

Define a strict discriminated input union and shared output:

```ts
export const platformReadinessSchema = z.object({
  platform: platformSchema,
  status: z.enum(["ready", "not_ready"]),
  checks: z.array(z.object({
    code: z.string().trim().min(1),
    status: z.enum(["pass", "fail", "agent_confirmation_required"]),
    message: z.string().trim().min(1),
    category: z.enum(["installation", "tool", "environment"]),
  }).strict()),
}).strict();
```

The input union uses `platform` as discriminator. Web accepts `entryPage?` and
`chromeDevtoolsMcp`; iOS accepts `simulator`, `app`, and `pepper`; Android
accepts `emulator`, `app`, `appium`, and `uiautomator2`.

- [ ] **Step 3: Implement read-only platform doctor adapters**

`runPlatformDoctor` maps installation checks first, then emits these stable
platform check codes and categories:

```ts
const PLATFORM_CHECKS = {
  web: ["web.entry_url", "web.entry_page", "web.readiness_url", "web.chrome_devtools_mcp"],
  "ios-simulator": ["ios.simulator", "ios.app", "ios.pepper"],
  "android-emulator": [
    "android.emulator",
    "android.app",
    "android.appium",
    "android.uiautomator2",
  ],
} as const;
```

Map observation `ready` → `pass`, `missing` → `fail`, and `unknown` →
`agent_confirmation_required`. Tool codes have category `tool`; app/device/URL
codes have category `environment`. Keep the Web readiness HTTP GET timeout at
5 seconds.

- [ ] **Step 4: Route doctor and run CLI inputs by platform**

Parse `--platform` with `platformSchema`, verify `config.targets[platform]` and
`config.tools[platform]` exist, parse stdin with the matching discriminated
input, and call `runPlatformDoctor`. Return `platform.unconfigured` before any
run creation when the selection is absent from config.

Replace the Web-only readiness schema in `run.ts` with
`platformReadinessSchema`; Task 3 will consume it for work orders.

- [ ] **Step 5: Commit platform readiness**

```bash
git add src/core/readiness src/services/doctor src/cli/commands/doctor.ts src/cli/commands/run.ts tests/integration/doctor-cli.test.ts tests/unit/platform-doctor.test.ts tests/unit/web-doctor.test.ts
git commit -m "feat: add iOS and Android readiness doctors"
```

---

### Task 3: Generic Single-Platform Work Orders and Audited Protocol

**Files:**
- Modify: `src/schemas/versions.ts`
- Modify: `src/core/runs/schema.ts`
- Modify: `src/core/runs/repository.ts`
- Modify: `src/core/runs/journal.ts`
- Modify: `src/core/runs/lifecycle.ts`
- Modify: `src/core/evidence/schema.ts`
- Modify: `src/core/evidence/repository.ts`
- Modify: `src/core/evidence/parity.ts`
- Modify: `src/cli/commands/run.ts`
- Modify: `src/cli/commands/evidence.ts`
- Modify: `src/services/run-protocol/start-exploratory-run.ts`
- Modify: `src/services/run-protocol/create-preflight-result-run.ts`
- Modify: `src/services/run-protocol/run-protocol-service.ts`
- Modify: `src/services/run-protocol/register-evidence.ts`
- Modify: `src/services/run-protocol/run-lifecycle.ts`
- Modify: `src/services/run-protocol/finalize-run.ts`
- Modify: `src/services/run-protocol/regression-fidelity.ts`
- Modify: `src/services/run-protocol/verdict-service.ts`
- Modify: `tests/unit/work-order.test.ts`
- Modify: `tests/integration/run-journal.test.ts`
- Modify: `tests/integration/typed-protocol.test.ts`
- Modify: `tests/integration/evidence.test.ts`
- Modify: `tests/unit/evidence-parity.test.ts`
- Modify: `tests/unit/evidence-semantics.test.ts`
- Modify: `tests/integration/run-finalize.test.ts`
- Modify: `tests/integration/run-hardening.test.ts`
- Modify: `tests/integration/verdict-service.test.ts`

**Interfaces:**
- Consumes: `PlatformReadiness`, platform/controller registry, schema-v3 config.
- Produces: protocol `2.0.0`, `createExploratoryWorkOrder({ platform, ... })`, platform-correct events/evidence, and generic preflight classification.

- [ ] **Step 1: Add cross-platform protocol tests without running them**

Add a shared matrix:

```ts
it.each([
  ["web", "chrome-devtools-mcp"],
  ["ios-simulator", "pepper"],
  ["android-emulator", "appium"],
] as const)("audits %s with %s", async (platform, controller) => {
  const workOrder = createExploratoryWorkOrder({
    platform,
    projectId: "sample-project",
    runId: `run-${platform}`,
    input: exploratoryInput(platform),
    evidencePolicy,
    recordingPolicy: { mode: "local-only" },
    startedAt: now(),
  });
  expect(workOrder.platform).toBe(platform);
  expect(workOrder.readiness.platform).toBe(platform);
  expect(controllerForPlatform(workOrder.platform)).toBe(controller);
});
```

Add negative assertions for mismatched readiness platform, planned action tool,
completed action tool, event platform, evidence platform/source tool, and
capture-action provenance.

- [ ] **Step 2: Bump current persisted protocol shapes**

Set these exact current versions:

```ts
export const EVENT_SCHEMA_VERSION = 2 as const;
export const EVIDENCE_SCHEMA_VERSION = 2 as const;
export const CASE_SCHEMA_VERSION = 2 as const;
export const WORK_ORDER_SCHEMA_VERSION = 2 as const;
export const REPORT_SCHEMA_VERSION = 2 as const;
export const WORK_PROTOCOL_VERSION = "2.0.0" as const;
```

`storedWorkProtocolVersionSchema` accepts only `2.0.0`. Replace every Web
literal in current work-order, readiness, event, and evidence schemas with
`platformSchema` or `controllerSchema`.

- [ ] **Step 3: Enforce platform/controller invariants in work orders and events**

Add schema refinement equivalent to:

```ts
if (workOrder.readiness.platform !== workOrder.platform) {
  issue(context, ["readiness", "platform"], "Readiness must match run platform");
}
for (const [index, step] of workOrder.requiredSteps.entries()) {
  if (!controllerMatchesPlatform(workOrder.platform, step.tool)) {
    issue(context, ["requiredSteps", index, "tool"], "Step controller must match run platform");
  }
}
```

`RunRepository.create` writes the start event with
`platform: validated.platform`. Journal/protocol validation rejects any later
event whose platform differs from the immutable work order.

- [ ] **Step 4: Make exploratory and preflight creation platform-generic**

Add `platform: Platform` to `createExploratoryWorkOrder` and use it in
`startExploratoryRun`. Validate that the platform is configured and readiness
matches. Remove all “Web QA” wording from service errors and summaries.

Classify preflight failure from doctor check `category`: any failed `tool`
check produces `blocked:tool`; otherwise a failed check produces
`blocked:environment`; unknown-only readiness produces
`not_verified/incomplete_coverage`.

- [ ] **Step 5: Make action and evidence provenance platform-generic**

Parse action/evidence tools with `controllerSchema`. Before append or file copy,
require:

```ts
const expectedController = controllerForPlatform(workOrder.platform);
if (payload.tool !== expectedController) {
  throw new AiQaError(
    "run_protocol.controller_mismatch",
    "Action controller must match the immutable run platform",
    {
      runId: workOrder.runId,
      platform: workOrder.platform,
      expectedController,
      actualController: payload.tool,
    },
  );
}
if (
  evidence.platform !== workOrder.platform ||
  evidence.sourceTool !== expectedController
) {
  throw new AiQaError(
    "evidence.controller_mismatch",
    "Evidence provenance must match the immutable run platform",
    {
      runId: workOrder.runId,
      platform: workOrder.platform,
      expectedController,
      evidencePlatform: evidence.platform,
      sourceTool: evidence.sourceTool,
    },
  );
}
```

Persist evidence with the work-order platform, not a caller-selected or
hard-coded platform. Preserve existing hash, path, action, observation,
criterion, sensitivity, and idempotency checks.

- [ ] **Step 6: Commit the shared audited protocol**

```bash
git add src/schemas/versions.ts src/core/runs src/core/evidence src/cli/commands/run.ts src/cli/commands/evidence.ts src/services/run-protocol tests/unit/work-order.test.ts tests/unit/evidence-parity.test.ts tests/unit/evidence-semantics.test.ts tests/integration/run-journal.test.ts tests/integration/typed-protocol.test.ts tests/integration/evidence.test.ts tests/integration/run-finalize.test.ts tests/integration/run-hardening.test.ts tests/integration/verdict-service.test.ts
git commit -m "refactor: generalize audited runs across platforms"
```

---

### Task 4: Immutable Cross-Platform Case Variants and Regression

**Files:**
- Modify: `src/core/cases/schema.ts`
- Modify: `src/core/cases/repository.ts`
- Modify: `src/services/case-promotion/draft-case.ts`
- Modify: `src/services/run-protocol/start-regression-run.ts`
- Modify: `src/services/run-protocol/create-preflight-result-run.ts`
- Modify: `src/services/run-protocol/regression-fidelity.ts`
- Modify: `src/services/run-protocol/finalize-run.ts`
- Modify: `src/cli/commands/case.ts`
- Modify: `src/cli/commands/run.ts`
- Modify: `tests/unit/case-hash.test.ts`
- Modify: `tests/unit/regression-budget.test.ts`
- Modify: `tests/integration/case-promotion.test.ts`
- Modify: `tests/integration/regression-replay.test.ts`

**Interfaces:**
- Consumes: generic audited exploratory runs and platform registry.
- Produces: `caseVariantSchema`, partial `variants`, per-platform promotion sources, `calculatePlatformVariantHash(revision, platform)`, and platform-selected regression work orders.

- [ ] **Step 1: Add case merge and regression tests without running them**

Build Web and iOS completed exploratory source runs with identical acceptance
criteria. Assert:

```ts
const webDraft = await draftCaseFromRun({
  projectRoot,
  runId: "run-web-source",
  input: { caseId: "login", title: "Login", steps: webSteps, excludedActions: [] },
});
const iosDraft = await draftCaseFromRun({
  projectRoot,
  runId: "run-ios-source",
  input: { caseId: "login", title: "Login", steps: iosSteps, excludedActions: [] },
});

expect(iosDraft.revision).toBe(webDraft.revision + 1);
expect(Object.keys(iosDraft.variants).sort()).toEqual(["ios-simulator", "web"]);
expect(iosDraft.promotion.sources.web.sourceRunId).toBe("run-web-source");
expect(iosDraft.promotion.sources["ios-simulator"].sourceRunId).toBe("run-ios-source");
```

Also test replacement of one variant, acceptance-criteria mismatch blocking
activation, missing selected variant, selected variant hash pinning, and stale
case/variant hash rejection.

- [ ] **Step 2: Replace the Web-only case shape**

Define a platform-neutral step and partial variant/source maps:

```ts
export const caseStepSchema = z.object({
  id: stepIdSchema,
  sourceActionId: actionIdSchema,
  intent: z.string().trim().min(1),
  tool: controllerSchema,
  target: targetDescriptionSchema,
  expectedState: z.string().trim().min(1),
  assertionStrategy: z.string().trim().min(1),
  evidenceCheckpoints: z.array(z.string().trim().min(1)).min(1),
}).strict();

export const caseVariantSchema = z.object({
  steps: z.array(caseStepSchema).min(1),
}).strict();
```

Use strict optional keys for all formal platforms, require at least one
variant, require source keys to equal variant keys, and refine every step tool
against its variant platform. Export:

```ts
export function calculatePlatformVariantHash(
  revision: CaseRevision,
  platform: Platform,
): string
```

Throw `case.variant_missing` when the selected key is absent.

- [ ] **Step 3: Merge promotions into new immutable revisions**

Rename input `webSteps` to `steps`. Read the source work-order platform and
controller. If the case exists, read its latest revision, copy variants and
promotion sources, and replace only `variants[source.platform]` and
`sources[source.platform]`. If shared criteria or title differ, retain the
proposed revision with a stable validation issue that blocks activation.

Validate each stored source run against its matching variant. Never edit an
existing revision file or active index entry.

- [ ] **Step 4: Select and pin the requested regression variant**

Add `platform: Platform` to `PrepareRegressionWorkOrderInput`. Require the
platform in project config, select `revision.variants[platform]`, and map only
those ordered steps. Write:

```ts
pinnedCase: {
  caseId: revision.caseId,
  revision: revision.revision,
  caseContentHash: calculateCaseContentHash(revision),
  platformVariantHash: calculatePlatformVariantHash(revision, platform),
}
```

All fidelity, finalization, and report integrity checks calculate the same
selected hash from `workOrder.platform`.

- [ ] **Step 5: Commit cross-platform cases and regression**

```bash
git add src/core/cases src/services/case-promotion src/services/run-protocol/start-regression-run.ts src/services/run-protocol/create-preflight-result-run.ts src/services/run-protocol/regression-fidelity.ts src/services/run-protocol/finalize-run.ts src/cli/commands/case.ts src/cli/commands/run.ts tests/unit/case-hash.test.ts tests/unit/regression-budget.test.ts tests/integration/case-promotion.test.ts tests/integration/regression-replay.test.ts
git commit -m "feat: add immutable platform case variants"
```

---

### Task 5: Platform-Correct Per-Run Reports

**Files:**
- Modify: `src/core/reports/schema.ts`
- Modify: `src/services/report-generation/generate-run-report.ts`
- Modify: `src/services/report-generation/render-markdown.ts`
- Modify: `src/services/report-generation/recording-receipt.ts`
- Modify: `tests/unit/run-report-schema.test.ts`
- Modify: `tests/unit/render-markdown.test.ts`
- Modify: `tests/integration/report-generation.test.ts`
- Modify: `tests/integration/recording-receipt.test.ts`

**Interfaces:**
- Consumes: terminal generic work orders, verified evidence, selected case variants.
- Produces: schema-v2 `RunReport` with platform/controller identity, platform-neutral variant labels, and `verifyRunReport(input)` for canonical aggregate reuse.

- [ ] **Step 1: Add report matrix tests without running them**

For each platform/controller pair, generate a completed run report and assert:

```ts
expect(report.run).toMatchObject({ platform, controller });
expect(report.evidence.every((item) => item.sourceTool === controller)).toBe(true);
expect(markdown).toContain(`- Platform: \`${platform}\``);
expect(markdown).toContain(`- Controller: \`${controller}\``);
expect(markdown).toContain("- Platform variant hash:");
```

Keep recording receipt tests unchanged in meaning: recording status never
changes the QA verdict and still requires a verified configured local report.

- [ ] **Step 2: Generalize report schemas and content**

Set report `schemaVersion` to `REPORT_SCHEMA_VERSION` (`2`). Replace the Web
literal with `platformSchema`, add `controller: controllerSchema` to `run`, and
include `sourceTool` in every evidence summary. Refine controller/platform
matches.

Build report controller with `controllerForPlatform(workOrder.platform)` and
validate the selected case variant using `calculatePlatformVariantHash`.

Extract the existing locked canonical build path as:

```ts
export async function verifyRunReport(
  input: ReportOperationInput,
): Promise<RunReport>
```

It returns a freshly integrity-verified report without writing artifacts and
is the only child-report input accepted by Task 7 aggregation.

- [ ] **Step 3: Render platform-neutral Markdown and preserve recording**

Replace “Web variant hash” with “Platform variant hash”, print controller and
evidence source-tool identity, and keep the stable report-content comparison
for JSON/Markdown parity. Do not change receipt idempotency, uncertain-result,
or Project Skill snapshot rules.

- [ ] **Step 4: Commit generic run reports**

```bash
git add src/core/reports/schema.ts src/services/report-generation tests/unit/run-report-schema.test.ts tests/unit/render-markdown.test.ts tests/integration/report-generation.test.ts tests/integration/recording-receipt.test.ts
git commit -m "feat: report verified platform provenance"
```

---

### Task 6: Immutable RunGroup Orchestration

**Files:**
- Create: `src/core/run-groups/schema.ts`
- Create: `src/core/run-groups/paths.ts`
- Create: `src/core/run-groups/repository.ts`
- Create: `src/services/run-groups/start-run-group.ts`
- Create: `src/services/run-groups/finish-run-group.ts`
- Create: `src/services/run-groups/cancel-run-group.ts`
- Create: `src/cli/commands/run-group.ts`
- Modify: `src/core/cases/repository.ts`
- Modify: `src/core/runs/schema.ts`
- Modify: `src/services/run-protocol/start-regression-run.ts`
- Modify: `src/services/doctor/installation-doctor.ts`
- Modify: `src/cli/program.ts`
- Modify: `tests/helpers/project-fixture.ts`
- Modify: `tests/unit/installation-doctor.test.ts`
- Create: `tests/integration/run-group.test.ts`
- Modify: `tests/cli/help.test.ts`

**Interfaces:**
- Consumes: active case revisions, selected configured platforms, per-platform readiness, prepared regression work orders.
- Produces: `RunGroupManifest`, `RunGroupRepository`, `startRunGroup`, `finishRunGroup`, `cancelRunGroup`, and `run-group` CLI commands.

- [ ] **Step 1: Add immutable group behavior tests without running them**

Cover explicit cases, `--all-active`, one/two/three platform selections,
unconfigured platform rejection, missing variant exclusions, frozen active
revision selection, parallel child isolation, finish-before-terminal rejection,
and group cancellation.

Use this core assertion:

```ts
const started = await startRunGroup({
  projectRoot,
  selection: { mode: "explicit", caseIds: ["login"] },
  platforms: ["web", "ios-simulator"],
  execution: "local",
  readiness: { web: readyWeb, "ios-simulator": readyIos },
  now,
});

expect(started.manifest.members.map(({ platform }) => platform).sort()).toEqual([
  "ios-simulator",
  "web",
]);
expect(started.manifest.exclusions).toEqual([]);
expect(await readFile(groupPath, "utf8")).toBe(originalManifestBytes);
```

- [ ] **Step 2: Define immutable manifest and group-event schemas**

Create IDs `run-group-<slug>`. Define manifest members with run ID, case ID,
revision, case hash, platform, variant hash, and budget. Define exclusions with
case identity, platform, and literal reason `missing_variant`. Require unique
member run IDs and unique case/platform cells.

The manifest includes:

```ts
{
  schemaVersion: 1,
  id,
  projectId,
  execution,
  selectionMode,
  selectedPlatforms,
  createdAt,
  members,
  exclusions,
  maximumBudget: { maxToolCalls, maxRecoveryActions },
}
```

Store lifecycle events separately in `events.jsonl`; never rewrite
`group.json`.

- [ ] **Step 3: Implement contained storage and integrity checks**

Resolve only:

```text
.ai-qa/run-groups/<group-id>/group.json
.ai-qa/run-groups/<group-id>/events.jsonl
```

Reject symlinked/non-regular ancestors and files. Use the existing atomic
write and proper-lockfile patterns. Anchor the immutable manifest hash in the
first `started` group event and verify it on every read.

Extend installation doctor and the project fixture with real project-local
`.ai-qa/run-groups` and `.ai-qa/reports/groups` directories, preserving the
existing symlink and containment checks.

- [ ] **Step 4: Prepare and start frozen child work orders**

Add optional fixed `runId` and `runGroupId` inputs to regression preparation.
Resolve selected case revisions once, cross them with selected platforms,
create exclusions for missing variants, and prepare all member work orders.
Persist the manifest before creating child run journals. Return the manifest
and all member work orders; do not invoke platform tools.

- [ ] **Step 5: Finish and cancel groups safely**

`finishRunGroup` verifies every member work order matches the manifest and
every member lifecycle is terminal before appending one idempotent `completed`
event. `cancelRunGroup` invokes canonical `cancelRun` only for non-terminal
members, preserves terminal members, then appends one idempotent `cancelled`
group event.

Register:

```text
ai-qa run-group start (--case <id>... | --all-active) --platform <platform>... --execution local|ci --stdin-json
ai-qa run-group finish <group-id>
ai-qa run-group cancel <group-id> --reason <reason>
```

- [ ] **Step 6: Commit RunGroup orchestration**

```bash
git add src/core/run-groups src/services/run-groups src/cli/commands/run-group.ts src/core/cases/repository.ts src/core/runs/schema.ts src/services/run-protocol/start-regression-run.ts src/services/doctor/installation-doctor.ts src/cli/program.ts tests/helpers/project-fixture.ts tests/unit/installation-doctor.test.ts tests/integration/run-group.test.ts tests/cli/help.test.ts
git commit -m "feat: orchestrate immutable multi-platform run groups"
```

---

### Task 7: Aggregate Group Reports and Recording

**Files:**
- Create: `src/core/reports/group-schema.ts`
- Modify: `src/core/reports/storage.ts`
- Modify: `src/core/recording/schema.ts`
- Modify: `src/core/recording/repository.ts`
- Create: `src/services/report-generation/generate-group-report.ts`
- Create: `src/services/report-generation/render-group-markdown.ts`
- Modify: `src/services/report-generation/recording-receipt.ts`
- Modify: `src/cli/commands/report.ts`
- Create: `tests/integration/group-report.test.ts`
- Modify: `tests/unit/recording-schema.test.ts`
- Modify: `tests/integration/recording-receipt.test.ts`

**Interfaces:**
- Consumes: terminal verified group, terminal child reports, exclusions, report/recording policy.
- Produces: `RunGroupReport`, JSON/Markdown group artifacts, complete matrix, group recording status and receipts.

- [ ] **Step 1: Add aggregate report tests without running them**

Create a group with pass Web, blocked iOS, and missing Android variant. Assert:

```ts
expect(report.matrix).toEqual([
  expect.objectContaining({ caseId: "login", platform: "web", status: "pass" }),
  expect.objectContaining({ caseId: "login", platform: "ios-simulator", status: "blocked", blockerSubtype: "tool" }),
  expect.objectContaining({ caseId: "login", platform: "android-emulator", status: "coverage_gap" }),
]);
expect(report.summary).toEqual({
  pass: 1,
  fail: 0,
  blocked: 1,
  notVerified: 0,
  coverageGap: 1,
});
expect(report).not.toHaveProperty("verdict");
```

Test JSON/Markdown parity, tampered child report rejection, group receipt
idempotency, local-only status, and unknown Project Skill recording behavior.

- [ ] **Step 2: Define the aggregate matrix schema**

Each matrix cell has case ID/revision/hash and platform. Member cells also have
run ID and one preserved status: `pass`, `fail`, `blocked` with subtype, or
`not_verified` with reason. Exclusion cells have `coverage_gap` and
`missing_variant`. Report includes group execution status and summary counts,
but no `verdict` property.

- [ ] **Step 3: Generate and verify group artifacts**

Read the locked terminal group, rebuild every member run report from canonical
journals/evidence, verify manifest identities and hashes, and render the full
selected matrix in stable case/platform order. Write configured artifacts to:

```text
.ai-qa/reports/groups/<group-id>/report.json
.ai-qa/reports/groups/<group-id>/report.md
```

Use a group-directory lock and the same stable-content parity rule as run
reports.

- [ ] **Step 4: Generalize recording subjects**

Use a discriminated report subject:

```ts
export const reportSubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run"), id: runIdSchema }).strict(),
  z.object({ kind: z.literal("run-group"), id: runGroupIdSchema }).strict(),
]);
```

Store group receipts under its group report directory. Apply the same
local-only, Project Skill snapshot, verified-artifact prerequisite,
idempotency, status/reference, and unknown-result rules as individual runs.

Register `report group-generate`, `group-export`, `group-receipt`, and
`group-recording-status` commands.

- [ ] **Step 5: Commit aggregate reporting**

```bash
git add src/core/reports src/core/recording src/services/report-generation src/cli/commands/report.ts tests/integration/group-report.test.ts tests/unit/recording-schema.test.ts tests/integration/recording-receipt.test.ts
git commit -m "feat: add aggregate platform result reports"
```

---

### Task 8: Global Skill, Documentation, and Three-Platform E2E Contracts

**Files:**
- Modify: `src/skills/global/SKILL.md`
- Create: `src/skills/global/references/shared-work-protocol.md`
- Create: `src/skills/global/references/web-controller.md`
- Create: `src/skills/global/references/ios-simulator-controller.md`
- Create: `src/skills/global/references/android-emulator-controller.md`
- Delete: `src/skills/global/references/web-work-protocol.md`
- Delete: `src/skills/global/legacy/1.0.0/SKILL.md`
- Delete: `src/skills/global/legacy/1.0.0/references/web-work-protocol.md`
- Modify: `src/services/skill-management/global-skill.ts`
- Modify: `tests/helpers/global-skill-fixture.ts`
- Modify: `tests/integration/global-skill.test.ts`
- Modify: `tests/unit/managed-skill.test.ts`
- Create: `tests/e2e/three-platform-vertical-slices.test.ts`
- Modify: `tests/e2e/cli-web-vertical-slice.test.ts`
- Modify: `tests/e2e/web-vertical-slice.test.ts`
- Modify: `README.md`
- Modify: `docs/validation/web-live-acceptance.md`
- Create: `docs/validation/ios-simulator-live-acceptance.md`
- Create: `docs/validation/android-emulator-live-acceptance.md`
- Create: `docs/validation/multi-platform-live-acceptance.md`

**Interfaces:**
- Consumes: all current CLI commands and protocol `2.0.0`.
- Produces: bundled Skill `2.0.0`, platform setup/execution routing, current docs, recorded controller contract E2E, and live acceptance runbooks.

- [ ] **Step 1: Add Skill and E2E assertions without running them**

Assert the installed Skill:

```ts
expect(skill).toContain("aiQaSkillVersion: 2.0.0");
expect(skill).toContain("aiQaProtocolRange: ^2.0.0");
expect(skill).toContain("web, ios-simulator, and android-emulator");
expect(skill).toContain("ask which configured platform subset");
expect(skill).not.toContain("schema-v2");
expect(skill).not.toContain("automatically run all");
```

The E2E test uses host-supplied recorded controller observations and temporary
PNG evidence to complete doctor → exploratory → evidence → pass → case variant
→ regression → report for each platform. Then build a two-platform and a
three-platform group and assert aggregate matrices and coverage gap behavior.

- [ ] **Step 2: Rewrite the canonical Skill as platform-neutral routing**

Bump managed metadata to Skill `2.0.0`, protocol `^2.0.0`. Setup asks for a
non-empty deployed platform selection, collects every selected platform's
required config, always asks recording mode, validates schema 3, displays full
diffs, writes once after approval, and doctors every configured platform.

Execution asks for the current requested platform subset. Route shared action,
evidence, case, verdict, and recording rules through
`shared-work-protocol.md`; route controller-specific readiness, target,
screenshot, stale-session, and recovery details through the matching platform
reference. State explicitly that real devices are unsupported and that the CLI
does not invoke controllers.

- [ ] **Step 3: Remove obsolete active and legacy Web-only assets**

Delete the Web-only active reference and legacy `1.0.0` bundle. Update global
skill installation tests so the bundled current asset set is exact and stale
removed reference files do not survive a confirmed sync.

- [ ] **Step 4: Update current README and validation runbooks**

README documents schema-3 setup examples for each platform, doctor/run command
examples, incremental case variants, user-selected platform subsets, RunGroup,
aggregate report/recording commands, and the simulator/emulator-only boundary.

Each live runbook names its required controller and completes the full
evidence-backed vertical slice. The multi-platform runbook selects two and
three platforms explicitly and verifies matrix/exclusion behavior.

- [ ] **Step 5: Commit the public workflow and acceptance contracts**

```bash
git add src/skills/global src/services/skill-management/global-skill.ts tests/helpers/global-skill-fixture.ts tests/integration/global-skill.test.ts tests/unit/managed-skill.test.ts tests/e2e README.md docs/validation
git commit -m "docs: deliver the three-platform AI QA workflow"
```

---

### Task 9: Single Final Quality Gate and Review Package

**Files:**
- Modify only files reported by formatting or final focused fixes.
- Create: `.superpowers/sdd/three-platform-final-review.md`

**Interfaces:**
- Consumes: Tasks 1–8 on one implementation branch.
- Produces: one formatted, fully validated commit range and evidence package for final review.

- [ ] **Step 1: Run formatting once**

Run:

```bash
pnpm format
```

Expected: Prettier completes successfully. Inspect `git diff --stat` and ensure
formatting touched only intended current source, tests, Skill, README, and
validation files.

- [ ] **Step 2: Run the complete quality gate once**

Run:

```bash
pnpm check
```

Expected: format check, ESLint, TypeScript no-emit, all Vitest files, and the
production build pass. Record the exact file/test counts and command exit code.

If this command fails, fix only the reported failure and rerun only its focused
command (`pnpm format:check`, `pnpm lint`, `pnpm typecheck`, one Vitest file, or
`pnpm build`). After focused success, rerun `pnpm check` once to establish one
clean final gate.

- [ ] **Step 3: Audit design acceptance and literals**

Run these read-only checks:

```bash
rg -n 'WebDoctorResult|WEB_CONTROLLER|webControllerSchema|calculateWebVariantHash|schema-v2|Increment 1 provides one complete local Web workflow' src tests README.md docs/validation
rg -n 'ios-simulator|android-emulator|pepper|appium|uiautomator2|coverage_gap|run-group' src tests README.md docs/validation
git status --short
```

Expected: the first search returns no active Web-only domain literals or stale
public copy; the second demonstrates all formal platform/controller and group
contracts; status contains only intended final changes.

- [ ] **Step 4: Commit formatting and any final gate fixes**

```bash
git add src tests README.md docs/validation package.json pnpm-lock.yaml
git commit -m "chore: finalize three-platform QA support"
```

If formatting produced no changes and the gate needed no fix, skip this empty
commit.

- [ ] **Step 5: Create the final review package and dispatch one reviewer**

Write `.superpowers/sdd/three-platform-final-review.md` with the design link,
base/head commits, task commit list, `pnpm check` output summary, literal-audit
results, and residual live-controller limitations. Dispatch one final reviewer
against that exact commit range. The reviewer must use supplied validation
evidence and must not rerun the full suite under the fast profile.

- [ ] **Step 6: Address findings once and hand off**

Fix correctness findings in one pass, run only affected focused validation,
then one final `pnpm check` if production code changed. Commit the corrections,
update the review package, and report the final commit, validation evidence,
live acceptance still requiring real host tools, and merge options.
