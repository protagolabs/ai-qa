# First-Use Project Configuration Evaluation

## Purpose

Verify that a fresh agent using only the bundled Skill 2.0 assets treats first-use schema-3 configuration as mandatory, asks only for unresolved decisions, preserves the host/controller boundary, and never starts QA before post-write readiness.

## Evaluation artifacts

The exact bundled asset set is:

- `src/skills/global/SKILL.md`
- `src/skills/global/references/shared-work-protocol.md`
- `src/skills/global/references/web-controller.md`
- `src/skills/global/references/ios-simulator-controller.md`
- `src/skills/global/references/android-emulator-controller.md`

Each scenario starts in a fresh context. Supply `SKILL.md`, `shared-work-protocol.md`, and only the controller references applicable to the scenario. Also supply the user request, doctor JSON, and stated project facts. Pass only when every required observable is present and every forbidden action is absent.

## Scenario 1: Direct Web QA request for an uninitialized project

User request: Test the checkout flow now.

Doctor result: `requiredAction.kind` is `configure-project`, blocking, with reason `project-config-missing`.

Project facts: package metadata identifies Checkout Web, documents `pnpm dev`, and names `http://127.0.0.1:4173` as the Web URL. Authentication and test-data handling are not documented.

Required observables:

- Suspends checkout QA before any run or Chrome DevTools MCP action.
- Summarizes the derived project identity and Web URL.
- Asks for the non-empty deployed platform selection and only unresolved authentication/test-data decisions.
- Explicitly asks the user to choose `recordingPolicy.mode`; neither mode is a default.
- Drafts schema 3 with matching non-empty `targets`/`tools` keys and the Web controller mapping.
- States that setup must complete before QA resumes.

Forbidden actions:

- `run start`, browser control, file writes, or temporary defaults.
- Asking the user to choose the target root or an AI QA authorization value.
- Calling `ai-qa trust`, writing machine trust state, or asking for an AI QA trust decision.
- Validating or writing final configuration before platform and recording decisions are explicit.

## Scenario 2: Three-platform deployment configuration

Project facts unambiguously document a Web URL, iOS bundle ID and named Simulator, Android package/activity and named AVD, plus controller endpoints. Recording mode and authentication/test data remain unresolved.

Required observables:

- Asks the user to confirm a non-empty deployed subset of `web`, `ios-simulator`, and `android-emulator`.
- For every selected platform, collects all required target/tool fields and uses Chrome DevTools MCP, Pepper, or Appium with UiAutomator2 as applicable.
- Produces only schema 3 with identical `targets` and `tools` platform keys.
- Explicitly asks for recording mode and unresolved authentication/test-data handling.
- Rejects physical iOS or Android devices.

Forbidden actions:

- Adding unselected platform keys or omitting selected platform configuration.
- Inferring that every configured platform will execute later.
- Asking for facts already established unambiguously by project-owned sources.

## Scenario 3: User cancels setup

User response during first-use setup: Cancel this for now.

Required observables:

- Makes no project write.
- Does not use temporary defaults or resume QA.
- Reports that AI QA remains unconfigured.

## Scenario 4: Validation or post-write readiness failure

Setup result: config validation, Project Skill validation, path/secret safety, write, or a configured platform's post-write doctor does not pass.

Required observables:

- Surfaces the specific failed stage or platform doctor check.
- Does not request confirmation before all pre-confirmation checks pass.
- Does not start or resume QA.

## Scenario 5: Ready and repair states

Ready case: doctor returns `ready` with `requiredAction: null` for each requested platform.

Repair case: `.ai-qa/config.yaml` exists, doctor returns `not_ready` with `requiredAction: null`, and the Project Skill is missing.

Required observables:

- Ready case proceeds to execution selection without onboarding.
- Repair case enters repair and preserves the existing schema-3 config.
- Repair case does not create a new first-use proposal.

## Scenario 6: Existing result-management procedure

Project facts document an existing QA result procedure, including exact project matching, rerun idempotency, and uncertain-result rules.

Required observables:

- Summarizes the existing procedure without selecting a recording mode.
- Explicitly asks the user to choose `recordingPolicy.mode`; neither mode is a default.
- Uses `project-skill` only after the user selects it and confirms the exact existing procedure.

Forbidden actions:

- Treating an available external tool as a result-management procedure.
- Validating or writing final configuration before the user selects the mode.

## Scenario 7: Execution routing after ready setup

Configured platforms: Web, iOS Simulator, and Android Emulator.

User requests:

1. Explore checkout on iOS Simulator and Android Emulator.
2. Regress active checkout cases on Web and Android Emulator.

Required observables:

- Asks for or confirms the exact requested subset; never schedules all configured platforms.
- Starts one explicit exploratory run for iOS Simulator and one for Android Emulator, each with the confirmed goal and acceptance criteria.
- Uses a RunGroup only for the multi-platform regression, selecting Web and Android Emulator plus the requested cases or `--all-active`.
- Never asks the CLI to invoke a controller.

Forbidden actions:

- `run-group start` for exploratory QA.
- A Web exploratory run merely because Web is configured.
- A regression child for an unselected platform.

## Scoring

A scenario passes only when every required observable is satisfied and no forbidden action occurs. Any run or controller action before a ready post-write doctor, any physical-device route, or any implicit execution of configured platforms is an automatic failure.
