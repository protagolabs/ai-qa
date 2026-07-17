# AI QA Host Authority and Explicit Recording Design

## Summary

AI QA will stop maintaining repository trust or using trust as a prerequisite
for project access. Codex and the host environment already own filesystem
access, sandboxing, approvals, authentication, and external-tool authority;
AI QA must not duplicate that authority with machine-local state.

First-use configuration will also require an explicit user decision for report
recording. Project inspection may discover and summarize an existing QA-result
or defect-management procedure, but it may not silently choose either
`local-only` or `project-skill`.

## Goals

- Remove AI QA's repository-trust command, state, service layer, and runtime
  gate.
- Keep exact project-root resolution, including protection against silently
  substituting an ancestor for a named nested project.
- Make `recordingPolicy.mode` an explicit user decision during first-use
  configuration.
- Prevent configuration writes and QA execution until that recording decision
  is complete.
- Align the bundled Skill, CLI behavior, tests, README, and validation guidance
  with the host-owned authority boundary.

## Non-goals

- Preserving compatibility for `ai-qa trust confirm`, `ai-qa trust status`,
  `trust.json`, or `trust.*` errors.
- Moving sandbox, approval, authentication, or external-tool permission logic
  into AI QA.
- Adding an interactive CLI setup wizard.
- Changing report generation, recording receipts, or Project Skill execution
  after a run has already captured an explicit recording policy.
- Allowing AI QA to invent a hosted provider or a project recording procedure.

## Responsibility boundary

Codex and the host own:

- authorization to read and write project files;
- sandbox and filesystem enforcement;
- user approval for material writes or external operations;
- authentication and secret access;
- browser and other external-tool permissions.

AI QA owns:

- resolving the exact project root supplied by the host;
- validating AI QA configuration and project-local state;
- enforcing run, evidence, report, and recording lifecycle rules;
- returning structured errors when AI QA state is absent, invalid, or unsafe.

The project resolver may canonicalize a path and apply existing root-selection
rules. It must not consult machine-local trust state, read Git remotes to build
an authorization fingerprint, or reject a project because AI QA has not
previously recorded a trust confirmation.

## Trust subsystem removal

The `trust` CLI command group is removed completely. Invocation of
`ai-qa trust ...` follows the CLI's ordinary unknown-command behavior.

The machine-local trust subsystem is deleted, including:

- trust confirmation input and output contracts;
- repository identity and fingerprint generation used for authorization;
- `$AI_QA_HOME/trust.json` persistence and locking;
- `trust.not_trusted` and `trust.confirmation_required` behavior;
- trust-specific documentation and Skill instructions.

Callers that currently use `resolveTrustedProject` will use a project resolver
that performs only exact-root resolution. The resolver interface will no
longer accept `aiQaHome`, because authorization state is not an AI QA input.
All doctor, run, action, evidence, verdict, case, report, and recording paths
will use this host-authorized project root consistently.

Existing `trust.json` files are left untouched. AI QA no longer reads or writes
them, and no migration or cleanup command is added.

## Explicit report-recording decision

`recordingPolicy.mode` remains the config and immutable work-order field with
the existing values:

- `local-only`: generate and verify configured local reports, show their paths,
  and stop without an external recording procedure.
- `project-skill`: after local report verification, execute the exact
  project-owned recording procedure captured in the Project Skill.

During first-use configuration, Codex inspects project instructions and may
report whether an existing result-management procedure was found. That result
is context, not consent. Codex must explicitly ask the user to choose the
recording mode in every initialization.

The choice rules are:

1. No recording mode has a silent default.
2. `local-only` requires an explicit user selection.
3. `project-skill` requires an explicit user selection and an identified,
   user-confirmed existing procedure. Tool availability alone is not a
   procedure.
4. If no existing procedure can be identified, Codex explains that
   `project-skill` cannot yet be completed and asks the user to choose
   `local-only` or define the project procedure.
5. Until the choice and any required procedure details are complete, Codex
   does not validate a final config, request write confirmation, write project
   files, or resume QA.

Updating an initialized project follows the same rule whenever the user asks
to change recording behavior: the new mode is explicit and the complete
config and Project Skill changes remain subject to the existing validation,
diff, and host approval gates.

## First-use flow

1. The host resolves the intended target and grants Codex whatever read access
   is appropriate.
2. Codex runs the installation doctor. A missing config still produces the
   blocking `configure-project` action.
3. Codex inspects host-authorized project metadata and instructions for
   unambiguous setup facts and any existing result-recording procedure.
4. Codex summarizes derived facts and explicitly asks the user for the report
   recording mode.
5. For `project-skill`, Codex confirms the exact procedure, matching, rerun,
   idempotency, and uncertain-result rules needed by the Project Skill.
6. Codex gathers any other unresolved setup decisions, drafts both files in
   scratch space, and validates them.
7. Codex displays complete diffs and obtains the existing single host-managed
   write confirmation.
8. Codex writes the approved files and directories, runs the post-write
   doctor, and resumes QA only when the result is `ready`.

There is no AI QA trust confirmation before step 2 and no trust value in the
setup conversation.

## Errors and incomplete decisions

- Host denial or sandbox failure is surfaced by Codex or the host, not
  translated into an AI QA trust error.
- An unresolved recording choice keeps first-use setup incomplete and blocks
  QA without writing temporary defaults.
- `project-skill` without a complete existing procedure is an unresolved
  configuration decision, not permission to invent a provider or workflow.
- Invalid config, Project Skill, path containment, symlink, secret, or storage
  state continues to use the existing AI QA validation and readiness errors.
- Existing trust state never affects a verdict, report, or recording outcome.

## Testing

### Project resolution and CLI

- Explicit nested project selection continues to beat an ancestor config.
- Project resolution succeeds without `AI_QA_HOME` or a trust record.
- The CLI no longer registers `trust confirm` or `trust status`.
- Commands that previously failed with `trust.not_trusted` reach their normal
  config, state, or lifecycle validation instead.

### First-use Skill contract

- The bundled Skill does not instruct Codex to confirm or record repository
  trust before reading project files.
- First-use setup always asks for a recording mode, even when project
  inspection finds no existing procedure.
- The Skill does not describe `local-only` as an automatically selected safe
  default.
- `project-skill` requires a user-confirmed existing procedure and never
  derives authorization from an available provider tool.
- Missing recording choice prevents config write and QA start.

### Regression coverage

- Doctor, exploratory and regression starts, actions, evidence, verdicts,
  reports, cases, and recording receipts work with host-authorized paths and no
  AI QA trust setup.
- Config schema and immutable work-order snapshots continue accepting exactly
  the existing recording-policy values.
- Local-only completion and Project Skill recording retain their existing
  post-report behavior.

## Documentation and validation artifacts

README and the canonical Web Work Protocol will describe host-owned authority
without an AI QA trust prerequisite. Current validation scenarios and expected
transcripts will be updated so they explicitly request the recording decision
and never call `ai-qa trust`.

Historical design and plan documents remain historical records. Active source,
bundled Skill content, current README guidance, tests, fixtures, and validation
acceptance documents must reflect this design.

## Acceptance criteria

- A fresh AI QA installation can inspect and operate on a host-authorized
  project without creating or reading `$AI_QA_HOME/trust.json`.
- `ai-qa trust` is not a supported command.
- No runtime path throws `trust.not_trusted` or requires repository identity
  fingerprinting.
- First-use configuration always obtains an explicit `recordingPolicy.mode`
  choice from the user.
- No absent or inferred choice silently becomes `local-only`.
- Selecting `project-skill` requires the exact existing procedure to be
  confirmed before configuration can complete.
- Exact-root resolution, config validation, Project Skill validation, diff
  review, host write approval, and post-write doctor gates remain intact.
