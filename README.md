# ai-qa

`ai-qa` is an agent-orchestrated QA CLI and Agent Skill. It is not a runtime,
daemon, or background service: the host invokes the CLI on demand and each
command exits. The agent controls the Web target through Chrome DevTools MCP;
the Node.js CLI owns the trusted configuration, immutable work orders, typed
event protocol, evidence files and hashes, regression cases, verdict
validation, and project-local reports.

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

When a work order snapshots `recordingPolicy.mode: project-skill`, the same
per-run report directory can also contain the canonical neutral receipt journal
`recording.jsonl` and its deterministic view `recording.json`. These files do
not change the run, verdict, or generated report bytes.

Repository trust is machine-level state under `$AI_QA_HOME/trust.json` (default `~/.ai-qa/trust.json`). It never belongs inside the target project, and a repository's config cannot declare itself trusted. Secret references contain environment-variable names, not credential values.

## Initialize a target project

Initialization is a host-managed project change. Follow this exact two-doctor
workflow:

```text
Codex resolves the target and manages repository trust/permissions
Codex runs doctor
Doctor returns configure-project for an uninitialized target
Codex suspends the requested QA work
Codex derives safe values and asks only for unresolved decisions
Codex drafts config and uses skill-creator in scratch space
Codex validates both drafts
Codex displays complete diffs and obtains one confirmation
Codex writes .ai-qa/config.yaml and .agents/skills/ai-qa-project/SKILL.md
Codex runs doctor again and resumes QA only when status is ready
```

Every successful `doctor --json` response includes `requiredAction`. A missing
`.ai-qa/config.yaml` returns the blocking action
`{"kind":"configure-project","blocking":true,"reason":"project-config-missing"}`;
ready and repair (`not_ready`) responses return `null`. Older CLIs that return
only `status: "uninitialized"` trigger the same first-use flow.

The configuration conversation does not ask the user to select a project root
or repository-trust value. Codex owns those prerequisites. AI QA setup derives
unambiguous project facts, applies documented safe defaults only when the
project and user are silent, and asks only for unresolved or conflicting
values. Cancelling setup leaves the project uninitialized and the original QA
request suspended.

Draft the complete schema-v2 config and the complete Project Skill separately
in scratch space. Validate the config without writing project files:

```bash
ai-qa config validate --stdin-json < config-draft.json
```

Use `skill-creator` to create and validate the Skill draft. The target Skill is
an ordinary, complete, project-owned Skill; it has no AI-QA managed/user
regions or embedded AI-QA checksum. Display the complete config and Skill diffs
and obtain one confirmation covering both files. Only then may Codex create the
canonical `.ai-qa/` directories and write the two approved files. There is no
combined initialization JSON, manual checksum, `ai-qa init`, or CLI-owned
Project Skill generate/sync step.

If the project has no existing result-management procedure, use
`recordingPolicy.mode: local-only` and do not invent a provider. If it has one,
use `project-skill` and put that exact arbitrary procedure, including match and
rerun rules, in the Project Skill. Git tracking and commits are optional;
GitHub and a Git remote are not assumed or required. Codex/host manages
filesystem and tool permissions, executes approved authentication procedures,
and invokes the final doctor. Unresolved target-project authentication and
test-data requirements are confirmed during setup.

## Finish reporting and project recording

Recording mode is frozen in each immutable work order. Changing the current
config affects only new runs: a historical `local-only` run remains
`not_applicable`, and a historical `project-skill` run remains receipt-eligible.

For a local-only run, generate and verify the configured local reports, confirm
the neutral status, and end:

```bash
ai-qa --project /absolute/target report generate <run-id>
ai-qa --project /absolute/target report recording-status <run-id>
# {"runId":"<run-id>","status":"not_applicable","references":[]}
```

For a project-skill run, `recording-status` becomes `pending` only after a
terminal run has an existing verified report. Before report generation it
returns `report.not_generated`; report or evidence drift returns the applicable
integrity error instead of `pending`. After the host performs the exact Project
Skill procedure, register only its neutral outcome and opaque references:

```bash
ai-qa --project /absolute/target report generate <run-id>
ai-qa --project /absolute/target report recording-status <run-id>
# {"runId":"<run-id>","status":"pending","references":[]}

printf '%s\n' \
  '{"status":"recorded","references":["docs/qa-results.md#run-id"]}' \
  | ai-qa --project /absolute/target report receipt <run-id> --stdin-json

ai-qa --project /absolute/target report recording-status <run-id>
```

Use `not_recorded` with no references when the host confirms no record was
made. Use `unknown` when the host cannot determine the outcome, and do not
retry an uncertain external operation. `ai-qa` stores no provider payload and
never changes the QA verdict based on a recording receipt.

Receipt idempotency is derived internally from the run and frozen recording
context. Do not construct or submit an idempotency key. If the Project Skill
changes after a project-skill run starts, status and receipt operations stop
with `project_skill.changed`; the verified report and QA verdict remain intact.
Start a new run to snapshot the updated Skill.

`report export <run-id> --adapter project-local` verifies and returns only the
configured `report.json` and `report.md` paths. It deliberately excludes
`recording.jsonl` and `recording.json`; query the latest recording state through
`report recording-status`.

## Typed workflow

The agent runs doctor first, derives unambiguous project facts and documented safe defaults, and asks only about unresolved or conflicting configuration values. Only a complete, user-confirmed configuration is submitted.

1. Install/check the global product Skill explicitly with `ai-qa skill install --global` and `ai-qa skill check --global`.
2. Confirm machine trust with `ai-qa trust confirm --project <target> --stdin-json`.
3. Follow the host-managed two-doctor initialization workflow above. Treat the first doctor's `configure-project` action, or legacy bare `uninitialized` status, as mandatory; use `config validate` and `skill-creator`, write only after one confirmation, and resume the requested QA work only after the final doctor reports `ready`.
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
