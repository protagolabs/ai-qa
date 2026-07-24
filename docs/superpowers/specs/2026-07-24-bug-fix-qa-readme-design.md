# AI QA Bug 修復驗證 README 設計

## 目標

讓使用者能從 README 直接理解並啟動「重現 Bug、保存失敗證據、驗證修復、建立防回歸 case」的 QA 流程，不需要先理解底層 event protocol。

## 文件範圍

- 以英文主版 `README.md` 為結構基準。
- 同步更新 `README.zh-TW.md` 與 `README.zh-CN.md`。
- 三份 README 使用相同的章節位置、命令區塊與技術含義。
- 只修改 README；不新增 CLI 命令、不改變 schema 或執行行為。

## 章節位置與結構

在 Usage 的 exploratory QA 章節之後、run repair 章節之前，新增一個「Verify a bug fix」對等章節。這個位置先建立 exploratory run 的必要背景，再說明如何把兩個獨立 run 串成修復驗證流程。

章節依序包含：

1. 說明沒有專用的 `bug start` 指令；Bug QA 由 exploratory run 組成。
2. 修復前使用一個 run 重現問題，以 fresh post-action observation、evidence 與 violated assertion 支持 `fail` verdict。
3. 提供一段可直接交給 Agent 的修復前 prompt，包含平台、Bug ID、前置條件、重現步驟、預期結果與實際結果。
4. 修復部署後啟動新的 exploratory run，沿用相同驗收條件取得修復後證據。
5. 提供一段可直接交給 Agent 的修復後 prompt。
6. 說明修復前與修復後必須使用不同 run，保留可稽核的 before/after 紀錄。
7. 說明 fail run 用於保存重現報告；只有有效的 pass run 才能啟用為 regression case。
8. 顯示 `case draft`、`case validate`、`case activate` 與 regression `run start` 指令，完成防回歸閉環。

## 用詞與行為約束

- 不暗示 CLI 會自行修改程式、部署修正版或操作 controller。
- 不建議使用 `verdict revise` 表示修復完成；修復後驗證必須建立新 run。
- Prompt 使用 Web 作為具體範例，但文字明確指出也可選擇已設定的 iOS Simulator 或 Android Emulator。
- 多平台修復前與修復後探索仍各平台使用獨立 run，不使用 RunGroup。
- Case activation 必須保留人工審查與明確確認。
- 技術識別字、CLI 命令、Bug ID 與 case ID 在三種語言中保持一致。

## 驗證

- 比對三份 README 的標題順序與 fenced code block 數量。
- 確認三份文件都包含 before-fix、after-fix、case promotion 與 regression replay。
- 執行 Prettier Markdown 格式檢查。
- 使用 built CLI help 驗證新增範例引用的 `run start`、`case draft`、`case validate` 與 `case activate` 命令仍存在。
- 檢查 README 相對連結仍指向存在的檔案。
- 確認變更只涉及三份 README 與本設計／後續計畫文件。

## 非目標

- 不新增 `ai-qa bug` 命令。
- 不自動關聯外部 issue tracker。
- 不產生新的 before/after 聚合報告格式。
- 不允許從 fail run 啟用 regression case。
- 不改寫 bundled Agent Skill 或 shared work protocol。
