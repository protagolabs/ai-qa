# ai-qa

[English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md)

`ai-qa` 是一套由代理程式協作執行的 QA CLI 與 Agent Skill，支援 Web、iOS Simulator 和 Android Emulator。主機端代理程式透過已設定的 controller 操作瀏覽器、Simulator 或 Emulator；CLI 則記錄並驗證 readiness、action、evidence、assertion、case、verdict、RunGroup 與 report。

不支援實體 iOS 與 Android 裝置。

## 系統需求

- Node.js 22 或 24。
- 可使用 Agent Skill，以及各目標平台 controller 的代理程式主機。
- Web：Chrome DevTools MCP。
- iOS Simulator：Pepper。
- Android Emulator：搭配 UiAutomator2 的 Appium。

## 安裝

全域安裝公開套件，然後安裝套件內附的 Agent Skill：

```bash
npm install --global @narra-im/ai-qa
ai-qa --help
ai-qa skill install --global
ai-qa skill check --global
```

Agent Skill 預設安裝於 `~/.agents/skills/ai-qa/`。若要使用其他 Agent Skill 根目錄，請在 Skill 指令設定 `AI_QA_AGENTS_HOME`：

```bash
AI_QA_AGENTS_HOME=/custom/agents/home ai-qa skill install --global
AI_QA_AGENTS_HOME=/custom/agents/home ai-qa skill check --global
```

安裝套件絕不會在未告知的情況下覆寫代理程式指示。若服務管理的 Skill 內容曾在本機修改，請先檢查 install 或 sync 指令回傳的差異，再允許取代。

## 快速開始

### 1. 檢查目標專案

在你要測試的確切專案中執行 doctor。若不想切換目錄，也可以使用 `--project`。

```bash
cd /path/to/your/project
ai-qa doctor --json
```

第一次使用時，doctor 會回傳阻擋流程的 `configure-project` action，因為專案尚未建立 `.ai-qa/config.yaml`。

### 2. 請代理程式設定 AI QA

安裝 AI QA Skill 後，請代理程式設定目前專案。例如：

> 請為這個專案設定 AI QA，平台使用 Web 與 iOS Simulator，報告只保留在本機。

代理程式會蒐集已部署平台的設定，並要求明確選擇 recording policy。寫入任何內容前，它會驗證並顯示完整的 `.ai-qa/config.yaml` 與 `.agents/skills/ai-qa-project/SKILL.md` 提案。一次確認會同時套用兩個檔案；取消則完全不寫入。

### 3. 請代理程式執行 QA

每次請求都要從已設定的平台中選擇非空白的子集。例如：

> 請在 Web 執行登入功能的探索式 QA。有效使用者應該在沒有錯誤的情況下進入儀表板。

也可以重播已審查的迴歸測試範圍：

> 請在 Web 與 iOS Simulator 執行所有已啟用的登入迴歸測試 case。

代理程式會呼叫各平台的 controller。CLI 本身不會點擊、輸入、啟動 App 或擷取畫面；它會記錄代理程式規劃及完成的 controller 呼叫，並驗證 evidence chain。

### 4. 產生報告

代理程式通常會在 run 結束時產生並驗證報告。你也可以使用 ID 重新產生及匯出報告：

```bash
ai-qa report generate <run-id>
ai-qa report export <run-id> --adapter project-local
```

通過驗證的 run report 儲存在 `.ai-qa/reports/runs/`，RunGroup report 則儲存在 `.ai-qa/reports/groups/`。

## 使用方式

一般使用者只需要向已安裝 AI QA Skill 的代理程式描述 QA 目標與驗收條件。以下較底層的指令說明主機端代理程式透過 CLI 記錄的工作流程。

### 設定專案

先執行 `ai-qa doctor --json`。缺少 config 是第一次使用時的阻擋條件。設定流程必須：

1. 選擇一組非空白的已部署平台。
2. 蒐集每個所選平台的 target 與 controller 設定。
3. 明確選擇 `recordingPolicy.mode`；`local-only` 與 `project-skill` 都不是預設值。
4. 草擬並驗證 schema-3 config 與專案所擁有的 Agent Skill。
5. 顯示完整提案內容或差異，並取得一次確認。
6. 一次寫入兩個檔案，並對所有已設定平台執行 doctor。

`targets` 與 `tools` 必須包含完全相同的平台 key。以下是部分 schema 片段，不是完整的專案 config：

```yaml
schemaVersion: 3
targets:
  web:
    entryUrl: https://example.test
    readinessUrl: https://example.test/health
tools:
  web:
    controller: chrome-devtools-mcp
```

```yaml
schemaVersion: 3
targets:
  ios-simulator:
    bundleId: com.example.app
    simulator:
      selection: device-name
      deviceName: iPhone 17 Pro
tools:
  ios-simulator:
    controller: pepper
```

```yaml
schemaVersion: 3
targets:
  android-emulator:
    appPackage: com.example.app
    appActivity: .MainActivity
    emulator:
      selection: avd-name
      avdName: Pixel_10_API_36
tools:
  android-emulator:
    controller: appium
    automationName: uiautomator2
    endpoint: http://127.0.0.1:4723
```

完整 config 還包含 `project`、`environments`、`evidencePolicy`、`reportPolicy`、`recordingPolicy`、`storagePolicy`、`gitPolicy`、`ciPolicy` 與 `secretReferences`。Config 可以指定存放 secret 的環境變數名稱，但絕不能包含實際憑證。

### 檢查平台就緒狀態

主機端先使用平台 controller 檢查 readiness，再將記錄到的 observation 提供給 doctor：

```bash
ai-qa doctor --platform web --json --stdin-json
ai-qa doctor --platform ios-simulator --json --stdin-json
ai-qa doctor --platform android-emulator --json --stdin-json
```

設定決定哪些平台可用；每個 QA 請求則另外選擇要執行的已設定平台子集。

### 執行探索式 QA

為每個所選平台啟動一個該平台專屬的 run：

```bash
ai-qa run start --kind exploratory --platform ios-simulator --execution local --stdin-json
```

每次 controller 互動、observation 與截圖前，都要記錄 `ai-qa action plan`；完成後則使用 `ai-qa action complete` 記錄唯一一個終止結果。互動後，同一個 step 必須包含新的 observation，以及由已設定 controller 新註冊的 evidence，才能將 assertion 記為已滿足。

設定有 evidence 連結的 verdict、完成 run，再產生並驗證報告。多平台探索式 QA 使用彼此獨立的 run，不使用 RunGroup。

### 將探索式 run 提升為迴歸測試 case

審查完整的探索式 run 後，建立並啟用其不可變的平台 variant：

```bash
ai-qa case draft --from-run <run-id> --stdin-json
ai-qa case validate login --revision <revision>
ai-qa case activate login --revision <revision> --stdin-json
```

Draft 只會新增或取代來源 run 的平台 variant，並保留其他平台的 variant。

### 重播迴歸測試 case

在一個已設定的平台執行一個已啟用的 case variant：

```bash
ai-qa run start --kind regression --case login --platform ios-simulator --execution local --stdin-json
```

代理程式會依序執行釘選 variant 的 step，並遵守與探索式 QA 相同的互動後新鮮 evidence 要求。

### 使用 RunGroup 執行多平台迴歸測試

執行群組（RunGroup）只用於迴歸測試。選擇明確的 case 或所有已啟用 case，並列出確切的平台子集：

```bash
ai-qa run-group start --case login \
  --platform ios-simulator android-emulator \
  --execution local --stdin-json

ai-qa run-group start --all-active \
  --platform web ios-simulator android-emulator \
  --execution ci --stdin-json

ai-qa run-group finish <group-id>
```

Manifest 會凍結 case revision、platform variant、selection 與 budget。所選平台缺少 variant 時會成為 `coverage_gap`，而不是 child run。彙總 matrix 會保留每個 case/platform cell，且不會合成 QA verdict。

### 產生報告並記錄結果

針對單一 run 產生、匯出報告，並檢查 recording status：

```bash
ai-qa report generate <run-id>
ai-qa report export <run-id> --adapter project-local
ai-qa report recording-status <run-id>
```

針對 RunGroup：

```bash
ai-qa report group-generate <group-id>
ai-qa report group-export <group-id> --adapter project-local
ai-qa report group-recording-status <group-id>
```

使用 `local-only` 時，回報通過驗證的本機路徑後即停止。使用 `project-skill` 時，主機端只有在報告驗證完成後，才會執行專案凍結的 recording procedure，接著提交包含 opaque reference 的中性 receipt：

```bash
printf '%s\n' '{"status":"recorded","references":["docs/qa.md#run"]}' \
  | ai-qa report receipt <run-id> --stdin-json

printf '%s\n' '{"status":"recorded","references":["docs/qa.md#group"]}' \
  | ai-qa report group-receipt <group-id> --stdin-json
```

Receipt status 可以是 `recorded`、`not_recorded` 或 `unknown`。外部記錄操作結果為 `unknown` 時，絕不能重試。Recording 不會變更 run verdict 或彙總 matrix cell。

## 專案資料與權限邊界

每個目標專案都擁有自己的 `.ai-qa/config.yaml`、case、run、RunGroup、evidence、report 與 recording receipt。專案所擁有的 `.agents/skills/ai-qa-project/SKILL.md` 可定義既有的結果管理流程；它不會授予 CLI controller 或外部系統存取權。

主機端代理程式擁有專案存取權、權限、驗證狀態、controller session 與檔案寫入權。CLI 只驗證及記錄主機端提供的 event，絕不呼叫 Chrome DevTools MCP、Pepper、Appium 或 UiAutomator2。

## 清除專案資料

移除專案設定，但保留 case、run、evidence 與 report：

```bash
ai-qa clear
ai-qa --project /exact/project/path clear
```

這會立即移除 `.ai-qa/config.yaml` 與完整的 `.agents/skills/ai-qa-project/` 目錄。指令具冪等性，且不會要求確認。

若也要刪除所有專案內的 AI QA 紀錄，包括 case、run、RunGroup、evidence、report 與 recording receipt：

```bash
ai-qa clear --records
```

`--records` 會立即移除完整的 `.ai-qa/` 目錄，其他 project skill 不受影響。

若 clear 回報 `storage.recovery_required`，請先檢查並手動處理專案相對路徑 `recoveryPath`，再重試。Clear 絕不會自動刪除、還原或繼續執行保留的 recovery entry。

## 開發

原始碼開發需求：Node.js 22 或 24，以及 pnpm 11.9.0。

```bash
corepack enable
pnpm install
pnpm check
pnpm build
```

套件內附的 Skill 版本為 `2.0.0`，接受 work protocol `^2.0.0`。經確認的 sync 會安裝正好四個服務管理的 reference：shared protocol，以及 Web、iOS Simulator、Android Emulator controller guide。Managed marker 以外的使用者內容會保留。

## 實際驗收

- [Web](docs/validation/web-live-acceptance.md)
- [iOS Simulator](docs/validation/ios-simulator-live-acceptance.md)
- [Android Emulator](docs/validation/android-emulator-live-acceptance.md)
- [Multi-platform](docs/validation/multi-platform-live-acceptance.md)
