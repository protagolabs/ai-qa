# Web Work Protocol

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
4. Generate Markdown and JSON reports and show their project-local paths.

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
