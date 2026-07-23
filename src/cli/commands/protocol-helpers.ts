import type { Command } from "commander";
import { resolveProject } from "../../services/project-root/resolve-project.js";
import { RunProtocolService } from "../../services/run-protocol/run-protocol-service.js";
import type { ProtocolCommandResult } from "../../services/run-protocol/run-session.js";
import type { CliContext } from "../context.js";
import { writeJson } from "../io.js";

export async function createRunProtocolService(
  command: Command,
  context: CliContext,
  runId: string,
): Promise<RunProtocolService> {
  const projectOption: unknown = command.optsWithGlobals().project;
  const project = await resolveProject({
    cwd: context.cwd,
    ...(typeof projectOption === "string"
      ? { explicitProject: projectOption }
      : {}),
  });
  return new RunProtocolService(project.projectRoot, runId, context.now);
}

export function writeProtocolEvent(
  context: CliContext,
  result: ProtocolCommandResult,
): void {
  const { event, state, permittedNextActions } = result;
  writeJson(context, {
    eventId: event.id,
    sequence: event.sequence,
    payload: event.payload,
    state: {
      status: state.status,
      ...(state.effectiveVerdict === undefined
        ? {}
        : { effectiveVerdict: state.effectiveVerdict }),
      requiresFreshObservation: state.requiresFreshObservation,
    },
    permittedNextActions,
  });
}
