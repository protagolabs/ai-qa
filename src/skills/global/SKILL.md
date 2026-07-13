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
6. Before every Chrome DevTools MCP invocation, including read-only observation and screenshot capture, call `ai-qa action plan`; after the browser call, record `completed` or `unknown` before continuing. This is how the CLI enforces the frozen tool-call budget.
7. Record before/after observations, assertions, screenshots, recovery decisions, blockers, and the verdict through typed CLI commands.
8. Never claim `pass` from a successful tool response alone. Cite criterion, assertion, observation, and evidence IDs.
9. Promote only complete exploratory runs. Review the generated draft with the user before activation.
10. During regression, follow the pinned work order in order. Recovery actions must reference the affected required step and remain inside the frozen budget.

Read `references/web-work-protocol.md` before the first Web run in a project.
<!-- ai-qa:managed:end -->

<!-- ai-qa:user:start -->
<!-- ai-qa:user:end -->
