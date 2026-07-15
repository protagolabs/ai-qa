# Web Work Protocol

## Initialization contract

Ask how the project already manages QA results or defects. If no process exists, choose `recordingPolicy.mode: local-only`. If one exists, choose `project-skill` and put the exact procedure in `projectSkill.content`; do not replace it with a different workflow.

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
