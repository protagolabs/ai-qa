import { join } from "node:path";
import type { Command } from "commander";
import type { RunEvent } from "../../core/runs/schema.js";
import { resolveTrustedProject } from "../../services/project-root/resolve-trusted-project.js";
import { RunProtocolService } from "../../services/run-protocol/run-protocol-service.js";
import { readRunState } from "../../services/run-protocol/read-run-state.js";
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

export async function writeProtocolEvent(
  command: Command,
  context: CliContext,
  runId: string,
  event: RunEvent,
): Promise<void> {
  const home = context.env.AI_QA_HOME ?? join(context.homeDir, ".ai-qa");
  const projectOption: unknown = command.optsWithGlobals().project;
  const trusted = await resolveTrustedProject({
    cwd: context.cwd,
    aiQaHome: home,
    ...(typeof projectOption === "string"
      ? { explicitProject: projectOption }
      : {}),
  });
  const state = await readRunState({
    projectRoot: trusted.projectRoot,
    aiQaHome: home,
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
