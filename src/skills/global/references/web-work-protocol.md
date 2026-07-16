# Web Work Protocol

## Host-managed project setup

Use one host-owned workflow for `.ai-qa/config.yaml` and `.agents/skills/ai-qa-project/SKILL.md`:

1. Resolve the exact target project and obtain explicit trust confirmation before reading project content.
2. Record trust with the exact single-field stdin object below. The schema accepts literal `true` and no additional fields.

<!-- canonical-trust-confirm:start -->

```text
{"confirmed":true}
```

<!-- canonical-trust-confirm:end -->

```text
printf '%s\n' '{"confirmed":true}' | ai-qa trust confirm --project <path> --stdin-json
```

3. Inspect the existing config, Project Skill, and project instructions. Ask how QA results or defects are already managed without suggesting providers. When no existing result-management procedure exists, use `recordingPolicy.mode: local-only`; do not choose a provider from available tools. Use `project-skill` only for an existing procedure, copied exactly with its match and rerun rules.
4. Draft the complete schema-v2 config as JSON in scratch space. Draft the Project Skill separately: Use `skill-creator` to create or update `.agents/skills/ai-qa-project/SKILL.md` in scratch space before target write.
5. Keep the Project Skill project-owned and concise. The target Project Skill is project-owned; do not add AI-QA managed/user markers or an embedded AI-QA checksum. Put result-management commands and secret environment-variable references in its body, never literal secrets or provider assumptions.
6. Pipe the complete config JSON to the CLI. Run `ai-qa config validate --stdin-json` as a read-only config check. Use the returned config only after validation succeeds, and validate the scratch Project Skill with `skill-creator`.
7. Render the validated config as `.ai-qa/config.yaml`. Compute complete diffs for that file and the validated Project Skill. Codex validates the config and Project Skill, displays both complete diffs, obtains one confirmation, then writes both project files.
8. On initialization, create the project-local directories `.ai-qa/cases`, `.ai-qa/runs`, `.ai-qa/evidence`, and `.ai-qa/reports/runs`. Do not replace unsafe paths or symlinks.
9. Run `ai-qa doctor --json` after the host-managed write. If installation is not ready, surface the failed check and stop before Web QA.

Permissions, authentication, file writes, and external tools remain host-owned.

### Arbitrary local Project Skill body example

The following Markdown is only an example body for a project that chose local-only recording. It is not a provider contract. Supply appropriate `skill-creator` frontmatter and replace every sample value with confirmed project facts.

```markdown
# Sample Web Project Procedures

## Match

Apply only to the trusted project root and Web target identified in this project.

## Evidence and reports

Capture the evidence required by the project config and generate its configured local report formats.

## Result recording

After the local report is generated and verified, show its project-local paths and end without creating an external record.

## Reruns

Match this exact project and target. Create fresh observations, evidence, and reports for every rerun.
```

## Controller provenance

- Every Web `ai-qa action plan --run <run-id> [--step <step-id>] --stdin-json` body names the configured controller.
- Every `ai-qa evidence add --run <run-id> --file <path> --stdin-json` body names that controller as `sourceTool` and cites its completed evidence-capture action.
- Never relabel output from another controller. HTTP checks, modeled events, or stale screenshots do not satisfy controller provenance.

## Post-action evidence

For an exploratory interaction, retain the returned `payload.stepId`. For regression, use the required step ID from the pinned work order. Keep this order on that step:

1. Plan the interaction, invoke the configured controller, and record its terminal result with `ai-qa action complete <action-id> --run <run-id> --stdin-json`.
2. Plan a new observation action on the same step, invoke the controller, record completion, then write the fresh state with `ai-qa observation add --run <run-id> --stdin-json`.
3. Plan an evidence-capture action on the same step, invoke the controller, record completion, then register the raw file with `evidence add`. Cite the capture action and fresh observation ID.
4. Record the satisfied assertion with `ai-qa assertion record --run <run-id> --step <step-id> --stdin-json`, citing the same fresh observation and evidence IDs.

Evidence captured before the interaction result or fresh observation cannot support `pass`, case promotion, or a verified report. An unresolved `unknown` action must follow recovery and cannot satisfy this chain.

## Exploratory and promotion

1. Confirm the goal, criterion IDs, descriptions, and required evidence.
2. Start with `ai-qa run start --kind exploratory --platform web --execution local --stdin-json`.
3. Capture and register initial state, then apply the post-action evidence sequence for each interaction.
4. Set one evidence-backed verdict and finish the run.
5. Build a case draft only from recorded IDs. Run `ai-qa case draft --from-run <run-id> --stdin-json`, review it with the user, then validate and activate the immutable revision.

## Regression

1. Start the active Web case and retain its work order.
2. Execute required steps in order with only step-linked bounded recovery.
3. Finish only after every criterion cites assertion and evidence IDs.
4. Complete verified report and recording handling below.

## Verified report and recording

1. Run `ai-qa report generate <run-id>` and retain its project-local paths.
2. Run `ai-qa report recording-status <run-id>` only after report generation. On `report.not_generated`, generate the report before querying status again.
3. Stop on lifecycle, evidence, report, recording, Project Skill snapshot, or storage integrity failure. Such failures are not `pending`, and receipt submission is forbidden.
4. For `local-only`, show local paths and end.
5. For project-skill runs, execute the exact Project Skill procedure only after a verified report and submit only status/references. Execute the current Project Skill only if it still matches the run-start snapshot; otherwise stop and surface the integrity error.
6. Submit the neutral outcome through `ai-qa report receipt <run-id> --stdin-json`:

```json
{
  "status": "recorded",
  "references": ["<stable project reference>"]
}
```

Use `not_recorded` with an empty reference list when no record was made. Use `unknown` with an empty reference list when an external operation returns no certain result, and do not retry it. Never revise the QA verdict from a recording outcome.

## Verdict and safety

- `pass`: every required criterion cites recorded assertions, observations, and evidence IDs.
- `fail`: observed product behavior contradicts a criterion; cite the contradicting records.
- `blocked`: a concrete tool, permission, environment, data, or evidence-capture blocker prevents coverage.
- `not_verified`: coverage is missing without a concrete external blocker. Do not promote or claim `pass`.
- Retry an initial verdict only with the identical payload. Use `verdict revise --supersedes <verdict-id>` for a correction.
- Cancel only with `ai-qa run cancel <run-id> --reason <reason>`.
- Do not retry an externally visible operation after an unknown result until a fresh observation resolves whether it applied.
