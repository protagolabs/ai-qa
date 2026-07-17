# Android Emulator Controller

Controller: `appium` with `uiautomator2`. Physical Android devices are unsupported.

Configure `targets.android-emulator.appPackage`, `appActivity`, and an Emulator selection of `running` or `avd-name`. Configure `tools.android-emulator` with `controller: appium`, `automationName: uiautomator2`, and the Appium endpoint.

Doctor requires host-recorded evidence that the selected target is an Emulator, the configured package is available, Appium is ready, and UiAutomator2 is ready. Reject any observation that identifies a real device.

Use the selected Emulator, package, and activity. Treat a different AVD, package, activity, driver session, or pre-run screen as stale. Plan every launch, interaction, observation, and screenshot before the host invokes Appium; complete it afterward. Capture screenshots through Appium and register them with `sourceTool: appium`.

On a stale driver/session, freshly observe Emulator and app identity before creating a replacement session. Recover only within the work-order budget; never fall back to a USB or network-connected physical device.
