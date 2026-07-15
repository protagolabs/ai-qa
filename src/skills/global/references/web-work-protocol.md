# Web Work Protocol

## Initialization contract

Ask how the project already manages QA results or defects. If no process exists, choose `recordingPolicy.mode: local-only`. If one exists, choose `project-skill` and put the exact procedure in `projectSkill.content`; do not replace it with a different workflow.

Before any project read, record the user's trust confirmation with this exact single-field stdin object:

<!-- canonical-trust-confirm:start -->

```text
{"confirmed":true}
```

<!-- canonical-trust-confirm:end -->

```text
printf '%s\n' '{"confirmed":true}' | ai-qa trust confirm --project <path> --stdin-json
```

The trust input schema is strict: `confirmed` must be literal `true`, and no other stdin fields are accepted.

### Project Skill wire contract

`projectSkill.content` is a complete managed Skill source, not a prose-only Skill body. Generate it in this order:

1. Use the fixed `name: ai-qa-project`. Include metadata `aiQaProjectSkillVersion: 1.0.0`, an `aiQaProtocolRange` containing `1.1.0`, and `aiQaManagedChecksum`.
2. Start `description` with `Use when `. Make its primary trigger start with an `-ing` word. An optional `, including ` suffix may contain only short noun trigger contexts separated by commas, with `and` or `or` only on the last item. Put commands in the body, never in the description.
3. Put each marker below exactly once, after frontmatter, in managed-start, managed-end, user-start, user-end order. Put generated project procedures inside the managed region. Start with an empty user region; sync preserves an installed user region byte-for-byte.
4. Keep the combined managed and user body at or below 500 lines and 5,000 words. Use only configured environment-variable names for secret references and never put a literal secret in the Skill.
5. Compute the managed checksum after the other frontmatter and managed content are final. Parse frontmatter as a YAML mapping, remove only `metadata.aiQaManagedChecksum`, serialize the full mapping with sorted map entries, normalize managed-region CRLF to LF, and SHA-256 `normalizedFrontmatter + "\n" + normalizedManagedRegion`. In JavaScript, the checksum operation is:

```js
import { createHash } from "node:crypto";
import { stringify } from "yaml";

const metadata = { ...frontmatter.metadata };
delete metadata.aiQaManagedChecksum;
const normalizedFrontmatter = stringify(
  { ...frontmatter, metadata },
  { sortMapEntries: true },
);
const managedLf = managedRegion.replace(/\r\n/g, "\n");
const checksum = createHash("sha256")
  .update(`${normalizedFrontmatter}\n${managedLf}`)
  .digest("hex");
```

The preview path repeats this calculation and returns canonical `projectSkill.content` with the computed managed checksum. A submitted managed checksum is not trusted. After any source change, recalculate it and preview the complete request. The preview's top-level setup checksum is separate: apply by resubmitting the original request unchanged with that setup checksum; do not replace the apply request with preview-normalized content.

This provider-neutral example is a complete CLI-valid wire artifact:

<!-- canonical-project-skill:start -->

```markdown
---
name: ai-qa-project
description: Use when performing Sample Web AI QA, including evidence, reports, or result recording.
metadata:
  aiQaProjectSkillVersion: 1.0.0
  aiQaProtocolRange: ^1.1.0
  aiQaManagedChecksum: 74da8973832c3263eca6b23b0661470997e10f815c68455622c831742a1c7f8f
---

<!-- ai-qa:managed:start -->

# Sample Web Project Procedures

## Match

Apply only to the trusted project root `/workspace/sample-web` with project ID `sample-web`.

## Web target

Use the confirmed entry URL `http://127.0.0.1:3000` and `chrome-devtools-mcp`.

## Evidence and reports

Require internal screenshots, retain them for 30 days, and generate full Markdown and JSON engineering reports in project-local storage.

## Result recording

Use local-only recording. After the local report is generated and verified, show its paths and end without creating an external record or receipt.

## Reruns

Match this exact project and target. Create fresh observations, evidence, and reports for every rerun.
<!-- ai-qa:managed:end -->
<!-- ai-qa:user:start -->
<!-- ai-qa:user:end -->
```

<!-- canonical-project-skill:end -->

Build one complete request with these top-level fields:

```json
{
  "config": {
    "schemaVersion": 2,
    "recordingPolicy": { "mode": "local-only" },
    "project": { "id": "<stable-id>", "name": "<name>" },
    "targets": { "web": { "entryUrl": "<confirmed-url>" } },
    "environments": {},
    "tools": { "web": { "controller": "chrome-devtools-mcp" } },
    "evidencePolicy": {
      "screenshots": "required",
      "defaultSensitivity": "internal",
      "retentionDays": 30
    },
    "reportPolicy": {
      "formats": ["markdown", "json"],
      "audience": "engineering",
      "detail": "full"
    },
    "storagePolicy": { "adapter": "project-local" },
    "gitPolicy": { "config": "track", "artifacts": "ignore" },
    "ciPolicy": { "nonPassExit": "failure" },
    "secretReferences": {}
  },
  "projectSkill": {
    "reason": "<why these project procedures are canonical>",
    "content": "<complete ai-qa-project Skill; include the exact result-recording procedure when mode is project-skill>"
  }
}
```

Use confirmed project-specific values rather than copying example defaults blindly. Preview and apply the same complete request:

```text
ai-qa init --project <path> --stdin-json --preview
ai-qa init --project <path> --stdin-json --confirm-checksum <preview-checksum>
```

For an existing setup, use the equivalent `ai-qa configure` preview/apply pair. The approval decision contains the chosen recording mode, full config, complete Project Skill, preview/apply commands, and the statement that permissions, authentication, and tool approvals stay with the host. Present the diff and checksum for confirmation before applying. The confirmed canonical Project Skill is the reusable rule for later matching runs.

## Controller provenance

- Every Web `ai-qa action plan --run <run-id> [--step <step-id>] --stdin-json` body uses `tool: "chrome-devtools-mcp"`.
- Every `ai-qa evidence add --run <run-id> --file <path> --stdin-json` body uses `sourceTool: "chrome-devtools-mcp"`, matching its completed `evidence-capture` action.
- Do not relabel output from another controller as Chrome DevTools evidence. HTTP checks, generic browser tools, Playwright, modeled events, and stale screenshots do not satisfy this provenance contract.

## Post-action evidence

For an exploratory interaction, retain the returned `payload.stepId`. For a regression interaction, use the required step ID from the pinned work order. Then keep this exact order on that one step:

1. Plan the interaction with `action plan`, invoke Chrome DevTools MCP, and record its terminal result with `ai-qa action complete <action-id> --run <run-id> --stdin-json`.
2. Plan a new observation action with `action plan --step <step-id>`, invoke Chrome DevTools MCP, record its completed terminal result, then write the fresh state with `ai-qa observation add --run <run-id> --stdin-json`.
3. Plan an `evidence-capture` action with `action plan --step <step-id>`, invoke Chrome DevTools MCP, record its completed terminal result, then register the raw file with `evidence add`. The evidence payload cites that capture action and the fresh observation ID; `evidence add` has no `--step` option.
4. Record the satisfied assertion with `ai-qa assertion record --run <run-id> --step <step-id> --stdin-json`, citing the same fresh observation and evidence IDs.

Evidence captured before the asserted interaction, before its terminal result, or before the fresh post-action observation cannot support a `pass`, case promotion, or a verified report claim. An unresolved `unknown` action must follow the recovery protocol and cannot satisfy this chain.

## Exploratory

1. Discuss goal, criterion IDs, descriptions, and required evidence.
2. Start with `ai-qa run start --kind exploratory --platform web --execution local --stdin-json`.
3. Capture initial browser state with Chrome DevTools MCP and register it.
4. For each browser operation: plan action, invoke MCP, complete or mark unknown, observe, assert, and register evidence.
5. Set one evidence-backed verdict and finish the run.

## Promotion

1. Build the draft payload only from recorded action, observation, assertion, and evidence IDs.
2. Run `ai-qa case draft --from-run <run-id> --stdin-json` with the reviewed payload on stdin.
3. Validate and activate the immutable revision after user review.

## Regression

1. Start the active case on Web and retain the returned work order.
2. Execute required steps in order. Use only step-linked bounded recovery.
3. Finish only after every criterion cites assertion and evidence IDs.
4. Complete the verified-report and recording procedure below.

## Verified report and recording

At regression completion:

```text
generate verified local report
├── recordingPolicy.mode = local-only     -> show local paths and end
└── recordingPolicy.mode = project-skill  -> load trusted Project Skill
                                             -> host executes procedure
                                             -> register neutral receipt
```

1. Run `ai-qa report generate <run-id>` and retain its local paths.
2. Run `ai-qa report recording-status <run-id>` only after generation. If it returns `report.not_generated`, generate the report before retrying the status query.
3. If lifecycle, evidence, report, recording, or storage integrity validation fails, stop and surface that error. It is not `pending`, and receipt submission is forbidden until report verification succeeds.
4. For `local-only`, show the local paths and end.
5. For `project-skill`, load the trusted canonical `.agents/skills/ai-qa-project/SKILL.md`. The host executes its exact procedure with host-owned permissions, authentication, and approvals.
6. Register only protocol metadata plus the neutral outcome through `ai-qa report receipt <run-id> --stdin-json`:

```json
{
  "idempotencyKey": "recording:<run-id>:<procedure-revision>",
  "status": "recorded",
  "references": ["<stable project reference>"]
}
```

Use `not_recorded` with an empty reference list when the host confirms no record was made. Use `unknown` with an empty reference list when a submitted external operation returns no certain result; do not retry that operation. The receipt contains no provider payload, and its outcome never revises the QA verdict.

## Verdict taxonomy

- `pass`: every required criterion is supported by recorded assertions, observations, and evidence IDs. A successful tool response alone is insufficient.
- `fail`: observed product behavior contradicts a criterion. Cite the contradicting observation, assertion, and evidence; never invent IDs.
- `blocked`: a concrete tool, permission, environment, data, or evidence-capture blocker prevents required coverage. Record the blocker separately; it is not a product failure, and the run must not be finished as failed.
- `not_verified`: required coverage is missing without a concrete external blocker. Do not promote or claim `pass`.

## Cancellation and retries

- Retrying an identical initial `ai-qa verdict set --run <run-id> --stdin-json` payload is safe and returns the original verdict event. A different correction uses `verdict revise --supersedes <verdict-id>` before finish.
- Cancel only with `ai-qa run cancel <run-id> --reason <reason>`. Never submit `classification: "not_verified", reasonCode: "cancelled"` through `verdict set` or `verdict revise`.
- Cancellation is lifecycle-owned. The CLI creates its canonical `not_verified/cancelled` verdict with `criterionResults: []`; do not attach partial, failed, or synthetic criterion results.

## Safety

- Do not retry destructive or externally visible operations after an unknown result until a fresh observation resolves whether the action applied.
- Never convert a tool, permission, environment, data, or evidence-capture blocker into product `fail`.
- Never convert missing coverage into `pass` or invent assertion, observation, or evidence IDs.
