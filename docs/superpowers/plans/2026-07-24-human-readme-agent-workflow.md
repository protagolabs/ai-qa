# Human README and Agent Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three low-level public Usage sections with human-facing prompt cookbooks and add an English Agent workflow guide that indexes the authoritative AI QA protocol.

**Architecture:** Keep the English README as the canonical public structure and mirror it in Traditional and Simplified Chinese. Move host-facing lifecycle and CLI guidance into `docs/agent-workflow.md`, which links to the bundled Skill as the source of truth instead of duplicating payload schemas or controller procedures.

**Tech Stack:** Markdown, Node.js 22/24, Prettier, built `ai-qa` CLI

## Global Constraints

- `README.md`, `README.zh-TW.md`, and `README.zh-CN.md` must retain identical H2/H3 structure, prompt count, code-block count, technical facts, and links.
- Human prompts must identify platform, goal, preconditions, acceptance criteria, test-data requirements, and result handling when those fields matter.
- Human prompts must not require run IDs, event IDs, revisions, or CLI JSON.
- `docs/agent-workflow.md` is an English navigation guide; `src/skills/global/SKILL.md` and its references remain authoritative.
- Do not add or rename CLI commands, modify schemas, alter bundled Skill behavior, or support real devices.
- Do not create a root `AGENTS.md`.

---

### Task 1: Create the Agent workflow guide

**Files:**

- Create: `docs/agent-workflow.md`
- Reference: `src/skills/global/SKILL.md`
- Reference: `src/skills/global/references/shared-work-protocol.md`

**Interfaces:**

- Consumes: The bundled Skill's setup, execution, evidence, case, RunGroup, report, recording, repair, and clear contracts.
- Produces: A stable README link target and Agent-oriented lifecycle/CLI index.

- [ ] **Step 1: Create the guide with the required authority header**

Create `docs/agent-workflow.md` beginning with:

```markdown
# AI QA Agent Workflow

This guide is for an Agent executing QA on behalf of a human. It is a navigation guide, not the protocol source of truth.

Before acting, read and follow the installed `ai-qa` Agent Skill. In this repository, the maintained source is [`src/skills/global/SKILL.md`](../src/skills/global/SKILL.md), with the shared lifecycle contract in [`shared-work-protocol.md`](../src/skills/global/references/shared-work-protocol.md). When this guide and the installed Skill differ, follow the installed Skill.

## Audience and authority

The human supplies the QA goal, acceptance criteria, platform scope, and any project-specific constraints. The host Agent owns project access, permissions, authentication, controller sessions, controller calls, and file writes. The CLI validates and records host-supplied readiness, actions, evidence, assertions, verdicts, cases, RunGroups, reports, and recording receipts; it never invokes a platform controller.

Supported targets are Web, iOS Simulator, and Android Emulator. Real iOS and Android devices are unsupported.
```

- [ ] **Step 2: Add the complete lifecycle navigation**

Add these exact H2 headings, each with the listed high-level sequence and command families:

```markdown
## Sources of truth

- Global workflow: [`src/skills/global/SKILL.md`](../src/skills/global/SKILL.md)
- Shared lifecycle and evidence contract: [`shared-work-protocol.md`](../src/skills/global/references/shared-work-protocol.md)
- Web controller guide: [`web-controller.md`](../src/skills/global/references/web-controller.md)
- iOS Simulator controller guide: [`ios-simulator-controller.md`](../src/skills/global/references/ios-simulator-controller.md)
- Android Emulator controller guide: [`android-emulator-controller.md`](../src/skills/global/references/android-emulator-controller.md)

## First-use project configuration

1. Resolve the exact target-project root and run `ai-qa doctor --json`.
2. If doctor requires configuration, ask the human for a non-empty deployed-platform selection and an explicit recording mode.
3. Collect every required target and controller field for the selected platforms. Never place literal secrets in config.
4. Draft and validate schema-3 `.ai-qa/config.yaml` together with `.agents/skills/ai-qa-project/SKILL.md`.
5. Show the complete proposed content for missing destinations or the complete diff for existing destinations. Obtain one confirmation, then write both files once.
6. Run doctor for every configured platform. Do not begin QA until every requested platform is ready.

Use `ai-qa config --help`, `ai-qa doctor --help`, and the installed Skill for the current input contract.

## Per-request platform selection

Configuration defines available platforms; it does not select the platforms for a QA request. Confirm a non-empty subset of the configured Web, iOS Simulator, and Android Emulator targets for every new request.

Exploratory multi-platform work uses one independent run per platform. Multi-platform regression uses a RunGroup.

## Exploratory QA lifecycle

1. Confirm the goal and observable acceptance criteria.
2. Obtain controller-recorded readiness and start one platform-owned exploratory run with `ai-qa run start --kind exploratory`.
3. Before every controller call, record `ai-qa action plan`; after the call, record exactly one `ai-qa action complete`.
4. After an interaction, capture a fresh observation and fresh registered evidence on the same step before recording a satisfied assertion.
5. Set one evidence-linked verdict, finish the run, then generate and verify the report.
6. Report the verdict, covered criteria, evidence, blockers, and verified report path to the human.

Use the installed Skill for event ordering, evidence freshness, recovery budgets, and controller-specific behavior.

## Bug-fix QA lifecycle

Use two independent exploratory runs:

1. Before the fix, reproduce the bug and preserve an evidence-backed fail baseline.
2. After the fix is deployed, start a new run with the same acceptance criteria and gather fresh evidence.
3. Keep the failed and passing runs separate. Do not revise the failed verdict to represent the deployment.
4. After human review, promote only the evidence-valid passing run to a regression case.
5. Replay the activated case on the requested platform subset.

## Case promotion and activation

Draft from a completed, reviewed exploratory run with `ai-qa case draft --from-run <run-id>`. Validate with `ai-qa case validate`, then activate with `ai-qa case activate` only after explicit human review confirmation.

Each promotion adds or replaces only the source platform variant and retains other platform variants. A fail run may remain a reproduction record, but only a valid pass source can produce an activatable revision.

## Regression and multi-platform RunGroups

For one platform, use `ai-qa run start --kind regression --case <case-id> --platform <platform>`. Follow the pinned variant steps in order and satisfy the same fresh-evidence requirements as exploratory QA.

For multiple platforms, use `ai-qa run-group start` with explicit cases or `--all-active`, the exact platform subset, and local or CI execution. Missing selected variants become `coverage_gap` cells. Finish only after every child run is terminal; the aggregate matrix never synthesizes one QA verdict.

## Reports and recording

Generate and verify each run report before export. Generate and verify every child report before a RunGroup aggregate report.

With `local-only`, return the verified local paths and stop. With `project-skill`, execute the frozen project procedure only after report verification, then submit a neutral receipt. Never retry an external recording operation whose outcome is `unknown`. Recording never changes QA verdicts or matrix cells.

## Interrupted-run repair and project clearing

Use `ai-qa run repair <run-id>` for crash-orphaned evidence or a torn journal tail. Review preserved recovery data under `.ai-qa/recovery/<run-id>/`.

`ai-qa clear` removes configuration and the project-owned AI QA Skill while retaining records. `ai-qa clear --records` removes the complete project-local AI QA record store. These commands are destructive; execute only when the human's request clearly includes the intended scope.

## CLI command map

- Project setup and readiness: `config`, `doctor`, `skill`
- Run lifecycle: `run`, `action`, `observation`, `evidence`, `assertion`, `decision`, `recovery`, `blocker`, `verdict`
- Reusable coverage: `case`, `run-group`
- Results: `report`
- Project cleanup: `clear`

Use `ai-qa <command> --help` for current flags and the installed Skill for sequencing and safety rules.
```

- [ ] **Step 3: Validate guide structure and links**

Run:

```bash
pnpm exec prettier --check docs/agent-workflow.md
```

Expected: Prettier reports the file as correctly formatted.

Run a relative-link check and expect every linked repository file to exist.

### Task 2: Rewrite the English README around human prompts

**Files:**

- Modify: `README.md:37-269`
- Reference: `docs/agent-workflow.md`

**Interfaces:**

- Consumes: The Agent guide created in Task 1.
- Produces: The canonical public heading order, seven prompt examples, and Agent-guide link mirrored by both translations.

- [ ] **Step 1: Replace Quick start and Usage with human-facing sections**

Keep the introduction, Requirements, Install, Project data and authority, Clear project data, Development, and Live acceptance sections. Replace the current `## Quick start` through `### Errors` range with:

````markdown
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
````

- [ ] **Step 2: Verify the English prompt contract**

Run a check that asserts the README has the H2 headings `Quick start`, `How to prompt AI QA`, `Prompt cookbook`, and `Agent workflow guide`, plus exactly seven cookbook H3 headings and nine blockquotes total (two Quick start prompts plus seven cookbook prompts).

- [ ] **Step 3: Format-check the English README**

Run `pnpm exec prettier --check README.md`.

Expected: Prettier reports correct formatting.

### Task 3: Mirror the public structure in Traditional and Simplified Chinese

**Files:**

- Modify: `README.zh-TW.md:37-269`
- Modify: `README.zh-CN.md:37-269`

**Interfaces:**

- Consumes: English heading order, seven cookbook prompts, two Quick start prompts, and Agent-guide link from Task 2.
- Produces: Natural Traditional and Simplified Chinese public documentation with identical technical tokens and structure.

- [ ] **Step 1: Add the Traditional Chinese structure and prompts**

Use these exact H2/H3 translations:

```text
## 快速開始
## 如何向 AI QA 下指令
## Prompt 範例
### 設定專案
### 探索功能
### 修復前重現 Bug
### 驗證已部署的 Bug 修復
### 建立迴歸測試 case
### 在單一平台重播迴歸測試
### 在多平台重播迴歸測試
## Agent 操作指南
```

Translate all nine English prompts naturally. Preserve `BUG-123`, `bug-123-sign-in`, URLs, platform names, `local`, case identifiers, and the relative link `docs/agent-workflow.md`.

- [ ] **Step 2: Add the Simplified Chinese structure and prompts**

Use these exact H2/H3 translations:

```text
## 快速开始
## 如何向 AI QA 下指令
## Prompt 示例
### 配置项目
### 探索功能
### 修复前重现 Bug
### 验证已部署的 Bug 修复
### 创建回归测试 case
### 在单个平台重放回归测试
### 在多平台重放回归测试
## Agent 操作指南
```

Translate all nine English prompts naturally. Preserve `BUG-123`, `bug-123-sign-in`, URLs, platform names, `local`, case identifiers, and the relative link `docs/agent-workflow.md`.

- [ ] **Step 3: Verify three-language structural parity**

Run a Node script that compares H2 count, H3 count, fenced code-block count, and blockquote count across all three README files.

Expected: all four counts are identical.

- [ ] **Step 4: Format-check all public docs**

Run:

```bash
pnpm exec prettier --check README.md README.zh-TW.md README.zh-CN.md docs/agent-workflow.md
```

Expected: all four files pass.

### Task 4: Verify the full documentation change

**Files:**

- Verify: `README.md`
- Verify: `README.zh-TW.md`
- Verify: `README.zh-CN.md`
- Verify: `docs/agent-workflow.md`

**Interfaces:**

- Consumes: Completed public and Agent-facing documentation.
- Produces: Evidence that links, structures, prompts, CLI references, tests, and build are valid.

- [ ] **Step 1: Verify all relative Markdown links**

Run a Node script over the four files and fail when a non-HTTP, non-anchor target does not exist.

Expected: `README and Agent Workflow links OK`.

- [ ] **Step 2: Verify Agent Workflow command families**

Run:

```bash
node dist/cli/main.js --help
node dist/cli/main.js run --help
node dist/cli/main.js case --help
node dist/cli/main.js run-group --help
node dist/cli/main.js report --help
```

Expected: every command family referenced by the guide appears in built CLI help.

- [ ] **Step 3: Run the complete project check**

Run:

```bash
pnpm check
```

Expected: formatting, lint, typecheck, all tests, and build pass.

- [ ] **Step 4: Inspect and commit the intended diff**

Run `git diff --check`, inspect `git diff -- README.md README.zh-TW.md README.zh-CN.md docs/agent-workflow.md`, and confirm no CLI, schema, Skill, or controller files changed.

Commit:

```bash
git add README.md README.zh-TW.md README.zh-CN.md docs/agent-workflow.md
git commit -m "docs: refocus README on human prompts"
```
