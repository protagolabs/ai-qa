# ai-qa

`ai-qa` is an agent-orchestrated QA CLI and Agent Skill. The agent controls the Web target through Chrome DevTools MCP; the Node.js CLI owns the trusted configuration, immutable work orders, typed event protocol, evidence files and hashes, regression cases, verdict validation, and project-local reports.

The split is intentional: the agent decides what to observe and do, while the CLI is the authority for persisted state and whether the available evidence supports a verdict.

## Increment 1 scope

Increment 1 provides one complete local Web workflow: global skill installation, machine trust, target-project setup, Web readiness, exploratory QA, two-phase browser calls, screenshot evidence, reviewed case promotion, pinned regression replay, and JSON/Markdown reports.

RunGroup and suite aggregation, Codex/Claude CI runner templates, external storage adapters, iOS/Pepper, Android/Appium, real-device workflows, and public npm publication are Increment 2 or later work.

## Develop

Requirements: Node.js 22 or 24 and pnpm 11.9.0.

```bash
corepack enable
pnpm install
pnpm check
pnpm build
```

Start the deterministic local fixture with a runtime-only password:

```bash
AI_QA_FIXTURE_PASSWORD=correct-horse pnpm fixture:web
```

`correct-horse` is a published, non-production value used only by this deterministic fixture. Treat real target credentials as secrets: preload them through the operator's secret manager and never persist their values in project state or reports.

## Pack and install in isolation

Public publication is not part of Increment 1. Build and verify the npm package locally:

```bash
PACK_DIR="$(mktemp -d)"
PREFIX="$(mktemp -d)"
AGENTS_HOME="$(mktemp -d)"
pnpm pack --pack-destination "$PACK_DIR"
npm install --global --prefix "$PREFIX" "$PACK_DIR/ai-qa-0.0.0.tgz"
AI_QA_AGENTS_HOME="$AGENTS_HOME" "$PREFIX/bin/ai-qa" skill install --global
AI_QA_AGENTS_HOME="$AGENTS_HOME" "$PREFIX/bin/ai-qa" skill check --global
"$PREFIX/bin/ai-qa" --help
```

npm installation never edits agent instructions. `skill install --global` is a separate, explicit operation that previews managed changes and installs the canonical skill under `$AI_QA_AGENTS_HOME/skills/ai-qa/` (default `~/.agents/skills/ai-qa/`). CLI-managed regions and reference assets may be updated by `skill sync`; user-authored content outside the managed markers is preserved. Replacing locally changed managed content requires explicit confirmation.

## State and trust boundary

Each target project owns its QA records under `<target>/.ai-qa/`:

- confirmed `config.yaml`;
- immutable run work orders and append-only typed journals;
- per-run evidence indexes and raw files;
- immutable case revisions and activation provenance;
- generated reports under `reports/runs/<run-id>/`.

Repository trust is machine-level state under `$AI_QA_HOME/trust.json` (default `~/.ai-qa/trust.json`). It never belongs inside the target project, and a repository's config cannot declare itself trusted. Secret references contain environment-variable names, not credential values.

## Typed workflow

The user and agent first discuss the target, acceptance criteria, evidence policy, report formats, storage, and secret references. Only the complete user-confirmed configuration is submitted.

1. Install/check the managed skill with `ai-qa skill install --global` and `ai-qa skill check --global`.
2. Confirm machine trust with `ai-qa trust confirm --project <target> --stdin-json`.
3. Initialize the target with `ai-qa init --project <target> --stdin-json`.
4. Use Chrome DevTools MCP read-only checks and submit their result to `ai-qa doctor --platform web --json --stdin-json`.
5. Start exploratory QA with `ai-qa run start --kind exploratory --platform web --execution local --stdin-json`.
6. Before every browser call, record `ai-qa action plan`. After the call, record `ai-qa action complete`; then use the typed `observation`, `evidence`, `assertion`, `decision`, `recovery`, or `blocker` commands as appropriate.
7. Register screenshot bytes with `ai-qa evidence add`, including their completed capture action, observation IDs, criterion IDs, and evidence kinds.
8. Set or explicitly revise the evidence-linked verdict with `ai-qa verdict set`/`verdict revise`, then validate the terminal state with `ai-qa run finish`.
9. Promote a completed exploratory run through `ai-qa case draft`, `case validate`, and explicit `case activate` review confirmation.
10. Start `--kind regression --case <case-id>` and replay every pinned step exactly and in order. Each run pins the active revision plus case and platform-variant hashes.
11. Generate and verify project-local output with `ai-qa report generate <run-id>` and `report export <run-id> --adapter project-local`.

There is no public generic event-append command. A successful MCP response alone is never a QA pass: every pass must satisfy all acceptance criteria and cite valid observations, assertions, and required evidence.

The exact live release-gate procedure is in [docs/validation/web-live-acceptance.md](docs/validation/web-live-acceptance.md).
