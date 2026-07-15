import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { sha256Canonical } from "../../src/core/canonical-json.js";
import { AiQaError } from "../../src/core/errors.js";
import {
  applyProjectFileTransaction,
  type ProjectFileWrite,
} from "../../src/services/initialization/project-file-transaction.js";
import {
  applyProjectSetup,
  previewProjectSetup,
  type InitializationRequest,
} from "../../src/services/initialization/project-setup.js";
import { prepareProjectSkill } from "../../src/services/skill-management/project-skill.js";
import { readRepositoryIdentity } from "../../src/services/trust/repository-identity.js";
import {
  projectConfigV1,
  projectConfigV2,
} from "../helpers/project-fixture.js";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

const CONFIG_PATH = ".ai-qa/config.yaml";
const SKILL_PATH = ".agents/skills/ai-qa-project/SKILL.md";
const SECRET_REFERENCES = { login: "QA_TEST_PASSWORD" };

function projectSkillSource(recordingProcedure: string): string {
  return `---
name: ai-qa-project
description: Use when performing AI QA work in this target project, including startup, authentication, evidence, reports, or result recording.
metadata:
  aiQaProjectSkillVersion: 1.0.0
  aiQaProtocolRange: ^1.1.0
  aiQaManagedChecksum: generated
---
<!-- ai-qa:managed:start -->
# Project AI QA Procedures

## Startup and environment

Run the existing local development command documented by the project.

## Authentication and test data

Read credentials only from \${QA_TEST_PASSWORD}; never persist the value.

## Navigation and platform constraints

Start at the configured Web entry URL and prefer stable test IDs.

## Evidence, privacy, and reports

Follow config sensitivity, retention, and local report policy.

## Project result recording

${recordingProcedure}
<!-- ai-qa:managed:end -->
<!-- ai-qa:user:start -->
<!-- ai-qa:user:end -->
`;
}

function request(
  procedure = "No additional project record is required; the verified local report completes the workflow.",
): InitializationRequest {
  return {
    config: projectConfigV2("project-skill"),
    projectSkill: {
      reason: "Project-specific QA procedures",
      content: projectSkillSource(procedure),
    },
  };
}

async function temporaryProject(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

async function writeConfig(projectRoot: string, value = projectConfigV2()) {
  await mkdir(join(projectRoot, ".ai-qa"), { recursive: true });
  const content = stringify(value, { sortMapEntries: true });
  await writeFile(join(projectRoot, CONFIG_PATH), content);
  return content;
}

async function writeSkill(projectRoot: string, content: string) {
  await mkdir(join(projectRoot, ".agents", "skills", "ai-qa-project"), {
    recursive: true,
  });
  await writeFile(join(projectRoot, SKILL_PATH), content);
}

describe("project setup preview", () => {
  it("is read-only and leaves no project-local residue", async () => {
    const projectRoot = await temporaryProject("ai-qa-setup-preview-");

    const preview = await previewProjectSetup({
      operation: "init",
      projectRoot,
      request: request(),
    });

    expect(preview.checksum).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await readdir(projectRoot)).toEqual([]);
    await expectMissing(join(projectRoot, ".ai-qa"));
    await expectMissing(join(projectRoot, ".agents"));
  });

  it("returns complete normalized bytes, paths, diffs, snapshots, and checksum", async () => {
    const projectRoot = await temporaryProject("ai-qa-setup-complete-");
    const installedConfig = projectConfigV2("local-only");
    const installedConfigBytes = await writeConfig(
      projectRoot,
      installedConfig,
    );
    const installedSkill = prepareProjectSkill({
      source: projectSkillSource(
        "Record the result in the former local ledger.",
      ),
      secretReferences: SECRET_REFERENCES,
    }).content.replace(
      "<!-- ai-qa:user:start -->",
      "<!-- ai-qa:user:start -->\nKeep this exact user-authored note.\n",
    );
    await writeSkill(projectRoot, installedSkill);
    const submitted = request(
      "Record the result in the current project-specific QA ledger.",
    );
    submitted.config = {
      ...submitted.config,
      project: { id: "ignored-replacement", name: "Renamed Project" },
    };
    const expectedConfig = {
      ...submitted.config,
      project: { id: installedConfig.project.id, name: "Renamed Project" },
    };
    const expectedSkill = prepareProjectSkill({
      source: submitted.projectSkill.content,
      existing: installedSkill,
      secretReferences: expectedConfig.secretReferences,
    });

    const preview = await previewProjectSetup({
      operation: "configure",
      projectRoot,
      request: submitted,
    });
    const identity = await readRepositoryIdentity(projectRoot);

    expect(preview).toMatchObject({
      schemaVersion: 1,
      operation: "configure",
      projectRoot: identity.canonicalPath,
      configPath: CONFIG_PATH,
      projectSkillPath: SKILL_PATH,
      writePaths: [CONFIG_PATH, SKILL_PATH],
      config: expectedConfig,
      projectSkill: {
        reason: submitted.projectSkill.reason,
        content: expectedSkill.content,
        requiresManagedReplacement: false,
      },
    });
    expect(preview.projectSkill.content).toContain(
      "\nKeep this exact user-authored note.\n",
    );
    expect(preview.unifiedDiff).toContain(`--- ${CONFIG_PATH}`);
    expect(preview.unifiedDiff).toContain("-  name: Sample Web");
    expect(preview.unifiedDiff).toContain("+  name: Renamed Project");
    expect(preview.unifiedDiff).toContain(`--- ${SKILL_PATH}`);
    expect(preview.unifiedDiff).toContain("former local ledger");
    expect(preview.unifiedDiff).toContain("current project-specific QA ledger");
    expect(preview.destinations).toHaveLength(2);
    expect(
      preview.destinations.map(({ relativePath, state }) => ({
        relativePath,
        state,
      })),
    ).toEqual([
      { relativePath: CONFIG_PATH, state: "regular" },
      { relativePath: SKILL_PATH, state: "regular" },
    ]);
    for (const destination of preview.destinations) {
      expect(destination.identity?.device).toMatch(/^\d+$/);
      expect(destination.identity?.inode).toMatch(/^\d+$/);
      expect(destination.identity?.size).toMatch(/^\d+$/);
      expect(destination.identity?.modifiedNanoseconds).toMatch(/^\d+$/);
      expect(destination.contentSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
    expect(preview.destinations[0]?.contentSha256).toBe(
      `sha256:${createHash("sha256").update(installedConfigBytes).digest("hex")}`,
    );
    expect(preview.checksum).toBe(
      sha256Canonical({
        schemaVersion: 1,
        operation: "configure",
        repository: {
          canonicalPath: identity.canonicalPath,
          fingerprint: identity.fingerprint,
        },
        request: {
          config: expectedConfig,
          projectSkill: submitted.projectSkill,
        },
        targetPaths: [CONFIG_PATH, SKILL_PATH],
        destinations: preview.destinations,
      }),
    );
  });

  it("binds but does not diff or rewrite a noncanonical v1 config for skill generate", async () => {
    const projectRoot = await temporaryProject("ai-qa-skill-v1-preview-");
    await mkdir(join(projectRoot, ".ai-qa"));
    const legacyConfig = `# preserve this legacy comment\n${stringify(
      projectConfigV1(),
      { sortMapEntries: false },
    )}`;
    await writeFile(join(projectRoot, CONFIG_PATH), legacyConfig);
    const setupRequest = request();

    const preview = await previewProjectSetup({
      operation: "skill-generate",
      projectRoot,
      request: setupRequest,
    });

    expect(preview.writePaths).toEqual([SKILL_PATH]);
    expect(preview.config).toMatchObject({
      schemaVersion: 2,
      recordingPolicy: { mode: "local-only" },
    });
    expect(preview.unifiedDiff).not.toContain(`--- ${CONFIG_PATH}`);
    expect(preview.destinations[0]).toMatchObject({
      relativePath: CONFIG_PATH,
      state: "regular",
      contentSha256: `sha256:${createHash("sha256")
        .update(legacyConfig)
        .digest("hex")}`,
    });
    const identity = await readRepositoryIdentity(projectRoot);
    expect(preview.checksum).toBe(
      sha256Canonical({
        schemaVersion: 1,
        operation: "skill-generate",
        repository: {
          canonicalPath: identity.canonicalPath,
          fingerprint: identity.fingerprint,
        },
        request: {
          config: preview.config,
          projectSkill: setupRequest.projectSkill,
        },
        targetPaths: [CONFIG_PATH, SKILL_PATH],
        destinations: preview.destinations,
      }),
    );

    await applyProjectSetup({
      operation: "skill-generate",
      projectRoot,
      request: setupRequest,
      confirmChecksum: preview.checksum,
    });
    await expect(
      readFile(join(projectRoot, CONFIG_PATH), "utf8"),
    ).resolves.toBe(legacyConfig);
  });
});

describe("checksum-confirmed project setup", () => {
  it("rejects request changes after preview without publishing files", async () => {
    const projectRoot = await temporaryProject("ai-qa-setup-request-stale-");
    const original = request();
    const preview = await previewProjectSetup({
      operation: "init",
      projectRoot,
      request: original,
    });
    const changed = request("Record results in a different procedure.");

    await expect(
      applyProjectSetup({
        operation: "init",
        projectRoot,
        request: changed,
        confirmChecksum: preview.checksum,
      }),
    ).rejects.toMatchObject({ code: "setup.checksum_mismatch" });

    await expectMissing(join(projectRoot, CONFIG_PATH));
    await expectMissing(join(projectRoot, SKILL_PATH));
  });

  it.each([CONFIG_PATH, SKILL_PATH])(
    "rejects a changed %s destination as a stale preview",
    async (relativePath) => {
      const projectRoot = await temporaryProject("ai-qa-setup-dest-stale-");
      const setupRequest = request();
      const preview = await previewProjectSetup({
        operation: "init",
        projectRoot,
        request: setupRequest,
      });
      const destination = join(projectRoot, relativePath);
      await mkdir(join(destination, ".."), { recursive: true });
      await writeFile(destination, "changed after preview\n");

      await expect(
        applyProjectSetup({
          operation: "init",
          projectRoot,
          request: setupRequest,
          confirmChecksum: preview.checksum,
        }),
      ).rejects.toMatchObject({ code: "setup.checksum_mismatch" });
      await expect(readFile(destination, "utf8")).resolves.toBe(
        "changed after preview\n",
      );
    },
  );

  it.each([
    ".agents",
    ".agents/skills",
    ".agents/skills/ai-qa-project",
    SKILL_PATH,
  ])("rejects a symlink at %s before following it", async (relativePath) => {
    const projectRoot = await temporaryProject("ai-qa-setup-symlink-");
    const outside = await temporaryProject("ai-qa-setup-outside-");
    const destination = join(projectRoot, relativePath);
    await mkdir(join(destination, ".."), { recursive: true });
    if (relativePath === SKILL_PATH) {
      await writeFile(join(outside, "outside.md"), "outside bytes\n");
      await symlink(join(outside, "outside.md"), destination);
    } else {
      await symlink(outside, destination);
    }

    await expect(
      previewProjectSetup({
        operation: "init",
        projectRoot,
        request: request(),
      }),
    ).rejects.toMatchObject({ code: "storage.integrity_error" });
    if (relativePath === SKILL_PATH) {
      await expect(readFile(join(outside, "outside.md"), "utf8")).resolves.toBe(
        "outside bytes\n",
      );
    } else {
      await expectMissing(join(outside, "SKILL.md"));
    }
  });

  it("rolls back caught publish failure to exact original or missing bytes", async () => {
    const projectRoot = await temporaryProject("ai-qa-setup-rollback-");
    const originalConfig = await writeConfig(
      projectRoot,
      projectConfigV2("local-only"),
    );
    const originalSkill = prepareProjectSkill({
      source: projectSkillSource(
        "Record results using the original procedure.",
      ),
      secretReferences: SECRET_REFERENCES,
    }).content.replace(
      "<!-- ai-qa:user:start -->",
      "<!-- ai-qa:user:start -->\r\nExact user bytes: 靜態記錄\r\n",
    );
    await writeSkill(projectRoot, originalSkill);
    const setupRequest = request(
      "Record results using the proposed procedure.",
    );
    const publishPaths: string[] = [];
    const preview = await previewProjectSetup({
      operation: "configure",
      projectRoot,
      request: setupRequest,
    });

    await expect(
      applyProjectSetup({
        operation: "configure",
        projectRoot,
        request: setupRequest,
        confirmChecksum: preview.checksum,
        hooks: {
          beforePublish: ({ publishIndex, relativePath }) => {
            publishPaths.push(relativePath);
            if (publishIndex === 1)
              throw new Error("injected second publish fault");
            return Promise.resolve();
          },
        },
      }),
    ).rejects.toThrow("injected second publish fault");

    expect(publishPaths).toEqual([SKILL_PATH, CONFIG_PATH]);
    await expect(
      readFile(join(projectRoot, CONFIG_PATH), "utf8"),
    ).resolves.toBe(originalConfig);
    await expect(readFile(join(projectRoot, SKILL_PATH), "utf8")).resolves.toBe(
      originalSkill,
    );
  });

  it("removes a newly published first file when the second publish fails", async () => {
    const projectRoot = await temporaryProject("ai-qa-setup-new-rollback-");
    const originalConfig = await writeConfig(
      projectRoot,
      projectConfigV2("local-only"),
    );
    const setupRequest = request(
      "Record results using the proposed procedure.",
    );
    const preview = await previewProjectSetup({
      operation: "configure",
      projectRoot,
      request: setupRequest,
    });

    await expect(
      applyProjectSetup({
        operation: "configure",
        projectRoot,
        request: setupRequest,
        confirmChecksum: preview.checksum,
        hooks: {
          beforePublish: ({ publishIndex }) => {
            if (publishIndex === 1)
              throw new Error("injected second publish fault");
            return Promise.resolve();
          },
        },
      }),
    ).rejects.toThrow("injected second publish fault");

    await expectMissing(join(projectRoot, SKILL_PATH));
    await expect(
      readFile(join(projectRoot, CONFIG_PATH), "utf8"),
    ).resolves.toBe(originalConfig);
  });

  it("rejects a destination changed immediately before publish and rolls back", async () => {
    const projectRoot = await temporaryProject("ai-qa-setup-publish-race-");
    const originalConfig = await writeConfig(
      projectRoot,
      projectConfigV2("local-only"),
    );
    const originalSkill = prepareProjectSkill({
      source: projectSkillSource(
        "Record results using the original procedure.",
      ),
      secretReferences: SECRET_REFERENCES,
    }).content;
    await writeSkill(projectRoot, originalSkill);
    const setupRequest = request(
      "Record results using the proposed procedure.",
    );
    const preview = await previewProjectSetup({
      operation: "configure",
      projectRoot,
      request: setupRequest,
    });
    const externalConfig = "external concurrent bytes\n";

    await expect(
      applyProjectSetup({
        operation: "configure",
        projectRoot,
        request: setupRequest,
        confirmChecksum: preview.checksum,
        hooks: {
          beforePublish: async ({ publishIndex }) => {
            if (publishIndex === 1) {
              await writeFile(join(projectRoot, CONFIG_PATH), externalConfig);
            }
          },
        },
      }),
    ).rejects.toMatchObject({ code: "setup.checksum_mismatch" });

    expect(originalConfig).not.toBe(externalConfig);
    await expect(
      readFile(join(projectRoot, CONFIG_PATH), "utf8"),
    ).resolves.toBe(externalConfig);
    await expect(readFile(join(projectRoot, SKILL_PATH), "utf8")).resolves.toBe(
      originalSkill,
    );
    expect(
      (await readdir(projectRoot, { recursive: true })).filter((path) =>
        /\.(?:stage|backup)$/.test(path),
      ),
    ).toEqual([]);
  });

  it("serializes concurrent apply attempts to one winner", async () => {
    const projectRoot = await temporaryProject("ai-qa-setup-concurrent-");
    const setupRequest = request();
    const preview = await previewProjectSetup({
      operation: "init",
      projectRoot,
      request: setupRequest,
    });

    const results = await Promise.allSettled([
      applyProjectSetup({
        operation: "init",
        projectRoot,
        request: setupRequest,
        confirmChecksum: preview.checksum,
      }),
      applyProjectSetup({
        operation: "init",
        projectRoot,
        request: setupRequest,
        confirmChecksum: preview.checksum,
      }),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    const rejected = results.find(({ status }) => status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status !== "rejected") throw new Error("missing rejection");
    expect(rejected.reason).toBeInstanceOf(AiQaError);
    expect((rejected.reason as AiQaError).code).toMatch(
      /^(?:setup\.checksum_mismatch|project\.already_initialized)$/,
    );
    await expect(
      readFile(join(projectRoot, CONFIG_PATH), "utf8"),
    ).resolves.toContain("schemaVersion: 2");
    await expect(
      readFile(join(projectRoot, SKILL_PATH), "utf8"),
    ).resolves.toContain("name: ai-qa-project");
  });

  it("waits through a long concurrent apply before returning stale state", async () => {
    const projectRoot = await temporaryProject("ai-qa-setup-long-lock-");
    const setupRequest = request();
    const preview = await previewProjectSetup({
      operation: "init",
      projectRoot,
      request: setupRequest,
    });
    let signalFirstPublish!: () => void;
    const firstAtPublish = new Promise<void>((resolve) => {
      signalFirstPublish = resolve;
    });
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = applyProjectSetup({
      operation: "init",
      projectRoot,
      request: setupRequest,
      confirmChecksum: preview.checksum,
      hooks: {
        beforePublish: async ({ publishIndex }) => {
          if (publishIndex !== 0) return;
          signalFirstPublish();
          await holdFirst;
        },
      },
    });
    await firstAtPublish;
    let secondSettled = false;
    const second = applyProjectSetup({
      operation: "init",
      projectRoot,
      request: setupRequest,
      confirmChecksum: preview.checksum,
    }).finally(() => {
      secondSettled = true;
    });
    void second.catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const settledBeforeRelease = secondSettled;
    releaseFirst();
    const results = await Promise.allSettled([first, second]);

    expect(settledBeforeRelease).toBe(false);
    expect(results[0]).toMatchObject({ status: "fulfilled" });
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: { code: "setup.checksum_mismatch" },
    });
  }, 10_000);
});

describe("project file transaction ownership", () => {
  it("never removes an identically named unowned staging fixture", async () => {
    const projectRoot = await temporaryProject("ai-qa-setup-owned-");
    await mkdir(join(projectRoot, ".ai-qa"));
    const uuid = "00000000-0000-4000-8000-000000000000";
    const unowned = join(projectRoot, ".ai-qa", `config.yaml.${uuid}.stage`);
    await writeFile(unowned, "unowned fixture\n");
    vi.mocked(randomUUID).mockReturnValueOnce(uuid);
    const writes: ProjectFileWrite[] = [
      {
        relativeSegments: [".ai-qa", "config.yaml"],
        content: "new config\n",
      },
    ];

    await expect(
      applyProjectFileTransaction({
        projectRoot,
        writes,
        expectedDestinations: [{ relativePath: CONFIG_PATH, state: "missing" }],
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });

    await expect(readFile(unowned, "utf8")).resolves.toBe("unowned fixture\n");
    await expectMissing(join(projectRoot, CONFIG_PATH));
  });

  it("does not remove an unowned replacement at a consumed stage path", async () => {
    const projectRoot = await temporaryProject("ai-qa-setup-stage-replaced-");
    const uuid = "00000000-0000-4000-8000-000000000001";
    const firstStage = join(projectRoot, `${SKILL_PATH}.${uuid}.stage`);
    vi.mocked(randomUUID).mockReturnValueOnce(uuid);
    const writes: ProjectFileWrite[] = [
      {
        relativeSegments: [".ai-qa", "config.yaml"],
        content: "new config\n",
      },
      {
        relativeSegments: [".agents", "skills", "ai-qa-project", "SKILL.md"],
        content: "new skill\n",
      },
    ];

    await expect(
      applyProjectFileTransaction({
        projectRoot,
        writes,
        expectedDestinations: [
          { relativePath: CONFIG_PATH, state: "missing" },
          { relativePath: SKILL_PATH, state: "missing" },
        ],
        hooks: {
          beforePublish: async ({ publishIndex }) => {
            if (publishIndex !== 1) return;
            await writeFile(firstStage, "unowned replacement\n");
            throw new Error("injected after first publish");
          },
        },
      }),
    ).rejects.toThrow("injected after first publish");

    await expect(readFile(firstStage, "utf8")).resolves.toBe(
      "unowned replacement\n",
    );
    await expectMissing(join(projectRoot, CONFIG_PATH));
    await expectMissing(join(projectRoot, SKILL_PATH));
  });

  it("does not remove an identically named unowned backup fixture", async () => {
    const projectRoot = await temporaryProject("ai-qa-setup-backup-owned-");
    const originalConfig = await writeConfig(projectRoot);
    const preview = await previewProjectSetup({
      operation: "configure",
      projectRoot,
      request: request(),
    });
    const configSnapshot = preview.destinations.find(
      ({ relativePath }) => relativePath === CONFIG_PATH,
    )!;
    const uuid = "00000000-0000-4000-8000-000000000002";
    const backup = join(projectRoot, `${CONFIG_PATH}.${uuid}.backup`);
    vi.mocked(randomUUID).mockReturnValueOnce(uuid);

    await expect(
      applyProjectFileTransaction({
        projectRoot,
        writes: [
          {
            relativeSegments: [".ai-qa", "config.yaml"],
            content: "replacement config\n",
          },
        ],
        expectedDestinations: [configSnapshot],
        hooks: {
          beforePublish: async () => {
            await unlink(backup);
            await writeFile(backup, "unowned backup\n");
            throw new Error("injected after backup replacement");
          },
        },
      }),
    ).rejects.toThrow("injected after backup replacement");

    await expect(readFile(backup, "utf8")).resolves.toBe("unowned backup\n");
    await expect(
      readFile(join(projectRoot, CONFIG_PATH), "utf8"),
    ).resolves.toBe(originalConfig);
  });
});
