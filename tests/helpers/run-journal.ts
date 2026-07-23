import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { RunJournal } from "../../src/core/runs/journal.js";

export async function createEmptyRunJournal(
  projectRoot: string,
  runId: string,
  now: () => Date,
): Promise<RunJournal> {
  const directory = join(projectRoot, ".ai-qa", "runs", runId);
  await mkdir(directory, { recursive: true });
  const handle = await open(join(directory, "events.jsonl"), "wx", 0o600);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  return RunJournal.open(projectRoot, runId, now);
}
