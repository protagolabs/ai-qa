import type { Command } from "commander";
import type { RunEvent } from "../../core/runs/schema.js";
import { resolveProject } from "../../services/project-root/resolve-project.js";
import { RunProtocolService } from "../../services/run-protocol/run-protocol-service.js";
import { readRunState } from "../../services/run-protocol/read-run-state.js";
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

export async function writeProtocolEvent(
  command: Command,
  context: CliContext,
  runId: string,
  event: RunEvent,
): Promise<void> {
  const projectOption: unknown = command.optsWithGlobals().project;
  const project = await resolveProject({
    cwd: context.cwd,
    ...(typeof projectOption === "string"
      ? { explicitProject: projectOption }
      : {}),
  });
  const state = await readRunState({
    projectRoot: project.projectRoot,
    runId,
    now: context.now,
  });
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
    permittedNextActions: state.permittedNextActions,
  });
}
