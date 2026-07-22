# ai-qa

[English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md)

`ai-qa` 是一套由代理协作执行的 QA CLI 与 Agent Skill，支持 Web、iOS Simulator 和 Android Emulator。主机端代理通过已配置的 controller 操作浏览器、Simulator 或 Emulator；CLI 则记录并验证 readiness、action、evidence、assertion、case、verdict、RunGroup 与 report。

不支持实体 iOS 与 Android 设备。

## 系统要求

- Node.js 22 或 24。
- 可使用 Agent Skill，以及各目标平台 controller 的代理主机。
- Web：Chrome DevTools MCP。
- iOS Simulator：Pepper。
- Android Emulator：搭配 UiAutomator2 的 Appium。

## 安装

全局安装公开软件包，然后安装软件包内附的 Agent Skill：

```bash
npm install --global @narra-im/ai-qa
ai-qa --help
ai-qa skill install --global
ai-qa skill check --global
```

Agent Skill 默认安装于 `~/.agents/skills/ai-qa/`。如需使用其他 Agent Skill 根目录，请在 Skill 命令中设置 `AI_QA_AGENTS_HOME`：

```bash
AI_QA_AGENTS_HOME=/custom/agents/home ai-qa skill install --global
AI_QA_AGENTS_HOME=/custom/agents/home ai-qa skill check --global
```

安装软件包绝不会在未告知的情况下覆盖代理指令。如果服务管理的 Skill 内容曾在本地修改，请先检查 install 或 sync 命令返回的差异，再允许替换。

## 快速开始

### 1. 检查目标项目

在你要测试的确切项目中运行 doctor。如果不想切换目录，也可以使用 `--project`。

```bash
cd /path/to/your/project
ai-qa doctor --json
```

第一次使用时，doctor 会返回阻塞流程的 `configure-project` action，因为项目尚未创建 `.ai-qa/config.yaml`。

### 2. 请代理配置 AI QA

安装 AI QA Skill 后，请代理配置当前项目。例如：

> 请为这个项目配置 AI QA，平台使用 Web 与 iOS Simulator，报告只保留在本地。

代理会收集已部署平台的配置，并要求明确选择 recording policy。写入任何内容前，它会验证并显示完整的 `.ai-qa/config.yaml` 与 `.agents/skills/ai-qa-project/SKILL.md` 提案。一次确认会同时应用两个文件；取消则完全不写入。

### 3. 请代理执行 QA

每次请求都要从已配置的平台中选择非空子集。例如：

> 请在 Web 执行登录功能的探索式 QA。有效用户应该在没有错误的情况下进入仪表盘。

也可以重放已审查的回归测试范围：

> 请在 Web 与 iOS Simulator 执行所有已启用的登录回归测试 case。

代理会调用各平台的 controller。CLI 本身不会点击、输入、启动 App 或截取画面；它会记录代理规划及完成的 controller 调用，并验证 evidence chain。

### 4. 生成报告

代理通常会在 run 结束时生成并验证报告。你也可以使用 ID 重新生成及导出报告：

```bash
ai-qa report generate <run-id>
ai-qa report export <run-id> --adapter project-local
```

通过验证的 run report 存储在 `.ai-qa/reports/runs/`，RunGroup report 则存储在 `.ai-qa/reports/groups/`。

## 使用方法

一般用户只需要向已安装 AI QA Skill 的代理描述 QA 目标与验收条件。以下较底层的命令说明主机端代理通过 CLI 记录的工作流程。

### 配置项目

先运行 `ai-qa doctor --json`。缺少 config 是第一次使用时的阻塞条件。配置流程必须：

1. 选择一组非空的已部署平台。
2. 收集每个所选平台的 target 与 controller 配置。
3. 明确选择 `recordingPolicy.mode`；`local-only` 与 `project-skill` 都不是默认值。
4. 起草并验证 schema-3 config 与项目所拥有的 Agent Skill。
5. 显示完整提案内容或差异，并取得一次确认。
6. 一次写入两个文件，并对所有已配置平台运行 doctor。

`targets` 与 `tools` 必须包含完全相同的平台 key。以下是部分 schema 片段，不是完整的项目 config：

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

完整 config 还包含 `project`、`environments`、`evidencePolicy`、`reportPolicy`、`recordingPolicy`、`storagePolicy`、`gitPolicy`、`ciPolicy` 与 `secretReferences`。Config 可以指定存放 secret 的环境变量名称，但绝不能包含实际凭证。

### 检查平台就绪状态

主机端先使用平台 controller 检查 readiness，再将记录到的 observation 提供给 doctor：

```bash
ai-qa doctor --platform web --json --stdin-json
ai-qa doctor --platform ios-simulator --json --stdin-json
ai-qa doctor --platform android-emulator --json --stdin-json
```

配置决定哪些平台可用；每个 QA 请求则另外选择要执行的已配置平台子集。

### 执行探索式 QA

为每个所选平台启动一个该平台专属的 run：

```bash
ai-qa run start --kind exploratory --platform ios-simulator --execution local --stdin-json
```

每次 controller 交互、observation 与截图前，都要记录 `ai-qa action plan`；完成后则使用 `ai-qa action complete` 记录唯一一个终止结果。交互后，同一个 step 必须包含新的 observation，以及由已配置 controller 新注册的 evidence，才能将 assertion 记录为已满足。

设置有 evidence 链接的 verdict、完成 run，再生成并验证报告。多平台探索式 QA 使用彼此独立的 run，不使用 RunGroup。

### 将探索式 run 提升为回归测试 case

审查完整的探索式 run 后，创建并启用其不可变的平台 variant：

```bash
ai-qa case draft --from-run <run-id> --stdin-json
ai-qa case validate login --revision <revision>
ai-qa case activate login --revision <revision> --stdin-json
```

Draft 只会新增或替换来源 run 的平台 variant，并保留其他平台的 variant。

### 重放回归测试 case

在一个已配置的平台运行一个已启用的 case variant：

```bash
ai-qa run start --kind regression --case login --platform ios-simulator --execution local --stdin-json
```

代理会依次执行固定 variant 的 step，并遵守与探索式 QA 相同的交互后新鲜 evidence 要求。

### 使用 RunGroup 执行多平台回归测试

运行组（RunGroup）只用于回归测试。选择明确的 case 或所有已启用 case，并列出确切的平台子集：

```bash
ai-qa run-group start --case login \
  --platform ios-simulator android-emulator \
  --execution local --stdin-json

ai-qa run-group start --all-active \
  --platform web ios-simulator android-emulator \
  --execution ci --stdin-json

ai-qa run-group finish <group-id>
```

Manifest 会冻结 case revision、platform variant、selection 与 budget。所选平台缺少 variant 时会成为 `coverage_gap`，而不是 child run。汇总 matrix 会保留每个 case/platform cell，且不会合成 QA verdict。

### 生成报告并记录结果

针对单个 run 生成、导出报告，并检查 recording status：

```bash
ai-qa report generate <run-id>
ai-qa report export <run-id> --adapter project-local
ai-qa report recording-status <run-id>
```

针对 RunGroup：

```bash
ai-qa report group-generate <group-id>
ai-qa report group-export <group-id> --adapter project-local
ai-qa report group-recording-status <group-id>
```

使用 `local-only` 时，报告通过验证的本地路径后即停止。使用 `project-skill` 时，主机端只有在报告验证完成后，才会执行项目冻结的 recording procedure，接着提交包含 opaque reference 的中性 receipt：

```bash
printf '%s\n' '{"status":"recorded","references":["docs/qa.md#run"]}' \
  | ai-qa report receipt <run-id> --stdin-json

printf '%s\n' '{"status":"recorded","references":["docs/qa.md#group"]}' \
  | ai-qa report group-receipt <group-id> --stdin-json
```

Receipt status 可以是 `recorded`、`not_recorded` 或 `unknown`。外部记录操作结果为 `unknown` 时，绝不能重试。Recording 不会更改 run verdict 或汇总 matrix cell。

## 项目数据与权限边界

每个目标项目都拥有自己的 `.ai-qa/config.yaml`、case、run、RunGroup、evidence、report 与 recording receipt。项目所拥有的 `.agents/skills/ai-qa-project/SKILL.md` 可定义现有的结果管理流程；它不会授予 CLI controller 或外部系统访问权限。

主机端代理拥有项目访问权、操作权限、身份验证状态、controller session 与文件写入权。CLI 只验证及记录主机端提供的 event，绝不调用 Chrome DevTools MCP、Pepper、Appium 或 UiAutomator2。

## 清除项目数据

移除项目配置，但保留 case、run、evidence 与 report：

```bash
ai-qa clear
ai-qa --project /exact/project/path clear
```

这会立即移除 `.ai-qa/config.yaml` 与完整的 `.agents/skills/ai-qa-project/` 目录。命令具有幂等性，且不会要求确认。

如果还要删除所有项目内的 AI QA 记录，包括 case、run、RunGroup、evidence、report 与 recording receipt：

```bash
ai-qa clear --records
```

`--records` 会立即移除完整的 `.ai-qa/` 目录，其他 project skill 不受影响。

如果 clear 报告 `storage.recovery_required`，请先检查并手动处理项目相对路径 `recoveryPath`，再重试。Clear 绝不会自动删除、还原或继续执行保留的 recovery entry。

## 开发

源代码开发要求：Node.js 22 或 24，以及 pnpm 11.9.0。

```bash
corepack enable
pnpm install
pnpm check
pnpm build
```

软件包内附的 Skill 版本为 `2.0.0`，接受 work protocol `^2.0.0`。经确认的 sync 会安装正好四个服务管理的 reference：shared protocol，以及 Web、iOS Simulator、Android Emulator controller guide。Managed marker 以外的用户内容会保留。

## 实际验收

- [Web](docs/validation/web-live-acceptance.md)
- [iOS Simulator](docs/validation/ios-simulator-live-acceptance.md)
- [Android Emulator](docs/validation/android-emulator-live-acceptance.md)
- [Multi-platform](docs/validation/multi-platform-live-acceptance.md)
