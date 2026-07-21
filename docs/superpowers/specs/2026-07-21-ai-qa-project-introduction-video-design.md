# AI QA 專案介紹影片設計

**日期：** 2026-07-21  
**狀態：** 已核准，待製作計畫  
**交付語言：** 台灣華語配音、繁體中文字幕

## 目標

製作一支約四分鐘、面向內部團隊與主管的 AI QA 專案介紹影片。影片必須讓非實作者在一次觀看後理解：

1. AI QA 解決什麼問題。
2. AI QA 的完整功能面與平台邊界。
3. 一次測試如何從操作變成可重現、可驗證、可追蹤的工程紀錄。
4. 真實 session 如何從 `blocked` 找到工程根因、修正、重跑為 `pass`，最後把結果記錄至 Lark。

影片採真實案例紀錄片形式，不使用簡報頁輪播。畫面以實際操作、Simulator 錄影、CLI、動態流程、報告與證據為主。

## 受眾與成功標準

主要受眾是內部團隊與主管。內容不假設觀眾熟悉 AI QA CLI，但允許保留必要的英文產品名詞。

成功標準：

- 影片約四分鐘，完整成片不超過四分三十秒。
- 觀眾能說出 AI QA 支援 Web、iOS Simulator、Android Emulator，且不支援實體行動裝置。
- 觀眾能理解 host controller 與 AI QA CLI 的責任分界。
- 觀眾能理解設定、readiness、run、evidence、verdict、case、RunGroup、report、recording 與 clear 的用途。
- 真實案例清楚呈現 `blocked` 與產品 `fail` 的差別。
- 成片含台灣華語旁白、繁體中文字幕、低音量背景音樂與必要提示音。
- 畫面不揭露 record ID、絕對路徑、憑證或其他不必要的內部資料。

## 訊息主軸

核心訊息是：

> AI QA 不只協助操作畫面，而是把測試轉換為具備明確工作單、事件紀錄、新鮮證據、可驗證判定與可追蹤報告的工程流程。

收尾訊息是：

> 從第一次操作，到下一次可靠回歸，AI QA 保留完整脈絡。

## 功能覆蓋

影片必須涵蓋目前 README 公開描述的完整功能面：

| 功能 | 影片要傳達的重點 |
| --- | --- |
| Agent Skill | 定義代理執行 QA 時必須遵循的共用工作規範與平台 controller 指南。 |
| Project Skill | 保存專案特有的認證、測試資料、報告與外部記錄流程；不把敏感值寫入 AI QA 設定。 |
| 專案設定 | 每個專案擁有 schema 3 config，明確選擇平台、controller、證據、報告與記錄政策。 |
| Readiness doctor | 在測試前確認 App、環境、controller 與平台 ready；未 ready 時阻止測試開始。 |
| 平台 | Web 使用 Chrome DevTools MCP；iOS Simulator 使用 Pepper；Android Emulator 使用 Appium／UiAutomator2。實體 iOS／Android 裝置不支援。 |
| Exploratory run | 以明確目標和 acceptance criteria 進行探索測試。 |
| Regression run | 重播已啟用、固定 revision 與平台 variant 的案例。 |
| Work order | 每個 run 固定平台、執行方式、目標、標準與必要證據。 |
| Typed journal | action plan／complete、observation、assertion、blocker、decision、verdict 等事件以型別化紀錄保存。 |
| Evidence integrity | 截圖及其他證據註冊來源 controller、事件關聯與雜湊；判定只能引用符合語意的新鮮證據。 |
| Verdict | `pass`、`fail`、`blocked`、`inconclusive` 分別表示不同狀態，不可互相代替。 |
| Case promotion | 從通過審查的 exploratory run 建立或更新單一平台 case variant，保留其他平台 variant。 |
| RunGroup | 只用於明確選定平台與案例的多平台 regression；凍結 revisions、variants、selection 與 budgets。 |
| Aggregate matrix | 每個 case／platform 組合都有獨立 cell；缺少 variant 顯示 `coverage_gap`，群組不合成單一 QA verdict。 |
| Reports | 產生並驗證 Markdown／JSON run report 與 group report，保留事件、證據與完整性資訊。 |
| External recording | 報告驗證後才依 Project Skill 記錄到 Lark 等外部系統，並提交中立的 `recorded`、`not_recorded` 或 `unknown` receipt。 |
| Clear | 可只移除 config 與 AI QA Project Skill，也可明確選擇連歷史 cases、runs、evidence、reports 與 receipts 一起清除；保留項目有安全恢復規則。 |

## 故事與時間軸

### 0:00–0:15：開場

以 Simulator 操作、事件 timeline 與證據縮圖的快節奏 montage 開場。旁白說明 AI QA 不只「幫忙點畫面」，而是把測試變成工程流程。

### 0:15–0:40：產品定位與三平台

使用三分割動態畫面快速呈現瀏覽器、iPhone Simulator 與 Android Emulator。畫面把 Chrome DevTools MCP、Pepper、Appium 連到 AI QA event timeline，說明 host 負責 controller 與實際操作，CLI 負責狀態、完整性與產物。

### 0:40–1:00：設定與 readiness

以實際 config 片段、Project Skill、專案 `.ai-qa` 結構及 `doctor` 輸出說明每個專案獨立管理設定與紀錄。`READY` 動畫允許 run 開始；`NOT READY` 動畫阻止流程向下。

### 1:00–1:35：一次完整測試

沿著動態 event timeline 呈現：建立 exploratory／regression run、action plan、controller 操作、action complete、observation、evidence、assertion、blocker／decision、verdict 與 finish。四種 verdict 使用固定色彩與簡短語義，不以單純圖示暗示等價。

### 1:35–1:55：從探索變成回歸案例

將一個完成的 exploratory run 動畫轉換為 case revision，再分出 Web、iOS Simulator、Android Emulator variant。強調 revision 與 variant 不可變，下一次 regression 重播的是已審查步驟。

### 1:55–2:18：多平台 RunGroup

以動態矩陣顯示選定 cases 與 platforms。正常 cell 顯示各自 run 狀態；缺少 variant 的 cell 顯示 `COVERAGE GAP`。群組摘要只計數，不產生虛構的總體 verdict。

### 2:18–2:38：報告、記錄與清除

呈現 Markdown／JSON report、證據雜湊驗證、Project Skill 外部記錄和 receipt。最後短暫展示 clear 的兩種範圍：只清除設定，或連同 AI QA 歷史紀錄清除。

### 2:38–3:05：真實案例第一次執行

以 2026-07-20 session 為案例。從既有 Lark bug「app 交互界面返回按鈕失效」開始 iOS exploratory run，Pepper 操作 local Narra App。登入狀態與 Pepper 無法同時保留，流程停在登入頁。AI QA 將結果記為 `BLOCKED`，並保留 blocker、截圖、事件鏈與完整 report；畫面不可將此狀態稱為產品 `FAIL`。

### 3:05–3:30：工程根因與修正

以路徑動畫說明 local 與 staging 共用 deep-link scheme，seed session 因而送入 staging App，而 Pepper 控制 local App。動畫切換成 bundle-specific routing，接著顯示 seed 測試 `76/76` 通過。iOS 26 的系統開啟確認由 Pepper 點擊，影片不聲稱此提示已被完全消除。

### 3:30–3:50：重跑為 PASS

使用真實 Narra Simulator 錄影或原始 session 證據重現：Chats → Seed Local Group → 群組資訊；從群組資訊單擊返回對話，再從對話單擊返回 Chats。呈現 App 無崩潰、Pepper health check 正常與 `PASS`。

### 3:50–4:00：結果落地與收尾

呈現已驗證的 Markdown／JSON report、證據縮圖與一筆標記為「AI QA 模擬」的 Lark 複製紀錄。原 bug 未修改。以收尾訊息結束。

## 視覺系統

- 畫幅：16:9，1920×1080，30fps。
- 基調：深色介面、藍青主色。
- 狀態色：`BLOCKED` 橘色、`PASS` 綠色、`FAIL` 紅色、`INCONCLUSIVE` 紫灰色、`COVERAGE GAP` 黃色。
- 字體：使用 macOS 可合法嵌入影片的系統繁體中文字體；英文技術名稱使用等寬字體。
- 實際操作是主要畫面；文字只做標題、重點與狀態標記，不建立整頁簡報卡。
- session 截圖置於手機外框，使用緩慢推近、局部放大、遮罩和重點標記。
- CLI 使用真實輸出或經敏感資訊清理後的忠實重建，不顯示假的成功結果。
- 場景轉換採鏡頭推移、介面元素延伸、timeline 連續移動與遮罩轉場。

## 配音、字幕與音效

- 台灣華語女聲，沉穩、自然、清楚，接近內部產品發表。
- 語速約每分鐘 210–230 個中文字；狀態與章節切換保留短停頓。
- 全片繁體中文字幕；`AI QA`、`RunGroup`、`typed journal`、`Pepper` 等產品名詞保留英文。
- 旁白稿是字幕與剪輯時間的唯一文字來源；任何修改必須同步重新產生音訊與字幕。
- 背景音樂為自行合成、低音量、無人聲的科技氛圍音樂，不使用未授權外部素材。
- `BLOCKED`、root cause、`76/76`、`PASS` 與 Lark 寫入可使用低調提示音。
- 旁白必須始終清楚高於背景音樂，最終混音不得削波。

## 素材來源

主要素材：

- 本 repository 的 README、CLI help、config schema、測試與報告範例。
- session `019f7e7b-74b6-7c41-857e-84d30b862c55` 的事件順序與已驗證成果。
- Hybrid workspace 中兩個 iOS AI QA run 的 Markdown／JSON reports。
- `run-f91e8506-1ab4-4b0c-8d67-161916cb6c68` 的 iOS evidence screenshots。
- 若 runtime 仍可重現，使用 Simulator 錄製相同的通過路徑；錄影只作視覺重演，不改寫原 run 證據。

所有來源均以唯讀方式取得，再複製到影片工作目錄。原始 report、receipt、evidence 與 Lark record 不得因影片製作而修改。

## 製作架構

工作目錄為 `artifacts/ai-qa-intro/`：

```text
artifacts/ai-qa-intro/
├── script/       # 旁白稿、字幕、時間軸與場景 manifest
├── assets/       # 經清理後的截圖、CLI 與圖形素材
├── recordings/   # Simulator 重演錄影
├── audio/        # 旁白、背景音樂與提示音
├── frames/       # 中間場景與 QA 抽查影格
└── output/
    └── ai-qa-intro-zh-TW.mp4
```

場景 manifest 定義每段開始時間、長度、旁白、字幕、畫面素材、動畫與音訊。旁白稿產生語音與字幕；各場景先個別合成，再合併為 master video。最終階段加入字幕、背景音樂與提示音。

系統台灣華語 voice 負責旁白。FFmpeg 負責素材正規化、動畫、場景合成、音訊混合、字幕與 H.264 MP4 輸出。本機目前缺少 FFmpeg，製作計畫必須先透過 Homebrew 安裝並驗證版本。

`artifacts/` 是可重新產生的交付工作目錄；除非使用者另行要求，不把大型錄影、中間檔與最終 MP4 納入 Git commit。設計、腳本與可重建的製作程式可以另行決定是否追蹤。

## 降級與錯誤處理

- 若 Simulator 無法重演，改用原 session 截圖製作動態鏡頭；旁白不得暗示這是新的 live run。
- 若部分平台沒有真實畫面，平台總覽使用抽象 controller 視覺，不偽造 Android 或 Web 測試結果。
- 若台灣華語 voice 不可用，停止製作並回報，不自動改用非中文 voice。
- 若任何素材包含 record ID、絕對路徑、憑證或內部欄位，先遮蔽或重建畫面；無法安全清理的素材不使用。
- 若字幕超出場景、旁白長於畫面或音訊混音削波，該 build 判定失敗並重新產生，不以裁切旁白方式掩蓋。
- 若 FFmpeg 或編碼器不可用，停止在 setup 階段，不留下看似完成的空白或無聲 MP4。

## 隱私與正確性

- 不顯示 session ID、Lark record ID、絕對路徑、使用者帳號、token、password、service key 或資料庫連線資訊。
- Lark 只顯示模擬紀錄名稱、`PASS` 與代表性證據縮圖。
- 保留原 session 的事實界線：第一次是 `blocked`；第二次是 `pass`；iOS 26 系統確認提示仍可能出現。
- 不把影片重演紀錄登記為新的 AI QA run，也不更改既有 receipt。
- 所有產品功能敘述以目前 repository README 與實作為準。

## 驗證與驗收

最終 build 必須通過：

1. MP4 可由系統播放器與 FFprobe 解碼。
2. 視訊為 1920×1080、30fps、H.264；包含可播放音軌。
3. 完整片長介於三分四十五秒與四分三十秒。
4. 字幕開始與結束時間有效，沒有字幕超出影片範圍。
5. 每個故事段落抽取至少一張代表影格，檢查裁切、文字、遮蔽、顏色與清晰度。
6. 音訊峰值不削波；旁白清晰高於音樂和提示音。
7. 功能覆蓋表的每個項目都能對應到旁白或畫面。
8. session 案例依序包含 Lark bug、第一次 `blocked`、root cause、bundle-specific routing、`76/76`、第二次 `pass`、report 與 Lark 模擬紀錄。
9. 對輸出影格與字幕執行敏感詞掃描，確認不含 session ID、record ID 或絕對路徑。

## 交付物

- `artifacts/ai-qa-intro/output/ai-qa-intro-zh-TW.mp4`
- 完整台灣華語旁白音檔
- 繁體中文字幕檔
- 旁白稿、場景 manifest 與時間軸
- 每個場景的代表 QA 影格
- 可重新產生影片的製作來源與 build 指令
