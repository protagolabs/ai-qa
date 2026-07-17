# iOS Simulator Live Acceptance

This release gate requires the actual `pepper` controller and an iOS Simulator. Physical iPhones and iPads are unsupported.

## Preconditions

- Install and check bundled Skill `2.0.0` / protocol `^2.0.0`.
- Configure schema 3 with the bundle ID, `booted` or named Simulator selection, and `tools.ios-simulator.controller: pepper`.
- Run `doctor --platform ios-simulator --json --stdin-json` with host-recorded Simulator, app, and Pepper readiness. The evidence must identify a virtual Simulator; require `ready`.

## Evidence-backed vertical slice

1. Start an iOS Simulator exploratory run with stable criteria.
2. Record `action plan`, invoke Pepper through the host, and record `action complete` for every launch, interaction, observation, and screenshot.
3. After the interaction, add a fresh same-step observation and register a Pepper screenshot with `sourceTool: pepper`.
4. Record evidence-linked satisfied assertions, set `pass`, and finish.
5. Generate/export and verify the exploratory report.
6. Draft the iOS Simulator variant into the logical case without replacing other platform variants; review, validate, and activate.
7. Start an explicit `--platform ios-simulator` regression, replay the pinned steps with fresh Pepper evidence, finish, and generate/export the report.
8. Verify recording status or submit the neutral project-skill receipt after the verified report.

## Required proof

- Simulator identity, bundle ID, doctor result, exploratory/regression IDs, active revision and iOS variant hash.
- Complete two-phase action chain, fresh observation, Pepper screenshot path/hash, assertions, verdict, and verified reports.
- No physical-device identifier, fallback, or evidence.
