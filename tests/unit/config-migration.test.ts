import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import {
  normalizeProjectConfig,
  projectConfigV2Schema,
  storedProjectConfigSchema,
} from "../../src/core/config/schema.js";
import {
  readProjectConfig,
  readStoredProjectConfig,
} from "../../src/core/config/repository.js";
import {
  projectConfigV1,
  projectConfigV2,
} from "../helpers/project-fixture.js";

describe("config v2 migration boundary", () => {
  it("adds local-only semantics to v1 in memory", () => {
    expect(normalizeProjectConfig(projectConfigV1())).toMatchObject({
      schemaVersion: 2,
      recordingPolicy: { mode: "local-only" },
    });
  });

  it("accepts only provider-neutral recording modes", () => {
    expect(projectConfigV2Schema.parse(projectConfigV2())).toMatchObject({
      recordingPolicy: { mode: "local-only" },
    });
    expect(() =>
      projectConfigV2Schema.parse({
        ...projectConfigV2(),
        recordingPolicy: { mode: "github" },
      }),
    ).toThrow();
  });

  it("reads v1 as effective v2 without rewriting disk bytes", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-config-v1-"));
    await mkdir(join(projectRoot, ".ai-qa"));
    const path = join(projectRoot, ".ai-qa", "config.yaml");
    const bytes = stringify(projectConfigV1(), { sortMapEntries: true });
    await writeFile(path, bytes);

    await expect(readStoredProjectConfig(projectRoot)).resolves.toMatchObject({
      schemaVersion: 1,
    });
    await expect(readProjectConfig(projectRoot)).resolves.toMatchObject({
      schemaVersion: 2,
      recordingPolicy: { mode: "local-only" },
    });
    expect(await readFile(path, "utf8")).toBe(bytes);
  });

  it("rejects unknown stored schema versions", () => {
    expect(() =>
      storedProjectConfigSchema.parse({
        ...projectConfigV2(),
        schemaVersion: 3,
      }),
    ).toThrow();
  });
});
