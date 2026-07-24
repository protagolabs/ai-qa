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

Run AI QA from the exact project you want to test. Humans normally describe the work to an Agent; the Agent uses the installed Skill, platform controller, and CLI.

First ask the Agent to configure the project:

> Configure AI QA for this project. The deployed platforms are Web and iOS Simulator. Keep reports local. Show me the complete proposed files before writing anything.

After configuration and readiness checks pass, ask for QA:

> On Web, explore sign-in. Start from the sign-in page with a valid test account. A successful sign-in must open the dashboard without an error. Keep the report local and show me the verdict with its evidence.

The Agent handles readiness, controller actions, evidence, verdicts, and report generation.

## How to prompt AI QA

A useful request states:

- **Platform:** which configured Web, iOS Simulator, or Android Emulator targets to run now.
- **Goal:** the user behavior or product result to verify.
- **Preconditions:** starting screen, login state, feature flags, or required data.
- **Acceptance criteria:** observable results that determine success or failure.
- **Test data:** account or data requirements, using secret references instead of literal credentials.
- **Result handling:** keep verified reports local or use an already approved project recording procedure.

You do not need to provide work-order JSON, action IDs, evidence IDs, verdict payloads, or case revisions. Describe the outcome; the Agent manages the protocol.

## Prompt cookbook

### Configure a project

> Configure AI QA for this project. Web is deployed at `https://example.test`, and reports should stay local. Inspect the project, show the complete configuration and project Skill proposal, and wait for my confirmation before writing.

### Explore a feature

> On iOS Simulator, explore password reset. Start from the sign-in screen with a test account that can receive a reset link. The user must be able to request a reset and reach the confirmation state without an error. Capture evidence and return the verified report.

### Reproduce a bug before the fix

> On Web, reproduce BUG-123 before the fix. Start on the sign-in page with a valid test account. Submitting valid credentials should open the dashboard, but the reported behavior stays on the sign-in page. Preserve an evidence-backed fail baseline and show me the report.

### Verify a deployed bug fix

> BUG-123 is fixed and deployed. On Web, start a new run with the same preconditions and acceptance criteria. Verify that valid sign-in opens the dashboard without an error. Keep this result separate from the pre-fix run and show me the new report.

### Create a regression case

> I reviewed the passing BUG-123 result. Prepare it as regression case `bug-123-sign-in`, show me the proposed case, and activate it only after I confirm.

### Replay regression on one platform

> On Web, replay the active `bug-123-sign-in` regression case and return the verified report.

### Replay regression on multiple platforms

> On Web and iOS Simulator, replay all active sign-in regression cases. Report every case/platform result and any coverage gaps.

Bug verification uses separate before-fix and after-fix runs. The failed run remains the reproduction record; only an evidence-valid passing run can be activated as a regression case.

## Agent workflow guide

Agents implementing these requests should read [AI QA Agent Workflow](docs/agent-workflow.md). It maps human requests to project setup, controller work, CLI lifecycles, evidence, cases, RunGroups, reports, recording, repair, and cleanup. The installed AI QA Agent Skill remains the source of truth.

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
