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
- The fixture password value is absent from project state and reports. Trust exists only at `/private/tmp/ai-qa-machine.0jP1NE/ai-qa/trust.json`; the only fixture `.ai-qa` directory is `fixtures/web-app/.ai-qa/`.

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

## Confirmed fixture config

Discuss this complete configuration with the user and obtain explicit confirmation before passing it to `ai-qa init`:

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
AI_QA_HOME="$MACHINE_HOME/ai-qa"
pnpm pack --pack-destination "$PACK_DIR"
npm install --global --prefix "$PREFIX" "$PACK_DIR/ai-qa-0.0.0.tgz"
AI_QA_AGENTS_HOME="$AGENTS_HOME" "$PREFIX/bin/ai-qa" skill install --global
AI_QA_AGENTS_HOME="$AGENTS_HOME" "$PREFIX/bin/ai-qa" skill check --global
```

The explicit skill command must create `$AGENTS_HOME/skills/ai-qa/SKILL.md`. npm installation alone must not edit the agents home.

## Ordered execution

1. Start the fixture and confirm `/health` returns `ok`. Keep its terminal open for the complete run.
2. Use the isolated CLI with `AI_QA_HOME` and `AI_QA_AGENTS_HOME` set to the paths above. Explicitly confirm trust for `fixtures/web-app`, then initialize it with the confirmed config.
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
13. Inspect the project tree and the isolated machine home. Trust must exist only under `$AI_QA_HOME`; every target record must exist only under `fixtures/web-app/.ai-qa/`.

## Required proof

- One exploratory run ID and two unique, consecutive regression run IDs, all terminal `pass`.
- Active case `login-success` revision 1, plus the identical pinned case content hash and Web variant hash from both regression work orders.
- Raw screenshot evidence IDs, project-local paths, and verified SHA-256 content hashes for all three runs.
- Each verdict's criterion results and their cited assertion IDs and evidence IDs; each assertion's cited observation and evidence IDs; each evidence record's cited capture action and authenticated observation IDs.
- Every planned/terminal action tool and every evidence `sourceTool` is exactly `chrome-devtools-mcp`; evidence-index IDs are unique and have exact one-to-one canonical parity with typed evidence events.
- Three project-local JSON/Markdown pairs under `.ai-qa/reports/runs/<run-id>/`.
- The installed isolated global skill path and compatible check result.
- No trust state anywhere under `fixtures/web-app`, no `.ai-qa/` state outside `fixtures/web-app`, and no credential value in project or report files.

If Chrome DevTools MCP, screenshot capture, evidence validation, or any required state becomes unavailable after a run starts, record the typed non-pass result. Cancel only with `ai-qa run cancel <run-id> --reason <reason>`; never submit `not_verified/cancelled` through `verdict set` or `verdict revise`, and never attach criterion results to cancellation. Do not relabel the outcome as pass and do not substitute HTTP, Playwright, mocked events, a generic browser, or another Chrome controller.
