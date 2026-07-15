---
name: ai-qa
description: Use when configuring AI QA, manually testing Web behavior, capturing QA evidence, promoting an exploratory run, or replaying a regression case with the ai-qa CLI and platform control tools.
metadata:
  aiQaSkillVersion: 1.0.0
  aiQaProtocolRange: ^1.0.0
  aiQaManagedChecksum: bundled
---

<!-- ai-qa:managed:start -->

# AI QA Workflow

Follow this evidence-backed workflow:

1. Resolve the exact target project. Never assume an ancestor project when the user names a nested project.
2. Confirm repository trust with the user, record it through `ai-qa trust confirm --project <path> --stdin-json`, and only then read `.ai-qa/config.yaml`, a project skill, or project instructions.
3. Discuss targets, environment, evidence, report, storage, Git, and secret-reference policy with the user. Pipe only confirmed JSON to `ai-qa init` or `ai-qa configure`.
4. Use Chrome DevTools MCP read-only to observe capability and entry-page readiness, then pipe those observations to `ai-qa doctor --platform web --json --stdin-json`. The CLI does not control the browser.
5. Before an exploratory run, confirm a goal and stable acceptance criteria with required evidence. Reject a returned work order whose protocol version is outside `^1.0.0` before invoking a platform tool.
6. Before every Chrome DevTools MCP invocation, including read-only observation and screenshot capture, call `ai-qa action plan --run <run-id> [--step <step-id>] --stdin-json` with `tool: "chrome-devtools-mcp"`; after the browser call, use `ai-qa action complete <action-id> --run <run-id> --stdin-json` to record `completed` or `unknown`. Never relabel another controller's output as Chrome DevTools evidence.
7. After an interaction, record its terminal result, then a fresh observation action and observation, then a completed evidence-capture action and `evidence add`, and only then a satisfied assertion. Carry the interaction's returned `payload.stepId` through the observation and capture action plans and `assertion record --step`; every evidence payload uses `sourceTool: "chrome-devtools-mcp"` and cites its completed capture action and fresh observation.
8. Never use a pre-action, stale, or differently sourced screenshot to support `pass`, case promotion, or a verified report claim. A successful tool response alone is insufficient; cite criterion, assertion, observation, and evidence IDs.
9. Retrying an identical initial `verdict set` payload is safe and returns the original event. To cancel, use only `ai-qa run cancel <run-id> --reason <reason>`; never submit `not_verified/cancelled` through `verdict set` or `verdict revise`, and never attach criterion results to cancellation.
10. Promote only complete exploratory runs. Review the generated draft with the user before activation.
11. During regression, follow the pinned work order in order. Recovery actions must reference the affected required step and remain inside the frozen budget.

Read `references/web-work-protocol.md` before the first Web run in a project.
<!-- ai-qa:managed:end -->

<!-- ai-qa:user:start -->
<!-- ai-qa:user:end -->
