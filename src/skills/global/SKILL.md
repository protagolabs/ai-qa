---
name: ai-qa
description: Use when configuring AI QA, testing Web or virtual mobile app behavior, capturing evidence, promoting platform case variants, replaying regressions, or reporting selected multi-platform runs with the ai-qa CLI.
metadata:
  aiQaSkillVersion: 2.0.0
  aiQaProtocolRange: ^2.0.0
  aiQaRecordingReceipt: true
  aiQaManagedChecksum: bundled
---

<!-- ai-qa:managed:start -->

# AI QA Workflow

AI QA supports exactly web, ios-simulator, and android-emulator. Real devices are unsupported. The host owns project access, permissions, authentication, platform controllers, and file writes. The CLI never invokes controllers; it validates and records host-supplied readiness, actions, evidence, verdicts, cases, RunGroups, reports, and recording receipts.

## Configure a project

1. Resolve the exact project root and run `ai-qa doctor --json`. Treat `requiredAction.kind: configure-project` as a blocking first-use gate.
2. Inspect project-owned instructions and derive only unambiguous values. Ask for a non-empty deployed platform selection, then collect every selected platform's required configuration. Never configure a physical iOS or Android device.
3. Inspect existing result-management procedures. Always ask the user to explicitly choose `recordingPolicy.mode`; neither `local-only` nor `project-skill` has a default. Select `project-skill` only after the user confirms the exact existing procedure.
4. Draft the complete schema 3 config and project-owned `.agents/skills/ai-qa-project/SKILL.md` together. Use `skill-creator` for the Project Skill. Keep literal secrets out; config may name environment variables.
5. Run `ai-qa config validate --stdin-json`, validate the scratch Project Skill, and verify exact-root, target/parent symlink, and secret safety.
6. The host displays both complete diffs. Obtain one confirmation, then write both files once and create the canonical `.ai-qa/` directories. If the user cancels, write nothing.
7. Run doctor for every configured platform. Resume QA only when every requested platform is ready.

Read [shared-work-protocol.md](references/shared-work-protocol.md) for setup, lifecycle, evidence, case, RunGroup, report, and recording contracts.

## Execute selected platforms

Before starting work, ask which configured platform subset the user wants now. Accept any non-empty subset of one, two, or three configured platforms. Configuration does not select execution platforms.

For each selected platform:

1. Read its controller reference and obtain host-recorded readiness.
2. Start a platform-owned exploratory run or regression. One run has one platform, work order, journal, evidence directory, verdict, and report.
3. Follow the shared two-phase action and fresh post-action evidence chain. Invoke the controller only through the host, never through the CLI.
4. Promote reviewed exploratory work incrementally into the matching immutable platform variant.

Use [web-controller.md](references/web-controller.md) for Web, [ios-simulator-controller.md](references/ios-simulator-controller.md) for iOS Simulator, and [android-emulator-controller.md](references/android-emulator-controller.md) for Android Emulator.

For multiple selected platforms, start a RunGroup with the explicit subset. Missing selected case variants are coverage gaps, not child runs. Generate and verify every child report before the aggregate report. An aggregate report preserves the complete matrix and never synthesizes a QA verdict.

<!-- ai-qa:managed:end -->

<!-- ai-qa:user:start -->
<!-- ai-qa:user:end -->
