# AI QA README 三語化設計

## 目標

讓第一次接觸 `@narra-im/ai-qa` 的使用者能從 README 直接完成安裝、安裝 Agent Skill、設定目標專案、執行 QA，以及取得報告。同時提供英文、繁體中文與簡體中文三個內容對等的版本。

## 文件配置

- `README.md` 是英文主版，也是 npm 與 GitHub 預設顯示的文件。
- `README.zh-TW.md` 是繁體中文完整版。
- `README.zh-CN.md` 是簡體中文完整版。
- 三份文件頂端都提供語言切換連結，並以英文、繁體中文、簡體中文的固定順序排列。

三份 README 採相同的章節順序、命令範例與技術事實。只翻譯自然語言、標題與註解；套件名稱、CLI 命令、平台識別字、設定欄位和值不翻譯。

## 內容結構

文件先服務首次使用者，再保留進階協定資訊：

1. 專案簡介、支援平台與實體裝置限制。
2. Requirements：Node.js 版本與受支援的 controller。
3. Install：從 npm 全域安裝 CLI，並安裝與檢查 bundled Agent Skill。
4. Quick start：在目標專案執行 doctor、由 Agent 完成受確認的設定、選擇平台執行 QA，以及產生報告。
5. Usage：分別說明專案設定、doctor、exploratory run、case promotion、regression、RunGroup、report 與 recording。
6. Project data and authority：說明 `.ai-qa/`、host/controller 與 CLI 的責任邊界。
7. Clear project data：保留現有清除行為與 recovery 注意事項。
8. Development：保留從原始碼安裝、檢查與建置方式。
9. Live acceptance：保留既有驗收文件連結。

README 不提供一份看似可直接複製、但缺少專案欄位的偽完整 config。平台 YAML 片段會明確標示為 schema 參考，並說明完整設定應由支援 AI QA Skill 的 Agent 蒐集資料、預覽、確認後寫入。

## 使用流程

公開安裝路徑以 npm 為主：

```bash
npm install --global @narra-im/ai-qa
ai-qa --help
ai-qa skill install --global
ai-qa skill check --global
```

若使用非預設的 Agent Skill 根目錄，才示範 `AI_QA_AGENTS_HOME`；不要求一般使用者設定未必存在的 `AGENTS_HOME`。

Quick start 會區分 Agent 負責的 controller 操作與 CLI 負責的紀錄操作。它不暗示 `ai-qa` 自己會操作瀏覽器、Simulator 或 Emulator，也不把專案設定平台誤寫成當次執行平台。

## 一致性與驗證

- 比對三份 README 的章節、程式碼區塊數量與命令內容。
- 執行所有 README 內可安全執行的唯讀命令，例如 built CLI 的 `--help` 與子命令 help。
- 執行 Markdown 格式檢查。
- 檢查所有相對連結指向存在的 repo 檔案。
- 確認沒有憑證、絕對使用者路徑或內部紀錄識別碼。
- README-only 變更不修改 CLI 行為、schema 或既有資料。

## 非目標

- 不新增 CLI 命令或互動式初始化器。
- 不支援實體 iOS 或 Android 裝置。
- 不在 README 複製完整的 host/controller protocol；細節仍由 bundled Agent Skill 管理。
- 不翻譯 `docs/validation/` 或既有設計、計畫文件。
