# iOS Simulator Controller

Controller: `pepper`. Physical iPhones and iPads are unsupported.

Configure `targets.ios-simulator.bundleId` and a Simulator selection of `booted` or `device-name`; optional launch settings may name a build command and arguments. Configure `tools.ios-simulator.controller: pepper`.

Doctor requires host-recorded evidence that the selected target is a Simulator, the configured app is available, and Pepper is ready. Reject any observation that identifies a real device.

Use the selected Simulator and configured bundle ID. Treat a different Simulator, bundle, app instance, or pre-run screen as stale. Plan every launch, interaction, observation, and screenshot before the host invokes Pepper; complete it afterward. Capture screenshots through Pepper and register them with `sourceTool: pepper`.

On stale session or app loss, freshly observe the Simulator and app identity. Relaunch or reacquire only within the recovery budget; never fall back to a physical device.
