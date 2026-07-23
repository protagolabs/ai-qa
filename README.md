# ai-qa

[English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md)

`ai-qa` is an agent-orchestrated QA CLI and Agent Skill for Web, iOS Simulator, and Android Emulator. Your host Agent operates the browser, Simulator, or Emulator through the configured controller; the CLI records and validates readiness, actions, evidence, assertions, cases, verdicts, RunGroups, and reports.

Real iOS and Android devices are not supported.

## Requirements

- Node.js 22 or 24.
- An Agent host that can use Agent Skills and the controller for each target platform.
- Web: Chrome DevTools MCP.
- iOS Simulator: Pepper.
- Android Emulator: Appium with UiAutomator2.

## Install

Install the public package globally, then install its bundled Agent Skill:

```bash
npm install --global @narra-im/ai-qa
ai-qa --help
ai-qa skill install --global
ai-qa skill check --global
```

The Skill is installed under `~/.agents/skills/ai-qa/` by default. To use a different Agent Skill root, set `AI_QA_AGENTS_HOME` for the Skill commands:

```bash
AI_QA_AGENTS_HOME=/custom/agents/home ai-qa skill install --global
AI_QA_AGENTS_HOME=/custom/agents/home ai-qa skill check --global
```

Package installation never silently overwrites Agent instructions. If managed Skill content was edited locally, review the diff returned by the install or sync command before allowing replacement.

## Quick start

### 1. Check the target project

Run doctor from the exact project you want to test. `--project` is also available when you do not want to change directories.

```bash
cd /path/to/your/project
ai-qa doctor --json
```

On first use, doctor returns a blocking `configure-project` action because the project does not yet have `.ai-qa/config.yaml`.

### 2. Ask your Agent to configure AI QA

With the AI QA Skill installed, ask your Agent to configure the current project. For example:

> Configure AI QA for this project for Web and iOS Simulator. Keep reports local only.

The Agent collects the deployed platform settings and an explicit recording policy. Before writing anything, it validates and shows the complete proposed `.ai-qa/config.yaml` and `.agents/skills/ai-qa-project/SKILL.md`. One confirmation applies both files; cancellation writes neither file.

### 3. Ask your Agent to run QA

Choose a non-empty subset of the configured platforms for each request. For example:

> Run exploratory QA on Web for sign-in. A valid user should reach the dashboard without an error.

Or replay reviewed regression coverage:

> Run the active sign-in regression cases on Web and iOS Simulator.

The Agent invokes the platform controllers. The CLI does not click, type, launch apps, or capture screenshots itself; it records the Agent's planned and completed controller calls and validates the evidence chain.

### 4. Generate a report

The Agent normally generates and verifies the report at the end of a run. You can also regenerate and export it by ID:

```bash
ai-qa report generate <run-id>
ai-qa report export <run-id> --adapter project-local
```

Verified run reports are stored under `.ai-qa/reports/runs/`. RunGroup reports are stored under `.ai-qa/reports/groups/`.

## Usage

Most users should describe the QA goal and acceptance criteria to an Agent with the AI QA Skill installed. The lower-level commands below document the workflow that the host Agent records through the CLI.

### Configure a project

Start with `ai-qa doctor --json`. A missing config is a blocking first-use gate. Setup must:

1. Select a non-empty set of deployed platforms.
2. Collect every selected platform's target and controller configuration.
3. Select `recordingPolicy.mode` explicitly; neither `local-only` nor `project-skill` is a default.
4. Draft and validate schema-3 config and a project-owned Agent Skill.
5. Display the complete proposed content or diff and obtain one confirmation.
6. Write both files once and doctor every configured platform.

`targets` and `tools` must contain identical platform keys. The following are partial schema fragments, not complete project configs:

```yaml
schemaVersion: 3
targets:
  web:
    entryUrl: https://example.test
    readinessUrl: https://example.test/health
tools:
  web:
    controller: chrome-devtools-mcp
```

```yaml
schemaVersion: 3
targets:
  ios-simulator:
    bundleId: com.example.app
    simulator:
      selection: device-name
      deviceName: iPhone 17 Pro
tools:
  ios-simulator:
    controller: pepper
```

```yaml
schemaVersion: 3
targets:
  android-emulator:
    appPackage: com.example.app
    appActivity: .MainActivity
    emulator:
      selection: avd-name
      avdName: Pixel_10_API_36
tools:
  android-emulator:
    controller: appium
    automationName: uiautomator2
    endpoint: http://127.0.0.1:4723
```

A complete config also includes `project`, `environments`, `evidencePolicy`, `reportPolicy`, `recordingPolicy`, `storagePolicy`, `gitPolicy`, `ciPolicy`, and `secretReferences`. Config can name environment variables that contain secrets, but must never contain literal credentials.

### Check platform readiness

The host first uses the platform controller to inspect readiness, then supplies those recorded observations to doctor:

```bash
ai-qa doctor --platform web --json --stdin-json
ai-qa doctor --platform ios-simulator --json --stdin-json
ai-qa doctor --platform android-emulator --json --stdin-json
```

Configuration defines which platforms are available. Each QA request separately selects which configured platform subset to execute.

### Run exploratory QA

Start one platform-owned run for each selected platform:

```bash
ai-qa run start --kind exploratory --platform ios-simulator --execution local --stdin-json
```

Before every controller interaction, observation, and screenshot, record `ai-qa action plan`; afterward, record exactly one terminal result with `ai-qa action complete`. After an interaction, the same step must contain a fresh observation and newly registered evidence from the configured controller before an assertion can be satisfied.

Set an evidence-linked verdict, finish the run, then generate and verify its report. Multi-platform exploratory QA uses independent runs, not a RunGroup.

### Repair an interrupted run

If a crash leaves orphaned evidence or a torn journal tail, run `ai-qa run repair <run-id>`. The command is idempotent; data it relocates is retained under `.ai-qa/recovery/<run-id>/` and reported in its JSON output.

### Promote an exploratory run to a regression case

After reviewing a complete exploratory run, draft and activate its immutable platform variant:

```bash
ai-qa case draft --from-run <run-id> --stdin-json
ai-qa case validate login --revision <revision>
ai-qa case activate login --revision <revision> --stdin-json
```

Drafting adds or replaces only the source run's platform variant and retains variants for other platforms.

### Replay regression cases

Run one active case variant on one configured platform:

```bash
ai-qa run start --kind regression --case login --platform ios-simulator --execution local --stdin-json
```

The Agent follows the pinned variant steps in order and uses the same fresh post-action evidence requirements as exploratory QA.

### Run multi-platform regression with a RunGroup

RunGroups are for regression only. Select explicit cases or all active cases, and list the exact platform subset:

```bash
ai-qa run-group start --case login \
  --platform ios-simulator android-emulator \
  --execution local --stdin-json

ai-qa run-group start --all-active \
  --platform web ios-simulator android-emulator \
  --execution ci --stdin-json

ai-qa run-group finish <group-id>
```

The manifest freezes case revisions, platform variants, selection, and budgets. A missing selected platform variant becomes a `coverage_gap`, not a child run. The aggregate matrix retains every case/platform cell and does not synthesize a QA verdict.

### Generate reports and record results

Generate, export, and inspect recording status for one run:

```bash
ai-qa report generate <run-id>
ai-qa report export <run-id> --adapter project-local
ai-qa report recording-status <run-id>
```

For a RunGroup:

```bash
ai-qa report group-generate <group-id>
ai-qa report group-export <group-id> --adapter project-local
ai-qa report group-recording-status <group-id>
```

With `local-only`, report the verified local paths and stop. With `project-skill`, the host runs the project's frozen recording procedure only after report verification, then submits a neutral receipt with opaque references:

```bash
printf '%s\n' '{"status":"recorded","references":["docs/qa.md#run"]}' \
  | ai-qa report receipt <run-id> --stdin-json

printf '%s\n' '{"status":"recorded","references":["docs/qa.md#group"]}' \
  | ai-qa report group-receipt <group-id> --stdin-json
```

Receipt status is `recorded`, `not_recorded`, or `unknown`. Never retry an external recording operation whose outcome is `unknown`. Recording never changes run verdicts or aggregate matrix cells.

### Errors

CLI failures are written to stderr as a JSON `error` envelope. It always includes `code` and `message`; `retryable` appears only when true, while `details` and `issues` appear when available.

## Project data and authority

Each target project owns its `.ai-qa/config.yaml`, cases, runs, RunGroups, evidence, reports, and recording receipts. The project-owned `.agents/skills/ai-qa-project/SKILL.md` defines an optional existing result-management procedure; it does not grant the CLI controller or external-system access.

The host Agent owns project access, permissions, authentication, controller sessions, and file writes. The CLI validates and records host-supplied events. It never invokes Chrome DevTools MCP, Pepper, Appium, or UiAutomator2.

## Clear project data

Remove project configuration without deleting cases, runs, evidence, or reports:

```bash
ai-qa clear
ai-qa --project /exact/project/path clear
```

This immediately removes `.ai-qa/config.yaml` and the complete `.agents/skills/ai-qa-project/` directory. The command is idempotent and does not prompt for confirmation.

To also delete every project-local AI QA record, including cases, runs, RunGroups, evidence, reports, and recording receipts:

```bash
ai-qa clear --records
```

`--records` immediately removes the complete `.ai-qa/` directory. Other project skills remain untouched.

If clear reports `storage.recovery_required`, inspect and manually resolve the project-relative `recoveryPath` before retrying. Clear never automatically deletes, restores, or resumes a retained recovery entry.

## Development

Requirements for source development: Node.js 22 or 24 and pnpm 11.9.0.

```bash
corepack enable
pnpm install
pnpm check
pnpm build
```

The bundled Skill is version `2.0.0` and accepts work protocol `^2.0.0`. A confirmed sync installs exactly four managed references: the shared protocol plus Web, iOS Simulator, and Android Emulator controller guides. User content outside managed markers is preserved.

## Live acceptance

- [Web](docs/validation/web-live-acceptance.md)
- [iOS Simulator](docs/validation/ios-simulator-live-acceptance.md)
- [Android Emulator](docs/validation/android-emulator-live-acceptance.md)
- [Multi-platform](docs/validation/multi-platform-live-acceptance.md)
