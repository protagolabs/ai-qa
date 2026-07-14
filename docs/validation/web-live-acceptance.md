# Web Live Acceptance

This is the release-gate procedure for Increment 1. It is not satisfied by the automated modeled-MCP tests: every browser operation below must use the actual Chrome DevTools MCP controller.

## Current manual status

- Status: **pending; not executed and not passed**.
- Environment assessment date: `2026-07-14`.
- Assessed repository HEAD: `93e0a43d3372c70d1b994f2abeb6b3d734febdf5` before the uncommitted Task 9 documentation/test update.
- Blocker: this Codex environment exposes other browser/Chrome capabilities, but no callable Chrome DevTools MCP controller. Those capabilities cannot be substituted for, or relabeled as, `chrome-devtools-mcp`.

The live run requires all of these prerequisites before execution:

- A callable Chrome DevTools MCP controller that can navigate, observe DOM state, interact, and return raw screenshot bytes.
- The Chrome and Chrome DevTools MCP versions available for recording.
- A disposable trusted checkout in which the packed CLI and installed packaged skill can create project-local `.ai-qa/` state.
- Runtime access to the fixture password reference without writing the value to shell history, project state, evidence, or reports.

Record these reproducibility fields when the prerequisite is met; none may be inferred from modeled tests or another browser controller:

- Execution date: pending until a real MCP run occurs.
- Tested CLI commit and packed tarball name: pending until a real MCP run occurs.
- Chrome version: pending because the required controller is unavailable.
- Chrome DevTools MCP version: pending because the required controller is unavailable.
- Exploratory run ID: pending.
- Active case ID/revision, case content hash, and Web variant hash: pending.
- Two consecutive regression run IDs: pending.
- Final verdicts: pending; no live verdict has been claimed.
- JSON/Markdown report and verified export paths: pending.

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
