# Web Controller

Controller: `chrome-devtools-mcp`.

Configure `targets.web.entryUrl` and optional `readinessUrl`; configure `tools.web.controller: chrome-devtools-mcp`. Doctor records entry-page or readiness-URL availability plus host-observed controller readiness.

Use a current browser page/session for the configured URL. Treat a page from another origin, target, or earlier run as stale. Plan each navigation, interaction, observation, and screenshot action before the host invokes Chrome DevTools MCP; complete it afterward. Capture screenshots through that controller and register them with `sourceTool: chrome-devtools-mcp`.

On a stale or lost page, observe current browser state first. Reacquire the configured URL only within the run's recovery budget. Do not replace controller evidence with HTTP checks or a generic browser.
