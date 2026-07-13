# Web Work Protocol

## Exploratory

1. Discuss goal, criterion IDs, descriptions, and required evidence.
2. Start with `ai-qa run start --kind exploratory --platform web --execution local --stdin-json`.
3. Capture initial browser state with Chrome DevTools MCP and register it.
4. For each browser operation: plan action, invoke MCP, complete or mark unknown, observe, assert, and register evidence.
5. Set one evidence-backed verdict and finish the run.

## Promotion

1. Build the draft payload only from recorded action, observation, assertion, and evidence IDs.
2. Run `ai-qa case draft --from-run <run-id>` with the reviewed payload on stdin.
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

## Safety

- Do not retry destructive or externally visible operations after an unknown result until a fresh observation resolves whether the action applied.
- Never convert a tool, permission, environment, data, or evidence-capture blocker into product `fail`.
- Never convert missing coverage into `pass` or invent assertion, observation, or evidence IDs.
