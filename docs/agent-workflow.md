# AI QA Agent Workflow

This guide is for an Agent executing QA on behalf of a human. It is a navigation guide, not the protocol source of truth.

Before acting, read and follow the installed `ai-qa` Agent Skill. In this repository, the maintained source is [`src/skills/global/SKILL.md`](../src/skills/global/SKILL.md), with the shared lifecycle contract in [`shared-work-protocol.md`](../src/skills/global/references/shared-work-protocol.md). When this guide and the installed Skill differ, follow the installed Skill.

## Audience and authority

The human supplies the QA goal, acceptance criteria, platform scope, and any project-specific constraints. The host Agent owns project access, permissions, authentication, controller sessions, controller calls, and file writes. The CLI validates and records host-supplied readiness, actions, evidence, assertions, verdicts, cases, RunGroups, reports, and recording receipts; it never invokes a platform controller.

Supported targets are Web, iOS Simulator, and Android Emulator. Real iOS and Android devices are unsupported.

## Sources of truth

- Global workflow: [`src/skills/global/SKILL.md`](../src/skills/global/SKILL.md)
- Shared lifecycle and evidence contract: [`shared-work-protocol.md`](../src/skills/global/references/shared-work-protocol.md)
- Web controller guide: [`web-controller.md`](../src/skills/global/references/web-controller.md)
- iOS Simulator controller guide: [`ios-simulator-controller.md`](../src/skills/global/references/ios-simulator-controller.md)
- Android Emulator controller guide: [`android-emulator-controller.md`](../src/skills/global/references/android-emulator-controller.md)

## First-use project configuration

1. Resolve the exact target-project root and run `ai-qa doctor --json`.
2. If doctor requires configuration, ask the human for a non-empty deployed-platform selection and an explicit recording mode.
3. Collect every required target and controller field for the selected platforms. Never place literal secrets in config.
4. Draft and validate schema-3 `.ai-qa/config.yaml` together with `.agents/skills/ai-qa-project/SKILL.md`.
5. Show the complete proposed content for missing destinations or the complete diff for existing destinations. Obtain one confirmation, then write both files once.
6. Run doctor for every configured platform. Do not begin QA until every requested platform is ready.

Use `ai-qa config --help`, `ai-qa doctor --help`, and the installed Skill for the current input contract.

## Per-request platform selection

Configuration defines available platforms; it does not select the platforms for a QA request. Confirm a non-empty subset of the configured Web, iOS Simulator, and Android Emulator targets for every new request.

Exploratory multi-platform work uses one independent run per platform. Multi-platform regression uses a RunGroup.

## Exploratory QA lifecycle

1. Confirm the goal and observable acceptance criteria.
2. Obtain controller-recorded readiness and start one platform-owned exploratory run with `ai-qa run start --kind exploratory`.
3. Before every controller call, record `ai-qa action plan`; after the call, record exactly one `ai-qa action complete`.
4. After an interaction, capture a fresh observation and fresh registered evidence on the same step before recording a satisfied assertion.
5. Set one evidence-linked verdict, finish the run, then generate and verify the report.
6. Report the verdict, covered criteria, evidence, blockers, and verified report path to the human.

Use the installed Skill for event ordering, evidence freshness, recovery budgets, and controller-specific behavior.

## Bug-fix QA lifecycle

Use two independent exploratory runs:

1. Before the fix, reproduce the bug and preserve an evidence-backed fail baseline.
2. After the fix is deployed, start a new run with the same acceptance criteria and gather fresh evidence.
3. Keep the failed and passing runs separate. Do not revise the failed verdict to represent the deployment.
4. After human review, promote only the evidence-valid passing run to a regression case.
5. Replay the activated case on the requested platform subset.

## Case promotion and activation

Draft from a completed, reviewed exploratory run with `ai-qa case draft --from-run <run-id>`. Validate with `ai-qa case validate`, then activate with `ai-qa case activate` only after explicit human review confirmation.

Each promotion adds or replaces only the source platform variant and retains other platform variants. A fail run may remain a reproduction record, but only a valid pass source can produce an activatable revision.

## Regression and multi-platform RunGroups

For one platform, use `ai-qa run start --kind regression --case <case-id> --platform <platform>`. Follow the pinned variant steps in order and satisfy the same fresh-evidence requirements as exploratory QA.

For multiple platforms, use `ai-qa run-group start` with explicit cases or `--all-active`, the exact platform subset, and local or CI execution. Missing selected variants become `coverage_gap` cells. Finish only after every child run is terminal; the aggregate matrix never synthesizes one QA verdict.

## Reports and recording

Generate and verify each run report before export. Generate and verify every child report before a RunGroup aggregate report.

With `local-only`, return the verified local paths and stop. With `project-skill`, execute the frozen project procedure only after report verification, then submit a neutral receipt. Never retry an external recording operation whose outcome is `unknown`. Recording never changes QA verdicts or matrix cells.

## Interrupted-run repair and project clearing

Use `ai-qa run repair <run-id>` for crash-orphaned evidence or a torn journal tail. Review preserved recovery data under `.ai-qa/recovery/<run-id>/`.

`ai-qa clear` removes configuration and the project-owned AI QA Skill while retaining records. `ai-qa clear --records` removes the complete project-local AI QA record store. These commands are destructive; execute only when the human's request clearly includes the intended scope.

## CLI command map

- Project setup and readiness: `config`, `doctor`, `skill`
- Run lifecycle: `run`, `action`, `observation`, `evidence`, `assertion`, `decision`, `recovery`, `blocker`, `verdict`
- Reusable coverage: `case`, `run-group`
- Results: `report`
- Project cleanup: `clear`

Use `ai-qa <command> --help` for current flags and the installed Skill for sequencing and safety rules.
