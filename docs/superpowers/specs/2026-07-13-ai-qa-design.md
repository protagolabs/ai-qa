# AI QA Toolkit Design Specification

**Status:** Approved design

**Date:** 2026-07-13

**Working name:** `ai-qa`

## 1. Summary

`ai-qa` is a globally installed Node.js CLI plus a global Agent Skill that lets an AI agent perform manual QA, preserve auditable evidence, promote successful exploratory runs into regression cases, and replay those cases across Web, iOS Simulator, and Android Emulator.

The CLI does not replace the platform-control tools. The AI agent controls each platform with the tool intended for that environment:

```text
Web               -> Chrome DevTools MCP
iOS Simulator     -> Pepper
Android Emulator  -> Appium + UiAutomator2
Real devices      -> Appium contract only in npm v1
```

The AI agent is the orchestrator. The CLI is the durable state, validation, evidence, case, and reporting layer. Every target project owns its own QA configuration and records even though the CLI and main skill are installed globally.

The npm package will be public. The source repository will remain private initially. This design does not configure the npm package name, registry, publishing credentials, or release automation.

## 2. Goals

The npm v1 release must:

- Install the CLI and main `ai-qa` skill globally.
- Initialize and manage QA state inside each target project.
- Let the main skill discuss configuration decisions with the user instead of forcing a fixed questionnaire.
- Generate a project-specific skill under `.agents/skills/` only when the target project needs procedural QA knowledge.
- Support exploratory manual QA with before/after observations and screenshots.
- Require all meaningful direct tool actions to be written back into the CLI event log.
- Promote an exploratory run into a reviewed, replayable regression case.
- Model one shared scenario with platform-specific steps and assertions.
- Replay active cases through an AI agent runner locally or in CI.
- Produce evidence-backed verdicts and user-configured reports.
- Distinguish product failures from environment, permission, evidence, and automation-tool blockers.
- Complete a live vertical slice on Web, iOS Simulator, and Android Emulator before npm v1 is declared complete.

## 3. Non-goals for npm v1

- A standalone deterministic runner that can execute MCP tools without an AI agent.
- A built-in model runtime or a built-in generic MCP client.
- Full real-device support or real-device release acceptance.
- Full-screen pixel-diff visual regression.
- A hosted QA service, centralized project database, or device farm.
- Silent installation, service startup, app build, simulator mutation, or external evidence upload.
- Automatically treating every exploratory action sequence as an active regression case.
- Maintaining separate full QA workflows for Codex and Claude Code.

## 4. Architectural principles

### 4.1 Agent-orchestrated execution

The main skill plans the QA flow, discusses settings with the user, invokes external platform tools, interprets screenshots, and records semantic decisions. The CLI never pretends to be the AI and never infers unobserved UI state.

### 4.2 Durable CLI state

The CLI owns the canonical project configuration, event log, per-run evidence indexes, case lifecycle, verdict validation, and report/export lifecycle. Skills and reports are views or workflows around this state; they are not alternate sources of truth.

### 4.3 Project isolation

The executable is global, but every target project has an independent `.ai-qa/` directory. Commands must resolve and confirm the project root before mutation. Data from two projects must never share a run, case, evidence index, or report directory.

### 4.4 Mandatory write-back

The AI may call Chrome DevTools MCP, Pepper, or Appium directly. Every meaningful action, observation, assertion, screenshot, recovery decision, and verdict must still be registered through `ai-qa`. A flow that is not completely written back cannot be promoted to an active regression case.

### 4.5 Evidence before verdict

A successful tool command or screen transition is not a QA pass. A `pass` verdict requires the configured acceptance criteria and evidence policy to be satisfied.

### 4.6 User-approved environment changes

Environment inspection is read-only. Installation and setup changes require a generated setup plan, an explanation from the AI, and explicit user approval before application.

## 5. System context

```text
User
  <-> AI Agent + global ai-qa Skill
        |-- Chrome DevTools MCP --> Web
        |-- Pepper --------------> iOS Simulator
        |-- Appium --------------> Android Emulator
        |-- Appium contract -----> Real device (not accepted in v1)
        `-- global ai-qa CLI
              |-- Project resolution
              |-- Configuration
              |-- Runs and event logs
              |-- Per-run evidence indexes
              |-- Regression cases
              |-- Assertions and verdicts
              `-- Report exporters and storage adapters
```

The AI agent runner is required for interactive and CI regression execution. The CLI exposes a machine-readable work protocol but does not call MCP servers itself.

## 6. Global installation and target-project layout

### 6.1 Global installation

```text
Global npm installation
|-- ai-qa executable
`-- bundled canonical skill assets

Explicit global skill installation
`-- ~/.agents/skills/ai-qa/
    |-- SKILL.md
    |-- references/
    `-- assets/
```

Installing the public package globally installs the executable and bundled canonical skill assets. `ai-qa skill install --global` then previews and installs the skill into `~/.agents/skills/ai-qa/`. The explicit command is required because package installation must not silently overwrite user-level agent instructions. The installer may create client-specific shims when a supported client requires them, but the bundled skill remains the one canonical source.

### 6.2 Target-project files

```text
target-project/
|-- .agents/
|   `-- skills/
|       `-- ai-qa-project/
|           |-- SKILL.md
|           `-- references/
`-- .ai-qa/
    |-- config.yaml
    |-- cases/
    |   `-- <case-id>/
    |       |-- case.yaml
    |       `-- revisions/
    |-- runs/
    |   `-- <run-id>/
    |       `-- events.jsonl
    |-- evidence/
    |   `-- <run-id>/
    |       |-- index.jsonl
    |       `-- files/
    `-- reports/
```

`.agents/skills/ai-qa-project/` is optional. `.ai-qa/` is the canonical project QA workspace.

The `.agents/skills/` location follows the cross-client Agent Skills convention. Each skill directory contains a `SKILL.md` with valid Agent Skills metadata. The project skill uses the fixed name `ai-qa-project`; project roots provide isolation, so different repositories can use the same skill name safely.

### 6.3 Project-root resolution

Project resolution follows this precedence:

1. An explicit `--project <path>` argument.
2. The nearest ancestor containing `.ai-qa/config.yaml`.
3. For `init` only, the current Git repository root after user confirmation.

Mutating commands fail when the project root is ambiguous or outside the confirmed target. Tracked configuration must use project-relative paths and must not persist machine-specific absolute paths.

## 7. Skill architecture

### 7.1 Global `ai-qa` skill

The global skill owns the reusable QA workflow:

- Project discovery and trust confirmation.
- User dialogue for configuration.
- Platform and tool capability checks.
- Setup planning and consent boundaries.
- Exploratory QA protocol.
- Pre-action and post-action observation requirements.
- Mandatory event and evidence write-back.
- Case promotion and regression replay.
- Verdict, blocker, and reporting rules.
- Detection and loading of the optional project skill.

### 7.2 Project `ai-qa-project` skill

The project skill contains only stable procedural knowledge unique to the target project:

- Required service startup order and ports.
- Environment profiles and platform entry points.
- Login, seed-data, or test-account procedures.
- Platform-specific navigation constraints.
- Stable selector, deep-link, or routing guidance.
- Evidence, privacy, retention, and report policies.
- Required project documents and runbooks.

The project skill must not copy the global QA workflow. The global skill checks for `.agents/skills/ai-qa-project/SKILL.md` and reads it when present.

### 7.3 Generation criteria

The main skill recommends project-skill generation only when at least one stable procedural rule cannot be represented safely as structured configuration. A simple project with targets and URLs but no special workflow does not need a project skill.

`ai-qa skill generate` and `ai-qa skill sync` must:

- Show the proposed file and reason for generation.
- Validate the Agent Skills format.
- Preserve user-authored content.
- Refuse silent overwrite when the existing skill differs.
- Present a diff and require confirmation before replacement.

Generated project skills separate CLI-managed and user-managed content with explicit markers:

```html
<!-- ai-qa:managed:start -->
<!-- ai-qa:managed:end -->

<!-- ai-qa:user:start -->
<!-- ai-qa:user:end -->
```

`skill sync` updates only the managed region and preserves the user region byte-for-byte. Frontmatter metadata stores a checksum over the normalized CLI-managed frontmatter fields and managed body region. If either managed area was edited manually, sync shows a diff and requires confirmation instead of merging or replacing it silently.

## 8. Configuration dialogue and storage selection

`ai-qa init` is driven by the global skill, not by a fixed CLI wizard. The AI discusses the project with the user and writes only confirmed decisions.

The dialogue covers:

- Targets and supported platforms.
- Entry URLs, app identifiers, and environment profiles.
- Required services and readiness checks.
- Tool availability and connection requirements.
- Test accounts, seed data, and secret references.
- Acceptance and evidence expectations.
- Screenshot sensitivity and redaction.
- Report audience, format, detail, storage, retention, and sharing.
- Git inclusion and ignore policy.
- Local versus CI agent-runner behavior.

The internal run representation is always versioned JSON Lines. User-facing report format and storage are configurable.

The CLI exposes exporter and storage-adapter registries. The main skill maps the user's goals to installed capabilities instead of presenting a hard-coded provider menu. Project-local storage is always available for canonical data. External storage receives only artifacts permitted by the confirmed project policy, never receives raw evidence implicitly, and never becomes an alternate mutable event log.

Secrets are stored as references such as environment-variable names, not as literal values.

## 9. Canonical data model

### 9.1 Configuration

`config.yaml` contains a schema version and confirmed project policies. Its logical sections are:

```yaml
schemaVersion: 1
project:
  id: project-stable-id
  name: project-display-name
targets: {}
environments: {}
tools: {}
evidencePolicy: {}
reportPolicy: {}
storagePolicy: {}
gitPolicy: {}
ciPolicy: {}
secretReferences: {}
```

The schema permits platform-specific configuration without putting platform-tool logic in the core domain.

### 9.2 Scenario, revisions, and platform variants

One logical case shares intent and acceptance criteria while keeping platform steps separate. Each saved revision is immutable:

```yaml
schemaVersion: 1
id: login-success
title: 使用者成功登入
activeRevision: 2
revisions:
  - revision: 1
    status: superseded
    contentHash: sha256:previous-content
  - revision: 2
    status: active
    contentHash: sha256:current-content
```

The immutable revision file contains the executable scenario:

```yaml
schemaVersion: 1
caseId: login-success
revision: 2
contentHash: sha256:current-content
acceptance:
  - 使用者進入首頁
  - 畫面顯示目前帳號
variants:
  web:
    steps: []
  ios-simulator:
    steps: []
  android-emulator:
    steps: []
```

Each step contains an intent, tool action record, stable target description, expected state, assertion strategy, and evidence checkpoint. Platform-specific selectors remain inside that platform variant.

An active revision is never edited in place. Editing creates the next draft revision. Activating that draft marks the previous active revision as `superseded` but retains it for historical reports. `contentHash` is calculated from the canonical revision content with the `contentHash` field omitted; the platform-variant hash is calculated from the canonical selected variant. Every regression run pins `caseId`, `caseRevision`, `caseContentHash`, and the selected platform-variant hash in its work order and event log.

### 9.3 Run event log

Each run has an append-only `events.jsonl`. Every event contains:

- Schema version.
- Run ID and monotonically increasing sequence.
- Timestamp and actor.
- Platform and tool identity.
- Event type.
- Idempotency key when the event represents an action.
- Structured payload.
- Related event and evidence IDs.

Required event types are:

- `action`
- `observation`
- `assertion`
- `evidence`
- `decision`
- `blocker`
- `verdict`
- `recovery`

An `action` event has a `phase` of `planned`, `completed`, or `unknown`. Before invoking an external platform tool, the agent appends the `planned` event and receives the action ID and idempotency key. After the tool returns, it appends a second `action` event with `completed` or `unknown` phase referencing the planned action. This makes a crash between intent and write-back visible instead of silently losing the operation.

Regression events reference the required `stepId`. Additional recovery actions reference `recoveryForStepId`; they cannot replace, skip, or reorder a required step.

### 9.4 Evidence

Evidence metadata includes:

- Evidence ID and run ID.
- Project-relative path.
- Content hash and media type.
- Platform, source tool, and capture timestamp.
- Raw, redacted, or annotated classification.
- Parent evidence ID for derived evidence.
- Redaction status and sensitivity classification.

Raw evidence is immutable. Redacted and annotated files are new derived artifacts and never overwrite the raw file.

Evidence files and their append-only index live under `.ai-qa/evidence/<run-id>/`. Each run owns its evidence index and lock, so parallel platform runs never contend on a shared mutable registry. A project-wide evidence view is derived from per-run indexes and can be rebuilt; it is not another source of truth.

### 9.5 State machines

Case-revision status:

```text
draft -> active -> superseded
              `-> retired
```

Run execution status transitions:

```text
created -> running
created -> cancelled
running -> completed
running -> interrupted
running -> cancelled
interrupted -> running
interrupted -> cancelled
```

Run verdict is independent of execution status:

```text
pass | fail | blocked | not_verified
```

An exploratory session is not a separate entity. It is a run with `kind: exploratory`; a regression execution is a run with `kind: regression`. `execution` separately records `local` or `ci`. `completed` requires a terminal verdict. A cancelled run is terminal and receives a `not_verified` verdict with a cancellation reason.

### 9.6 Versioned work order and execution budget

`run start` returns a versioned work order containing:

- Work-order schema and protocol versions.
- Run kind, execution environment, project ID, platform, and environment profile.
- Pinned case ID, revision, content hash, and platform-variant hash for regression runs.
- Ordered required steps and evidence checkpoints.
- Supported recovery policy.
- Frozen execution budgets.
- Required output and verdict rules.

The default regression budgets are derived from the selected platform variant:

```text
maxToolCalls
  = min(100, 10 + requiredStepCount * 6)

maxRecoveryActions
  = min(10, max(3, ceil(requiredStepCount / 2)))

deadline
  = min(30 minutes, max(10 minutes, requiredStepCount * 2 minutes))
```

An exploratory run defaults to 100 tool calls, 10 recovery actions, and a 30-minute deadline because it has no required-step count. Project configuration may define different defaults, and an immutable case revision may override regression defaults. `run start` freezes the resulting values in the work order. Every work order has finite budgets; CI and local runs cannot use unlimited values.

A tool call is any external Chrome DevTools MCP, Pepper, or Appium invocation, including read-only observation and screenshot calls. A recovery action is a state-changing external invocation marked `recoveryForStepId`. Generic budget exhaustion produces `not_verified` with reason `budget_exhausted`; when evidence identifies repeated platform-tool failure as the cause, the result is `blocked:tool`.

## 10. CLI surface

The CLI command groups are:

```text
ai-qa init/configure       Project configuration
ai-qa doctor/setup         Readiness and approved environment preparation
ai-qa skill               Project-skill generation, validation, and sync
ai-qa action              Two-phase action write-back
ai-qa observation         UI and runtime observations
ai-qa assertion           Structured acceptance checks
ai-qa evidence            Immutable evidence registration
ai-qa decision            Semantic decision write-back
ai-qa recovery            Unknown-action resolution
ai-qa blocker/verdict     Typed result write-back
ai-qa case                Regression-case lifecycle
ai-qa run                 Exploratory/regression lifecycle and recovery
ai-qa report              Report generation and export
```

Important commands include:

```text
ai-qa init
ai-qa configure
ai-qa doctor --platform <platform> --json
ai-qa setup plan --platform <platform>
ai-qa setup apply <plan-id>
ai-qa skill install --global
ai-qa skill generate
ai-qa skill check
ai-qa skill sync
ai-qa run start --kind exploratory --platform <platform> --execution local
ai-qa action plan --run <run-id> [--step <step-id>] --stdin-json
ai-qa action complete <action-id> --stdin-json
ai-qa observation add --run <run-id> --stdin-json
ai-qa assertion record --run <run-id> --step <step-id> --stdin-json
ai-qa evidence add --run <run-id> --file <path> --stdin-json
ai-qa decision record --run <run-id> --stdin-json
ai-qa recovery resolve <action-id> --stdin-json
ai-qa blocker record --run <run-id> --stdin-json
ai-qa verdict set --run <run-id> --stdin-json
ai-qa case draft --from-run <run-id>
ai-qa case validate <case-id> --revision <revision>
ai-qa case activate <case-id> --revision <revision>
ai-qa run start --kind regression --case <case-id> --platform <platform> --execution local|ci
ai-qa run resume <run-id>
ai-qa run cancel <run-id> --reason <reason>
ai-qa run finish <run-id>
ai-qa report generate <run-id>
ai-qa report export <run-id> --adapter <adapter-id>
```

Mutating commands accept structured JSON through standard input and return structured JSON with the created event ID, current state, validation result, and permitted next actions. Human-readable output is available for direct operator use, but agent workflows use `--json`.

There is no public generic event-append command. Each typed command enforces the domain invariants for its event type; the internal append service is not an escape hatch for agents or users.

Regression actions require an existing required or recovery step ID from the pinned work order. Exploratory actions may omit `--step`; the CLI then creates and returns a stable draft step ID that subsequent observations and assertions can reference and that case promotion can normalize.

## 11. Workflows

### 11.1 Initialization

```text
Activate global ai-qa skill
-> Resolve and confirm target project
-> Confirm project trust
-> Read only the required project documents
-> Discuss configuration with the user
-> Run read-only doctor checks
-> Write confirmed config
-> Generate project skill only when needed
-> Show Git policy and created files
-> Validate configuration and skill
```

### 11.2 Environment setup

```text
doctor
-> setup plan
-> AI explains effects
-> user approves
-> setup apply
-> doctor verifies resulting state
```

QA execution never calls `setup apply` implicitly.

### 11.3 Exploratory manual QA

```text
Start exploratory run
-> observe current UI and capture required evidence
-> register observation
-> register planned action and receive idempotency key
-> invoke platform tool
-> register completed or unknown action result
-> observe resulting UI and capture required evidence
-> register observation and assertions
-> repeat
-> record evidence-backed verdict
-> finish run
```

### 11.4 Case promotion

```text
Exploratory run
-> create the next draft case revision
-> normalize steps, selectors, assertions, and checkpoints
-> validate replayability
-> AI and user review
-> activate the draft revision and supersede the previous active revision
```

Runs with missing actions, unresolved unknown actions, ambiguous outcomes, unstable selectors, or insufficient evidence remain drafts.

### 11.5 Regression replay

```text
Agent runner activates global and project skills
-> ai-qa run start pins the case revision and returns a versioned work order
-> agent invokes the configured platform tool
-> agent writes every action, observation, assertion, and evidence item back
-> agent uses bounded recovery actions only when required
-> ai-qa run finish validates fidelity, completeness, budgets, and verdict coverage
-> configured reports are generated and exported
```

Regression replay uses bounded adaptive fidelity. Required steps remain ordered and cannot be skipped, replaced, or silently rewritten. Recovery actions are allowed only when they reference the affected required step and remain within the frozen work-order budgets.

Before accepting a terminal verdict, `run finish` verifies:

- The run used the pinned case revision and platform-variant hash.
- Every required step has a matching planned action and terminal outcome (`completed`, resolved unknown, or typed blocker/failure).
- Every planned action has a completed result or an explicit recovery resolution.
- No unknown action remains unresolved or indeterminate for a `pass` verdict.
- Required observations, assertions, and evidence checkpoints are present and linked to their step IDs.
- Every acceptance criterion is covered by the verdict and cited assertion/evidence IDs.
- Recovery actions and total tool calls remained within the frozen budget and deadline.
- Extra recovery actions did not replace or reorder required product steps.

Cross-platform execution may run platform variants sequentially or in parallel. Each platform has its own run directory and verdict. An aggregate report must preserve each platform's result instead of collapsing `blocked` into `fail`.

### 11.6 CI execution

CI must launch a supported AI agent runner. `ai-qa run start --kind regression --case <case-id> --execution ci` is a protocol operation used by that agent; it is not a standalone test executor.

The npm package provides client-oriented CI templates. Each template:

- Makes the global and project skills available.
- Selects a case and platform.
- Starts the external agent runner.
- Preserves the `.ai-qa/` output according to project policy.
- Returns a non-success pipeline status for every non-`pass` verdict by default.
- Keeps `fail`, `blocked`, and `not_verified` distinct in the generated report.

Project CI policy may explicitly allow selected `blocked` subtypes or `not_verified` reasons without failing the pipeline. A product `fail` can never be mapped to a successful process exit.

## 12. Platform contracts

### 12.1 Web

Chrome DevTools MCP is the preferred interactive control tool. The project configuration identifies the browser target, entry URL, readiness conditions, capture policy, and any required browser profile constraints.

### 12.2 iOS Simulator

Pepper is the preferred iOS Simulator control tool. The project skill records any stable service chain, app-build policy, simulator-selection policy, and recovery constraints. A stale or rebuilt app invalidates assumptions about the existing automation session.

`doctor` reports `missing_required_tool` when Pepper or its required simulator capability is unavailable; this readiness result is not itself a run verdict. If an iOS run is requested while the required Pepper capability is unavailable, the CLI creates a reportable run with verdict `blocked:tool`. A release candidate cannot satisfy the iOS vertical-slice gate without a live Pepper-backed run.

### 12.3 Android Emulator

Appium with UiAutomator2 controls the Android Emulator. Configuration records the Appium endpoint reference, app package/activity references, emulator-selection policy, and required capability profile.

### 12.4 Real devices

The schema and capability model reserve an Appium real-device target. npm v1 may detect and describe that capability, but real-device runs are experimental and do not count toward v1 acceptance.

## 13. Screenshot and visual evaluation policy

Screenshots are immutable evidence and an input to AI semantic evaluation. npm v1 does not use full-screen pixel difference as a required pass/fail mechanism.

Where a stable non-visual assertion exists, the case also uses element, text, URL, app-state, or other structured assertions. The AI verdict cites the relevant acceptance criterion, observation, assertion, and evidence IDs.

Annotations are derived evidence. Raw images remain available and unchanged. If a sensitive screenshot must leave the project, a redacted derivative is created before export.

## 14. Error model and recovery

### 14.1 Verdict classification

```text
pass
  All required acceptance criteria have sufficient evidence.

fail
  Observed product behavior clearly violates an acceptance criterion.

blocked
  Environment, tool, permission, data, or required-evidence conditions prevent validation.

not_verified
  Only part of the scenario was verified or the available evidence is insufficient.
```

Blocked subtypes include `environment`, `tool`, `permission`, `data`, and `evidence`.

### 14.2 Ambiguous action result

When a tool result is ambiguous, the agent must not immediately repeat the action. It first captures a fresh UI state or screenshot, determines whether the action took effect, records a recovery decision, and only then continues, retries, or blocks the run.

The recovery event references the unknown action and records one resolution:

```text
applied | not_applied | indeterminate
```

An `applied` resolution lets the required step continue. A `not_applied` resolution permits a new planned action within the recovery budget. An `indeterminate` or unresolved unknown action prevents `pass`, prevents case activation, and produces `not_verified` unless evidence identifies a platform-tool failure, in which case it produces `blocked:tool`.

Potentially destructive or externally visible actions such as deleting, paying, sending, submitting, or publishing must not be retried blindly. Action idempotency keys prevent duplicate write-back and help detect accidental repetition.

### 14.3 Crash recovery

Events are durably appended after each accepted mutation. An unfinished run becomes `interrupted`. Resuming a run requires a new observation of the current UI; the agent cannot assume the app remains at the previous event's state. An interrupted or running run may be explicitly cancelled; cancellation is terminal and records `not_verified` with the cancellation reason.

Different platform runs use separate directories and locks and may execute in parallel. A single run permits only one writer.

## 15. Security and trust

- The user must trust a target repository before its project skill is loaded.
- Project skills, configuration, cases, logs, and reports must not contain literal passwords, tokens, recovery codes, or private keys.
- Secret values are supplied at runtime through the user's chosen secret mechanism.
- Tool output and screenshots are treated as potentially sensitive.
- Exporters receive only artifacts permitted by the configured evidence and redaction policy.
- No evidence is uploaded externally without confirmed storage configuration.
- Retention cleanup lists the affected runs and files before deletion and requires confirmation.
- Setup plans expire when their preconditions or detected environment change.
- The public npm tarball must exclude private repository metadata, internal evidence, credentials, and test-account data.

## 16. Internal code organization

The first release is one npm package with focused internal modules:

```text
src/
|-- cli/
|-- core/
|   |-- config/
|   |-- cases/
|   |-- runs/
|   |-- events/
|   |-- evidence/
|   `-- verdicts/
|-- services/
|   |-- project-root/
|   |-- doctor/
|   |-- setup-plan/
|   |-- case-promotion/
|   `-- report-generation/
|-- exporters/
|-- storage/
|-- skills/
|   |-- global/
|   `-- project-template/
`-- schemas/
```

The core domain cannot import client-specific or platform-control packages. Client compatibility, skill installation, and CI templates are boundary modules around the same core workflow.

## 17. Runtime and compatibility

- TypeScript with strict type checking.
- ESM package output.
- Node.js 22 and Node.js 24 LTS support.
- Schema validation at every file and CLI boundary.
- Versioned config, case, event, evidence, work-order, and report schemas.
- Explicit migrations; a newer CLI must not silently rewrite tracked project data without a migration preview and confirmation.

An agent runner must reject an unsupported work-order major version before invoking a platform tool. Work orders are immutable execution contracts and are regenerated from the pinned case revision rather than migrated in place.

Node.js 20 is not supported because it is end-of-life at the time of this design. The supported Node matrix is verified against the official Node.js release schedule during each release cycle.

## 18. Testing strategy

### 18.1 Unit tests

- Schema parsing and migration.
- Event ordering and duplicate idempotency keys.
- Case-revision and run state transitions, including supersede and cancel flows.
- Verdict and evidence-completeness rules.
- Evidence hashing and immutable derivation.
- Work-order version compatibility and budget calculation.
- Bounded adaptive fidelity and required-step coverage.
- Project-root resolution and project isolation.
- Secret detection and project-relative path enforcement.
- Atomic writes and lock behavior.

### 18.2 CLI integration tests

- Temporary Project A and Project B remain isolated.
- Crash recovery resumes from the event journal.
- Parallel platform runs do not conflict.
- Parallel platform runs write only to their own evidence index and directory.
- Invalid or incomplete events are rejected.
- Public typed event commands cannot bypass action, recovery, or verdict invariants.
- Doctor, setup plan, approval, apply, and verification preserve the consent boundary.
- A packed npm tarball installs globally into a clean temporary prefix and operates on a target project.
- Explicit global skill installation previews its destination, preserves an existing skill, and installs the bundled canonical source after confirmation.

### 18.3 Skill tests and evals

- The main skill discusses configuration before writing.
- It confirms project root and repository trust.
- It generates a project skill only when stable procedural differences require one.
- It observes before and after meaningful actions.
- It records direct tool operations through the CLI.
- It does not skip or replace required regression steps during recovery.
- It distinguishes product failure from tool and environment blockers.
- It refuses an unsupported `pass` verdict.
- Generated skills pass Agent Skills validation.

### 18.4 Tool-contract tests

Recorded fixtures validate event mapping for Chrome DevTools MCP, Pepper, and Appium. Failure fixtures cover stale automation connections, missing elements, screenshot failures, timeouts, partial command success, unknown-action resolution, budget exhaustion, and tool disconnection.

Real-device Appium receives contract tests only in npm v1.

### 18.5 Live vertical-slice acceptance

Each formal platform must complete:

```text
init/configure
-> doctor
-> exploratory QA
-> raw screenshot
-> draft case
-> active case
-> regression replay
-> evidence-backed verdict
-> configured report/export
```

The formal platform matrix is:

```text
Web               Chrome DevTools MCP
iOS Simulator     Pepper
Android Emulator  Appium + UiAutomator2
```

## 19. npm v1 release gates

npm v1 is complete only when:

- Format, lint, typecheck, unit, and integration checks pass on Node.js 22 and 24.
- Global and generated project skills pass Agent Skills validation.
- The packed tarball installs globally in a clean temporary prefix.
- Explicit global skill installation produces a valid `~/.agents/skills/ai-qa/` without silently replacing an existing user skill.
- Global CLI operation in two target projects produces fully isolated records.
- Web, iOS Simulator, and Android Emulator each have one successful live vertical-slice acceptance run with raw evidence.
- Failure-injection runs prove that tool failures and incomplete evidence cannot produce a product `fail` or unsupported `pass`.
- Fidelity tests prove that required steps cannot be skipped or replaced and that bounded recovery cannot exceed the frozen work-order budget.
- CI templates successfully launch an external agent runner and preserve distinct verdict classifications.
- The public tarball contains no secrets, private evidence, internal test data, or private repository metadata.
- Public npm installation works while the source repository remains private.

Mock or contract coverage alone cannot satisfy a formal platform gate.

## 20. Delivery decomposition

Implementation should be delivered as independently reviewable vertical increments:

1. Core schemas, project isolation, event/evidence journal, global skill, and Web vertical slice.
2. Case promotion, regression replay, reporting/storage contracts, and CI agent protocol.
3. Pepper iOS Simulator vertical slice and recovery behavior.
4. Appium Android Emulator vertical slice and recovery behavior.
5. Cross-platform aggregation, packaging hardening, skill evals, and npm v1 release gates.

Each increment must leave a working, testable system. Platform increments may not bypass the canonical event and evidence protocol.

## 21. External specifications

- Agent Skills specification: <https://agentskills.io/specification>
- Agent Skills client implementation guide: <https://agentskills.io/client-implementation/adding-skills-support>
- Node.js release schedule: <https://nodejs.org/en/about/previous-releases>
- Appium driver architecture: <https://appium.io/docs/en/latest/intro/drivers/>
- Appium UiAutomator2 setup: <https://appium.io/docs/en/latest/quickstart/uiauto2-driver/>
- Pepper iOS package and documentation: <https://pypi.org/project/pepper-ios/>

## 22. Approved decisions recap

- Architecture: Agent-orchestrated, CLI-managed state and evidence.
- Distribution: Globally installed public npm package; source initially private.
- Skills: One global main skill plus an optional project skill under `.agents/skills/ai-qa-project/`.
- Records: Stored per target project under `.ai-qa/`.
- Platforms: Web, iOS Simulator, Android Emulator in v1; real devices are contract-only.
- Tools: Chrome DevTools MCP, Pepper, Appium/UiAutomator2.
- Regression: Exploratory manual run promoted into a reviewed case.
- Case structure: Shared scenario with platform-specific variants.
- Case history: Immutable revisions pinned by revision number and content hash in every regression run.
- Direct tool usage: Allowed, with mandatory CLI write-back.
- Event API: Public write-back commands are typed; generic event append remains internal.
- Evidence concurrency: Evidence indexes and files are isolated per run.
- Replay fidelity: Required ordered steps with bounded, step-linked adaptive recovery.
- Execution limits: Every versioned work order freezes finite tool-call, recovery-action, and deadline budgets.
- Screenshots: Immutable evidence plus AI semantic evaluation; no mandatory full-screen pixel diff.
- Configuration: User and AI discuss report, storage, evidence, Git, environment, and CI policy.
- Internal record: Versioned JSON Lines event log.
- Environment changes: Read-only doctor first; setup requires an approved plan.
- CI: Requires an external AI agent runner; all non-`pass` verdicts fail by default.
- npm v1: Requires a complete live vertical slice on all three formal platforms.
