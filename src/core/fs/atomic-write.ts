import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export async function atomicWriteFile(
  path: string,
  content: string,
  options: { preCommit?: () => void } = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  let closed = false;
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    closed = true;
    options.preCommit?.();
    await rename(temporaryPath, path);
  } catch (error: unknown) {
    if (!closed) {
      try {
        await handle.close();
      } catch {
        // Preserve the original write, sync, or close failure.
      }
    }
    try {
      await rm(temporaryPath, { force: true });
    } catch {
      // Preserve the original atomic-write failure.
    }
    throw error;
  }
}
