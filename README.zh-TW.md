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

請在你要測試的確切專案中執行 AI QA。一般情況下，人類只需向代理程式描述工作；代理程式會使用已安裝的 Skill、平台 controller 與 CLI。

先請代理程式設定專案：

> 請為這個專案設定 AI QA。已部署的平台是 Web 與 iOS Simulator。報告只保留在本機。寫入任何內容前，先向我顯示完整的檔案提案。

設定完成且 readiness 檢查通過後，再要求執行 QA：

> 請在 Web 探索登入功能。從登入頁開始，並使用有效的測試帳號。成功登入後必須進入儀表板，且不能出現錯誤。報告只保留在本機，並向我顯示 verdict 與其證據。

代理程式會處理 readiness、controller 操作、evidence、verdict 與報告產生。

## 專案設定流程

第一次使用時，在代理程式與你完成以下設定前，QA 會保持阻擋：

1. **檢查專案：** 代理程式解析確切的專案根目錄並執行 doctor。
2. **選擇已部署平台：** 至少選擇一個已部署的 Web、iOS Simulator 或 Android Emulator；不支援實體裝置。
3. **選擇結果處理方式：** 明確選擇 `local-only` 或 `project-skill`，兩種模式都不會預先選定。
4. **收集安全的設定：** 代理程式蒐集每個所選平台的 target 與 controller 設定，並確保 config 不包含實際 secret。
5. **審查兩份提案：** 代理程式同時驗證 `.ai-qa/config.yaml` 與 `.agents/skills/ai-qa-project/SKILL.md`，接著顯示新檔的完整內容或既有檔案的完整 diff。一次確認會涵蓋兩個檔案；取消則兩個檔案都不寫入。
6. **驗證 readiness：** 確認後，代理程式只寫入兩個檔案一次，並對所有已設定平台執行 doctor。所有本次要求的平台 ready 後才開始 QA。

代理程式會處理 schema validation、路徑與 symlink 檢查、目錄建立，以及 controller-specific readiness 細節。

## 如何向 AI QA 下指令

一個實用的請求會說明：

- **平台：** 本次要執行哪些已設定的 Web、iOS Simulator 或 Android Emulator。
- **目標：** 想驗證的使用者行為或產品結果。
- **前置條件：** 起始畫面、登入狀態、功能旗標或必要資料。
- **驗收條件：** 能夠觀察並判定成功或失敗的結果。
- **測試資料：** 帳號或資料需求；請引用 secret，而不要提供實際憑證。
- **結果處理：** 將驗證過的報告保留在本機，或使用已核准的專案記錄流程。

你不需要提供 work-order JSON、action ID、evidence ID、verdict payload 或 case revision。描述想要的結果即可，代理程式會管理協定細節。

## Prompt 範例

### 設定專案

> 請為這個專案設定 AI QA。Web 已部署在 `https://example.test`，報告應只保留在本機。請檢查專案、顯示完整的 config 與 project Skill 提案，並在寫入前等待我確認。

### 探索功能

> 請在 iOS Simulator 探索重設密碼功能。從登入畫面開始，使用能接收重設連結的測試帳號。使用者必須能要求重設密碼並在沒有錯誤的情況下進入確認狀態。請擷取證據並回傳驗證過的報告。

### 修復前重現 Bug

> 請在 Web 重現修復前的 BUG-123。從登入頁開始，並使用有效的測試帳號。送出有效帳密後應進入儀表板，但回報的實際行為是仍停留在登入頁。請保留有證據支持的 fail baseline，並向我顯示報告。

### 驗證已部署的 Bug 修復

> BUG-123 已修復並部署。請在 Web 使用相同的前置條件與驗收條件建立新的 run。驗證有效登入會在沒有錯誤的情況下進入儀表板。請將此結果與修復前的 run 分開保存，並向我顯示新報告。

### 建立迴歸測試 case

> 我已審查通過的 BUG-123 結果。請將它準備成 regression case `bug-123-sign-in`，向我顯示 case 提案，並只在我確認後啟用。

### 在單一平台重播迴歸測試

> 請在 Web 重播已啟用的 `bug-123-sign-in` regression case，並回傳驗證過的報告。

### 在多平台重播迴歸測試

> 請在 Web 與 iOS Simulator 重播所有已啟用的登入 regression case。回報每個 case／platform 結果與所有 coverage gap。

Bug 驗證會分別使用修復前與修復後的 run。失敗的 run 會保留為重現紀錄；只有具有有效證據且通過的 run 能啟用為 regression case。

## Agent 操作指南

負責執行上述請求的 Agent 應閱讀 [AI QA Agent Workflow](docs/agent-workflow.md)。該文件會將人類請求對應至專案設定、controller 操作、CLI lifecycle、evidence、case、RunGroup、report、recording、repair 與 cleanup。已安裝的 AI QA Agent Skill 仍是正式規則來源。

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
