# AI QA 專案記錄 Skill 設計規格

**狀態：** 已核准設計

**日期：** 2026-07-15

**範圍：** 目標專案 Skill 生成、provider-neutral 記錄政策與中立 receipt

**Review 修訂：** 2026-07-15，補入 crash recovery、per-run mode snapshot、status 前置條件、report export 邊界與 full-state configure 決策。

## 1. 規格關係

本規格延伸 `2026-07-13-ai-qa-design.md`，並在衝突時取代該規格以下內容：

- Project `ai-qa-project` Skill 為 optional 的生成規則；
- 由 `ai-qa` 提供外部 command/storage adapter 的設計；
- 把外部系統當作 report storage adapter 的描述。

`.ai-qa/` 仍是唯一 canonical QA workspace。外部或專案自訂的記錄方式只負責協作與管理，不成為可變的事件來源。

## 2. 問題與決策

專案管理 QA 結果的方式無法可靠枚舉。使用者可能使用專案文件、試算表、Notion、聊天流程、內部工具、GitHub、其他系統，或完全沒有外部管理方式。

因此採用 **Skill-led hybrid**：

- 結構化 config 保存 provider-neutral 且 CLI 可驗證的政策；
- 目標專案 Skill 保存專案特有的穩定操作程序；
- Codex、Claude Code 等宿主 Agent 解讀並執行程序；
- `ai-qa` 不操作外部系統，只保存中立的 recording status 與 references。

如果使用者沒有既有 QA 管理方式，系統預設為 `local-only`，只保留 `.ai-qa/` canonical records 與本地 JSON/Markdown 報告。

## 3. 目標

- 初始化時以開放式對話理解專案如何管理 QA 結果，不顯示 provider 選單。
- 產生完整的目標專案 `ai-qa-project` Skill，先預覽，取得確認後才寫入。
- 讓 Project Skill 描述任意專案程序，同時保留 CLI 可驗證的安全與資料政策。
- 讓宿主 Agent 負責工具選擇、認證、approval 與外部操作限制。
- 在不保存 provider payload 的前提下，稽核專案記錄是否完成及其 opaque references。
- 保持 QA verdict、證據完整性與專案記錄結果彼此獨立。

## 4. 非目標

- 內建 GitHub、Jira、Notion、Linear 或其他 connector。
- 動態載入第三方 npm adapter。
- 由 `ai-qa` 管理 token、登入狀態或宿主工具 approval。
- 解析、開啟、呼叫或驗證 reference 指向的外部內容。
- 把外部記錄失敗轉換成產品 `fail`、QA blocker 或 unsupported `pass`。
- 把外部系統當成 canonical event store。

## 5. 架構與責任

### 5.1 `ai-qa` CLI

CLI 擁有 `.ai-qa/` 下的 config、run journal、evidence、case、verdict、本地報告與獨立的 recording journal。CLI 不知道外部系統類型，也不執行專案記錄程序。Recording journal 屬於 report lifecycle，不追加事件到已 terminal 的 run journal。

### 5.2 全域 `ai-qa` Skill

全域 Skill 擁有通用 QA 協定：

- repository trust 與專案解析；
- 初始化對話；
- exploratory/regression 流程；
- evidence 與 verdict 完整性；
- 本地報告產生；
- 載入並遵循目標專案 Skill；
- 將宿主執行結果登記成中立 receipt。

### 5.3 目標專案 `ai-qa-project` Skill

每個完成新版本初始化的目標專案都有：

```text
<target>/.agents/skills/ai-qa-project/SKILL.md
```

Project Skill 保存該專案特有的穩定程序，包括：

- service 啟動順序、環境與入口；
- 登入、seed data 與測試帳號程序；
- 導航、selector、deep link 與平台限制；
- evidence、privacy、retention 與報告規則；
- QA 結果與缺陷如何由專案管理；
- 何時新增、更新、去重或不建立專案記錄；
- 專案要求的格式、模板與必要文件。

Project Skill 不複製全域 QA 協定，也不宣告宿主工具權限。

### 5.4 宿主 Agent

Codex、Claude Code 等宿主 Agent：

- 解讀 Project Skill；
- 選擇自身可用的工具；
- 處理認證、approval、sandbox 與操作限制；
- 執行專案記錄程序；
- 把結果以 provider-neutral receipt 回寫 CLI。

`ai-qa` 不實作第二套權限或授權系統。

## 6. 結構化設定

Config schema 升級為版本 2。現有欄位保持語意，`storagePolicy.adapter` 仍固定為 `project-local`，並新增：

```yaml
schemaVersion: 2
reportPolicy:
  formats: [markdown, json]
  audience: engineering
  detail: full
storagePolicy:
  adapter: project-local
recordingPolicy:
  mode: local-only # 或 project-skill
```

`recordingPolicy.mode` 只描述是否存在額外的專案記錄程序，不描述目的地或 provider。

- `local-only`：本地報告完成後流程結束，不要求 receipt。
- `project-skill`：本地報告完成後，宿主 Agent 必須讀取 Project Skill、執行其中的專案記錄程序並登記 receipt。

Evidence sensitivity、retention、Git policy、secret references 等仍由既有結構化欄位保存。Secret references 只能是環境變數名稱。

## 7. 初始化與 Skill 生成

### 7.1 對話

初始化依序執行：

1. 解析並讓使用者確認精確目標專案。
2. 完成 machine-local repository trust。
3. 只讀取理解專案所需的文件。
4. 討論 targets、環境、工具、帳號、evidence、報告、Git 與 secrets。
5. 開放式詢問專案目前如何管理 QA 結果與缺陷。
6. 若沒有既有方式，選用 `local-only`，不引導使用者建立外部流程。
7. 產生完整 config 與 Project Skill 預覽。

對話不得以 GitHub/Jira 等固定 provider 選單限制使用者答案。

### 7.2 預覽與套用

全域 Skill 將確認後的完整決策提交為同一份初始化 request：

```ts
type InitializationRequest = {
  config: ProjectConfigV2;
  projectSkill: {
    reason: string;
    content: string;
  };
};
```

預覽包含：

- 每個將建立或修改的精確路徑；
- 完整 config；
- 完整 Project Skill；
- 既有檔案的 unified diff；
- 預覽內容的 checksum。

Checksum 是 `sha256:` 前綴的 digest，涵蓋 canonical initialization request、目標路徑及預覽時的目的檔 identity/content hashes。使用者確認後，套用命令必須攜帶同一 checksum。Checksum 不一致表示預覽後輸入或目的檔已改變，CLI 必須拒絕寫入並要求新預覽。

套用服務先驗證並 stage 所有檔案，再發布 config 與 Project Skill。任何失敗都不得留下部分 config、部分 Skill 或覆寫既有使用者內容；清理只能移除本次 transaction 建立的暫存或新檔案。

### 7.3 Managed 與 user regions

Project Skill 使用：

```html
<!-- ai-qa:managed:start -->
<!-- ai-qa:managed:end -->

<!-- ai-qa:user:start -->
<!-- ai-qa:user:end -->
```

`skill sync` 只自動更新未被修改的 managed region，並逐 byte 保留 user region。Managed region 若被手動修改，必須顯示 diff 並取得明確確認才能替換。

## 8. 執行與資料流

### 8.1 Local-only

```text
finish run
-> generate verified JSON/Markdown reports
-> end
```

`local-only` 不建立 `recording.json`，也不產生 receipt obligation。

Recording mode 在 run 建立時凍結到 immutable work order。後續 config 變更只影響新 run，不追溯改變既有 run 的 recording obligation。

新 work order 保存：

```json
{
  "recordingPolicy": { "mode": "local-only" }
}
```

此欄位對舊 work order 為 optional；缺少時只在記憶體中衍生 `local-only`，不得改寫 immutable work order 或其 hash anchor。

### 8.2 Project-skill

```text
finish run
-> generate verified JSON/Markdown reports
-> load ai-qa-project Skill
-> host executes the project's recording procedure
-> host registers provider-neutral receipt
-> CLI materializes recording.json
```

外部記錄失敗不改變 run verdict 或本地報告有效性。

`project-skill` 流程以 work order 中的 recording mode snapshot 為準，不重新讀取目前 config 來重分類歷史 run。

## 9. Recording receipt

### 9.1 CLI

新增：

```text
ai-qa report receipt <run-id> --stdin-json
ai-qa report recording-status <run-id>
```

`receipt` 只登記宿主已執行之程序的結果，不執行外部操作。

### 9.2 Payload

```json
{
  "idempotencyKey": "host-generated-stable-key",
  "status": "recorded",
  "references": ["opaque-reference"]
}
```

`status` 只能是：

- `recorded`：專案記錄程序已完成；
- `not_recorded`：程序明確未完成；
- `unknown`：宿主無法確定外部操作是否成功。

References 是 provider-neutral opaque strings，可代表 URL、檔案路徑、row ID、message ID 或其他穩定參考。CLI 只驗證型別、數量、長度及不可含控制字元；不解析、不開啟，也不推論 provider。

- Idempotency key 必須符合 `^[A-Za-z0-9._:-]{1,128}$`。
- 每筆 receipt 最多包含 20 個 references。
- 每個 reference 長度為 1 到 2,048 個 Unicode code points，且不可包含 C0/C1 控制字元或換行。
- `recorded` 必須包含至少一個 reference。
- `not_recorded` 不得包含 reference。
- `unknown` 可包含零到二十個已知但尚無法確認結果的 references。

### 9.3 Idempotency 與歷史

- 相同 idempotency key 與完全相同 payload 回傳原事件。
- 相同 key 搭配不同 payload 必須拒絕。
- 不同 key 產生新的 append-only receipt event。
- 最新 receipt 決定目前 recording status；舊事件永久保留。
- 尚未登記 receipt 的 `project-skill` run 顯示衍生狀態 `pending`。
- `local-only` run 顯示衍生狀態 `not_applicable`，但不保存 receipt event。
- `pending` 只在 run 已 terminal、已產生本地報告且報告完整性驗證通過後成立。報告尚未產生時回報 `report.not_generated`；run 尚未 terminal 或報告／evidence 漂移時回報既有 lifecycle／integrity error，不降級成 `pending`。

## 10. Report 與 recording artifact

```text
.ai-qa/reports/runs/<run-id>/
|-- report.json
|-- report.md
|-- recording.jsonl
`-- recording.json
```

`report.json` 與 `report.md` 只描述 QA run、work order、verdict、criteria、evidence 與 integrity。Receipt 不改寫這兩個檔案，也不改變其內容雜湊。

`recording.jsonl` 是獨立於 terminal run journal 的 append-only recording journal。`report receipt` 只允許在 run 已完成且本地報告通過完整性驗證後寫入；append 與 materialization 使用同一個 per-run report lock。

`recording.json` 從 `recording.jsonl` 產生，包含：

- run ID；
- 衍生的最新 status；
- 最新 references；
- receipt 歷史與事件 ID；
- materialized timestamp。

其邏輯 schema 為：

```ts
type RecordingArtifact = {
  schemaVersion: 1;
  runId: string;
  current: {
    eventId: string;
    status: "recorded" | "not_recorded" | "unknown";
    references: string[];
  };
  history: Array<{
    eventId: string;
    recordedAt: string;
    idempotencyKey: string;
    status: "recorded" | "not_recorded" | "unknown";
    references: string[];
  }>;
  materializedAt: string;
};
```

`recording.jsonl` 是 canonical recording history；`recording.json` 是 deterministic materialized view。每次 materialization 使用最後一筆 event 的 `recordedAt` 作為 `materializedAt`，因此同一份 journal 只會產生一種結果。

若 process 在成功發布 `recording.jsonl` 後、發布 `recording.json` 前中止，下一次 `recording-status` 或相同 receipt retry 必須在 per-run report lock 內，從有效 journal 確定性重建缺失、無效或落後的 materialized view。相同 idempotency key/payload 在重建後仍回傳原事件。只有以下狀態屬於 `recording.integrity_error`：

- canonical journal 缺失但 materialized view 存在；
- materialized history 比 journal 超前；
- 兩者共享 event 的內容或順序矛盾；
- journal 本身無法通過 schema、run identity 或 JSONL 完整性驗證。

因此 `recording-status` 對外是狀態查詢，但允許唯一一種本地寫入副作用：在 lock 內修復可由 canonical journal 唯一決定的 `recording.json`。它不得修改 journal、report、run、verdict 或任何外部系統。

`report export --adapter project-local` 只驗證並回傳 configured `report.json`／`report.md` 路徑，不包含 `recording.json` 或 `recording.jsonl`。最新 Recording 狀態透過 `report recording-status` 查詢；完整 append-only history 保留在本地 canonical `recording.jsonl` 與 deterministic `recording.json`，不屬於 report export 或 status response。

`report export --adapter project-local` 保持向後相容；外部專案記錄不透過 export adapter 執行。

## 11. 錯誤處理

- 在 verified report 已存在的前提下，Project Skill 缺失、格式錯誤或 protocol 不相容時，本地報告仍有效，recording status 維持 `pending`，直到宿主登記 `not_recorded` 或問題修復。
- 所有 project-skill 與 receipt commands 必須先解析並驗證 machine-trusted project；未信任專案不得讀取 Project Skill。
- `.agents/skills/ai-qa-project/` 的每個 ancestor 與 artifact 都必須經 `lstat`/`realpath` 驗證，拒絕 symlink、非 canonical path 與非 regular file。
- Project Skill 不得保存 literal secrets，只能引用 config 中已確認的 secret-reference names。
- 宿主確認程序失敗時登記 `not_recorded`。
- 宿主無法確定結果時登記 `unknown`，`ai-qa` 不得自動重試外部操作。
- Reference 無效時 CLI 拒絕 receipt，但不修改 QA run 或本地報告。
- Receipt journal 與 `recording.json` 真正矛盾時，recording status 回報 integrity error。由有效 canonical journal 重建 deterministic materialized view 不屬於推論或補造成功結果。
- Recording error 不得改變產品 QA verdict、criterion results 或 evidence completeness。

## 12. CLI surface

新增或擴充：

```text
ai-qa init --project <target> --stdin-json --preview
ai-qa init --project <target> --stdin-json --confirm-checksum <sha256>
ai-qa configure --project <target> --stdin-json --preview
ai-qa configure --project <target> --stdin-json --confirm-checksum <sha256>
ai-qa skill generate --project <target> --stdin-json --preview
ai-qa skill generate --project <target> --stdin-json --confirm-checksum <sha256>
ai-qa skill check --project <target>
ai-qa skill sync --project <target> --stdin-json --preview
ai-qa skill sync --project <target> --stdin-json --confirm-checksum <sha256>
ai-qa report receipt <run-id> --stdin-json
ai-qa report recording-status <run-id>
```

`--preview` 與 `--confirm-checksum` 互斥。確認呼叫必須重新提交與預覽完全相同的 stdin request。`init` 在同一 transaction 中套用 config 與 Project Skill；`configure` 在同一 transaction 中套用 config 與對應的 Skill 更新。`skill generate` 與 `skill sync` 提供既有專案的獨立建立與維護流程。既有 `skill install|check|sync --global` 行為保持不變。

`configure` 刻意不支援 config-only partial request：每次必須重送完整 config 與完整 Project Skill request，讓跨檔 invariant、preview checksum 與 managed/user merge 在同一 transaction 內驗證。

Work protocol minor version 升級為 `1.1.0`，bundled global Skill version 同步升級為 `1.1.0`。`project-skill` recording flow 要求 global Skill metadata 宣告 `aiQaRecordingReceipt: true` 且 protocol range 包含 `1.1.0`。舊版 1.0.0 Skill 可繼續執行 v1/local-only flow，但不能啟動 project-skill recording phase。

## 13. Migration 與相容性

- Config v1 不會在 CLI 升級時被靜默改寫。
- 未 migration 的 v1 專案保持現有 Increment 1 行為，等同 local-only。
- 新 work order 保存 `recordingPolicy.mode` snapshot；舊 work order 缺少該欄位時衍生為 `local-only`，且讀取不改寫原檔。
- Work protocol 1.1 reader 保持接受 immutable 1.0.0 work order；只有新建 work order 使用 1.1.0。
- Migration 先預覽 v2 config 與完整 Project Skill，再由使用者確認套用。
- 使用者拒絕 migration 時，原 config、runs、evidence、cases 與 reports 保持可用。
- 新初始化直接建立 config v2 與完整 Project Skill。
- 現有 v1 report artifacts 不需要重寫，也不補造 recording receipts。

## 14. 測試策略

### 14.1 Unit

- Config v2 與 recording policy schema。
- Receipt payload、reference 限制與 idempotency。
- Reference 空字串、1／2,048／2,049 code points 與控制字元邊界。
- Latest status、`pending` 與 `not_applicable` 衍生規則。
- Managed/user region merge 與 checksum。
- `recording.json` schema 與 materialization。

### 14.2 Integration

- Init 預覽完整 config 與 Project Skill。
- 未確認、checksum mismatch、目的檔變更及 write failure 不留下部分狀態。
- 既有 user region byte-for-byte 保留。
- Project Skill 不包含 provider 假設。
- Local-only 不建立 receipt obligation。
- Receipt retry、conflict、歷史與最新狀態。
- Process 在 journal publish 與 materialized-view publish 之間中止後，可由 canonical journal 確定性恢復並安全 retry。
- Config mode 雙向切換不改變既有 work order 的 `pending`／`not_applicable` 或 receipt eligibility。
- Skill 缺失或不相容不影響 QA verdict 與本地報告。
- Receipt 不改寫既有 `report.json`/`report.md` bytes。
- `recording.jsonl` 與 `recording.json` exact parity。

### 14.3 End-to-end 與 Skill eval

- 使用任意本地程序模擬宿主 Agent，證明不需要內建 provider adapter。
- 對話可接受專案文件、試算表、聊天流程、內部工具或無管理方式等答案。
- 沒有管理方式時選擇 local-only，不引導使用者建立新外部流程。
- 宿主完成程序後只回寫 status/references，不回寫 provider payload。
- 外部記錄失敗或 unknown 不改變產品 QA verdict。

## 15. 驗收條件

本功能完成時必須證明：

1. 新專案初始化會預覽並產生完整 `ai-qa-project` Skill。
2. 初始化不需要也不提供 provider enum。
3. Local-only 專案只產生 canonical records 與本地報告。
4. Project-skill 專案可由宿主執行任意記錄程序。
5. CLI 只保存中立 status/references 與 append-only receipt history。
6. Recording failure 與 QA verdict 完全分離。
7. 現有 v1 專案可繼續使用，migration 不會靜默改寫資料。
8. 完整品質閘門與新增 unit/integration/E2E/Skill eval 全部通過。
9. Recording materialized view 可從有效 canonical journal 恢復，不會因正常 crash window 永久失效。
10. Config mode 變更只影響新 run，不重分類歷史 run。
