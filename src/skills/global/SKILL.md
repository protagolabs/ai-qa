---
name: ai-qa
description: Use when configuring AI QA, manually testing Web behavior, capturing QA evidence, promoting an exploratory run, or replaying a regression case with the ai-qa CLI and platform control tools.
metadata:
  aiQaSkillVersion: 1.1.0
  aiQaProtocolRange: ^1.1.0
  aiQaRecordingReceipt: true
  aiQaManagedChecksum: bundled
---

<!-- ai-qa:managed:start -->

# AI QA Workflow

## Initialize or reconfigure

1. Resolve the exact target project. Never assume an ancestor project when the user names a nested project.
2. Confirm repository trust with the user, then pipe exactly `{"confirmed":true}` to `ai-qa trust confirm --project <path> --stdin-json`; no other stdin fields are accepted. Only then read `.ai-qa/config.yaml`, the canonical Project Skill, or project instructions.
3. Ask how the project currently manages QA results or defects without offering a provider list.
4. When there is no existing process, default to `recordingPolicy.mode: local-only`. When there is an existing procedure, use `project-skill` and encode that procedure exactly in the Project Skill, including its match and rerun rules.
5. Discuss targets, environment, evidence, report, storage, Git, and secret-reference policy. Generate the complete config and Project Skill together, preview the complete change, then apply the resubmitted payload with its confirmed checksum.
6. Use the invariant description `Use when performing Web AI QA.` exactly; do not substitute project data or add a suffix. Build the rest of `projectSkill.content` with the canonical Project Skill wire format in the reference, including compatible metadata, managed and user markers, and a computed managed checksum; prose-only Skill content is not an initialization payload. Before presenting the request, actually execute the managed-checksum algorithm over its final bytes and verify the embedded value; never claim an unverified checksum. Run the complete request through production `initializationRequestSchema` and `prepareProjectSkill()` before presenting it.
7. The host owns permissions and authentication for every external tool. The CLI and this Skill neither acquire credentials nor bypass host approval.
8. Treat the confirmed Project Skill as the reusable project rule for matching later runs; tool approvals remain with the host.

Read `references/web-work-protocol.md` for the complete initialization payload and preview/apply commands.

## Execute Web QA

1. Use Chrome DevTools MCP read-only to observe capability and entry-page readiness, then pipe those observations to `ai-qa doctor --platform web --json --stdin-json`. The CLI does not control the browser.
2. Before an exploratory run, confirm a goal and stable acceptance criteria with required evidence. Accept stored work orders with protocol version `1.0.0` or `1.1.0`; new work orders use `1.1.0`.
3. Before every Chrome DevTools MCP invocation, including read-only observation and screenshot capture, call `ai-qa action plan --run <run-id> [--step <step-id>] --stdin-json` with `tool: "chrome-devtools-mcp"`; after the browser call, use `ai-qa action complete <action-id> --run <run-id> --stdin-json` to record `completed` or `unknown`. Never relabel another controller's output as Chrome DevTools evidence.
4. After an interaction, record its terminal result, then a fresh observation action and observation, then a completed evidence-capture action and `evidence add`, and only then a satisfied assertion. Carry the interaction's returned `payload.stepId` through the observation and capture action plans and `assertion record --step`; every evidence payload uses `sourceTool: "chrome-devtools-mcp"` and cites its completed capture action and fresh observation.
5. Never use a pre-action, stale, or differently sourced screenshot to support `pass`, case promotion, or a verified report claim. A successful tool response alone is insufficient; cite criterion, assertion, observation, and evidence IDs.
6. Retrying an identical initial `verdict set` payload is safe and returns the original event. To cancel, use only `ai-qa run cancel <run-id> --reason <reason>`; never submit `not_verified/cancelled` through `verdict set` or `verdict revise`, and never attach criterion results to cancellation.
7. Promote only complete exploratory runs. Review the generated draft with the user before activation.
8. During regression, follow the pinned work order in order. Recovery actions must reference the affected required step and remain inside the frozen budget.

## Complete and record

1. Finish the run, generate the configured local report, and verify that report before any recording-status or receipt work.
2. Treat `report.not_generated` as a prerequisite: generate the report before querying recording status again.
3. Stop on lifecycle, evidence, report, recording, or storage integrity errors; never report them as `pending` and never submit a receipt before the verified-report boundary succeeds.
4. For `local-only`, show the verified local report paths and end.
5. For `project-skill`, load the trusted canonical Project Skill before recording. After apply, derive the procedure revision only from its installed `metadata.aiQaManagedChecksum`, never from submitted candidate bytes.
6. Let the host execute that Project Skill procedure with host-owned permissions and approvals. Register only the neutral receipt `status` and `references` returned by the host-owned procedure.
7. If an external recording operation has an uncertain result, register `unknown` without retrying it.
8. The recording outcome never changes the QA verdict.

Read `references/web-work-protocol.md` before the first Web run in a project.
<!-- ai-qa:managed:end -->

<!-- ai-qa:user:start -->
<!-- ai-qa:user:end -->
