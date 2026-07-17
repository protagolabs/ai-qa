# Web Live Acceptance

This release gate requires the actual `chrome-devtools-mcp` controller. Modeled or recorded controller responses do not satisfy it.

## Preconditions

- Install and check bundled Skill `2.0.0` / protocol `^2.0.0` from the packaged CLI.
- Configure schema 3 with `targets.web` and `tools.web.controller: chrome-devtools-mcp`.
- Keep credentials in host-managed runtime secret sources.
- Run `doctor --platform web --json --stdin-json` with host-observed entry-page and controller readiness; require `ready`.

## Evidence-backed vertical slice

1. Start an exploratory Web run with stable acceptance criteria and required screenshot evidence.
2. Before every navigation, interaction, observation, and screenshot, record `action plan`; after the Chrome DevTools MCP call, record `action complete`.
3. After the interaction, add a fresh same-step observation, capture a real screenshot, and register it with `sourceTool: chrome-devtools-mcp`.
4. Record satisfied assertions citing the criterion, fresh observation, and evidence IDs. Set an evidence-linked `pass` and finish.
5. Generate/export JSON and Markdown reports and verify evidence-index/event parity, hashes, controller provenance, and report integrity.
6. Draft the Web case variant from the exploratory run, review, validate, and activate it.
7. Start a Web regression, replay every pinned step in order with fresh controller evidence, finish `pass`, and generate/export its report.
8. Verify `report recording-status`; for project-skill mode, perform the exact frozen procedure and submit only its neutral receipt.

## Required proof

- Doctor output, exploratory/regression run IDs, active case revision, case and Web variant hashes.
- Planned/terminal action IDs, observation/assertion/evidence IDs, raw screenshot paths and hashes.
- Every action/evidence source is `chrome-devtools-mcp`; no HTTP-only or stale screenshot substitution.
- Verified run report pairs and recording status/receipt.
