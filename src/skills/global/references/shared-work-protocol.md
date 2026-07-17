# Shared Work Protocol

## Host-managed setup

Resolve the exact project root. A missing `.ai-qa/config.yaml` blocks QA until the host completes the approved setup and post-write doctor returns `ready`.

Ask for a non-empty deployed platform selection and collect every selected platform's target and tool fields. `targets` and `tools` must have identical platform keys. Always ask for `recordingPolicy.mode`. Draft schema 3 config and a project-owned Project Skill in scratch space, validate both, reject literal secrets and unsafe paths, display both complete diffs, obtain one confirmation, and write once. Create `.ai-qa/cases`, `.ai-qa/runs`, `.ai-qa/run-groups`, `.ai-qa/evidence`, `.ai-qa/reports/runs`, and `.ai-qa/reports/groups`.

Immediately before confirmation, attest that config validation, Project Skill validation with `skill-creator`, exact-root/symlink safety, and literal-secret safety passed. Doctor every configured platform after the write.

## Execution selection

Ask which configured platform subset to execute for the current request. Accept any non-empty subset. Configuration never selects execution platforms. Real devices are unsupported.

For exploration, multi-platform exploratory QA starts one explicit exploratory run per selected platform. Give each run the confirmed shared goal and acceptance criteria plus that platform's readiness. Finish, report, and review each platform run independently.

For regression, one selected platform uses `run start --kind regression`. Multi-platform regression uses a RunGroup with every selected platform and either explicit case IDs or `--all-active`. RunGroups do not start exploratory work.

## Actions and evidence

The CLI never invokes controllers. Before every host controller call, including observation and screenshot capture, record `ai-qa action plan`. After the call, record exactly one `action complete` result as `completed` or `unknown`.

After an interaction, keep this order on the same step:

1. Complete the interaction action.
2. Plan and complete a fresh observation, then add it.
3. Plan and complete evidence capture, then register the raw file with the configured controller as `sourceTool`.
4. Record satisfied assertions citing the criterion, observation, and evidence IDs.

Never use pre-action, stale, differently sourced, or unregistered evidence for `pass`, case promotion, or a verified report. Resolve an unknown non-recording action through fresh observation before retrying. Keep recovery within the work-order budget.

## Runs, cases, and RunGroups

Start exploratory work with `ai-qa run start --kind exploratory --platform <platform> --execution local --stdin-json`. Set one evidence-linked verdict, then finish the run.

Draft a case from a complete reviewed exploratory run with `case draft --from-run`. Each draft adds or replaces only the source run's immutable platform variant while retaining other variants. Validate and explicitly activate the reviewed revision. Start regression with an explicit configured `--platform`; follow the pinned variant steps in order.

For multi-platform regression, use `run-group start --case <case-id> --platform <platform> ... --execution <local|ci> --stdin-json`, or replace explicit cases with `--all-active`. The selected subset is frozen. A missing selected variant becomes `coverage_gap`. Finish only after every child run is terminal.

## Reports and recording

Generate and verify individual output with `report generate <run-id>` and `report export <run-id> --adapter project-local`. For a RunGroup, use `report group-generate <run-group-id>` and `report group-export <run-group-id> --adapter project-local`. Aggregate output retains every case/platform cell and has no QA verdict.

For `local-only`, show the verified local paths and stop. For `project-skill`, run the exact frozen Project Skill procedure only after the report is verified, then submit a neutral receipt containing only status and opaque references. Use the corresponding run or group `recording-status` and `receipt` command. Never retry an external recording operation whose outcome is `unknown`. Recording never changes QA verdicts or aggregate matrix cells.
