# Web Live Acceptance

This is the release-gate procedure for Increment 1. It is not satisfied by the automated modeled-MCP tests: every browser operation below must use the actual Chrome DevTools MCP controller.

## Current manual status

- Status: **passed**.
- Execution date: `2026-07-14`.
- Tested CLI commit: `bf16b87978d7391cddc1066270c52f4ec7b6879d`.
- Packed tarball: `ai-qa-0.0.0.tgz`.
- Chrome version: `150.0.7871.115`.
- Chrome DevTools MCP version: `1.5.0`.
- MCP launch policy: global Codex stdio server using `chrome-devtools-mcp@latest`, an isolated temporary Chrome profile, and disabled usage-statistics and CrUX reporting.
- Installed packaged skill: `/private/tmp/ai-qa-machine.0jP1NE/agents/skills/ai-qa/SKILL.md`; `skill check --global` returned `compatible`.
- Exploratory run: `run-d6ebd74a-f8e1-4220-8bf0-76c666c62713` — `pass`.
- Active case: `login-success` revision `1`.
- Case content hash: `sha256:7eefcae26548ec7e0554d58a8e26978bfad155d669260ab106d8908d25253f83`.
- Web variant hash: `sha256:36212ce368dbb1176779263256b26e14106816b45490bba6f40c7441331ac7c8`.
- Consecutive regression runs:
  - `run-fb26677f-05f7-42e0-a7a0-af966255dc86` — `pass`.
  - `run-dffdb39c-ab6a-42aa-a9cc-316575e2ce5d` — `pass`.
- Reports and verified project-local exports:
  - `.ai-qa/reports/runs/run-d6ebd74a-f8e1-4220-8bf0-76c666c62713/report.json` and `.ai-qa/reports/runs/run-d6ebd74a-f8e1-4220-8bf0-76c666c62713/report.md`.
  - `.ai-qa/reports/runs/run-fb26677f-05f7-42e0-a7a0-af966255dc86/report.json` and `.ai-qa/reports/runs/run-fb26677f-05f7-42e0-a7a0-af966255dc86/report.md`.
  - `.ai-qa/reports/runs/run-dffdb39c-ab6a-42aa-a9cc-316575e2ce5d/report.json` and `.ai-qa/reports/runs/run-dffdb39c-ab6a-42aa-a9cc-316575e2ce5d/report.md`.

### Verified live proof

- The exploratory run and both regression runs completed with evidence-backed `pass` verdicts for `authenticated-home-visible` and `current-account-visible`.
- The two regression work orders pin the same active revision, case content hash, and Web variant hash shown above.
- All planned and terminal browser actions use `chrome-devtools-mcp`; all three evidence records use `sourceTool: chrome-devtools-mcp`.
- Raw screenshot evidence:
  - `evidence-fd837d33-a283-40fc-bef3-6a1531c253e7` at `.ai-qa/evidence/run-d6ebd74a-f8e1-4220-8bf0-76c666c62713/files/evidence-fd837d33-a283-40fc-bef3-6a1531c253e7-ai-qa-live-exp.png`.
  - `evidence-fa2fd1fd-73fc-4179-a06c-a32ead6e90c9` at `.ai-qa/evidence/run-fb26677f-05f7-42e0-a7a0-af966255dc86/files/evidence-fa2fd1fd-73fc-4179-a06c-a32ead6e90c9-ai-qa-live-reg1.png`.
  - `evidence-ebd3511a-5d89-4a8a-ab00-7a978e0bd845` at `.ai-qa/evidence/run-dffdb39c-ab6a-42aa-a9cc-316575e2ce5d/files/evidence-ebd3511a-5d89-4a8a-ab00-7a978e0bd845-ai-qa-live-reg2.png`.
- Every screenshot reverified as `sha256:fe6b5805ff9ade7a3bb96a5478ad3da8d2f301f4039decc36d8c4f5ddb664fd8`; the identical hash is expected because the fixture rendered identical deterministic authenticated state.
- Each run has exact one-to-one evidence-index/event parity, and every Markdown report contains its JSON report's exact `integrity.verifiedAt` timestamp.
- Visual inspection confirmed that the screenshot shows `Authenticated home` and `Current account: qa@example.test` without the password.
- The fixture password value is absent from project state and reports. AI QA creates or reads no repository authorization file; the only fixture `.ai-qa` directory is `fixtures/web-app/.ai-qa/`.

## Host-managed Project Skill acceptance addendum

The live proof above records the Increment 1 browser run at its stated commit.
It does not prove the later host-owned initialization and recording lifecycle.
That extension is released only when this reproducible gate passes from the
repository root:

```bash
pnpm vitest run \
  tests/unit/config-migration.test.ts \
  tests/unit/recording-schema.test.ts \
  tests/integration/doctor-cli.test.ts \
  tests/integration/global-skill.test.ts \
  tests/integration/run-journal.test.ts \
  tests/integration/report-generation.test.ts \
  tests/integration/recording-receipt.test.ts \
  tests/e2e/project-recording-flow.test.ts \
  tests/e2e/cli-web-vertical-slice.test.ts
```

Acceptance checklist and test evidence:

- [ ] Config v1 read-without-rewrite: `config-migration.test.ts` hashes the
      original bytes before and after normalization; `cli-web-vertical-slice.test.ts`
      also runs a legacy project without rewriting its config or creating recording
      artifacts.
- [ ] Host-managed initialization: the E2Es use `config validate` as a
      read-only draft check, then the host fixture creates the config, all four
      canonical directories, and an ordinary project-owned Project Skill. No init
      command, combined initialization JSON, managed marker, or manual checksum is
      used.
- [ ] Local-only completion: `project-recording-flow.test.ts` generates a
      verified report, returns `not_applicable`, and confirms that neither
      recording file exists.
- [ ] Arbitrary local Markdown procedure: the project-skill E2E installs and
      reads and follows the exact `docs/qa-results.md` procedure from the normal
      Skill, performs the host-side update, then registers only neutral status and
      opaque references. No built-in provider is needed.
- [ ] Receipt idempotency: the E2E submits no caller key. Production derives the
      run key internally, replays the same payload without another journal write,
      and rejects a conflicting payload as `recording.idempotency_conflict`.
- [ ] Crash recovery: the same integration file removes `recording.json` to
      simulate a crash after canonical journal publication, then separately makes
      the view lag by one event. Status/retry deterministically rebuilds the view
      from unchanged `recording.jsonl` in both cases.
- [ ] Frozen bidirectional mode switches: the E2E changes current config from
      `local-only` to `project-skill` and back. Historical work-order snapshots keep
      their original status and receipt eligibility.
- [ ] Project Skill drift: after report generation, editing the Skill makes both
      receipt and status stop with `project_skill.changed` without recording files
      or QA artifact mutation. A new run snapshots the edited Skill hash.
- [ ] Verified-report boundary: before report generation, recording status and
      receipt return `report.not_generated`; after a terminal verified report, an
      empty project-skill repository returns `pending`. Report/evidence drift stays
      an integrity error instead of becoming pending.
- [ ] Immutable QA artifacts: receipt integration and the project-skill E2E
      compare report JSON, report Markdown, run journal, and verdict before and
      after initial receipt and replay.
- [ ] Doctor boundaries: doctor reports installation and availability only. It
      never installs, authenticates, grants permission, creates project files, or
      mutates the project; a stored config-v1 project without a Skill receives a
      migration advisory.
- [ ] Packaged global Skill metadata: after `pnpm build`, verify the copied
      artifact directly:

  ```bash
  rg -n "aiQaSkillVersion: 1.4.0|aiQaProtocolRange: \^1.2.0|aiQaRecordingReceipt: true" \
    dist/skills/global/SKILL.md
  ```

For a current manual replay, follow the exact two-doctor workflow in the
README: Codex drafts config and uses `skill-creator` in scratch space, validates
both drafts, shows both complete diffs, obtains one confirmation, writes the
config and project-owned Skill, and runs doctor again. `ai-qa` is not a runtime;
doctor never installs. Git and GitHub are optional. The schema-v1 fixture below
is retained as immutable input from the dated historical proof, not current
initialization input.

## Target

- Project root: `fixtures/web-app`
- Entry URL: `http://127.0.0.1:4173/login`
- Readiness URL: `http://127.0.0.1:4173/health`
- Controller: Chrome DevTools MCP
- Account: `qa@example.test`
- Password source: the fixture's published, non-production value is `correct-horse`; preload it as `AI_QA_WEB_FIXTURE_PASSWORD` and pass it only in the fixture process environment. Do not put even fixture credentials in `.ai-qa/`, command JSON, screenshots, or reports. For real targets, use the operator's secret manager and do not enter secret values in shell history.

Start the fixture with the runtime reference without persisting the value:

```bash
AI_QA_FIXTURE_PASSWORD="$AI_QA_WEB_FIXTURE_PASSWORD" pnpm fixture:web
```

## Acceptance criteria

1. `authenticated-home-visible`: `[data-testid="authenticated-home"]` is visible after login. Required evidence: `post-action-screenshot`.
2. `current-account-visible`: `[data-testid="current-account"]` contains `qa@example.test`. Required evidence: `structured-text-assertion` and `post-action-screenshot`.

## Historical fixture config (evidence only)

The bare schema-v1 object below is preserved only as the exact historical input
used for the live proof at commit `bf16b87978d7391cddc1066270c52f4ec7b6879d`.
It is not a schema-v2 config draft and is not valid input for the current
read-only `ai-qa config validate --stdin-json` command. There is no current
`ai-qa init` command or combined initialization request. Do not submit or adapt
this block as a current initialization draft.

```json
{
  "schemaVersion": 1,
  "project": { "id": "ai-qa-web-fixture", "name": "AI QA Web Fixture" },
  "targets": {
    "web": {
      "entryUrl": "http://127.0.0.1:4173/login",
      "readinessUrl": "http://127.0.0.1:4173/health"
    }
  },
  "environments": {},
  "tools": { "web": { "controller": "chrome-devtools-mcp" } },
  "evidencePolicy": {
    "screenshots": "required",
    "defaultSensitivity": "internal",
    "retentionDays": 30
  },
  "reportPolicy": {
    "formats": ["markdown", "json"],
    "audience": "engineering",
    "detail": "full"
  },
  "storagePolicy": { "adapter": "project-local" },
  "gitPolicy": { "config": "ignore", "artifacts": "ignore" },
  "ciPolicy": { "nonPassExit": "failure" },
  "secretReferences": { "loginPassword": "AI_QA_WEB_FIXTURE_PASSWORD" }
}
```

## Isolated package and skill setup

Use a locally packed CLI. Do not use a source-tree entry point or a previously installed global copy.

```bash
PACK_DIR="$(mktemp -d)"
PREFIX="$(mktemp -d)"
MACHINE_HOME="$(mktemp -d)"
AGENTS_HOME="$MACHINE_HOME/agents"
pnpm pack --pack-destination "$PACK_DIR"
npm install --global --prefix "$PREFIX" "$PACK_DIR/ai-qa-0.0.0.tgz"
AI_QA_AGENTS_HOME="$AGENTS_HOME" "$PREFIX/bin/ai-qa" skill install --global
AI_QA_AGENTS_HOME="$AGENTS_HOME" "$PREFIX/bin/ai-qa" skill check --global
```

The explicit skill command must create `$AGENTS_HOME/skills/ai-qa/SKILL.md`. npm installation alone must not edit the agents home.

## Current replay ordered execution

1. Start the fixture and confirm `/health` returns `ok`. Keep its terminal open for the complete run.
2. Use the isolated CLI with `AI_QA_AGENTS_HOME` set to the path above and host-granted access to `fixtures/web-app`. Then follow [Initialize a target project](../../README.md#initialize-a-target-project): run doctor, discuss requirements, explicitly choose `recordingPolicy.mode: local-only` as the user decision, draft the schema-v2 config and ordinary fixture Project Skill in scratch space with `skill-creator`, validate them separately, display both complete diffs, obtain one confirmation, write both files through the host, and run doctor again. Neither recording mode is a default. Never pass the historical bare schema-v1 block above to the current CLI.
3. Activate the installed `ai-qa` skill. Use Chrome DevTools MCP to open the entry URL, confirm that the login fixture is rendered, and supply that observation to `doctor --platform web --json --stdin-json`.
4. Start one exploratory run with the two stable criterion IDs above.
5. For every Chrome DevTools MCP call—including navigation, DOM observation, form interaction, and screenshot capture—first record `action plan` with `tool: "chrome-devtools-mcp"`, invoke MCP, then record `action complete`. Retain the login interaction's returned `payload.stepId`; use it for the fresh authenticated observation action, the later evidence-capture action, and the satisfied assertions. The interaction terminal result must precede the fresh observation, and the fresh observation must precede screenshot capture.
6. Supply the password to the browser from the runtime environment without echoing or recording it. Submit the account and password through Chrome DevTools MCP.
7. Capture a real post-action screenshot through Chrome DevTools MCP. Register its raw bytes with `sourceTool: "chrome-devtools-mcp"`, the completed `evidence-capture` action ID, both criterion IDs, the authenticated observation ID, and evidence kind `post-action-screenshot`. `evidence add` has no `--step` option; the completed capture action and cited observation must already carry the interaction step ID.
8. Record satisfied assertions that cite the relevant observation and evidence IDs. Set an evidence-supported `pass`, then finish the exploratory run.
9. Draft `login-success` from the exploratory run. Review every promoted interaction, validate the draft, and explicitly activate revision 1.
10. Start a new regression run and execute every pinned Web step exactly, in order. Record two-phase MCP calls, fresh observations, real screenshot evidence, assertions, and an evidence-supported `pass`; finish it.
11. Repeat step 10 with a second fresh run ID. The two regression passes must be consecutive and must pin the same active revision, case content hash, and Web variant hash.
12. Generate JSON and Markdown reports for the exploratory run and both regression runs. For each run, execute `ai-qa report export <run-id> --adapter project-local` and confirm the exported paths match the generated paths and the Markdown contains the JSON report's exact `integrity.verifiedAt` timestamp.
13. Inspect the project tree and the isolated machine home. Prove that no `$AI_QA_HOME/trust.json` is created or read; every target record must exist only under `fixtures/web-app/.ai-qa/`.

## Required proof

- One exploratory run ID and two unique, consecutive regression run IDs, all terminal `pass`.
- Active case `login-success` revision 1, plus the identical pinned case content hash and Web variant hash from both regression work orders.
- Raw screenshot evidence IDs, project-local paths, and verified SHA-256 content hashes for all three runs.
- Each verdict's criterion results and their cited assertion IDs and evidence IDs; each assertion's cited observation and evidence IDs; each evidence record's cited capture action and authenticated observation IDs.
- Every planned/terminal action tool and every evidence `sourceTool` is exactly `chrome-devtools-mcp`; evidence-index IDs are unique and have exact one-to-one canonical parity with typed evidence events.
- Three project-local JSON/Markdown pairs under `.ai-qa/reports/runs/<run-id>/`.
- The installed isolated global skill path and compatible check result.
- No AI QA repository authorization state anywhere, no `.ai-qa/` state outside `fixtures/web-app`, and no credential value in project or report files.

If Chrome DevTools MCP, screenshot capture, evidence validation, or any required state becomes unavailable after a run starts, record the typed non-pass result. Cancel only with `ai-qa run cancel <run-id> --reason <reason>`; never submit `not_verified/cancelled` through `verdict set` or `verdict revise`, and never attach criterion results to cancellation. Do not relabel the outcome as pass and do not substitute HTTP, Playwright, mocked events, a generic browser, or another Chrome controller.
