# AI QA Three-Platform Vertical Slices Design

## Summary

AI QA will support projects deployed to any non-empty subset of Web, iOS
Simulator, and Android Emulator. First-use configuration will explicitly ask
which platforms the project deploys and collect the target and tool settings
for every selected platform.

The support is a complete vertical slice rather than a configuration-only
change. Doctor, exploratory runs, evidence capture, case promotion, regression
replay, reports, and the global Skill will work on all three platforms.
Users choose the platform subset for each execution. A single-platform run
remains available, while `RunGroup` provides multi-case and multi-platform
selection with an aggregate result matrix.

## Decisions

- Formal platforms are `web`, `ios-simulator`, and `android-emulator`.
- Real iOS and Android devices are outside this increment.
- Web uses `chrome-devtools-mcp`.
- iOS Simulator uses `pepper`.
- Android Emulator uses `appium` with `uiautomator2`.
- The implementation uses a typed platform registry and shared protocol core,
  not copied platform-specific run pipelines.
- A project may configure one, two, or all three formal platforms.
- A user may select one, two, or all configured platforms for an invocation.
- Compatibility with the current Web-only configuration and protocol is not a
  requirement. The current schema becomes the only supported schema.

## Goals

- Make first-use setup collect every deployed platform and its required
  settings.
- Keep platform-specific configuration strongly typed.
- Preserve one audited run, evidence, verdict, and report lifecycle across all
  platforms.
- Allow one logical case to share acceptance criteria while owning independent
  platform variants.
- Allow users to run any requested subset of configured platforms.
- Add immutable run groups and aggregate case-by-platform reports.
- Reject controller provenance that does not match the run platform.
- Complete live, evidence-backed vertical-slice acceptance on every formal
  platform.

## Non-goals

- Real-device execution, signing, pairing, provisioning, device farms, or
  physical-device lifecycle management.
- Embedding Chrome DevTools MCP, Pepper, Appium, or UiAutomator2 clients in the
  CLI. Codex or another supported host agent continues to invoke platform
  tools.
- Automatically running every configured platform.
- Inferring unconfirmed bundle IDs, Android packages, activities, endpoints,
  credentials, or secret values.
- Collapsing a run group into a synthetic QA verdict.
- Preserving Web-only schema or work-protocol compatibility.

## Architecture

### Platform registry

The core exposes a closed `Platform` union:

```text
web | ios-simulator | android-emulator
```

A typed platform registry is the single source of truth for each platform's:

- platform identifier;
- controller identifier;
- target configuration schema;
- tool configuration schema;
- doctor input and readiness-check codes;
- target-description validation;
- case-step and evidence provenance constraints.

The registry contains definitions and validation behavior only. It does not
contain an external tool client. Shared run, event, evidence, case, verdict,
and report services consume the platform contract instead of branching on Web
throughout the domain.

The fixed controller mapping is:

```text
web              -> chrome-devtools-mcp
ios-simulator    -> pepper
android-emulator -> appium
```

Android tool configuration also fixes `automationName` to `uiautomator2`.
An action or evidence record whose controller does not match its work-order
platform is rejected.

### Responsibility boundary

Codex and the host remain responsible for filesystem authority, approvals,
authentication, external-tool availability, and actual controller calls.
AI QA validates confirmed configuration, stores immutable execution state,
enforces provenance and lifecycle rules, and generates reports.

The CLI never treats a modeled doctor observation as proof that it invoked a
controller. The agent supplies fresh observations obtained through the
configured tool, and all meaningful tool operations still use the two-phase
action protocol.

## Configuration and first-use setup

### Current schema only

Configuration advances to a new schema version and removes the old Web-only
normalization path. `targets` and `tools` accept the same non-empty subset of
formal platform keys. A configuration is invalid when:

- no platform is configured;
- a target has no matching tool entry;
- a tool entry has no matching target;
- a controller or Android automation name differs from the registry;
- a platform-specific required field is missing;
- a literal secret is supplied where only a secret reference is allowed.

The logical shape is:

```yaml
schemaVersion: 3
project:
  id: sample-project
  name: Sample Project
targets:
  web:
    entryUrl: https://example.test
    readinessUrl: https://example.test/health
  ios-simulator:
    bundleId: com.example.app
    simulator:
      selection: booted
    launch:
      buildCommand: pnpm ios:build
  android-emulator:
    appPackage: com.example.app
    appActivity: .MainActivity
    emulator:
      selection: running
tools:
  web:
    controller: chrome-devtools-mcp
  ios-simulator:
    controller: pepper
  android-emulator:
    controller: appium
    automationName: uiautomator2
    endpoint: http://127.0.0.1:4723
```

Optional launch, build, device-name, AVD-name, readiness, and endpoint fields
remain typed and platform-local. Stable multi-service startup or recovery
procedures that cannot be represented safely in configuration belong in a
user-confirmed Project Skill. Machine-local absolute paths and literal secret
values do not belong in tracked configuration.

### Setup dialogue

The global Skill drives setup in this order:

1. Resolve the exact host-authorized project root.
2. Inspect project metadata and instructions for candidate platform facts.
3. Ask the user to select the deployed platforms as a non-empty multi-select.
4. Present discovered values as proposals and confirm every platform's
   required identifiers and policies.
5. Collect shared evidence, report, recording, Git, CI, environment, and secret
   reference decisions.
6. Create a Project Skill only for confirmed stable procedures that structured
   configuration cannot express.
7. Validate the complete configuration and optional Project Skill in scratch
   space.
8. Show complete diffs and obtain the existing host-managed write approval.
9. Write the approved files and run doctor separately for every configured
   platform.

A not-ready platform does not invalidate another platform's setup. It remains
configured and reports its own repair action. QA can start on any configured
platform whose fresh doctor result is ready.

## Doctor and readiness

Doctor accepts exactly one configured platform per call and returns a shared
readiness envelope with platform-specific checks.

Web checks the entry URL or fresh entry-page observation and Chrome DevTools
MCP availability. iOS checks the selected Simulator, installed/launchable app,
bundle ID match, and required Pepper capabilities. Android checks the selected
Emulator, package/activity availability, Appium endpoint, UiAutomator2
capability, and application launchability.

Doctor performs read-only validation. It may describe a setup plan, but does
not start services, boot devices, install applications, rebuild applications,
or change environment state without the separate approved setup flow.

A requested run with not-ready inputs creates the existing reportable
preflight-result run. The blocker is classified from the failed checks, such
as `blocked:tool` or `blocked:environment`; readiness failure is never
misreported as a product failure.

## Runs and protocol

`run start` creates one immutable platform run:

```text
ai-qa run start --kind exploratory --platform <platform> --execution local
ai-qa run start --kind regression --case <case-id> \
  --platform <platform> --execution local|ci
```

The selected platform must exist in project configuration. Work order,
readiness, required steps, run events, evidence, and reports all carry that
platform. Required steps use the controller fixed by the platform registry.

The existing rules remain shared:

- plan an external action before invoking a controller;
- record `completed` or `unknown` after the call;
- require a fresh post-action observation;
- link evidence to a completed capture action;
- link assertions and verdict criteria to the same run and step;
- resolve ambiguous actions before retry or pass;
- enforce finite tool-call, recovery, and deadline budgets;
- preserve `pass`, `fail`, `blocked`, and `not_verified` distinctions.

Separate platform runs own separate directories and locks and may execute in
parallel.

## Cases and platform variants

A logical case owns shared title and acceptance criteria and a non-empty
partial map of platform variants. Every variant contains ordered steps using
its platform controller and target descriptions.

Promotion works incrementally:

1. Promoting the first completed, evidence-backed exploratory run creates a
   draft case with the source platform variant.
2. Promoting another platform run into the same case creates the next immutable
   draft revision.
3. The new revision copies existing variants and adds or replaces the source
   platform variant.
4. Promotion provenance is stored per variant, including source run and
   excluded exploratory actions.
5. Shared acceptance-criterion IDs and meaning must match. A mismatch becomes
   a validation issue and prevents activation.
6. User review and explicit activation remain required.

Case content hash covers shared content and all included variants. A regression
work order also pins the selected platform variant hash. Adding or changing one
variant therefore produces a new case revision without rewriting history.

Cases do not need variants for every configured platform. Missing variants are
allowed in storage but become explicit coverage gaps when that platform is
selected for grouped regression.

## Evidence and reports

Every evidence record stores its run platform and source controller. The
source controller must match both the work order and the completed capture
action. Evidence from Chrome DevTools MCP, Pepper, and Appium cannot be
relabeled across platforms.

Per-run JSON and Markdown reports include the actual platform, controller
provenance, pinned variant hash where applicable, evidence integrity, timeline,
criteria, and verdict. Existing local recording and Project Skill recording
policies continue to apply to every generated report.

## RunGroup and platform selection

The user selects the execution platforms for every invocation. Configuration
never implies “run all.”

- One selected platform may use direct `run start`.
- One or more selected platforms may use `run-group start`.
- Every selected platform must be configured in the project.
- Each explicit case or resolved active case is crossed with the selected
  platforms.

`run-group start` freezes an immutable manifest before child execution. The
manifest contains selection mode, case revisions and content hashes, selected
platforms, available member variants and hashes, allocated child run IDs,
exclusions, and the maximum frozen budget.

When a selected case lacks a selected platform variant, the manifest records
an explicit coverage gap. It is not silently omitted and is non-success by
default. Every included member is a normal independent regression run. Child
runs never mutate the group manifest.

`run-group finish` requires every included member to be terminal, validates
their identities and pinned hashes, and records group completion. The group
has execution status but no collapsed QA verdict.

The aggregate JSON and Markdown report renders the complete case-by-platform
matrix. Cells retain `pass`, `fail`, typed `blocked`, `not_verified`, or
coverage-gap status. CI succeeds by default only when every included member
passes and no coverage gap exists. Product failures can never be configured as
successful exits.

## Global Skill

The bundled Skill becomes platform-neutral at its entry point and routes to
platform-specific work protocols. It:

- configures every user-selected deployed platform;
- reads the initialized platform list before offering execution choices;
- asks which configured platform subset to run for the current request;
- invokes only the matching controller;
- applies the shared two-phase action and evidence protocol;
- promotes exploratory material into the correct platform variant;
- uses RunGroup for multi-platform or multi-case regression;
- never automatically runs all configured platforms;
- never claims real-device support.

Platform references document only controller-specific observation, target,
screenshot, stale-session, and recovery details. Shared lifecycle rules remain
canonical and are not copied into three divergent protocols.

## Errors

Stable typed errors cover:

- unsupported or unconfigured platform;
- target/tool platform-set mismatch;
- invalid controller for platform;
- missing required simulator, emulator, app, package, activity, endpoint, or
  capability;
- readiness platform mismatch;
- action or evidence controller mismatch;
- missing requested case variant;
- incompatible acceptance criteria while adding a variant;
- run-group coverage gap, non-terminal member, member identity mismatch, or
  aggregate integrity failure.

## Testing and acceptance

### Unit and integration

- Registry and schemas accept every non-empty platform subset and reject
  mismatched target/tool keys.
- Each doctor maps ready, missing, and unknown observations correctly.
- Work orders, events, evidence, cases, hashes, reports, and controller checks
  support all formal platforms.
- Adding a platform variant preserves existing variants and produces a new
  immutable revision.
- Regression pins and validates the selected variant hash.
- RunGroup freezes selection, records coverage gaps, isolates child runs, and
  produces a faithful aggregate matrix.
- Single-platform behavior uses the same core invariants as grouped members.

### Live vertical slices

Each formal platform completes:

```text
init/configure
-> doctor
-> exploratory QA
-> raw screenshot evidence
-> draft and activate platform variant
-> regression replay
-> evidence-backed verdict
-> configured JSON and Markdown report
```

Live controller provenance must be:

```text
Web              Chrome DevTools MCP
iOS Simulator    Pepper
Android Emulator Appium + UiAutomator2
```

Acceptance also includes one two-platform and one three-platform RunGroup,
with verified aggregate reports and a fixture that proves a missing selected
variant appears as a coverage gap.

## Documentation

README, help text, examples, validation runbooks, and the bundled Skill will no
longer describe AI QA as Web-only. The original Increment 1 Web plan remains a
historical record of the delivered slice. Current documentation points to this
design for supported platforms and execution behavior.

## Acceptance criteria

- First-use setup can configure any non-empty subset of the three formal
  platforms and explicitly collects settings for every selection.
- Doctor and the full exploratory-to-report workflow operate on Web, iOS
  Simulator, and Android Emulator with correct controller provenance.
- A logical case can gain independently reviewed platform variants across
  immutable revisions.
- Users can run one, two, or all configured platforms without AI QA forcing
  additional platforms.
- Missing requested variants are visible coverage gaps.
- Multi-platform members remain isolated and aggregate reports preserve the
  complete case-by-platform result matrix.
- Real devices remain rejected as unsupported formal platforms.
