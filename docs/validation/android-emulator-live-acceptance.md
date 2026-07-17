# Android Emulator Live Acceptance

This release gate requires actual Appium with `uiautomator2` and an Android Emulator. Physical Android devices are unsupported.

## Preconditions

- Install and check bundled Skill `2.0.0` / protocol `^2.0.0`.
- Configure schema 3 with package, activity, running or named AVD selection, Appium endpoint, and `automationName: uiautomator2`.
- Run `doctor --platform android-emulator --json --stdin-json` with host-recorded Emulator, app, Appium, and UiAutomator2 readiness. Require `ready` and virtual target identity.

## Evidence-backed vertical slice

1. Start an Android Emulator exploratory run with stable criteria.
2. Record `action plan`, invoke Appium through the host, and record `action complete` for every launch, interaction, observation, and screenshot.
3. After the interaction, add a fresh same-step observation and register an Appium screenshot with `sourceTool: appium`.
4. Record evidence-linked satisfied assertions, set `pass`, and finish.
5. Generate/export and verify the exploratory report.
6. Draft the Android Emulator variant into the logical case without replacing other variants; review, validate, and activate.
7. Start an explicit `--platform android-emulator` regression, replay pinned steps with fresh Appium evidence, finish, and generate/export the report.
8. Verify recording status or submit the neutral project-skill receipt after the verified report.

## Required proof

- AVD identity, package/activity, Appium/UiAutomator2 doctor result, run IDs, active revision and Android variant hash.
- Complete two-phase chain, fresh observation, Appium screenshot path/hash, assertions, verdict, and verified reports.
- No USB/network physical-device fallback or evidence.
