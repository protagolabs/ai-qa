# AI QA Host-Managed Project Skill Design

**Date:** 2026-07-16  
**Status:** Proposed written specification; awaiting user review  
**Supersedes:** The Project Skill authoring, preview/apply, managed-region, embedded-checksum, and project `skill generate|sync` portions of `2026-07-15-ai-qa-project-recording-skill-design.md`. The provider-neutral recording model, per-run recording-mode snapshot, verified-report boundary, neutral receipt, crash recovery, and immutable QA verdict remain in force unless this document changes them explicitly.

## 1. Objective

Keep project-specific AI QA rules in the target project while assigning each responsibility to the component that already owns it:

- the global `ai-qa` Skill teaches Codex the complete AI QA workflow;
- the target Project Skill contains only project-specific rules;
- Codex discusses, generates, validates, previews, confirms, writes, and executes project files and tools;
- the `ai-qa` CLI remains a non-resident local state and report engine.

The design must not require an Agent to hand-calculate a Skill checksum, must not assume Git or a hosted provider, and must not make `ai-qa` a second Skill editor beside Codex.

## 2. Non-goals

This design does not add:

- an `ai-qa` daemon, service, or background runtime;
- a provider registry for GitHub, Jira, or internal systems;
- provider credentials or provider payloads in `.ai-qa/`;
- automatic installation or permission grants from `doctor`;
- CLI-owned Project Skill generation, merging, or synchronization;
- managed/user regions or an embedded Project Skill checksum;
- automatic Git commits.

## 3. Four responsibility domains

### 3.1 Global `ai-qa` Skill

The bundled and globally installed main Skill is Codex's entry point. It explains:

- how to identify the exact target project and run `doctor`;
- how to detect an uninitialized project;
- how to discuss config, evidence, reports, reruns, and recording with the user;
- that no existing recording procedure means `local-only`;
- how to use `skill-creator` to create or update the target Project Skill;
- that Codex owns pre-write validation, full diff presentation, one-time user confirmation, and file writes;
- how to use the `ai-qa` CLI for runs, evidence, verdicts, reports, and receipts;
- that a verified report precedes project recording;
- that uncertain external recording is `unknown` and is not retried;
- that recording never changes the QA verdict;
- that permissions, authentication, and host tools remain controlled by Codex and its host.

It contains no target-specific startup command, credential, provider procedure, or provider payload.

### 3.2 Target Project Skill

The Project Skill lives at the fixed project-relative path:

```text
.agents/skills/ai-qa-project/SKILL.md
```

It is an ordinary, complete, project-owned Codex Skill created and validated through `skill-creator`. It may contain startup, environment, authentication-reference, navigation, evidence, report, rerun, and arbitrary project-recording procedures.

It has no AI-QA-managed region, user region, embedded `aiQaManagedChecksum`, or CLI-specific merge contract. The project may track it with Git, but Git is optional and no GitHub remote is assumed.

### 3.3 Codex

Codex is the orchestrator and executor. It:

- discusses requirements;
- creates config and invokes `skill-creator` for the Project Skill;
- runs pre-write validation with the appropriate tools;
- displays complete files or diffs;
- requests one-time confirmation for the exact initialization or update;
- writes project files through host-controlled filesystem tools;
- reads and executes the global and target Skills;
- controls browser, plugin, MCP, authentication, and external-tool use under host policy;
- sends only neutral recording status and references to `ai-qa`.

An approved Project Skill is a reusable project rule. Matching later work does not require reapproving the Skill, but the Skill never grants permissions that the host would otherwise require.

### 3.4 `ai-qa` CLI

The CLI is invoked on demand and exits after each command. It owns:

- `.ai-qa/` canonical records;
- cases, work orders, runs, observations, assertions, evidence, and verdict state;
- report generation and integrity checks;
- per-run recording-mode and Project Skill identity snapshots;
- neutral recording receipt status and opaque references;
- deterministic idempotency and crash recovery for local records.

It does not author, interpret, merge, or execute Project Skill instructions.

## 4. Installation and `doctor`

`doctor` is a report-only installation and availability check. It never installs, edits, grants permission, or authenticates automatically.

The CLI-visible checks are:

- the `ai-qa` executable and supported Node version;
- the global `ai-qa` Skill installation and protocol compatibility;
- config presence, readability, and schema compatibility when a project is initialized;
- canonical directory readability and writability;
- Project Skill presence as a project-local regular file for every initialized config-v2 project;
- local schema/protocol compatibility among installed artifacts.

Before initialization, missing project config and Project Skill are reported as `uninitialized`, not as corrupted installation state.

Codex supplements `doctor` with host-visible checks that the CLI cannot reliably perform:

- `skill-creator` availability;
- required Skills and plugins;
- configured MCP servers and browser controller;
- project-specific commands or tools named by the Project Skill.

When something is missing, Codex reports the finding, proposes a repair, and obtains any required approval before installing or changing it.

## 5. Initialization flow

1. Codex loads the global `ai-qa` Skill and confirms the exact target root.
2. Codex runs the applicable installation checks.
3. Codex discusses startup, target, environments, authentication/test data, evidence, retention, reports, reruns, Git policy, CI policy, secrets, and result recording.
4. When no existing result-management procedure exists, config uses `recordingPolicy.mode: local-only` and no external procedure is invented.
5. When an existing procedure must be followed, config uses `recordingPolicy.mode: project-skill`; its arbitrary procedure is written only in the Project Skill.
6. Codex creates the complete `.ai-qa/config.yaml` draft and uses `skill-creator` to create the complete Project Skill draft. Draft generation and validation use host scratch space or in-memory content; `skill-creator` does not write the target path before approval.
7. Codex owns pre-write validation:
   - validate config against the AI QA schema through a read-only schema tool or library entry point;
   - validate the Skill through `skill-creator`;
   - reject literal secrets and unsupported secret handling;
   - verify both destinations are inside the exact target root and are not symlink targets.
8. Codex presents both complete files or their complete diffs and asks for one confirmation covering the exact proposed initialization.
9. After confirmation, Codex writes both files as one host-managed project change when possible.
10. Codex runs `doctor` and does not start a QA run until the installed state passes.

There is no initialization preview checksum. The host's displayed diff and confirmation are the write authorization. There is no `InitializationRequest.projectSkill.content` wire artifact.

## 6. Configuration validation surface

The repository exposes a read-only config validation surface for Codex. It accepts a config draft, parses the current schema, and returns either the normalized config or structured validation errors. It has no project write, checksum, trust mutation, or directory-creation side effect.

The concrete CLI surface is:

```text
ai-qa config validate --stdin-json
```

It accepts the config object only, not a combined initialization request. Project Skill validation remains the responsibility of `skill-creator`.

Project mutation commands introduced by the superseded design are removed:

```text
ai-qa init --preview|--confirm-checksum
ai-qa configure --preview|--confirm-checksum
ai-qa skill generate --project ...
ai-qa skill sync --project ...
```

Global main-Skill installation/check/update commands remain supported because that artifact is product-distributed rather than project-authored.

## 7. Run creation and frozen Project Skill identity

At run creation, `recordingPolicy.mode` is copied into the immutable work order.

For `local-only`, no Project Skill snapshot is required for recording.

For `project-skill`, the CLI performs only filesystem identity checks:

- resolve the fixed project-relative path without following a symlink;
- require a regular file inside the canonical target root;
- compute SHA-256 over the complete file bytes;
- write the relative path and SHA-256 into the immutable work order.

The SHA-256 is an internal run-consistency snapshot. It is not embedded in the Skill, is not supplied by Codex or the user, and is not an authorship or security signature.

Codex loads and executes the Project Skill. The CLI does not parse its frontmatter or instructions.

## 8. Reports and recording

A terminal, verified local report is required before recording status or receipt registration succeeds. Report and run-journal bytes remain immutable across recording operations.

### 8.1 Local-only

For a run whose frozen mode is `local-only`:

- show the verified local Markdown/JSON report paths and end;
- do not execute an external or additional project-recording procedure;
- do not create `recording.jsonl` or `recording.json`;
- return `not_applicable` when recording status is queried.

### 8.2 Project-skill

For a run whose frozen mode is `project-skill`:

1. the CLI confirms the current Project Skill bytes match the work-order snapshot;
2. Codex reloads the Project Skill;
3. Codex executes the arbitrary procedure under host-controlled permissions;
4. Codex submits only `status` and opaque `references` to the CLI.

Allowed status values are:

- `recorded`;
- `not_recorded`;
- `unknown`.

The CLI derives receipt idempotency internally from the run and frozen recording context. An exact retry returns the existing receipt without another journal write; a conflicting retry is rejected. Codex does not construct a checksum-based idempotency key.

An uncertain external result is recorded as `unknown` with no references and is not retried. Recording status never revises or overrides the QA verdict.

Recording files contain only canonical status, timestamps, and opaque references. They contain no provider request/response payload, credentials, or copied Project Skill procedure.

## 9. Project Skill changes

To change a Project Skill:

1. Codex reads the existing Skill;
2. discusses the change with the user;
3. uses `skill-creator` to update and validate it;
4. checks secrets and target paths;
5. presents the complete diff;
6. writes only after user confirmation;
7. optionally uses the project's normal Git workflow.

There is no CLI project Skill generate/sync/merge operation.

If the Skill changes after a `project-skill` run is created, the verified QA report remains intact but project recording for that run stops with a Skill-changed error. A new run snapshots the new Skill. The system does not copy full Skill content into `.ai-qa/` and does not guess which version to execute.

## 10. Error behavior

- Pre-write validation failure: Codex fixes the draft before requesting confirmation; no file is written.
- Partial host write or failed post-write `doctor`: Codex reports and repairs the project change; no QA run starts until readiness passes.
- Missing or symlinked Project Skill in `project-skill` mode: run creation or recording stops with a project-local integrity error.
- Skill hash drift during a run: recording stops; report and verdict remain unchanged.
- Missing verified report: status/receipt returns `report.not_generated` or the applicable report integrity error.
- Uncertain external recording: save `unknown`, do not retry, and do not change verdict.
- Receipt replay with a different neutral payload: return an idempotency conflict.
- Canonical recording journal/view crash window: rebuild the deterministic view from the valid journal; true contradiction remains an integrity error.

Errors expose project-relative paths only and never expose secret values.

## 11. Compatibility and migration

- Stored config v1 remains readable without rewrite and behaves as `local-only`. A legacy v1 project without a target Project Skill remains runnable; `doctor` reports the missing Skill as a migration advisory rather than a blocking installation error.
- Config v2 retains `recordingPolicy.mode`.
- Per-run mode snapshots and historical recording records remain readable.
- A previously generated Project Skill containing managed markers or checksum metadata is treated as an ordinary project-owned Skill after this change; the CLI no longer interprets those fields. Codex may simplify it on the next user-confirmed edit.
- The temporary branch-only combined initialization request and project Skill mutation commands are not a compatibility target.
- The global main Skill remains versioned and installable; `doctor` verifies its compatibility with the CLI protocol.

## 12. Verification strategy

Automated tests must cover:

- read-only config validation with valid v2, rejected invalid input, and no filesystem mutation;
- `doctor` reporting global installation, uninitialized project, initialized local-only, missing Project Skill, symlinked Project Skill, and incompatible versions;
- the global main Skill directing Codex to use `skill-creator`, host-owned validation/diff/confirmation/write, and local-only default;
- no embedded checksum, managed markers, combined initialization wire request, or project generate/sync commands in the current global workflow;
- run creation snapshotting the complete Project Skill file hash only in `project-skill` mode;
- Skill drift stopping project recording without changing report or verdict bytes;
- local-only completion with no recording files;
- arbitrary local and external procedures represented only in Project Skill, with neutral receipts in `.ai-qa/`;
- exact receipt replay, conflicting replay, crash recovery, mode switches, report prerequisite, and report export exclusion;
- config v1 unchanged-byte compatibility;
- full TypeScript quality gate and packaged global Skill validation.

Fresh-context Skill evaluation must run at least five repetitions for each affected family:

- no existing recording process: choose `local-only`, do not invent a provider, produce config and a complete target Skill, validate, display a host-managed preview, and request one host confirmation;
- arbitrary existing project process: choose `project-skill`, preserve the exact procedure, execute it only after a verified report, submit neutral status/references, do not retry unknown work, and keep the verdict unchanged.

Workers are scored on host-owned file management and behavior. They are not asked to emit a CLI-specific combined JSON artifact or calculate a checksum.

## 13. Acceptance criteria

The design is complete when:

- Codex can initialize a target by creating validated config and Project Skill files after one displayed-diff confirmation;
- `skill-creator`, not `ai-qa`, owns Project Skill generation and validation;
- `doctor` reports required installations and availability without mutating them;
- the global main Skill reliably teaches the complete workflow;
- `ai-qa` has no Project Skill authoring, merging, embedded checksum, or project sync responsibility;
- `local-only` remains the no-process default;
- `project-skill` supports arbitrary procedures without provider enumeration;
- per-run path/hash snapshots prevent mid-run procedure drift without changing the Skill file;
- `.ai-qa/` stores only canonical QA state and neutral recording status/references;
- external permissions remain controlled by Codex host;
- all regression, quality, and fresh-context evaluation gates pass.
