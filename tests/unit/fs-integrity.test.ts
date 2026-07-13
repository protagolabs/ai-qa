import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { atomicWriteFile } from "../../src/core/fs/atomic-write.js";
import { readJsonLines } from "../../src/core/fs/json-lines.js";

describe("filesystem integrity helpers", () => {
  it("removes its owned temporary file when the final rename fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-qa-atomic-cleanup-"));
    const destination = join(root, "destination");
    await mkdir(destination);
    await writeFile(join(destination, "keep"), "occupied");

    await expect(atomicWriteFile(destination, "new content")).rejects.toThrow();

    expect(
      (await readdir(root)).filter((name) => name.startsWith("destination.")),
    ).toEqual([]);
  });

  it("rejects an internal blank JSONL record", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-qa-jsonl-blank-"));
    const path = join(root, "records.jsonl");
    await writeFile(path, '{"id":1}\n\n{"id":2}\n');

    await expect(
      readJsonLines(path, z.object({ id: z.number().int() })),
    ).rejects.toThrow();
  });
});
