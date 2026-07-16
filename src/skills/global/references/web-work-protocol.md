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

3. Before drafting, run `ai-qa doctor --json` and any applicable host-visible readiness checks. Treat a missing config as the expected `uninitialized` state. Discuss and resolve startup, targets, environments, authentication and test data, evidence, retention, reports, reruns, Git, CI, secrets, and result recording before choosing configuration values.
4. Inspect the existing config, Project Skill, and project instructions. Ask how QA results or defects are already managed without suggesting providers. When no existing result-management procedure exists, use `recordingPolicy.mode: local-only`; do not choose a provider from available tools. Use `project-skill` only for an existing procedure, copied exactly with its match and rerun rules.
5. A request to show the approval decision is proposal-only: produce the complete drafts and diffs from confirmed facts, but do not run host commands, write files, or treat an unavailable example path or CLI as a task failure before approval.
6. Draft the complete schema-v2 config as JSON in scratch space. Use the canonical object shape below; substitute confirmed values, omit no required keys, and add no other config keys. Draft the Project Skill separately: Use `skill-creator` to create or update `.agents/skills/ai-qa-project/SKILL.md` in scratch space before target write.
7. Keep the Project Skill project-owned and concise. The target Project Skill is project-owned; do not add AI-QA managed/user markers or an embedded AI-QA checksum. Put result-management commands and supported secret environment-variable references in its body, never literal secrets or provider assumptions.
8. Pipe the complete config JSON to the CLI. Run `ai-qa config validate --stdin-json` as a read-only config check. Use the returned config only after validation succeeds, and validate the scratch Project Skill with `skill-creator`.
9. Before displaying diffs or requesting confirmation, verify that `.ai-qa/config.yaml` and `.agents/skills/ai-qa-project/SKILL.md` are within the exact target project root. Reject either target, or an existing parent below the root, when it is a symlink. Reject literal secrets and secret handling other than config-declared environment-variable references; stop when the requested handling is unsupported.
   Only after config validation, scratch Project Skill validation, and all path, symlink, and secret safety checks succeed may Codex request the one confirmation; that confirmation authorizes only the two target writes and four canonical project-local directories, followed by the post-write doctor.
   The one confirmation does not authorize the post-write doctor; after the approved writes and directory creation complete, Codex runs doctor as a separate mandatory verification step.

## Required pre-confirmation attestation

Immediately before the approval question, include all four lines:

- Complete config validation: MUST PASS BEFORE CONFIRMATION.
- Scratch Project Skill validation with `skill-creator`: MUST PASS BEFORE CONFIRMATION.
- Exact-root and target/parent symlink safety: MUST PASS BEFORE CONFIRMATION.
- Literal-secret and unsupported-secret-handling safety: MUST PASS BEFORE CONFIRMATION.

10. Render the validated config as `.ai-qa/config.yaml`. Compute complete diffs for that file and the validated Project Skill. Include this required method line in the approval package: Project Skill drafted and validated with `skill-creator` in scratch space; target write waits for this one confirmation. Codex validates the config and Project Skill, displays both complete diffs, obtains one confirmation, then writes both project files.
11. On initialization, create the project-local directories `.ai-qa/cases`, `.ai-qa/runs`, `.ai-qa/evidence`, and `.ai-qa/reports/runs`. Do not replace unsafe paths or symlinks.
12. Run `ai-qa doctor --json` after the host-managed write. If installation is not ready, surface the failed check and stop before Web QA.

Permissions, authentication, file writes, and external tools remain host-owned.

## Canonical schema-v2 config draft

Use this exact config shape for a Web project. Substitute only confirmed values.
Project startup, authentication/test-data procedures, rerun rules, and project
matching belong in the Project Skill body, not as extra config fields.

```yaml
schemaVersion: 2
project:
  id: "<project-id>"
  name: "<project-name>"
targets:
  web:
    entryUrl: "<confirmed-entry-url>"
environments: {}
tools:
  web:
    controller: "chrome-devtools-mcp"
evidencePolicy:
  screenshots: required
  defaultSensitivity: internal
  retentionDays: 30
reportPolicy:
  formats:
    - markdown
    - json
  audience: engineering
  detail: full
storagePolicy:
  adapter: project-local
gitPolicy:
  config: track
  artifacts: ignore
ciPolicy:
  nonPassExit: failure
secretReferences: {}
recordingPolicy:
  mode: local-only
```

Use `mode: project-skill` only when the confirmed Project Skill contains an
existing result-management procedure. `recordingPolicy` contains only `mode`;
do not put a Skill path, provider, idempotency key, or procedure in config.

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

Use `not_recorded` with an empty reference list when no record was made. Use `unknown` with an empty reference list when an external result-recording operation returns no certain result, and never retry that operation. Never revise the QA verdict from a recording outcome.

## Verdict and safety

- `pass`: every required criterion cites recorded assertions, observations, and evidence IDs.
- `fail`: observed product behavior contradicts a criterion; cite the contradicting records.
- `blocked`: a concrete tool, permission, environment, data, or evidence-capture blocker prevents coverage.
- `not_verified`: coverage is missing without a concrete external blocker. Do not promote or claim `pass`.
- Retry an initial verdict only with the identical payload. Use `verdict revise --supersedes <verdict-id>` for a correction.
- Cancel only with `ai-qa run cancel <run-id> --reason <reason>`.
- For a non-recording Web action with an unknown result, do not retry until a fresh observation resolves whether it applied.
