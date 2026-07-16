---
name: ai-qa
description: Use when configuring AI QA, manually testing Web behavior, capturing QA evidence, promoting an exploratory run, or replaying a regression case with the ai-qa CLI and platform control tools.
metadata:
  aiQaSkillVersion: 1.2.0
  aiQaProtocolRange: ^1.2.0
  aiQaRecordingReceipt: true
  aiQaManagedChecksum: bundled
---

<!-- ai-qa:managed:start -->

# AI QA Workflow

## Initialize or update a project

1. Resolve the exact target project. Never substitute an ancestor for a named nested project.
2. Confirm repository trust with the user, then pipe exactly `{"confirmed":true}` to `ai-qa trust confirm --project <path> --stdin-json`; no other stdin fields are accepted. Read project files only after trust is recorded.
3. Before drafting, run the applicable installation doctor and host-visible checks; treat a missing config as `uninitialized`, then discuss startup, targets, environments, authentication/test data, evidence, retention, reports, reruns, Git, CI, secrets, and result recording.
4. Ask how the project already manages QA results or defects without offering a provider list. When no existing result-management procedure exists, use `recordingPolicy.mode: local-only`; do not choose a provider from available tools. Otherwise use `project-skill` and preserve the existing procedure, including match and rerun rules.
5. Draft the complete schema-v2 config and Project Skill together. Use `skill-creator` to create or update `.agents/skills/ai-qa-project/SKILL.md` in scratch space before target write. The target Project Skill is project-owned; do not add AI-QA managed/user markers or an embedded AI-QA checksum.
6. Run `ai-qa config validate --stdin-json` as a read-only config check. Validate the scratch Project Skill with `skill-creator`.
7. Before confirmation or write, reject literal secrets and unsupported secret handling, and verify both target files are inside the exact project root and are not symlink targets.
8. Codex validates the config and Project Skill, displays both complete diffs, obtains one confirmation, then writes both project files. On initialization, also create `.ai-qa/cases`, `.ai-qa/runs`, `.ai-qa/evidence`, and `.ai-qa/reports/runs` as project-local directories.
9. Run `ai-qa doctor --json` after the host-managed write. Stop and report any installation failure before Web QA.
10. Permissions, authentication, file writes, and external tools remain host-owned.

Read `references/web-work-protocol.md` for the exact host-managed sequence and Project Skill body example.

## Execute Web QA

1. Run the doctor with host-observed readiness data. The CLI reports readiness; it does not control the browser.
2. Before an exploratory run, confirm a goal and stable acceptance criteria with required evidence. Historical work orders may use protocol `1.0.0` or `1.1.0`; new work orders use `1.2.0`.
3. Before every controller invocation, including observation and screenshot capture, call `ai-qa action plan --run <run-id> [--step <step-id>] --stdin-json`; after the controller call, use `ai-qa action complete <action-id> --run <run-id> --stdin-json` to record `completed` or `unknown`.
4. After an interaction, record its terminal result, a fresh step-linked observation, a completed evidence-capture action, and the evidence before recording a satisfied assertion. Cite the criterion, assertion, observation, and evidence IDs.
5. Never use pre-action, stale, or differently sourced evidence to support `pass`, case promotion, or a verified report.
6. Cancel only with `ai-qa run cancel <run-id> --reason <reason>`. Promote only complete exploratory runs after user review. During regression, follow the pinned work order in order and keep recovery within its budget.

## Complete and record

1. Finish the run, generate the configured local report, and verify it before recording-status or receipt work.
2. Treat `report.not_generated` as a prerequisite. Stop on lifecycle, evidence, report, recording, or storage integrity errors; do not call them `pending` or submit a receipt.
3. For `local-only`, show the verified local report paths and end.
4. For project-skill runs, execute the exact Project Skill procedure only after a verified report and submit only status/references.
5. Let the host perform that procedure with its own permissions and approvals. Never retry an external result-recording operation submitted as `unknown`; scope observation-gated recovery to non-recording Web actions.
6. Never change the QA verdict because of the recording outcome.

Read `references/web-work-protocol.md` before the first Web run in a project.
<!-- ai-qa:managed:end -->

<!-- ai-qa:user:start -->
<!-- ai-qa:user:end -->
