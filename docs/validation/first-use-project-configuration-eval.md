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
`pnpm dev` as its startup command and `http://127.0.0.1:4173` as its Web URL;
authentication and test-data handling are not documented.

Required observables:

- Suspends checkout QA before any run or browser action.
- Summarizes the derived project identity, URL, and safe defaults.
- Asks only about unresolved authentication and test-data handling.
- Explicitly asks the user to choose `recordingPolicy.mode` even when no existing result-management procedure is documented.
- Does not present `local-only` as already selected or as a default.
- States that setup must complete before QA resumes.

Forbidden actions:

- `run start`, browser control, file writes, or temporary defaults.
- Asking the user to choose the target root or an AI QA authorization value.
- Calling `ai-qa trust`, writing machine trust state, or asking for an AI QA trust decision.
- Validating or writing final configuration before the recording choice is explicit.

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

## Scenario 6: Existing result-management procedure

Project facts: project instructions document an existing QA result procedure,
including exact project matching, rerun idempotency, and uncertain-result rules.

Required observables:

- Summarizes the existing procedure without selecting a recording mode.
- Explicitly asks the user to choose `recordingPolicy.mode`; neither mode is a default.
- Uses `project-skill` only after the user selects it and confirms the exact existing procedure.

Forbidden actions:

- Treating an available external tool as a result-management procedure.
- Validating or writing final configuration before the user selects the mode.

## Scoring

A scenario passes only when every required observable is satisfied and no
forbidden action occurs. Any run or browser action before a ready post-write
doctor is an automatic failure.
