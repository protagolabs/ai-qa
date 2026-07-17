# ai-qa

`ai-qa` is an agent-orchestrated QA CLI and Agent Skill for Web, iOS Simulator, and Android Emulator. The host invokes controllers; the CLI never does. The CLI owns schema-3 configuration, immutable platform work orders, typed journals, evidence integrity, case variants, verdict validation, RunGroups, aggregate matrices, reports, and neutral recording receipts.

Real iOS and Android devices are unsupported. Mobile targets are Simulator/Emulator only.

## Develop and install

Requirements: Node.js 22 or 24 and pnpm 11.9.0.

```bash
corepack enable
pnpm install
pnpm check
pnpm build
```

Install the bundled global Skill explicitly:

```bash
AI_QA_AGENTS_HOME="$AGENTS_HOME" ai-qa skill install --global
AI_QA_AGENTS_HOME="$AGENTS_HOME" ai-qa skill check --global
```

The current Skill is version `2.0.0` and accepts work protocol `^2.0.0`. A confirmed sync installs exactly four managed references: the shared protocol plus Web, iOS Simulator, and Android Emulator controller guides. User content outside managed markers is preserved.

## State and authority

Each target project owns `.ai-qa/config.yaml`, cases, runs, RunGroups, evidence, run reports, and group reports. Codex resolves the exact project and uses only host-granted access. Secret references are environment-variable names, never credential values.

The host owns Chrome DevTools MCP, Pepper, Appium/UiAutomator2, authentication, controller sessions, and screenshots. `ai-qa action plan` and `action complete` record those calls but do not make them.

## Configure a project

Run doctor first. A missing config returns the blocking `configure-project` action. Suspend QA until setup is approved and a post-write doctor is ready.

Setup must:

1. Ask for a non-empty deployed platform selection.
2. Collect every selected platform target/tool configuration.
3. Ask explicitly for `recordingPolicy.mode`; neither mode is a default.
4. Draft schema 3 config and a project-owned Project Skill in scratch space.
5. Validate config with `ai-qa config validate --stdin-json` and validate the Skill with `skill-creator`.
6. Display both complete diffs, obtain one confirmation, write once, and doctor every configured platform.

`targets` and `tools` must contain the same non-empty platform keys. These fragments show each platform's required schema-3 fields; combine any non-empty subset with the shared policies below.

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

Complete config also includes `project`, `environments`, `evidencePolicy`, `reportPolicy`, `recordingPolicy`, `storagePolicy`, `gitPolicy`, `ciPolicy`, and `secretReferences`. Run `config validate`; do not infer extra keys.

## Doctor and single-platform runs

Supply host-recorded observations to the platform doctor:

```bash
ai-qa doctor --platform web --json --stdin-json
ai-qa doctor --platform ios-simulator --json --stdin-json
ai-qa doctor --platform android-emulator --json --stdin-json
```

Before execution, ask the user which configured platform subset to run. A project may configure three platforms and run only one or two. Configuration never selects execution platforms. For one platform:

```bash
ai-qa run start --kind exploratory --platform ios-simulator --execution local --stdin-json
ai-qa run start --kind regression --case login --platform ios-simulator --execution local --stdin-json
```

Before every controller interaction, observation, and screenshot, record `action plan`; record the terminal result with `action complete`. A satisfied assertion must cite a fresh same-step post-action observation and registered evidence from the configured controller. Set an evidence-linked verdict and finish the run.

Promote a complete reviewed exploratory run incrementally:

```bash
ai-qa case draft --from-run <run-id> --stdin-json
ai-qa case validate login --revision <revision>
ai-qa case activate login --revision <revision> --stdin-json
```

Each draft adds or replaces only the source platform's immutable variant while retaining the other variants.

For exploratory QA on two or three selected platforms, start one explicit exploratory run per selected platform with the confirmed goal and acceptance criteria. Complete, report, and review those platform-owned runs independently; RunGroups do not start exploratory work.

## Explicit multi-platform regression RunGroups

Use a RunGroup only for regression cases. List the exact requested platform subset and select explicit cases or `--all-active`.

```bash
# Two selected platforms
ai-qa run-group start --case login \
  --platform ios-simulator android-emulator \
  --execution local --stdin-json

# Three selected platforms
ai-qa run-group start --all-active \
  --platform web ios-simulator android-emulator \
  --execution ci --stdin-json

ai-qa run-group finish <group-id>
```

The manifest freezes case revisions, platform variants, selection, and budgets. A missing selected variant is a `coverage_gap`, not a child run. Aggregate reports preserve every case/platform cell and never synthesize a QA verdict.

## Reports and recording

Generate and verify run reports:

```bash
ai-qa report generate <run-id>
ai-qa report export <run-id> --adapter project-local
ai-qa report recording-status <run-id>
```

Generate and verify aggregate output:

```bash
ai-qa report group-generate <group-id>
ai-qa report group-export <group-id> --adapter project-local
ai-qa report group-recording-status <group-id>
```

For `local-only`, show verified local paths and stop. For `project-skill`, the host executes the exact frozen Project Skill procedure only after report verification, then submits a neutral `recorded`, `not_recorded`, or `unknown` receipt with opaque references:

```bash
printf '%s\n' '{"status":"recorded","references":["docs/qa.md#run"]}' \
  | ai-qa report receipt <run-id> --stdin-json

printf '%s\n' '{"status":"recorded","references":["docs/qa.md#group"]}' \
  | ai-qa report group-receipt <group-id> --stdin-json
```

Never retry an external recording operation reported as `unknown`. Recording does not change run verdicts or aggregate matrix cells.

## Live acceptance

- [Web](docs/validation/web-live-acceptance.md)
- [iOS Simulator](docs/validation/ios-simulator-live-acceptance.md)
- [Android Emulator](docs/validation/android-emulator-live-acceptance.md)
- [Multi-platform](docs/validation/multi-platform-live-acceptance.md)
