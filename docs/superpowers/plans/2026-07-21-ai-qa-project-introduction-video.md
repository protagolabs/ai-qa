# AI QA Project Introduction Video Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a reproducible four-minute 1080p Traditional Chinese narrated video that explains the complete AI QA feature set and uses the approved iOS `blocked → fix → pass → Lark` session as its concrete example.

**Architecture:** Keep all rebuildable production logic under `scripts/video/ai-qa-intro/` and all generated media under ignored `artifacts/ai-qa-intro/`. A single scene manifest owns narration, captions, visual beats, durations, and feature coverage; Node scripts call macOS `say`, FFmpeg, and FFprobe without shell interpolation, render deterministic scene clips, compose the master, and verify media/privacy constraints. Existing AI QA reports and evidence are read-only sources copied into the artifact workspace; a Pepper/Simulator recording may replace the screenshot montage only when the same passed path can be safely reenacted.

**Tech Stack:** Node.js 22 or 24, pnpm 11.9.0, Vitest 4, macOS `say`, Pepper, iOS Simulator, FFmpeg/FFprobe installed by Homebrew, H.264/AAC MP4, SRT subtitles.

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-21-ai-qa-project-introduction-video-design.md` exactly.
- Output is 1920×1080, 30fps, H.264 video with AAC audio.
- Final duration must be 225–270 seconds.
- Narration is Taiwan Mandarin with Traditional Chinese subtitles.
- The video must cover every row in the spec's feature-coverage table.
- The case-study order is existing bug → iOS `blocked` → shared-scheme root cause → bundle-specific routing → `76/76` → iOS `pass` → reports → Lark simulation record.
- Never display the session ID, Lark record IDs, absolute filesystem paths, credentials, tokens, passwords, service keys, or database connection data.
- Do not modify existing AI QA runs, reports, evidence, receipts, or Lark records.
- Do not register the reenactment as a new AI QA run.
- Physical iOS and Android devices remain explicitly unsupported.
- Large recordings, intermediate files, and the final MP4 remain untracked under `artifacts/ai-qa-intro/`.

---

## Planned File Structure

```text
scripts/video/ai-qa-intro/
├── build.mjs              # end-to-end orchestrator
├── build-audio.mjs        # say/FFmpeg narration, SRT, music and cue generation
├── content.mjs            # approved narration, captions, visual beats and feature coverage
├── prepare-assets.mjs     # read-only source import and sanitized text/image assets
├── render-scenes.mjs      # per-scene FFmpeg composition
├── verify.mjs             # FFprobe, subtitle, privacy, feature and frame verification
└── lib/
    ├── ffmpeg.mjs         # safe FFmpeg/FFprobe argument builders
    ├── paths.mjs          # repository and artifact paths
    ├── privacy.mjs        # forbidden-pattern scan and safe labels
    ├── process.mjs        # spawn wrapper with structured failures
    └── subtitles.mjs      # SRT timing and formatting
tests/video/
└── ai-qa-intro.test.ts    # manifest, privacy, subtitle and argument-builder tests
docs/superpowers/specs/
└── 2026-07-21-ai-qa-project-introduction-video-design.md
artifacts/ai-qa-intro/     # ignored generated workspace and delivery
```

## Task 1: Deterministic Production Contract

**Files:**
- Create: `scripts/video/ai-qa-intro/content.mjs`
- Create: `scripts/video/ai-qa-intro/lib/paths.mjs`
- Create: `scripts/video/ai-qa-intro/lib/process.mjs`
- Create: `tests/video/ai-qa-intro.test.ts`
- Modify: `.gitignore`
- Modify: `package.json`

**Interfaces:**
- Produces: `SCENES`, `FEATURE_IDS`, `VIDEO`, `artifactPaths`, `runCommand(command, args, options)`.
- Consumes: only Node built-ins and the approved design spec.

- [ ] **Step 1: Add the failing manifest and privacy-boundary tests**

Create `tests/video/ai-qa-intro.test.ts` with these initial assertions:

```ts
import { describe, expect, test } from "vitest";
import {
  FEATURE_IDS,
  FORBIDDEN_OUTPUT_LITERALS,
  SCENES,
  VIDEO,
} from "../../scripts/video/ai-qa-intro/content.mjs";

describe("AI QA intro production contract", () => {
  test("covers every approved feature exactly once or more", () => {
    const covered = new Set(SCENES.flatMap((scene) => scene.features));
    expect([...FEATURE_IDS].filter((id) => !covered.has(id))).toEqual([]);
  });

  test("uses a bounded four-minute 1080p production target", () => {
    expect(VIDEO).toEqual({
      width: 1920,
      height: 1080,
      fps: 30,
      minSeconds: 225,
      maxSeconds: 270,
      voice: "Flo (中文（台灣）)",
      voiceRate: 220,
    });
    expect(SCENES.map((scene) => scene.id)).toEqual([
      "opening",
      "platforms",
      "configuration",
      "run_protocol",
      "case_promotion",
      "run_groups",
      "reports_recording_clear",
      "case_blocked",
      "case_root_cause",
      "case_pass",
      "outro",
    ]);
  });

  test("does not place private identifiers in narration or captions", () => {
    const outputText = JSON.stringify(
      SCENES.map(({ narration, captions }) => ({ narration, captions })),
    );
    for (const literal of FORBIDDEN_OUTPUT_LITERALS) {
      expect(outputText).not.toContain(literal);
    }
    expect(outputText).not.toMatch(/\/Users\//);
    expect(outputText).not.toMatch(/\brec[a-zA-Z0-9]{8,}\b/);
    expect(outputText).not.toMatch(/\brun-[0-9a-f-]{16,}\b/);
  });
});
```

- [ ] **Step 2: Run the focused test and verify the missing-module failure**

Run:

```bash
pnpm vitest run tests/video/ai-qa-intro.test.ts
```

Expected: FAIL because `scripts/video/ai-qa-intro/content.mjs` does not exist.

- [ ] **Step 3: Add the approved feature and scene manifest**

Create `scripts/video/ai-qa-intro/content.mjs` with this public shape:

```js
export const VIDEO = Object.freeze({
  width: 1920,
  height: 1080,
  fps: 30,
  minSeconds: 225,
  maxSeconds: 270,
  voice: "Flo (中文（台灣）)",
  voiceRate: 220,
});

export const FEATURE_IDS = Object.freeze([
  "agent_skill",
  "project_skill",
  "configuration",
  "doctor",
  "web",
  "ios_simulator",
  "android_emulator",
  "exploratory_run",
  "regression_run",
  "work_order",
  "typed_journal",
  "evidence_integrity",
  "verdicts",
  "case_promotion",
  "run_group",
  "aggregate_matrix",
  "reports",
  "external_recording",
  "clear",
]);

export const FORBIDDEN_OUTPUT_LITERALS = Object.freeze([
  "019f7e7b-74b6-7c41-857e-84d30b862c55",
  "recvhjp6hcKF40",
  "recvpYNoNWHiqR",
  "run-5b3aafba-2030-4e12-aacb-a2800f27a794",
  "run-f91e8506-1ab4-4b0c-8d67-161916cb6c68",
]);

export const SCENES = Object.freeze([
  {
    id: "opening",
    targetSeconds: 15,
    features: [],
    captions: ["不是只幫忙點畫面", "可重現・可驗證・可追蹤"],
    narration:
      "測試，不只是幫忙點幾下畫面。真正可靠的品質流程，必須知道做了什麼、證據在哪裡、為什麼失敗，以及修正後是否真的有效。AI QA，把每一次操作變成可重現、可驗證、可追蹤的工程紀錄。",
  },
  {
    id: "platforms",
    targetSeconds: 25,
    features: [
      "agent_skill",
      "web",
      "ios_simulator",
      "android_emulator",
    ],
    captions: [
      "Web · Chrome DevTools MCP",
      "iOS Simulator · Pepper",
      "Android Emulator · Appium",
      "不支援實體行動裝置",
    ],
    narration:
      "AI QA 是一套由代理協作執行的 QA CLI 與 Agent Skill。Web 由 Chrome DevTools MCP 操作，iOS Simulator 使用 Pepper，Android Emulator 使用 Appium 與 UiAutomator2。Controller 負責真正的畫面操作；AI QA 負責規範、狀態、完整性與產物。實體手機不在支援範圍內。",
  },
  {
    id: "configuration",
    targetSeconds: 20,
    features: ["project_skill", "configuration", "doctor"],
    captions: ["Schema 3 Config", "Project Skill", "Doctor → READY"],
    narration:
      "每個專案擁有自己的 schema 3 設定、Project Skill、案例、執行紀錄、證據與報告。Project Skill 保存專案特有的登入、測試資料與外部記錄程序，但不保存敏感值。開始測試前，doctor 會確認環境、App 與 controller 是否 ready；條件不足，就不讓測試往下執行。",
  },
  {
    id: "run_protocol",
    targetSeconds: 35,
    features: [
      "exploratory_run",
      "regression_run",
      "work_order",
      "typed_journal",
      "evidence_integrity",
      "verdicts",
    ],
    captions: [
      "Work Order",
      "Action Plan → Controller → Complete",
      "Observation · Evidence · Assertion",
      "PASS · FAIL · BLOCKED · INCONCLUSIVE",
    ],
    narration:
      "一次測試可以是探索性的 exploratory run，也可以是重播既有案例的 regression run。Work order 先固定平台、目標、驗收標準與必要證據。每次 controller 操作之前記錄 action plan，完成後記錄 terminal result；觀察、截圖、assertion、blocker 與 decision 都進入 typed journal。最後的 pass、fail、blocked 或 inconclusive，只能建立在同一步驟取得的新鮮證據上，不能靠印象補判。",
  },
  {
    id: "case_promotion",
    targetSeconds: 20,
    features: ["case_promotion"],
    captions: ["Exploratory Run", "Case Revision", "Platform Variants"],
    narration:
      "完成且通過審查的 exploratory run，可以提升為正式案例。每個 revision 保存不可變的步驟，各平台擁有自己的 variant；新增 iOS variant，不會覆蓋既有的 Web 或 Android 內容。下一次 regression 重播的是已經審查、固定版本的測試程序。",
  },
  {
    id: "run_groups",
    targetSeconds: 23,
    features: ["run_group", "aggregate_matrix"],
    captions: ["Explicit Platform Selection", "Frozen Manifest", "COVERAGE GAP"],
    narration:
      "需要多平台回歸時，RunGroup 只執行明確選定的 cases 與 platforms，並凍結 revisions、variants、selection 和 budgets。結果矩陣為每個案例與平台保留獨立 cell；某平台缺少 variant 時，顯示 coverage gap，而不是假裝測過。群組只彙整計數，也不虛構一個總體 verdict。",
  },
  {
    id: "reports_recording_clear",
    targetSeconds: 20,
    features: ["reports", "external_recording", "clear"],
    captions: ["Markdown + JSON", "Evidence Hash Verified", "Neutral Receipt"],
    narration:
      "測試完成後，AI QA 產生並驗證 Markdown 與 JSON 報告，核對事件、controller 來源和證據雜湊。報告確認無誤後，Project Skill 才能把結果寫入 Lark 等外部系統，再提交 recorded、not recorded 或 unknown 的中立 receipt。需要重設時，也能只清除設定，或明確連同歷史紀錄一起清除。",
  },
  {
    id: "case_blocked",
    targetSeconds: 27,
    features: [],
    captions: ["真實案例：返回按鈕", "第一次執行：BLOCKED", "不是產品 FAIL"],
    narration:
      "接著看一個真實案例。團隊從既有 bug 表選出返回按鈕失效問題，使用 Pepper 在 local iOS Simulator 上測試。第一次執行時，seed 登入狀態與 Pepper 注入無法同時保留，畫面最後停在登入頁。AI QA 沒有把它誤判為產品 fail，而是記為 blocked，並保留 blocker、截圖、事件鏈與完整報告。",
  },
  {
    id: "case_root_cause",
    targetSeconds: 25,
    features: [],
    captions: ["Shared Scheme → Wrong App", "Bundle-specific Routing", "Seed Tests 76/76"],
    narration:
      "追查後發現，local 與 staging App 共用 deep-link scheme。Seed session 被送進 staging，但 Pepper 控制的是 local App。修正方式是讓 development client 與 login bridge 使用 local bundle 專屬 scheme。相關 seed 測試七十六項全部通過。iOS 二十六仍可能顯示一次系統開啟確認，這次由 Pepper 正確點擊處理。",
  },
  {
    id: "case_pass",
    targetSeconds: 20,
    features: [],
    captions: ["Chats → 群組對話 → 群組資訊", "單擊返回 × 2", "PASS"],
    narration:
      "修正後重新執行。Pepper 從 Chats 進入 Seed Local Group，再打開群組資訊；第一次單擊返回對話，第二次單擊返回 Chats，兩次都立即成功。App 沒有崩潰，最終 health check 正常，這一次才具備足夠證據判定為 pass。",
  },
  {
    id: "outro",
    targetSeconds: 10,
    features: [],
    captions: ["Reports Verified", "Lark Simulation Record", "AI QA"],
    narration:
      "最後，報告與證據完成驗證，結果寫入一筆新的 Lark 模擬紀錄，原始 bug 保持不變。從第一次操作，到下一次可靠回歸，AI QA 保留完整脈絡。",
  },
]);
```

- [ ] **Step 4: Add deterministic paths and a safe process wrapper**

Create `scripts/video/ai-qa-intro/lib/paths.mjs`:

```js
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(here, "../../../..");
export const artifactRoot = join(repositoryRoot, "artifacts", "ai-qa-intro");
export const artifactPaths = Object.freeze({
  root: artifactRoot,
  script: join(artifactRoot, "script"),
  assets: join(artifactRoot, "assets"),
  recordings: join(artifactRoot, "recordings"),
  audio: join(artifactRoot, "audio"),
  frames: join(artifactRoot, "frames"),
  scenes: join(artifactRoot, "scenes"),
  output: join(artifactRoot, "output"),
  finalVideo: join(artifactRoot, "output", "ai-qa-intro-zh-TW.mp4"),
  subtitles: join(artifactRoot, "script", "ai-qa-intro-zh-TW.srt"),
});
```

Create `scripts/video/ai-qa-intro/lib/process.mjs` using `spawn` and argument arrays only:

```js
import { spawn } from "node:child_process";

export async function runCommand(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(
        new Error(
          `${command} exited ${code}\n${stderr.trim() || stdout.trim()}`,
        ),
      );
    });
  });
}
```

- [ ] **Step 5: Add package entry points and ignore generated media**

Add to `package.json` scripts:

```json
"video:ai-qa-intro": "node scripts/video/ai-qa-intro/build.mjs",
"video:ai-qa-intro:verify": "node scripts/video/ai-qa-intro/verify.mjs"
```

Append this exact line to `.gitignore`:

```gitignore
artifacts/ai-qa-intro/
```

- [ ] **Step 6: Run the focused test and repository format check**

Run:

```bash
pnpm vitest run tests/video/ai-qa-intro.test.ts
pnpm format:check
```

Expected: focused test PASS; format check may identify the new files, in which case run `pnpm exec prettier --write` only on the new/modified files and repeat until PASS.

- [ ] **Step 7: Commit the production contract**

```bash
git add .gitignore package.json scripts/video/ai-qa-intro/content.mjs scripts/video/ai-qa-intro/lib/paths.mjs scripts/video/ai-qa-intro/lib/process.mjs tests/video/ai-qa-intro.test.ts
git commit -m "feat(video): define AI QA intro production contract"
```

## Task 2: Sanitized Asset Preparation

**Files:**
- Create: `scripts/video/ai-qa-intro/lib/privacy.mjs`
- Create: `scripts/video/ai-qa-intro/prepare-assets.mjs`
- Modify: `tests/video/ai-qa-intro.test.ts`

**Interfaces:**
- Consumes: `artifactPaths`, `FORBIDDEN_OUTPUT_LITERALS`, `runCommand`.
- Produces: `assertPublicText(text, label)`, `scanTextFiles(paths)`, `prepareAssets({ hybridRoot })`, sanitized images and text under `artifacts/ai-qa-intro/assets/`.

- [ ] **Step 1: Add failing privacy tests**

Append:

```ts
import {
  assertPublicText,
  sanitizeDisplayText,
} from "../../scripts/video/ai-qa-intro/lib/privacy.mjs";

describe("AI QA intro privacy", () => {
  test("rejects private identifiers and absolute paths", () => {
    expect(() => assertPublicText("recvhjp6hcKF40", "caption")).toThrow(
      /private identifier/,
    );
    expect(() =>
      assertPublicText("/Users/example/project/report.md", "caption"),
    ).toThrow(/absolute path/);
  });

  test("sanitizes run-like display labels without changing product terms", () => {
    expect(
      sanitizeDisplayText(
        "run-f91e8506-1ab4-4b0c-8d67-161916cb6c68 PASS Pepper",
      ),
    ).toBe("iOS Run PASS Pepper");
  });
});
```

- [ ] **Step 2: Run the focused test and verify the missing-module failure**

Run `pnpm vitest run tests/video/ai-qa-intro.test.ts`.

Expected: FAIL because `lib/privacy.mjs` does not exist.

- [ ] **Step 3: Implement exact privacy guards**

Create `scripts/video/ai-qa-intro/lib/privacy.mjs`:

```js
import { readFile } from "node:fs/promises";
import { FORBIDDEN_OUTPUT_LITERALS } from "../content.mjs";

const absolutePath = /(?:\/Users\/|\/private\/|\/tmp\/)[^\s"']+/;
const larkRecord = /\brec[a-zA-Z0-9]{8,}\b/;
const runId = /\brun-[0-9a-f-]{16,}\b/;

export function assertPublicText(text, label) {
  if (absolutePath.test(text)) throw new Error(`${label}: absolute path`);
  if (larkRecord.test(text) || runId.test(text)) {
    throw new Error(`${label}: private identifier`);
  }
  for (const literal of FORBIDDEN_OUTPUT_LITERALS) {
    if (text.includes(literal)) throw new Error(`${label}: private identifier`);
  }
}

export function sanitizeDisplayText(text) {
  return text
    .replace(/run-[0-9a-f-]{16,}/g, "iOS Run")
    .replace(/\brec[a-zA-Z0-9]{8,}\b/g, "Lark Record")
    .replace(/\/(?:Users|private|tmp)\/[^\s"']+/g, "[local path]");
}

export async function scanTextFiles(paths) {
  for (const path of paths) {
    assertPublicText(await readFile(path, "utf8"), path);
  }
}
```

- [ ] **Step 4: Implement read-only source import**

Create `prepare-assets.mjs` so that it:

1. Requires `AI_QA_INTRO_HYBRID_ROOT` to be an existing directory.
2. Resolves these read-only source roots beneath it:
   - `.ai-qa/reports/runs/run-5b3aafba-2030-4e12-aacb-a2800f27a794/`
   - `.ai-qa/reports/runs/run-f91e8506-1ab4-4b0c-8d67-161916cb6c68/`
   - `.ai-qa/evidence/run-f91e8506-1ab4-4b0c-8d67-161916cb6c68/files/`
3. Copies the seven PASS JPG evidence files with this exact mapping:
   - `evidence-7256f296-d32a-46c1-8923-8a7a91abced0-run-f91e8506-initial.jpg` → `ios-01-chats.jpg`
   - `evidence-99cf8479-376e-4bc9-8fde-98c64bfe7a29-run-f91e8506-conversation.jpg` → `ios-02-conversation.jpg`
   - `evidence-8c930378-cfd2-4691-8bba-cd45b1672915-run-f91e8506-group-details.jpg` → `ios-03-group-details.jpg`
   - `evidence-e00c648e-c248-46e0-a8c2-fb3dd117fea6-run-f91e8506-after-details-back.jpg` → `ios-04-after-details-back.jpg`
   - `evidence-6fcf937a-699b-4369-88d5-c042ca0f04a3-run-f91e8506-final-chats.jpg` → `ios-05-final-chats.jpg`
   - `evidence-72b4927c-c686-4103-919d-c642305df822-run-f91e8506-post-back-protocol.jpg` → `ios-06-post-back.jpg`
   - `evidence-cc6090ab-ab8b-418b-990b-4ff46f02e6a6-run-f91e8506-stability-protocol.jpg` → `ios-07-stability.jpg`
4. Reads both reports and writes only these sanitized text assets:
   - `blocked-summary.txt`: `第一次 iOS 執行：BLOCKED\n登入狀態與 Pepper 注入無法同時保留`
   - `pass-summary.txt`: `第二次 iOS 執行：PASS\n兩次返回皆單擊成功，App 保持穩定`
   - `seed-tests.txt`: `Seed Tests\n76 / 76 PASS`
   - `lark-summary.txt`: `AI QA 模擬紀錄\n驗收通過 · 3 張代表性證據`
5. Never copies raw report JSON/Markdown into the asset directory.
6. Calls `assertPublicText` on every generated text asset.
7. Writes `asset-inventory.json` using only relative artifact paths and SHA-256 values.

Use `copyFile`, `mkdir`, `readFile`, `writeFile`, `createHash`, `resolve`, and `relative` from Node built-ins; reject any resolved source that escapes the supplied hybrid root.

- [ ] **Step 5: Run privacy tests and prepare the assets**

Run:

```bash
pnpm vitest run tests/video/ai-qa-intro.test.ts
AI_QA_INTRO_HYBRID_ROOT=/Users/cqi_clawbot/Project/hybrid node scripts/video/ai-qa-intro/prepare-assets.mjs
```

Expected: tests PASS; command writes seven sanitized JPGs, four sanitized text files, and one relative-path inventory under `artifacts/ai-qa-intro/assets/` without modifying Hybrid files.

- [ ] **Step 6: Commit the privacy and asset importer**

```bash
git add scripts/video/ai-qa-intro/lib/privacy.mjs scripts/video/ai-qa-intro/prepare-assets.mjs tests/video/ai-qa-intro.test.ts
git commit -m "feat(video): prepare sanitized AI QA evidence"
```

## Task 3: Narration, Subtitles, Music, and Cue Audio

**Files:**
- Create: `scripts/video/ai-qa-intro/lib/subtitles.mjs`
- Create: `scripts/video/ai-qa-intro/lib/ffmpeg.mjs`
- Create: `scripts/video/ai-qa-intro/build-audio.mjs`
- Modify: `tests/video/ai-qa-intro.test.ts`

**Interfaces:**
- Consumes: `SCENES`, `VIDEO`, `artifactPaths`, `runCommand`, `assertPublicText`.
- Produces: `formatSrtTime(seconds)`, `buildSubtitleEntries(sceneTimings)`, `probeDuration(path)`, per-scene AIFF/WAV files, master narration WAV, SRT, music WAV, and cue WAVs.

- [ ] **Step 1: Add failing subtitle and FFmpeg argument tests**

Append:

```ts
import {
  buildSubtitleEntries,
  formatSrtTime,
} from "../../scripts/video/ai-qa-intro/lib/subtitles.mjs";
import {
  buildProbeDurationArgs,
  buildVoiceNormalizeArgs,
} from "../../scripts/video/ai-qa-intro/lib/ffmpeg.mjs";

test("formats deterministic SRT timestamps", () => {
  expect(formatSrtTime(0)).toBe("00:00:00,000");
  expect(formatSrtTime(65.432)).toBe("00:01:05,432");
});

test("keeps every subtitle inside its scene", () => {
  expect(
    buildSubtitleEntries([
      { id: "a", start: 0, duration: 10, narration: "第一句。第二句。" },
    ]),
  ).toEqual([
    { index: 1, start: 0.35, end: 4.85, text: "第一句。" },
    { index: 2, start: 5.15, end: 9.65, text: "第二句。" },
  ]);
});

test("builds shell-free FFmpeg argument arrays", () => {
  expect(buildProbeDurationArgs("voice.aiff")).toEqual([
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    "voice.aiff",
  ]);
  expect(buildVoiceNormalizeArgs("in.aiff", "out.wav").at(-1)).toBe("out.wav");
});
```

- [ ] **Step 2: Run the focused test and verify missing modules**

Run `pnpm vitest run tests/video/ai-qa-intro.test.ts`.

Expected: FAIL because subtitle and FFmpeg modules do not exist.

- [ ] **Step 3: Implement subtitle timing and FFmpeg helpers**

`subtitles.mjs` must split each narration on `。！？`, preserve punctuation, distribute available scene time proportionally by sentence length, add 350ms head/tail padding, and emit valid sequential SRT entries. Export `renderSrt(entries)` in addition to the tested functions.

`ffmpeg.mjs` must export shell-free argument builders for:

- `buildProbeDurationArgs(path)` exactly as tested.
- `buildVoiceNormalizeArgs(input, output)`: `-y -i input -ar 48000 -ac 1 -af loudnorm=I=-18:TP=-2:LRA=7 output`.
- `buildConcatAudioArgs(listFile, output)`: concat demuxer, 48kHz mono PCM.
- `buildMusicArgs(duration, output)`: `lavfi` synthesis from three low-amplitude sine sources at 110Hz, 165Hz, and 220Hz, mixed and faded for the requested duration.
- `buildCueArgs(frequency, duration, output)`: sine cue with 10ms in/out fades.

`probeDuration(path)` must call FFprobe through `runCommand`, parse a finite positive number, and reject any empty, zero, negative, or non-numeric response.

- [ ] **Step 4: Install and verify FFmpeg**

Run:

```bash
brew install ffmpeg
ffmpeg -version
ffprobe -version
```

Expected: both tools exit 0 and report a version. Confirm the FFmpeg filter list includes `drawtext`, `overlay`, `xfade`, `subtitles`, `loudnorm`, `amix`, and `ebur128`.

- [ ] **Step 5: Implement audio generation**

`build-audio.mjs` must:

1. Verify the configured voice appears in `say -v ?` output.
2. Generate one AIFF per scene with `say -v VIDEO.voice -r VIDEO.voiceRate -o <scene>.aiff <scene.narration>`.
3. Normalize each scene to 48kHz mono WAV.
4. Probe narration duration and set effective scene duration to `max(targetSeconds, narrationDuration + 1.0)`.
5. Fail if the total effective duration is outside 225–270 seconds.
6. Write `scene-timings.json` with scene ID, start, duration, narration duration, and relative audio path.
7. Generate and write the complete SRT from the effective timings.
8. Generate master background music for the exact master duration.
9. Generate four cues: blocker 180Hz/0.18s, root-cause 330Hz/0.14s, pass 660Hz/0.18s, record 880Hz/0.12s.
10. Scan the SRT with `assertPublicText` before returning.

- [ ] **Step 6: Generate and inspect the narration package**

Run:

```bash
node scripts/video/ai-qa-intro/build-audio.mjs
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 artifacts/ai-qa-intro/audio/music.wav
```

Expected: all eleven scene narration files exist; SRT exists; total timing is 225–270 seconds; music duration equals scene-timing total within 50ms.

- [ ] **Step 7: Commit the audio builder**

```bash
git add scripts/video/ai-qa-intro/lib/subtitles.mjs scripts/video/ai-qa-intro/lib/ffmpeg.mjs scripts/video/ai-qa-intro/build-audio.mjs tests/video/ai-qa-intro.test.ts
git commit -m "feat(video): generate narration and subtitles"
```

## Task 4: Optional Pepper Simulator Reenactment

**Files:**
- Generated only: `artifacts/ai-qa-intro/recordings/ios-pass-reenactment.mp4`
- Generated only: `artifacts/ai-qa-intro/recordings/ios-pass-reenactment.json`

**Interfaces:**
- Consumes: the currently running Pepper-injected Narra local App when available.
- Produces: an optional 12–25 second screen recording and a provenance sidecar; otherwise produces an explicit fallback sidecar.

- [ ] **Step 1: Read the Pepper screen-recording guide and inspect the current app**

Read `pepper://guides/screen-recording`, then call Pepper `app_look` with `visual=true` before any interaction.

Expected: either the current local bundle is connected and the UI can reach Chats, or the task records a structured fallback reason. Never build or relaunch solely to obtain marketing footage if that would change the seeded state.

- [ ] **Step 2: Record only the approved passed navigation path when reachable**

When Chats is reachable:

1. Start Simulator recording using the Pepper guide.
2. Open `Seed Local Group`.
3. Open `群組資訊`.
4. Tap back once to the conversation.
5. Tap back once to Chats.
6. Stop recording and store it as `ios-pass-reenactment.mp4`.
7. Write sidecar JSON:

```json
{
  "kind": "reenactment",
  "claimsNewQaEvidence": false,
  "path": "recordings/ios-pass-reenactment.mp4",
  "sequence": [
    "Chats",
    "Seed Local Group",
    "群組資訊",
    "Seed Local Group",
    "Chats"
  ]
}
```

- [ ] **Step 3: Record the deterministic fallback when reenactment is unavailable**

If the current app is unavailable or not safely reachable, do not rebuild it. Write:

```json
{
  "kind": "screenshot-montage",
  "claimsNewQaEvidence": false,
  "reason": "Current Pepper runtime could not safely reenact the approved path; preserved session screenshots are used instead."
}
```

The later renderer must accept both sidecar variants.

- [ ] **Step 4: Verify recording properties when a recording exists**

Run FFprobe and require: decodable video, duration 12–25 seconds, no audio requirement, and resolution at least 390×844. Extract first/middle/last PNG frames and visually confirm the sequence contains no system permission sheet, record ID, or path.

## Task 5: Scene Rendering Engine

**Files:**
- Create: `scripts/video/ai-qa-intro/render-scenes.mjs`
- Modify: `scripts/video/ai-qa-intro/lib/ffmpeg.mjs`
- Modify: `tests/video/ai-qa-intro.test.ts`

**Interfaces:**
- Consumes: `SCENES`, `VIDEO`, `scene-timings.json`, sanitized assets, optional recording sidecar, narration WAVs.
- Produces: eleven 1920×1080 30fps H.264 scene MP4 files with narration audio.

- [ ] **Step 1: Add failing render-plan tests**

Add assertions that `buildSceneRenderPlan(scene, timing, assets)` returns:

- a `color` source of `0x08111F` at 1920×1080/30fps;
- the exact scene duration;
- `libx264`, `yuv420p`, `-r 30`, and AAC output settings;
- no absolute path in any `drawtext` textfile content;
- a screenshot montage for `case_pass` when sidecar kind is `screenshot-montage`;
- a reenactment overlay for `case_pass` when sidecar kind is `reenactment`.

- [ ] **Step 2: Run the focused test and verify the missing render-plan failure**

Run `pnpm vitest run tests/video/ai-qa-intro.test.ts`.

Expected: FAIL because `buildSceneRenderPlan` is not exported.

- [ ] **Step 3: Implement shared visual primitives**

Add builders to `ffmpeg.mjs` for these exact primitives:

- `background`: `color=c=0x08111F:s=1920x1080:r=30:d=<duration>`.
- `title`: PingFang TC Semibold, 64px, white, x=120, y=96, fade in/out alpha.
- `caption`: PingFang TC Regular, 38px, `0xD8E7F2`, placed inside a dark translucent box.
- `terminal`: x=120, y=260, w=1680, h=620, `0x0D1A2B`, cyan border, Menlo 34px.
- `statusPill`: green `0x2ED47A`, orange `0xFF9F43`, red `0xFF5D6C`, purple-gray `0x8C8FA6`, or yellow `0xF7C948` based on status.
- `screenshotPanel`: scale source to fit within 620×820, preserve aspect, add a 16px white border and slide/fade animation.
- `matrix`: four drawboxes with text labels, using coverage-gap yellow for missing variant.
- `timeline`: a 6px cyan line with event dots and captions animated left to right.

Every `drawtext` operation must use an artifact text file instead of shell-escaped inline text.

- [ ] **Step 4: Implement each approved scene composition**

`render-scenes.mjs` must map scene IDs to these visuals:

| Scene | Required visual composition |
| --- | --- |
| `opening` | quick montage of sanitized iOS screenshots, event dots, and final title |
| `platforms` | three panels labeled Web, iOS Simulator, Android Emulator connected to one timeline |
| `configuration` | sanitized config excerpt, Project Skill card, doctor transition from checking to READY |
| `run_protocol` | animated work-order card and typed event timeline ending in four verdict pills |
| `case_promotion` | exploratory run card transforms into revision and three platform variants |
| `run_groups` | selected-platform manifest and matrix with pass, blocked and coverage-gap examples |
| `reports_recording_clear` | Markdown/JSON cards, hash check, neutral receipt, and two clear scopes |
| `case_blocked` | blocked summary, login evidence screenshot, orange blocker timeline |
| `case_root_cause` | shared-scheme wrong-app route changes to bundle-specific local route; `76/76` card |
| `case_pass` | optional recording, otherwise five-step screenshot montage; green one-tap-back markers |
| `outro` | report cards, three evidence thumbnails, sanitized Lark simulation card, final message |

Each scene must include its normalized narration WAV and no background music yet.

- [ ] **Step 5: Render all scenes and verify their media shape**

Run:

```bash
node scripts/video/ai-qa-intro/render-scenes.mjs
```

Expected: eleven scene MP4s exist; each is 1920×1080, 30fps, H.264/AAC, with duration within 100ms of its effective scene timing.

- [ ] **Step 6: Extract representative frames for design review**

Extract the midpoint of each scene to `artifacts/ai-qa-intro/frames/<scene>-mid.png`. Inspect all eleven images and correct clipping, low contrast, broken Traditional Chinese glyphs, misleading statuses, or visible identifiers before continuing.

- [ ] **Step 7: Commit the renderer**

```bash
git add scripts/video/ai-qa-intro/render-scenes.mjs scripts/video/ai-qa-intro/lib/ffmpeg.mjs tests/video/ai-qa-intro.test.ts
git commit -m "feat(video): render AI QA introduction scenes"
```

## Task 6: Master Composition and Build Orchestrator

**Files:**
- Create: `scripts/video/ai-qa-intro/build.mjs`
- Modify: `scripts/video/ai-qa-intro/lib/ffmpeg.mjs`
- Modify: `tests/video/ai-qa-intro.test.ts`

**Interfaces:**
- Consumes: all scene MP4s, `music.wav`, cue WAVs, SRT.
- Produces: `artifacts/ai-qa-intro/output/ai-qa-intro-zh-TW.mp4` and `build-manifest.json`.

- [ ] **Step 1: Add failing master-build tests**

Test that the master argument builder:

- concatenates scenes in `SCENES` order;
- mixes narration with music at `0.12` gain;
- inserts cues only at the start of `case_blocked`, `case_root_cause`, `case_pass`, and `outro`;
- burns the approved SRT using PingFang TC;
- applies `loudnorm=I=-16:TP=-1.5:LRA=9` to the final mix;
- encodes H.264 CRF 18, `yuv420p`, AAC 192kbps, faststart.

- [ ] **Step 2: Run the focused test and verify failure**

Run `pnpm vitest run tests/video/ai-qa-intro.test.ts`.

Expected: FAIL because the master builder is absent.

- [ ] **Step 3: Implement the master argument builder**

Add `buildMasterArgs({ sceneList, subtitles, music, cues, output })` to `ffmpeg.mjs`. It must use the concat demuxer for video, `adelay` for cues, `volume=0.12` for music, `amix` for narration/music/cues, burned `subtitles`, final `loudnorm`, and these output flags:

```text
-c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p
-c:a aac -b:a 192k -movflags +faststart
```

- [ ] **Step 4: Implement the idempotent orchestrator**

`build.mjs` must:

1. Verify `ffmpeg`, `ffprobe`, and the configured `say` voice.
2. Create artifact directories.
3. Run asset preparation when the inventory is missing or source hashes changed.
4. Run audio generation when content or voice settings changed.
5. Read the recording sidecar; create screenshot fallback if no sidecar exists.
6. Render scenes when a scene input hash changed.
7. Compose the master.
8. Write `build-manifest.json` with relative paths, SHA-256 hashes, tool versions, duration, dimensions, fps, codecs, and content hash.
9. Invoke `verify.mjs` and fail the build when verification fails.

- [ ] **Step 5: Build the complete video**

Run:

```bash
AI_QA_INTRO_HYBRID_ROOT=/Users/cqi_clawbot/Project/hybrid pnpm video:ai-qa-intro
```

Expected: build completes with the final MP4, SRT, narration files, eleven scene files, eleven representative frames, and relative-path build manifest.

- [ ] **Step 6: Commit the master composer**

```bash
git add scripts/video/ai-qa-intro/build.mjs scripts/video/ai-qa-intro/lib/ffmpeg.mjs tests/video/ai-qa-intro.test.ts
git commit -m "feat(video): compose AI QA introduction master"
```

## Task 7: Automated Verification and Final Quality Gate

**Files:**
- Create: `scripts/video/ai-qa-intro/verify.mjs`
- Modify: `tests/video/ai-qa-intro.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: final MP4, SRT, scene timings, feature manifest, build manifest, representative frames.
- Produces: `artifacts/ai-qa-intro/output/verification.json`; exits non-zero on any failed acceptance criterion.

- [ ] **Step 1: Add failing verifier tests**

Test pure functions for:

- duration bounds 225–270 seconds;
- exact width/height/fps and accepted codec names;
- subtitles ending at or before video duration;
- all `FEATURE_IDS` covered;
- no forbidden literal/path/record/run pattern in SRT, text assets, build manifest, or OCR-free metadata strings;
- audio peak strictly below 0 dBFS;
- exactly eleven representative scene frames.

- [ ] **Step 2: Run the focused test and verify failure**

Run `pnpm vitest run tests/video/ai-qa-intro.test.ts`.

Expected: FAIL because verifier functions are absent.

- [ ] **Step 3: Implement verification**

`verify.mjs` must:

1. FFprobe the final MP4 as JSON.
2. Require H.264 video, AAC audio, 1920×1080, 30fps, 225–270 seconds.
3. Parse the SRT and require sequential indices, valid time order, nonempty Traditional Chinese text, and final subtitle end ≤ video duration.
4. Scan SRT, generated text assets, and JSON manifests with `assertPublicText`.
5. Run FFmpeg `volumedetect` and require `max_volume < 0.0 dB`.
6. Require every feature ID to appear in at least one scene.
7. Require all eleven midpoint PNGs and verify their dimensions are 1920×1080.
8. Require recording sidecar `claimsNewQaEvidence` to be `false`.
9. Write a JSON report with one named check per spec acceptance criterion and `status: "pass"` only when all checks pass.

- [ ] **Step 4: Document the rebuild commands**

Add a concise `## Project introduction video` section to `README.md` with:

```bash
brew install ffmpeg
AI_QA_INTRO_HYBRID_ROOT=/exact/hybrid/root pnpm video:ai-qa-intro
pnpm video:ai-qa-intro:verify
```

State that generated media is ignored under `artifacts/ai-qa-intro/`, the Hybrid source is read-only, and the reenactment is not new QA evidence.

- [ ] **Step 5: Run automated video verification**

Run:

```bash
pnpm video:ai-qa-intro:verify
```

Expected: every acceptance check reports PASS and `verification.json` has top-level `status: "pass"`.

- [ ] **Step 6: Perform visual and audible review**

Inspect all eleven representative frames with image viewing. Open the final MP4 in the system player and check:

- narration is natural Taiwan Mandarin and remains above music;
- no narration is clipped at scene boundaries;
- subtitles match the spoken content;
- the film feels like a product case study rather than slide pages;
- the first run is clearly `BLOCKED`, not `FAIL`;
- the second run is clearly `PASS`;
- all functions receive a concrete visual or narration beat;
- no record ID, run ID, session ID, absolute path, account, or credential appears.

If any check fails, correct the owning scene/content/audio source, rebuild, and repeat Steps 5–6.

- [ ] **Step 7: Run the repository quality gate**

Use the `quality-gate` skill because this task adds Node/JavaScript production tooling. At minimum run:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected: all commands PASS. Resolve findings in the new video tooling without changing unrelated product behavior.

- [ ] **Step 8: Commit verification and documentation**

```bash
git add README.md scripts/video/ai-qa-intro/verify.mjs tests/video/ai-qa-intro.test.ts
git commit -m "docs(video): verify and document AI QA introduction"
```

- [ ] **Step 9: Final delivery check**

Run:

```bash
git status --short
pnpm video:ai-qa-intro:verify
```

Expected: Git has no unintended changes; the ignored final video remains at `artifacts/ai-qa-intro/output/ai-qa-intro-zh-TW.mp4`; verification remains PASS. Deliver clickable paths for the MP4, SRT, narration audio, verification JSON, and design/implementation documents.
