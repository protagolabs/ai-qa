# AI QA README Localization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish an English primary README and complete Traditional Chinese and Simplified Chinese variants that explain how to install, configure, run, and retrieve results from AI QA.

**Architecture:** Treat `README.md` as the canonical content structure and keep `README.zh-TW.md` and `README.zh-CN.md` structurally equivalent. Technical tokens and shell/YAML examples remain identical across languages; only headings, prose, and explanatory comments are translated.

**Tech Stack:** GitHub-flavored Markdown, npm, Node.js 22/24, pnpm 11.9.0, `ai-qa` CLI.

## Global Constraints

- `README.md` is the English primary document; `README.zh-TW.md` and `README.zh-CN.md` are complete translations.
- Every README begins with links to English,繁體中文, and 简体中文 in that order.
- Package names, CLI commands, platform identifiers, YAML keys, and YAML values are not translated.
- Document only Web, iOS Simulator, and Android Emulator; real mobile devices remain unsupported.
- State explicitly that the host Agent invokes controllers and the CLI records and validates the workflow.
- Do not add CLI behavior, dependencies, schema fields, or a fabricated complete project config.
- Do not expose credentials, user-specific absolute paths, or internal record identifiers.

---

### Task 1: Rewrite the English primary README around installation and usage

**Files:**

- Modify: `README.md`
- Reference: `package.json`
- Reference: `src/cli/program.ts`
- Reference: `src/skills/global/SKILL.md`

**Interfaces:**

- Consumes: npm package name `@narra-im/ai-qa`, supported Node.js versions, existing CLI command surface, and work protocol constraints.
- Produces: the canonical README section order and exact command blocks used by both translations.

- [x] **Step 1: Rewrite the opening and navigation**

Add this language navigation immediately after the title:

```markdown
[English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md)
```

Keep the project description concise, name all three supported platforms, explain the host/CLI responsibility boundary, and state that real devices are unsupported.

- [x] **Step 2: Add Requirements and Install before development instructions**

Document Node.js `22` or `24` and the platform controller requirements. Use this public installation path:

```bash
npm install --global @narra-im/ai-qa
ai-qa --help
ai-qa skill install --global
ai-qa skill check --global
```

Explain that the default Agent Skill root is `~/.agents`, with `AI_QA_AGENTS_HOME=/custom/agents/home` as the optional override. Do not use `AI_QA_AGENTS_HOME="$AGENTS_HOME"` in the default path.

- [x] **Step 3: Add a minimal Quick start**

Use four numbered stages:

1. Change into the exact target project and run `ai-qa doctor --json`.
2. Ask an Agent with the installed AI QA Skill to configure the deployed platforms and recording policy; explain that it previews both files before confirmation.
3. Ask the Agent to run a selected configured platform subset, distinguishing exploratory runs from regression runs.
4. Generate and export a verified report.

Include only commands users can correctly run without inventing payloads:

```bash
cd /path/to/your/project
ai-qa doctor --json

ai-qa report generate <run-id>
ai-qa report export <run-id> --adapter project-local
```

- [x] **Step 4: Organize the detailed Usage reference**

Retain the existing technical details under this exact conceptual order:

1. `Configure a project`
2. `Check platform readiness`
3. `Run exploratory QA`
4. `Promote an exploratory run to a regression case`
5. `Replay regression cases`
6. `Run multi-platform regression with a RunGroup`
7. `Generate reports and record results`

Keep the existing schema-3 platform fragments, but introduce them as partial reference fragments. Preserve the same-step fresh observation/evidence rule, immutable platform variants, `coverage_gap`, neutral aggregate reports, and recording receipt rules.

- [x] **Step 5: Move maintenance material after Usage**

Follow Usage with `Project data and authority`, `Clear project data`, `Development`, and `Live acceptance`. Preserve all clear/recovery semantics and move the existing pnpm source workflow under Development.

- [x] **Step 6: Format-check the English README**

Run:

```bash
pnpm exec prettier --check README.md
```

Expected: `README.md` is reported as correctly formatted.

- [x] **Step 7: Commit the English README**

```bash
git add README.md
git commit -m "docs: add AI QA installation and usage guide"
```

### Task 2: Add complete Traditional and Simplified Chinese READMEs

**Files:**

- Create: `README.zh-TW.md`
- Create: `README.zh-CN.md`
- Reference: `README.md`

**Interfaces:**

- Consumes: the final heading order, facts, links, and code blocks from `README.md`.
- Produces: two localized documents with equivalent content and byte-identical fenced code payloads except for translated shell comments.

- [x] **Step 1: Create the Traditional Chinese document**

Translate every English heading and prose paragraph into natural Traditional Chinese. Use terminology consistently: `代理程式` for Agent when prose requires a translation, `探索式 QA` for exploratory QA, `迴歸測試` for regression, `執行群組` on first mention followed by `RunGroup`, and `實體裝置` for real devices. Retain established product identifiers such as Agent Skill, Web, iOS Simulator, Android Emulator, controller, CLI, schema, case, verdict, and receipt when translation would obscure the command model.

- [x] **Step 2: Create the Simplified Chinese document**

Translate every English heading and prose paragraph into natural Simplified Chinese. Use terminology consistently: `代理` for Agent in prose, `探索式 QA`, `回归测试`, `运行组` on first mention followed by `RunGroup`, and `实体设备`. Keep the same product identifiers and unmodified technical tokens as the Traditional Chinese version.

- [x] **Step 3: Verify language navigation and formatting**

Run:

```bash
pnpm exec prettier --check README.md README.zh-TW.md README.zh-CN.md
```

Expected: all three files are reported as correctly formatted.

- [x] **Step 4: Commit the localized READMEs**

```bash
git add README.zh-TW.md README.zh-CN.md
git commit -m "docs: add Chinese AI QA usage guides"
```

### Task 3: Verify README parity, commands, and repository links

**Files:**

- Verify: `README.md`
- Verify: `README.zh-TW.md`
- Verify: `README.zh-CN.md`

**Interfaces:**

- Consumes: all three completed README files and the built CLI.
- Produces: evidence that the documentation is formatted, structurally aligned, linked to existing files, and based on real CLI commands.

- [x] **Step 1: Build the packaged CLI**

Run:

```bash
pnpm build
```

Expected: TypeScript compilation and asset copying complete with exit code `0`.

- [x] **Step 2: Verify documented help surfaces**

Run:

```bash
node dist/cli/main.js --help
node dist/cli/main.js doctor --help
node dist/cli/main.js run start --help
node dist/cli/main.js run-group start --help
node dist/cli/main.js report --help
node dist/cli/main.js skill --help
```

Expected: every command exits `0`, and the named command/options shown in the README appear in help output.

- [x] **Step 3: Compare structure and fenced examples**

Run:

```bash
node --input-type=module -e '
import fs from "node:fs";
import assert from "node:assert/strict";
const files = ["README.md", "README.zh-TW.md", "README.zh-CN.md"];
const texts = files.map((file) => fs.readFileSync(file, "utf8"));
const headingLevels = (text) => [...text.matchAll(/^(#{1,6}) /gm)].map((match) => match[1].length);
const blocks = (text) => [...text.matchAll(/^```[^\n]*\n([\s\S]*?)^```$/gm)].map((match) => match[1].split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n"));
for (let index = 1; index < texts.length; index += 1) {
  assert.deepEqual(headingLevels(texts[index]), headingLevels(texts[0]), `${files[index]} heading levels differ`);
  assert.deepEqual(blocks(texts[index]), blocks(texts[0]), `${files[index]} code blocks differ`);
}
console.log("README parity OK");
'
```

Expected: the script prints `README parity OK` and exits `0`.

- [x] **Step 4: Verify repository-relative links**

Run:

```bash
node --input-type=module -e '
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
const files = ["README.md", "README.zh-TW.md", "README.zh-CN.md"];
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const href = match[1];
    if (/^(?:https?:|mailto:|#)/.test(href)) continue;
    const target = decodeURIComponent(href.split("#", 1)[0]);
    assert.ok(fs.existsSync(path.resolve(path.dirname(file), target)), `${file}: missing ${target}`);
  }
}
console.log("README links OK");
'
```

Expected: the script prints `README links OK` and exits `0`.

- [x] **Step 5: Run final repository checks**

Run:

```bash
pnpm exec prettier --check README.md README.zh-TW.md README.zh-CN.md
git diff --check
git status --short
```

Expected: formatting and diff checks exit `0`; status lists no unintended tracked files. Existing untracked `.DS_Store` and `.pnpm-store/` are left untouched.
