# Bug Fix QA README Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a complete, copyable bug-fix QA workflow to the English, Traditional Chinese, and Simplified Chinese READMEs.

**Architecture:** Keep `README.md` as the canonical structure and insert one new Usage subsection immediately after exploratory QA in all three README variants. The subsection documents separate before-fix and after-fix exploratory runs, promotion of only the passing run, and regression replay without changing CLI behavior.

**Tech Stack:** Markdown, `@narra-im/ai-qa` CLI help, Prettier, Node.js validation scripts

## Global Constraints

- `README.md`, `README.zh-TW.md`, and `README.zh-CN.md` must retain identical section order, command blocks, and technical meaning.
- Do not add an `ai-qa bug` command or imply that the CLI edits or deploys application code.
- Before-fix and after-fix verification must use different exploratory runs.
- A failed run preserves reproduction evidence; only an evidence-valid passing run may be activated as a regression case.
- Multi-platform exploratory QA uses one independent run per selected platform, never a RunGroup.
- Case activation retains explicit user review confirmation.
- Do not modify schemas, CLI behavior, bundled Agent Skills, or controller protocols.

---

### Task 1: Add the canonical English bug-fix QA workflow

**Files:**

- Modify: `README.md:164`

**Interfaces:**

- Consumes: Existing exploratory-run, case-promotion, and regression CLI vocabulary.
- Produces: The canonical heading position, prose structure, prompts, and commands that both translations mirror.

- [ ] **Step 1: Insert the English subsection**

Insert the following Markdown immediately before `### Repair an interrupted run`:

````markdown
### Verify a bug fix

There is no separate `bug start` command. Bug-fix QA uses two independent exploratory runs so the before-fix failure and after-fix result remain auditable. The example below uses Web; select iOS Simulator or Android Emulator instead when that configured platform is in scope.

Before changing the application, ask the Agent to reproduce the bug and preserve an evidence-backed baseline:

> On Web, start pre-fix QA for BUG-123. The precondition is an open sign-in page with a valid account. Reproduce the issue by submitting valid credentials. The expected result is navigation to the dashboard without an error; the actual result is that the sign-in page remains visible. Run exploratory QA, capture fresh post-action observation and screenshot evidence, record a fail verdict, and generate the report.

After the fix is deployed, start a new exploratory run with the same acceptance criteria:

> BUG-123 is fixed and deployed. On Web, start a new exploratory run with the same acceptance criteria and verify that valid sign-in reaches the dashboard without an error. Capture fresh post-action evidence and generate the report. If the run passes, prepare it for promotion to regression case `bug-123-sign-in`, but do not activate it until I review it.

Do not revise the failed run to represent the fix. Keep the failed and passing runs separate, then review the passing run and promote only that evidence-valid run:

```bash
ai-qa case draft --from-run <passing-run-id> --stdin-json
ai-qa case validate bug-123-sign-in --revision <revision>
ai-qa case activate bug-123-sign-in --revision <revision> --stdin-json
```

The failed run remains the reproduction record. After explicit review and activation, replay the pinned regression case:

```bash
ai-qa run start --kind regression --case bug-123-sign-in --platform web --execution local --stdin-json
```

For multi-platform bug verification, run the before-fix and after-fix exploration independently on each selected platform. Use a RunGroup only for later multi-platform regression replay.
````

- [ ] **Step 2: Format-check the canonical README**

Run:

```bash
pnpm exec prettier --check README.md
```

Expected: `README.md` is reported as correctly formatted.

- [ ] **Step 3: Review the English behavior claims**

Run:

```bash
rg -n "There is no separate|two independent exploratory runs|Do not revise|promote only|RunGroup only" README.md
```

Expected: all five bug-fix workflow constraints match inside `### Verify a bug fix`.

### Task 2: Add structurally equivalent Chinese translations

**Files:**

- Modify: `README.zh-TW.md:164`
- Modify: `README.zh-CN.md:164`

**Interfaces:**

- Consumes: The exact heading position, prompt sequence, case ID, and commands from Task 1.
- Produces: Complete Traditional Chinese and Simplified Chinese equivalents with unchanged technical tokens.

- [ ] **Step 1: Insert the Traditional Chinese subsection**

Insert the following Markdown immediately before `### 修復中斷的 run`:

````markdown
### 驗證 Bug 修復

沒有獨立的 `bug start` 指令。Bug 修復 QA 使用兩個彼此獨立的 exploratory run，讓修復前的失敗與修復後的結果都保有可稽核紀錄。以下使用 Web 作為範例；若測試範圍是已設定的 iOS Simulator 或 Android Emulator，請改選對應平台。

修改應用程式前，請代理程式重現 Bug，並保留有證據支持的基準：

> 請在 Web 啟動 BUG-123 的修復前 QA。前置條件是已開啟登入頁，並備有有效帳號。使用有效帳密送出登入以重現問題。預期結果是進入儀表板且沒有錯誤；實際結果是仍停留在登入頁。請執行探索式 QA、取得操作後的新 observation 與截圖證據、記錄 fail verdict，並產生報告。

修復部署後，使用相同驗收條件啟動新的 exploratory run：

> BUG-123 已修復並部署。請在 Web 使用相同驗收條件啟動新的 exploratory run，驗證有效登入會進入儀表板且沒有錯誤。請取得操作後的新證據並產生報告。如果 run 通過，請準備將它提升為 regression case `bug-123-sign-in`，但先不要啟用，等我審查。

不要修改失敗 run 的 verdict 來表示 Bug 已修好。保留彼此獨立的失敗與通過 run，接著審查通過的 run，並只提升該筆具有有效證據的 run：

```bash
ai-qa case draft --from-run <passing-run-id> --stdin-json
ai-qa case validate bug-123-sign-in --revision <revision>
ai-qa case activate bug-123-sign-in --revision <revision> --stdin-json
```

失敗的 run 會保留為問題重現紀錄。明確審查並啟用後，即可重播釘選的 regression case：

```bash
ai-qa run start --kind regression --case bug-123-sign-in --platform web --execution local --stdin-json
```

多平台 Bug 驗證應在每個所選平台分別執行修復前與修復後的探索。只有後續的多平台迴歸重播才使用 RunGroup。
````

- [ ] **Step 2: Insert the Simplified Chinese subsection**

Insert the following Markdown immediately before `### 修复中断的 run`:

````markdown
### 验证 Bug 修复

没有独立的 `bug start` 命令。Bug 修复 QA 使用两个彼此独立的 exploratory run，让修复前的失败与修复后的结果都保留可审计记录。以下使用 Web 作为示例；如果测试范围是已配置的 iOS Simulator 或 Android Emulator，请改选对应平台。

修改应用程序前，请代理重现 Bug，并保留有证据支持的基准：

> 请在 Web 启动 BUG-123 的修复前 QA。前置条件是已打开登录页，并备有有效账号。使用有效账号密码提交登录以重现问题。预期结果是进入仪表板且没有错误；实际结果是仍停留在登录页。请执行探索式 QA、取得操作后的新 observation 与截图证据、记录 fail verdict，并生成报告。

修复部署后，使用相同验收条件启动新的 exploratory run：

> BUG-123 已修复并部署。请在 Web 使用相同验收条件启动新的 exploratory run，验证有效登录会进入仪表板且没有错误。请取得操作后的新证据并生成报告。如果 run 通过，请准备将它提升为 regression case `bug-123-sign-in`，但先不要启用，等我审查。

不要修改失败 run 的 verdict 来表示 Bug 已修好。保留彼此独立的失败与通过 run，接着审查通过的 run，并只提升该条具有有效证据的 run：

```bash
ai-qa case draft --from-run <passing-run-id> --stdin-json
ai-qa case validate bug-123-sign-in --revision <revision>
ai-qa case activate bug-123-sign-in --revision <revision> --stdin-json
```

失败的 run 会保留为问题重现记录。明确审查并启用后，即可重放固定的 regression case：

```bash
ai-qa run start --kind regression --case bug-123-sign-in --platform web --execution local --stdin-json
```

多平台 Bug 验证应在每个所选平台分别执行修复前与修复后的探索。只有后续的多平台回归重放才使用 RunGroup。
````

- [ ] **Step 3: Format-check all README variants**

Run:

```bash
pnpm exec prettier --check README.md README.zh-TW.md README.zh-CN.md
```

Expected: all three files are reported as correctly formatted.

### Task 3: Verify parity, links, and referenced CLI commands

**Files:**

- Verify: `README.md`
- Verify: `README.zh-TW.md`
- Verify: `README.zh-CN.md`

**Interfaces:**

- Consumes: The completed English and Chinese README sections.
- Produces: Evidence that structure, examples, commands, links, and formatting are consistent.

- [ ] **Step 1: Compare heading and code-block parity**

Run:

```bash
node --input-type=module -e 'import fs from "node:fs"; const files=["README.md","README.zh-TW.md","README.zh-CN.md"]; const stats=files.map(file=>{const text=fs.readFileSync(file,"utf8"); return {file,h2:(text.match(/^## /gm)||[]).length,h3:(text.match(/^### /gm)||[]).length,fences:(text.match(/^```/gm)||[]).length};}); const baseline=stats[0]; if(stats.some(item=>item.h2!==baseline.h2||item.h3!==baseline.h3||item.fences!==baseline.fences)){console.error(stats);process.exit(1)} console.log(stats)'
```

Expected: all three objects have identical `h2`, `h3`, and `fences` values.

- [ ] **Step 2: Verify referenced CLI command families**

Run:

```bash
node dist/cli/main.js run --help
node dist/cli/main.js case --help
```

Expected: run help lists `start`; case help lists `draft`, `validate`, and `activate`.

- [ ] **Step 3: Check README-relative links**

Run:

```bash
node --input-type=module -e 'import fs from "node:fs"; import path from "node:path"; const files=["README.md","README.zh-TW.md","README.zh-CN.md"]; const missing=[]; for(const file of files){const text=fs.readFileSync(file,"utf8"); for(const match of text.matchAll(/\]\(([^)]+)\)/g)){const target=match[1]; if(/^(?:https?:|#)/.test(target)) continue; const clean=target.split("#")[0]; if(clean&&!fs.existsSync(path.resolve(path.dirname(file),clean))) missing.push(`${file}: ${target}`)}} if(missing.length){console.error(missing.join("\n"));process.exit(1)} console.log("README links OK")'
```

Expected: prints `README links OK`.

- [ ] **Step 4: Run final formatting and diff checks**

Run:

```bash
pnpm exec prettier --check README.md README.zh-TW.md README.zh-CN.md
git diff --check
git diff -- README.md README.zh-TW.md README.zh-CN.md
```

Expected: Prettier and `git diff --check` exit 0; the diff contains only the designed bug-fix QA subsections in the three README files.

- [ ] **Step 5: Commit the README update**

```bash
git add README.md README.zh-TW.md README.zh-CN.md
git commit -m "docs: add bug fix QA workflow"
```
