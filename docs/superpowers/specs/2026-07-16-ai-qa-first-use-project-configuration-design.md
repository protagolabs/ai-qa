# AI QA First-Use Project Configuration Design

## Summary

When Codex first uses AI QA in a target project that has no
`.ai-qa/config.yaml`, AI QA must block the requested QA work and direct Codex
to configure the project. Codex derives safe values from the project, asks the
user only for unresolved decisions, previews the complete validated change,
and resumes the original QA request only after the post-write doctor reports
`ready`.

The CLI remains non-interactive. The doctor exposes the blocking state as a
machine-readable contract, while the global AI QA Skill owns the agent-guided
configuration workflow.

## Goals

- Make first-use configuration mandatory before any QA run starts.
- Give Codex a deterministic, machine-readable signal to begin configuration.
- Minimize user questions by deriving unambiguous project facts and applying
  documented safe product defaults.
- Preserve the existing validated two-file initialization and post-write
  doctor workflow.
- Keep project selection, repository trust, and filesystem authorization under
  Codex rather than adding them to the AI QA configuration experience.

## Non-goals

- An interactive CLI wizard.
- A new CLI command that inspects a project and builds a configuration.
- Changing how Codex resolves a target project, manages repository trust, or
  obtains read and write permission.
- Treating a damaged initialized project as a first-use project.
- Silently inventing authentication, test data, environment, secret, or
  result-recording procedures.

## Responsibility boundaries

Codex resolves the exact target project and manages repository trust,
permissions, and project reads before invoking the AI QA workflow. Those
concerns are preconditions and remain outside this feature.

AI QA owns:

- recognizing that its target project is uninitialized;
- returning the required blocking action from the doctor;
- telling Codex how to derive and confirm the AI QA configuration;
- validating the configuration state before QA can begin.

The target is considered first-use only when `.ai-qa/config.yaml` is missing.
If that configuration exists but the Project Skill or canonical storage is
missing, unsafe, or invalid, the project remains `not_ready` and follows the
existing repair path rather than onboarding again.

## Doctor contract

`InstallationDoctorResult` gains an always-present `requiredAction` field:

```ts
type RequiredAction =
  | {
      kind: "configure-project";
      blocking: true;
      reason: "project-config-missing";
    }
  | null;
```

An uninitialized result is shaped as follows:

```json
{
  "status": "uninitialized",
  "requiredAction": {
    "kind": "configure-project",
    "blocking": true,
    "reason": "project-config-missing"
  },
  "checks": []
}
```

The real `checks` array continues to contain the current runtime, global Skill,
project config, Project Skill, and storage checks; the empty array above is
only abbreviated to emphasize the new field.

For `ready` and `not_ready`, `requiredAction` is `null`. Existing status and
check semantics do not change. Adding the field is an additive JSON contract
change. For compatibility with an older installed CLI, the global Skill must
also treat a bare `status: "uninitialized"` result as the same blocking
configuration trigger.

## Global Skill behavior

The global AI QA Skill treats `requiredAction.kind: "configure-project"` as a
mandatory state transition:

1. Suspend the user's original QA request.
2. Do not invoke `run start` or any Web QA action while configuration is
   incomplete.
3. Inspect the Codex-authorized project for unambiguous configuration facts.
4. Summarize derived values and ask only for unresolved or conflicting values.
5. Draft, validate, preview, and confirm the complete configuration change.
6. Perform the approved host-managed writes and run the post-write doctor.
7. Resume the original QA request only when the doctor returns `ready`.

The setup conversation is not optional. If the user cancels or defers it, the
Skill reports that AI QA remains unconfigured and does not continue the QA
request with temporary defaults.

## Configuration inference

Codex may derive a value only when the project contains one unambiguous source
of truth. Examples include:

- project name and slug from committed project metadata;
- startup commands from project instructions or package scripts;
- a Web entry URL explicitly documented in committed configuration or supplied
  in the user's request;
- an existing QA result or defect-recording procedure documented by the
  project;
- existing Git tracking and ignore conventions.

The Skill documents the following safe product defaults:

- schema version 2;
- `chrome-devtools-mcp` as the Web controller;
- required screenshots with `internal` default sensitivity and 30-day
  retention;
- Markdown and JSON full reports for an engineering audience;
- project-local storage;
- tracked configuration and ignored run artifacts;
- failure for non-pass CI results;
- empty environments and secret references when the project declares none;
- `local-only` recording when no existing result-management procedure exists.

Codex must ask the user when it cannot uniquely determine a Web entry URL or
startup procedure, authentication and test-data requirements, named
environments, secret environment-variable references, or the meaning of
conflicting project instructions. Literal secret values are never accepted.

Codex first presents a concise summary of derived values, then asks unresolved
questions without re-asking for facts already established by the project. The
final complete diff remains the user's authoritative confirmation of every
derived, defaulted, and supplied value.

## Validated write flow

After all required values are known, the existing host-managed flow remains
authoritative:

1. Draft the complete schema-v2 config and ordinary project-owned Project
   Skill in scratch space.
2. Validate the config with `ai-qa config validate --stdin-json` and validate
   the Project Skill with `skill-creator`.
3. Verify exact-root containment, symlink safety, and secret safety.
4. Display both complete diffs and the required pre-confirmation attestations.
5. Obtain one confirmation covering the two files and four canonical
   directories.
6. Write `.ai-qa/config.yaml` and
   `.agents/skills/ai-qa-project/SKILL.md`, then create `.ai-qa/cases`,
   `.ai-qa/runs`, `.ai-qa/evidence`, and `.ai-qa/reports/runs`.
7. Run the post-write doctor as a separate verification step.
8. Resume the suspended QA request only if the result is `ready`.

## Failure handling

- Ambiguous project facts cause a user question, never a guessed value.
- Cancellation or missing confirmation causes no write and keeps QA blocked.
- Config, Project Skill, path, symlink, or secret validation failure stops the
  flow before confirmation.
- A partial host write or post-write doctor result other than `ready` surfaces
  the failed check and keeps QA blocked.
- A `not_ready` initialized project stays in the repair path and never receives
  a new first-use proposal that could overwrite its existing configuration.
- No failure path falls back to temporary defaults or starts a run.

## Testing

### Unit tests

- An uninitialized installation result contains the exact blocking
  `configure-project` action.
- `ready` and `not_ready` results contain `requiredAction: null`.
- Existing checks and status calculation remain unchanged.

### CLI integration tests

- An explicit uninitialized target emits the new action without writing files.
- An initialized ready target emits `requiredAction: null`.
- An initialized target with an invalid or missing dependent resource remains
  `not_ready` with `requiredAction: null`.

### Skill contract tests

The bundled global Skill and Web Work Protocol must state that:

- the configuration action blocks all QA work;
- Codex derives only unambiguous values and asks only about unresolved values;
- user cancellation does not permit temporary defaults;
- the existing validation, diff, confirmation, and write gates remain in
  force;
- the original QA request resumes only after the post-write doctor reports
  `ready`;
- bare `status: "uninitialized"` remains a legacy-compatible trigger.

### Evaluation scenarios

- A direct request to test an uninitialized project begins configuration and
  does not call `run start`.
- A project with enough committed facts produces a derived-value summary and
  asks only for facts that remain unknown.
- User cancellation, draft validation failure, write failure, and a non-ready
  post-write doctor all prevent a run.
- A ready project continues directly to the requested QA workflow.
- A damaged initialized project enters repair rather than first-use setup.

## Documentation

README and the Web Work Protocol describe the doctor action, mandatory setup
transition, inference rules, cancellation behavior, and post-write readiness
gate. Existing target-resolution and repository-trust documentation may remain
as Codex/host prerequisites, but the first-use configuration design does not
present them as AI QA settings.

## Acceptance criteria

- Every first AI QA request in a project without `.ai-qa/config.yaml` produces
  a machine-readable blocking configuration action.
- Codex does not start QA until the approved configuration is written and the
  post-write doctor is `ready`.
- Users are asked only for unresolved or conflicting project-specific values.
- No target-root or repository-trust choice is added to the AI QA setup
  conversation.
- Ready and repair scenarios preserve their existing behavior.
