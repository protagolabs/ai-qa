import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { isNodeError } from "../node-errors.js";

export async function atomicWriteFile(
  path: string,
  content: string,
  options: { preCommit?: () => void; durable?: boolean } = {},
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
    if (options.durable === true) {
      await syncDirectoryWhereSupported(dirname(path));
    }
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

export async function syncDirectoryWhereSupported(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error: unknown) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await handle?.close();
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return [
    "EBADF",
    "EINVAL",
    "EISDIR",
    "ENOSYS",
    "ENOTSUP",
    "EOPNOTSUPP",
    "EPERM",
  ].some((code) => isNodeError(error, code));
}
