import { join } from "node:path";
import type { Command } from "commander";
import type { RunEvent } from "../../core/runs/schema.js";
import { resolveTrustedProject } from "../../services/project-root/resolve-trusted-project.js";
import { RunProtocolService } from "../../services/run-protocol/run-protocol-service.js";
import type { CliContext } from "../context.js";
import { writeJson } from "../io.js";

export async function createRunProtocolService(
  command: Command,
  context: CliContext,
  runId: string,
): Promise<RunProtocolService> {
  const home = context.env.AI_QA_HOME ?? join(context.homeDir, ".ai-qa");
  const projectOption: unknown = command.optsWithGlobals().project;
  const trusted = await resolveTrustedProject({
    cwd: context.cwd,
    aiQaHome: home,
    ...(typeof projectOption === "string"
      ? { explicitProject: projectOption }
      : {}),
  });
  return new RunProtocolService(trusted.projectRoot, home, runId, context.now);
}

export function writeProtocolEvent(context: CliContext, event: RunEvent): void {
  writeJson(context, {
    eventId: event.id,
    sequence: event.sequence,
    payload: event.payload,
    permittedNextActions: permittedNextActions(event),
  });
}

function permittedNextActions(event: RunEvent): string[] {
  if (event.type === "action") {
    const phase =
      typeof event.payload === "object" &&
      event.payload !== null &&
      !Array.isArray(event.payload)
        ? event.payload.phase
        : undefined;
    if (phase === "planned") return ["invoke-tool", "action.complete"];
    if (phase === "unknown") {
      return ["action.plan", "decision.record"];
    }
    return ["action.plan", "assertion.record", "decision.record"];
  }
  if (event.type === "observation") {
    return ["assertion.record", "recovery.resolve", "action.plan"];
  }
  if (event.type === "recovery") {
    const resolution =
      typeof event.payload === "object" &&
      event.payload !== null &&
      !Array.isArray(event.payload)
        ? event.payload.resolution
        : undefined;
    return resolution === "not_applied"
      ? ["action.plan", "decision.record"]
      : ["observation.add", "assertion.record", "decision.record"];
  }
  return ["action.plan", "decision.record"];
}
