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
- Group one or more pinned case/platform runs into a reproducible regression invocation and aggregate report.
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
- Persisted named test suites; npm v1 supports explicit case selection and `--all-active` snapshots instead.
- Dynamically loading third-party npm exporter or storage plugins.

## 4. Architectural principles

### 4.1 Agent-orchestrated execution

The main skill plans the QA flow, discusses settings with the user, invokes external platform tools, interprets screenshots, and records semantic decisions. The CLI never pretends to be the AI and never infers unobserved UI state.

### 4.2 Durable CLI state

The CLI owns the canonical project configuration, event log, per-run evidence indexes, case lifecycle, verdict validation, and report/export lifecycle. Skills and reports are views or workflows around this state; they are not alternate sources of truth.

### 4.3 Project isolation

The executable is global, but every target project has an independent `.ai-qa/` directory. Commands must resolve and confirm the project root before mutation. Data from two projects must never share a run, case, evidence index, or report directory.

Every `.ai-qa` storage ancestor and artifact is verified with `lstat` and `realpath` before use. Symlinked or non-canonical directories and files are rejected rather than followed, including links that resolve back inside the project.

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
              |-- Regression run groups
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

The npm package and every installed skill expose an `aiQaSkillVersion` and compatible CLI/work-protocol range in CLI-managed metadata. A global npm upgrade updates the bundled canonical assets but does not silently rewrite `~/.agents/skills/ai-qa/`. `doctor` reports missing, stale, and incompatible installed skills; `ai-qa skill sync --global` previews the managed-region diff before applying an upgrade. Starting a QA run with an incompatible global skill creates a reportable `blocked:tool` run instead of returning a work order that the installed skill cannot safely execute.

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
    |-- run-groups/
    |   `-- <run-group-id>/
    |       |-- group.json
    |       `-- events.jsonl
    |-- evidence/
    |   `-- <run-id>/
    |       |-- index.jsonl
    |       `-- files/
    `-- reports/
        |-- runs/
        |   `-- <run-id>/
        `-- run-groups/
            `-- <run-group-id>/
```

`.agents/skills/ai-qa-project/` is optional. `.ai-qa/` is the canonical project QA workspace.

The `.agents/skills/` location follows the cross-client Agent Skills convention. Each skill directory contains a `SKILL.md` with valid Agent Skills metadata. The project skill uses the fixed name `ai-qa-project`; project roots provide isolation, so different repositories can use the same skill name safely.

### 6.3 Project-root resolution

Project resolution follows this precedence:

1. An explicit `--project <path>` argument.
2. The nearest ancestor containing `.ai-qa/config.yaml`.
3. For `init` only, when no ancestor config exists, the current Git repository root after user confirmation.

`--project` always identifies the exact target, including a nested project. If `init` finds an ancestor configuration, it reports that existing project and does not initialize a nested project unless the caller explicitly supplies `--project`. Outside a Git repository, `init` has no implicit fallback: the caller must supply `--project <path>` and confirm that exact directory.

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

Installed global skills and generated project skills separate CLI-managed and user-managed content with explicit markers:

```html
<!-- ai-qa:managed:start -->
<!-- ai-qa:managed:end -->

<!-- ai-qa:user:start -->
<!-- ai-qa:user:end -->
```

`skill sync` updates only the managed region and preserves the user region byte-for-byte. Frontmatter metadata stores a checksum over the normalized CLI-managed frontmatter fields and managed body region. If either managed area was edited manually, sync shows a diff and requires confirmation instead of merging or replacing it silently.

The same managed metadata records skill and compatible work-protocol versions. `skill check`, `doctor`, and `run start` compare the installed global and project skill metadata with the active CLI. Project skills may be older than the bundled template only when their declared protocol range is compatible; incompatible managed regions require `skill sync` before execution.

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

The CLI exposes internal typed exporter and storage-adapter registries. npm v1 includes Markdown and JSON report exporters, project-local filesystem storage, and an explicitly configured command adapter for handing approved exports to an external system. The command adapter receives only the generated artifacts and metadata allowed by project policy; it cannot read the event store or raw evidence implicitly. npm v1 does not discover or dynamically load third-party npm adapters.

The main skill maps the user's goals to these installed capabilities instead of presenting a hard-coded provider menu. Project-local storage is always available for canonical data. External storage never becomes an alternate mutable event log.

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
  - id: authenticated-home-visible
    description: 使用者進入首頁
    requiredEvidence:
      - post-action-screenshot
  - id: current-account-visible
    description: 畫面顯示目前帳號
    requiredEvidence:
      - structured-text-assertion
variants:
  web:
    steps: []
  ios-simulator:
    steps: []
  android-emulator:
    steps: []
```

Every acceptance criterion has a stable ID, description, and required-evidence policy. Verdicts and assertions cite that ID; array position is never an identifier. Each step contains an intent, tool action record, stable target description, expected state, assertion strategy, and evidence checkpoint. Platform-specific selectors remain inside that platform variant.

An active revision is never edited in place. Editing creates the next draft revision. Activating that draft marks the previous active revision as `superseded` but retains it for historical reports. `contentHash` is calculated from the canonical revision content with the `contentHash` field omitted; the platform-variant hash is calculated from the canonical selected variant. Every regression run pins `caseId`, `caseRevision`, `caseContentHash`, and the selected platform-variant hash in its work order and event log.

### 9.3 Run event log

Each run has an append-only `events.jsonl`. Every event contains:

- Schema version.
- Run ID and monotonically increasing sequence.
- Optional run-group ID for grouped regression runs.
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

Journal mutation holds the run lock and commits the complete JSON Lines snapshot through atomic replacement. Every non-empty `events.jsonl` has a mandatory final newline; truncated or unterminated journals fail integrity validation rather than being partially accepted.

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

Each evidence-index mutation holds the per-run index lock and commits the complete JSON Lines snapshot through atomic replacement with a mandatory final newline. The index and typed `evidence` events have exact one-to-one canonical parity: duplicate, missing, extra, or mismatched records are integrity failures.

For Web, every planned platform action records `tool: "chrome-devtools-mcp"`; every evidence record uses `sourceTool: "chrome-devtools-mcp"` and must match its completed evidence-capture action. Output from another controller cannot be relabeled as Chrome DevTools evidence.

`evidence add` calculates and stores the content hash before accepting the evidence event. The CLI re-verifies registered evidence on `run resume`, before `run finish`, and before report generation or export. A mismatch before completion prevents the current verdict from being finalized and requires a typed `blocked:evidence` verdict or replacement evidence. A mismatch discovered after completion produces an integrity error and refuses a normal report/export without rewriting the historical verdict.

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

Run-group execution status transitions:

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

An exploratory session is not a separate entity. It is a run with `kind: exploratory`; a regression execution is a run with `kind: regression`. `execution` separately records `local` or `ci`. `completed` requires a terminal verdict. Cancellation is lifecycle-owned: only `run cancel` creates the terminal canonical `not_verified/cancelled` verdict, its summary matches the lifecycle reason, and its `criterionResults` is exactly empty.

The append-only log may contain verdict revisions, but it has exactly one effective verdict. `verdict set` creates the first verdict; an identical retry returns the original event without appending a second verdict. A later correction must use `verdict revise --supersedes <verdict-id>` and may occur only before `run finish`; implicit last-wins behavior is forbidden. `verdict set` and `verdict revise` reject `not_verified/cancelled`. `run finish` rejects zero effective verdicts, multiple unsuperseded verdicts, or a supersession chain that does not end at the effective verdict. Completed and cancelled runs cannot revise verdicts.

### 9.6 Regression run groups

A `RunGroup` represents one local or CI regression invocation over one or more case revisions and platforms. It is not an exploratory session or a persisted named suite. `run-group start` resolves the requested selection and writes an immutable, versioned `group.json` before any child tool action begins:

```yaml
schemaVersion: 1
id: run-group-01
execution: ci
selectionMode: all-active
members:
  - runId: run-web-login
    caseId: login-success
    caseRevision: 2
    caseContentHash: sha256:current-content
    platform: web
    platformVariantHash: sha256:web-variant
  - runId: run-ios-login
    caseId: login-success
    caseRevision: 2
    caseContentHash: sha256:current-content
    platform: ios-simulator
    platformVariantHash: sha256:ios-variant
```

Selection may name one or more cases or use `--all-active`, and it must name at least one platform. `--all-active` is resolved once at group creation; later case activation, supersession, or retirement does not change the group. The selected matrix contains members only where an active revision declares a platform variant. Missing requested variants are recorded as explicit exclusions in the manifest and aggregate coverage matrix; they are never silently omitted. CI policy decides whether such a coverage gap is allowed, and the default is non-success.

Every member is an atomic regression run with its own work order, event log, evidence directory, lock, and verdict, and records the parent `runGroupId`.

`run-group start` allocates all member run IDs in the manifest and returns the member work orders. Child runs never mutate the shared manifest while executing in parallel. The group cannot dynamically add members or perform platform-tool actions outside a child work order, so its maximum tool-call cost is the finite sum of its frozen member budgets; the CLI reports that bound before local confirmation or CI execution.

`run-group finish` acquires the group lock, validates that every member is terminal, and appends the group completion event. An interrupted group resumes by re-reading each child state and requiring the normal fresh-observation rule for any resumed child. Cancelling a group cancels every non-terminal member with `not_verified` while preserving terminal member results. A group has execution status but no collapsed QA verdict: aggregate reports and process exit policy preserve the full case/platform verdict matrix, exclusions, and result counts.

### 9.7 Versioned work order and execution budget

`run start` returns a versioned work order containing:

- Work-order schema and protocol versions.
- Run kind, execution environment, project ID, optional run-group ID, platform, and environment profile.
- A user-confirmed goal and stable acceptance-criterion objects for exploratory runs.
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

An exploratory run starts only after the user and AI have confirmed a goal and one or more acceptance criteria with stable IDs and required-evidence policies. Those criteria are frozen into the work order and become the only valid basis for an exploratory verdict. Case promotion copies and normalizes them into the draft case revision.

An exploratory run defaults to 100 tool calls, 10 recovery actions, and a 30-minute deadline because it has no required-step count. Project configuration may define different defaults, and an immutable case revision may override regression defaults. `run start` freezes the resulting values in the work order. Every work order has finite budgets; CI and local runs cannot use unlimited values.

A tool call is any external Chrome DevTools MCP, Pepper, or Appium invocation, including read-only observation and screenshot calls. A recovery action is a state-changing external invocation marked `recoveryForStepId`. Generic budget exhaustion produces `not_verified` with reason `budget_exhausted`; when evidence identifies repeated platform-tool failure as the cause, the result is `blocked:tool`.

### 9.8 Run reports

Configured JSON and Markdown generation and project-local export use one per-run report-directory lock for the complete multi-format operation. Reports are built from a locked, integrity-verified journal plus exact-parity evidence state; JSON and Markdown must describe the same run, verdict, evidence, and integrity verification time. A stale or mismatched artifact is rejected instead of exported as a verified report.

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
ai-qa run-group           Multi-case/platform regression orchestration
ai-qa report              Report generation and export
```

Important commands include:

```text
ai-qa init --stdin-json
ai-qa configure --stdin-json
ai-qa doctor --platform <platform> --json --stdin-json
ai-qa setup plan --platform <platform>
ai-qa setup apply <plan-id>
ai-qa skill install --global
ai-qa skill generate
ai-qa skill check
ai-qa skill sync [--global]
ai-qa run start --kind exploratory --platform <platform> --execution local --stdin-json
ai-qa action plan --run <run-id> [--step <step-id>] --stdin-json
ai-qa action complete <action-id> --run <run-id> --stdin-json
ai-qa observation add --run <run-id> --stdin-json
ai-qa assertion record --run <run-id> --step <step-id> --stdin-json
ai-qa evidence add --run <run-id> --file <path> --stdin-json
ai-qa decision record --run <run-id> --stdin-json
ai-qa recovery resolve <action-id> --run <run-id> --stdin-json
ai-qa blocker record --run <run-id> --stdin-json
ai-qa verdict set --run <run-id> --stdin-json
ai-qa verdict revise --run <run-id> --supersedes <verdict-id> --stdin-json
ai-qa case draft --from-run <run-id> --stdin-json
ai-qa case validate <case-id> --revision <revision>
ai-qa case activate <case-id> --revision <revision> --stdin-json
ai-qa run start --kind regression --case <case-id> --platform <platform> --execution local|ci --stdin-json
ai-qa run resume <run-id>
ai-qa run cancel <run-id> --reason <reason>
ai-qa run finish <run-id>
ai-qa run-group start (--case <case-id>... | --all-active) --platform <platform>... --execution local|ci
ai-qa run-group resume <run-group-id>
ai-qa run-group cancel <run-group-id> --reason <reason>
ai-qa run-group finish <run-group-id>
ai-qa report generate <run-id>
ai-qa report generate --group <run-group-id>
ai-qa report export <run-id> --adapter project-local
ai-qa report export --group <run-group-id> --adapter <adapter-id>
```

Mutating commands accept structured JSON through standard input and return structured JSON with the created event ID, current state, validation result, and permitted next actions. Human-readable output is available for direct operator use, but agent workflows use `--json`.

There is no public generic event-append command. Each typed command enforces the domain invariants for its event type; the internal append service is not an escape hatch for agents or users.

Regression actions require an existing required or recovery step ID from the pinned work order. Exploratory actions may omit `--step`; the CLI then creates and returns a stable draft step ID that subsequent observations and assertions can reference and that case promotion can normalize.

## 11. Workflows

### 11.1 Initialization

```text
Activate global ai-qa skill
-> Resolve and confirm target project
-> Confirm project trust in the machine-local trust store
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
Discuss and confirm the exploratory goal, acceptance criteria, and required evidence
-> start exploratory run and freeze them in the work order
-> observe current UI and capture required evidence
-> register observation
-> register planned action and receive idempotency key
-> invoke platform tool
-> register completed or unknown action result
-> on the same step ID, plan and complete a fresh observation action, then register the resulting UI state
-> on that step ID, plan and complete evidence capture, then register evidence citing the capture action and fresh observation
-> register assertions on that step, citing the fresh observation and evidence
-> repeat
-> record evidence-backed verdict
-> finish run
```

Pre-action evidence, an observation recorded before the interaction terminal result, or evidence captured before the fresh post-action observation cannot support `pass`, case promotion, or a verified report claim.

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
- Each satisfied post-action chain orders interaction, terminal result, fresh observation, evidence capture, and assertion on the same required step ID.
- Every acceptance criterion is covered by the verdict and cited assertion/evidence IDs.
- Recovery actions and total tool calls remained within the frozen budget and deadline.
- Extra recovery actions did not replace or reorder required product steps.

Cross-platform execution may run platform variants sequentially or in parallel. Each platform has its own run directory and verdict. An aggregate report must preserve each platform's result instead of collapsing `blocked` into `fail`.

One regression run may still be started directly for interactive use. Multi-case, cross-platform, and full-active execution uses a `RunGroup`:

```text
Resolve explicit cases or --all-active and requested platforms
-> create the immutable group manifest and child runs
-> execute child work orders sequentially or in parallel
-> finish every child run
-> finish the group
-> generate one aggregate report with the full case/platform verdict matrix
```

### 11.6 CI execution

CI must launch a supported AI agent runner. npm v1 formally supports Codex CLI and Claude Code CLI as external runners, with GitHub Actions as the first supported CI provider. The CLI does not embed either runner and does not maintain divergent QA workflows for them; client templates adapt the same versioned work protocol.

`ai-qa run start --kind regression --case <case-id> --platform <platform> --execution ci` and `ai-qa run-group start ... --execution ci` are protocol operations used by those agents; neither is a standalone test executor.

The npm package provides client-oriented CI templates. Each template:

- Makes the global and project skills available.
- Selects explicit cases or `--all-active` and one or more platforms.
- Starts the external agent runner.
- Preserves the `.ai-qa/` output according to project policy.
- Returns a non-success pipeline status for every non-`pass` verdict by default.
- Keeps `fail`, `blocked`, and `not_verified` distinct in the generated report.

A grouped CI job succeeds by default only when every member run has verdict `pass` and the group completes without an integrity error. The report never derives a single QA verdict by collapsing member results.

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
  A specific external environment, tool, permission, data, or evidence-capture condition prevents validation.

not_verified
  Validation or evidence coverage is incomplete without a specific external blocker.
```

Blocked subtypes include `environment`, `tool`, `permission`, `data`, and `evidence`.

`blocked:evidence` requires a recorded attempt to capture, register, read, or integrity-check required evidence plus the concrete tool, permission, policy, storage, or corruption condition that prevented it. `not_verified` covers skipped criteria, budget exhaustion, cancellation, an intentionally incomplete run, or insufficient coverage when no such external prevention occurred. Evidence being absent is not by itself a blocker.

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

- The user must trust a target repository before its project skill is loaded. A project cannot authorize itself through `.ai-qa/config.yaml`.
- Trust decisions live only in the per-machine user store `~/.ai-qa/trust.json`, outside every target repository. This is the only global project-related state in npm v1 and contains no cases, runs, evidence, reports, secrets, or project instructions.
- A trust entry records the canonical project path, repository identity fingerprint when Git metadata is available, confirmation time, and trust-schema version. A path or repository-identity mismatch requires confirmation again; untrusted project content is not loaded while prompting.
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
|   |-- run-groups/
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
|-- clients/
|   |-- codex/
|   |-- claude-code/
|   `-- github-actions/
|-- skills/
|   |-- global/
|   `-- project-template/
`-- schemas/
```

The core domain cannot import client-specific or platform-control packages. Client compatibility, skill installation, and CI templates are boundary modules around the same core workflow. Exporter and storage registries are internal composition mechanisms in npm v1, not a public plugin-loading API.

## 17. Runtime and compatibility

- TypeScript with strict type checking.
- ESM package output.
- Node.js 22 and Node.js 24 LTS support.
- Schema validation at every file and CLI boundary.
- Versioned config, case, event, evidence, run-group, work-order, skill-protocol, and report schemas.
- Explicit migrations; a newer CLI must not silently rewrite tracked project data without a migration preview and confirmation.

An agent runner must reject an unsupported work-order major version before invoking a platform tool. Work orders are immutable execution contracts and are regenerated from the pinned case revision rather than migrated in place. Codex CLI and Claude Code CLI templates declare the protocol versions they support; the release gate exercises both against the packaged CLI instead of assuming compatible command syntax.

Node.js 20 is not supported because it is end-of-life at the time of this design. The supported Node matrix is verified against the official Node.js release schedule during each release cycle.

## 18. Testing strategy

### 18.1 Unit tests

- Schema parsing and migration.
- Event ordering and duplicate idempotency keys.
- Case-revision, run, and run-group state transitions, including supersede and cancel flows.
- Run-group explicit and `--all-active` selection snapshots remain unchanged when active cases later change.
- Verdict and evidence-completeness rules.
- Verdict supersession and exactly-one-effective-verdict validation.
- `blocked:evidence` versus `not_verified` classification boundaries.
- Evidence hashing and immutable derivation.
- Work-order version compatibility and budget calculation.
- Bounded adaptive fidelity and required-step coverage.
- Project-root resolution and project isolation.
- Nested-project and non-Git `init` behavior.
- Secret detection and project-relative path enforcement.
- Atomic writes and lock behavior.

### 18.2 CLI integration tests

- Temporary Project A and Project B remain isolated.
- Crash recovery resumes from the event journal.
- Parallel platform runs do not conflict.
- Parallel platform runs write only to their own evidence index and directory.
- Parallel run-group members never mutate the shared immutable manifest.
- Invalid or incomplete events are rejected.
- Public typed event commands cannot bypass action, recovery, or verdict invariants.
- Doctor, setup plan, approval, apply, and verification preserve the consent boundary.
- A packed npm tarball installs globally into a clean temporary prefix and operates on a target project.
- Explicit global skill installation previews its destination, preserves an existing skill, and installs the bundled canonical source after confirmation.
- `doctor` and `run start` detect stale or incompatible global and project skill versions, and `skill sync` preserves user-managed regions while upgrading compatible metadata.
- Project configuration cannot forge machine-local repository trust.
- Evidence hash mismatches are detected on resume, finish, report generation, and export.
- Single-run and run-group reports preserve criterion, case, platform, and verdict identity.

### 18.3 Skill tests and evals

- The main skill discusses configuration before writing.
- It confirms project root and repository trust.
- It defines exploratory goals and stable acceptance criteria before starting a run.
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
-> regression replay 1
-> evidence-backed verdict 1
-> regression replay 2 of the same pinned revision
-> evidence-backed verdict 2
-> configured report/export
```

The exploratory-to-promotion flow occurs once per platform gate. The two regression replays use fresh run IDs and must both pass consecutively against the same case revision and platform-variant hash. A failed, blocked, or not-verified replay resets the consecutive-pass count for that gate.

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
- Web, iOS Simulator, and Android Emulator each complete one exploratory-to-promotion flow followed by two consecutive successful regression replays of the same pinned revision, with raw evidence for every run.
- Failure-injection runs prove that tool failures and incomplete evidence cannot produce a product `fail` or unsupported `pass`.
- Fidelity tests prove that required steps cannot be skipped or replaced and that bounded recovery cannot exceed the frozen work-order budget.
- GitHub Actions templates for Codex CLI and Claude Code CLI each successfully launch the external runner, execute a RunGroup, and preserve distinct verdict classifications.
- The public tarball contains no secrets, private evidence, internal test data, or private repository metadata.
- Public npm installation works while the source repository remains private.

Mock or contract coverage alone cannot satisfy a formal platform gate.

## 20. Delivery decomposition

Implementation should be delivered as independently reviewable vertical increments:

1. Core schemas, project isolation, event/evidence journal, global skill, case promotion, Web regression replay, project-local report/export, and the complete Web vertical slice.
2. RunGroup selection and aggregation, external reporting/storage contracts, Codex and Claude Code compatibility, and the GitHub Actions CI protocol.
3. Pepper iOS Simulator vertical slice and recovery behavior.
4. Appium Android Emulator vertical slice and recovery behavior.
5. Cross-platform hardening, packaging hardening, skill evals, and npm v1 release gates.

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
- Regression grouping: RunGroup snapshots explicit cases or `--all-active` across selected platforms; persisted named suites are outside npm v1.
- Replay fidelity: Required ordered steps with bounded, step-linked adaptive recovery.
- Execution limits: Every versioned work order freezes finite tool-call, recovery-action, and deadline budgets.
- Screenshots: Immutable evidence plus AI semantic evaluation; no mandatory full-screen pixel diff.
- Configuration: User and AI discuss report, storage, evidence, Git, environment, and CI policy.
- Exploratory criteria: Goal and stable, citable acceptance criteria are confirmed and frozen before the run starts.
- Trust: Repository trust is per-machine state under `~/.ai-qa/`, never project-controlled.
- Adapters: npm v1 has built-in typed adapters and an explicit command adapter, not third-party npm plugin loading.
- Internal record: Versioned JSON Lines event log.
- Environment changes: Read-only doctor first; setup requires an approved plan.
- CI: GitHub Actions templates support Codex CLI and Claude Code CLI; all non-`pass` member verdicts fail by default.
- npm v1: Requires promotion plus two consecutive successful replays on all three formal platforms.
