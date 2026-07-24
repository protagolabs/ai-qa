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

请在你要测试的确切项目中运行 AI QA。一般情况下，人类只需向代理描述工作；代理会使用已安装的 Skill、平台 controller 与 CLI。

先请代理配置项目：

> 请为这个项目配置 AI QA。已部署的平台是 Web 与 iOS Simulator。报告只保留在本地。写入任何内容前，先向我显示完整的文件提案。

配置完成且 readiness 检查通过后，再要求执行 QA：

> 请在 Web 探索登录功能。从登录页开始，并使用有效的测试账号。成功登录后必须进入仪表板，且不能出现错误。报告只保留在本地，并向我显示 verdict 与其证据。

代理会处理 readiness、controller 操作、evidence、verdict 与报告生成。

## 如何向 AI QA 下指令

一个实用的请求会说明：

- **平台：** 本次要执行哪些已配置的 Web、iOS Simulator 或 Android Emulator。
- **目标：** 想验证的用户行为或产品结果。
- **前置条件：** 起始画面、登录状态、功能标志或必要数据。
- **验收条件：** 能够观察并判定成功或失败的结果。
- **测试数据：** 账号或数据要求；请引用 secret，而不要提供实际凭证。
- **结果处理：** 将验证过的报告保留在本地，或使用已批准的项目记录流程。

你不需要提供 work-order JSON、action ID、evidence ID、verdict payload 或 case revision。描述想要的结果即可，代理会管理协议细节。

## Prompt 示例

### 配置项目

> 请为这个项目配置 AI QA。Web 已部署在 `https://example.test`，报告应只保留在本地。请检查项目、显示完整的 config 与 project Skill 提案，并在写入前等待我确认。

### 探索功能

> 请在 iOS Simulator 探索重置密码功能。从登录画面开始，使用能接收重置链接的测试账号。用户必须能请求重置密码并在没有错误的情况下进入确认状态。请捕获证据并返回验证过的报告。

### 修复前重现 Bug

> 请在 Web 重现修复前的 BUG-123。从登录页开始，并使用有效的测试账号。提交有效账号密码后应进入仪表板，但报告的实际行为是仍停留在登录页。请保留有证据支持的 fail baseline，并向我显示报告。

### 验证已部署的 Bug 修复

> BUG-123 已修复并部署。请在 Web 使用相同的前置条件与验收条件创建新的 run。验证有效登录会在没有错误的情况下进入仪表板。请将此结果与修复前的 run 分开保存，并向我显示新报告。

### 创建回归测试 case

> 我已审查通过的 BUG-123 结果。请将它准备成 regression case `bug-123-sign-in`，向我显示 case 提案，并只在我确认后启用。

### 在单个平台重放回归测试

> 请在 Web 重放已启用的 `bug-123-sign-in` regression case，并返回验证过的报告。

### 在多平台重放回归测试

> 请在 Web 与 iOS Simulator 重放所有已启用的登录 regression case。报告每个 case／platform 结果与所有 coverage gap。

Bug 验证会分别使用修复前与修复后的 run。失败的 run 会保留为重现记录；只有具有有效证据且通过的 run 能启用为 regression case。

## Agent 操作指南

负责执行上述请求的 Agent 应阅读 [AI QA Agent Workflow](docs/agent-workflow.md)。该文件会将人类请求对应至项目配置、controller 操作、CLI lifecycle、evidence、case、RunGroup、report、recording、repair 与 cleanup。已安装的 AI QA Agent Skill 仍是正式规则来源。

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
