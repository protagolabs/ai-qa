# AI QA 人類 README 與 Agent Workflow 設計

## 目標

把公開 README 從 host／CLI 操作手冊改成面向人類使用者的 prompt cookbook，讓使用者知道要向 Agent 提供哪些資訊、可以要求哪些 QA 工作，以及會得到什麼結果。同時新增一份英文 Agent 操作指南，集中保存 Agent 執行時需要的流程導覽與底層 CLI 索引。

## 受眾與文件分工

### 三語 README

`README.md`、`README.zh-TW.md` 與 `README.zh-CN.md` 的主要受眾是使用 AI QA 的人類。三份文件維持相同章節順序、prompt 數量、技術事實與連結，只翻譯自然語言。

README 負責：

- 說明產品用途、支援平台與限制。
- 提供安裝方式。
- 教使用者如何向 Agent 描述 QA 工作。
- 提供可以直接修改的 prompt 範例。
- 說明 Agent、controller 與 CLI 的責任邊界。
- 介紹並連結 `docs/agent-workflow.md`。
- 保留清除資料、開發與 live acceptance 資訊。

README 不再解釋 schema 欄位、action/evidence event 順序、receipt payload 或完整 CLI lifecycle。

### Agent Workflow

新增 `docs/agent-workflow.md`，使用英文，主要受眾是負責執行 AI QA 的 Agent。

Agent Workflow 負責：

- 告知 Agent 應先讀取並遵守已安裝的 AI QA Agent Skill。
- 將完整工作流整理成可掃讀的導覽與 CLI 索引。
- 說明 project setup、execution platform selection、exploratory QA、Bug 修復驗證、case promotion、regression、RunGroup、report、recording、repair 與 clear。
- 強調 host／Agent 負責 controller session、平台互動、權限與檔案寫入；CLI 只驗證與記錄 host 提供的事件。
- 將正式 evidence chain、recording 與 controller 規則連回 bundled Skill 及其 reference，不另建一套規範。

`docs/agent-workflow.md` 是導覽文件，不取代 `src/skills/global/SKILL.md` 或 `src/skills/global/references/shared-work-protocol.md` 的正式契約。

## README 資訊架構

三語 README 採以下結構：

1. 專案簡介與支援平台。
2. 系統需求。
3. 安裝 CLI 與 Agent Skill。
4. Quick start：在目標專案請 Agent 設定並執行第一個 QA 工作。
5. Prompting AI QA：
   - 一個 prompt 應包含的平台、目標、前置條件、驗收條件、測試資料與結果保存需求。
   - 說明不需要手動撰寫 work order、action、evidence 或 verdict 指令。
6. Prompt cookbook：
   - 設定專案。
   - 探索式 QA。
   - 修復前 Bug 重現。
   - 修復後驗證與準備 case promotion。
   - 審查後啟用 regression case。
   - 單平台 regression replay。
   - 多平台 regression replay。
7. Agent 操作指南：介紹 `docs/agent-workflow.md` 的受眾與用途並提供連結。
8. 專案資料與權限邊界。
9. 清除專案資料。
10. 開發與 live acceptance。

既有 Usage 中的 schema YAML、doctor platform payload、two-phase action、fresh evidence、receipt 指令與 RunGroup manifest 細節移至 Agent Workflow 或改為連結，不在 README 重複。

## 人類 Prompt 模型

README 使用以下六個欄位教使用者組織需求：

- **Platform:** 從已設定的 Web、iOS Simulator、Android Emulator 中選擇本次執行平台。
- **Goal:** 想驗證的使用者行為或產品結果。
- **Preconditions:** 登入狀態、起始頁面、功能旗標或必要資料。
- **Acceptance criteria:** 可觀察、可判定的預期結果。
- **Test data:** 可用帳號、資料條件或 secret reference；不在 prompt 放入實際 secret。
- **Result handling:** 報告只留本機，或依已核准的 project recording procedure 記錄。

Prompt 範例使用自然語言，不要求人類提供 run ID、event ID、revision 或 CLI JSON。需要後續操作時，人類以語意指令引用上一個已完成結果，例如「把剛才通過的 run 準備成 regression case」，Agent 再解析實際 ID。

## Bug 修復 Prompt 流程

Bug QA 在 README 中以人類對話呈現：

1. 修復前 prompt：指定平台、Bug ID、前置條件、重現步驟、預期與實際結果，要求保存 fail baseline。
2. Agent 完成並回報修復前 run 與報告。
3. 修復部署後 prompt：要求使用相同驗收條件建立新的 run 並驗證修復。
4. Agent 完成並回報修復後結果。
5. 人類審查通過後，以 prompt 要求將通過的 run 建立並啟用為 regression case。
6. 後續以 prompt 要求單平台或多平台 replay。

README 只解釋修復前後必須使用不同 run，以及只有有效的 pass run 能啟用為 regression case；具體 CLI 指令放在 Agent Workflow。

## Agent Workflow 結構

`docs/agent-workflow.md` 採以下章節：

1. Audience and authority.
2. Sources of truth.
3. First-use project configuration.
4. Per-request platform selection.
5. Exploratory QA lifecycle.
6. Bug-fix QA lifecycle.
7. Case promotion and activation.
8. Regression and multi-platform RunGroups.
9. Reports and recording.
10. Interrupted-run repair and project clearing.
11. CLI command map.

每個 lifecycle 章節包含：

- 人類可能提出的 request。
- Agent 必須確認的輸入。
- Agent 應遵守的高階順序。
- 對應 CLI command family。
- 需要回報給人類的結果。

底層 event payload、完整 JSON schema 與 controller-specific 操作不複製到此文件；Agent 必須依正式 Skill reference 執行。

## 一致性與驗證

- 三份 README 的 H2／H3 順序、prompt blockquote 數量與 fenced code block 數量一致。
- 三份 README 都介紹並連結 `docs/agent-workflow.md`。
- Prompt cookbook 涵蓋設定、探索、Bug before/after、case activation、單平台 regression 與多平台 regression。
- `docs/agent-workflow.md` 涵蓋設計指定的十一個章節，並明確標示正式 source of truth。
- README 與 Agent Workflow 的相對連結全部存在。
- 執行 Prettier、完整測試與 build。
- 變更不修改 CLI、schema、bundled Skill 或 controller behavior。

## 非目標

- 不新增或改名 CLI 指令。
- 不新增 `ai-qa bug` command。
- 不把 `docs/agent-workflow.md` 當成自動載入的根目錄 `AGENTS.md`。
- 不在 README 教人類手動組裝 event journal。
- 不複製 controller reference 的具體點擊、截圖或裝置啟動規則。
- 不修改目前支援平台或實體裝置限制。
