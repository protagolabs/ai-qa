import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { sha256Canonical } from "../../src/core/canonical-json.js";
import { AiQaError } from "../../src/core/errors.js";
import { runCli } from "../../src/cli/program.js";
import {
  applyProjectFileTransaction,
  type ProjectFileWrite,
} from "../../src/services/initialization/project-file-transaction.js";
import {
  applyProjectSetup,
  previewProjectSetup,
  type ApplyProjectSetupInput,
  type InitializationRequest,
  type ProjectSetupPreview,
} from "../../src/services/initialization/project-setup.js";
import { prepareProjectSkill } from "../../src/services/skill-management/project-skill.js";
import { confirmProjectTrust } from "../../src/services/trust/confirm-project-trust.js";
import { readRepositoryIdentity } from "../../src/services/trust/repository-identity.js";
import { createCapturedCli } from "../helpers/cli-context.js";
import {
  projectConfigV1,
  projectConfigV2,
  projectSkillSource,
} from "../helpers/project-fixture.js";

const ownedFileFault = vi.hoisted(() => ({
  purpose: undefined as "stage" | "backup" | undefined,
  operation: undefined as
    "write" | "sync" | "initial-stat" | "stat" | undefined,
}));

const publicMutationFault = vi.hoisted(() => ({
  destinationPath: undefined as string | undefined,
  externalContent: undefined as string | undefined,
}));

const cleanupFault = vi.hoisted(() => ({
  transactionId: undefined as string | undefined,
  failuresRemaining: 0,
  attemptedPaths: [] as string[],
}));

const publicLinkFault = vi.hoisted(() => ({
  destinationPath: undefined as string | undefined,
  externalContent: undefined as string | undefined,
}));

const publicSyncFault = vi.hoisted(() => ({
  directoryPath: undefined as string | undefined,
  action: undefined as (() => Promise<void>) | undefined,
  errorMessage: undefined as string | undefined,
}));

const publicDeletionFault = vi.hoisted(() => ({
  destinationPath: undefined as string | undefined,
}));

const rollbackSyncFault = vi.hoisted(() => ({
  directoryPath: undefined as string | undefined,
}));

const crossDeviceLinkFault = vi.hoisted(() => ({
  projectRoot: undefined as string | undefined,
}));

const hardLinkCapabilityFault = vi.hoisted(() => ({
  enabled: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: vi.fn(
      async (
        existingPath: import("node:fs").PathLike,
        newPath: import("node:fs").PathLike,
      ) => {
        const existingPathText = String(existingPath);
        const newPathText = String(newPath);
        if (
          hardLinkCapabilityFault.enabled &&
          newPathText.endsWith(".hardlink-probe.link") &&
          !dirname(newPathText).includes(".ai-qa-transaction-")
        ) {
          throw Object.assign(new Error("hard links are not permitted"), {
            code: "EPERM",
          });
        }
        if (
          crossDeviceLinkFault.projectRoot !== undefined &&
          [CONFIG_PATH, SKILL_PATH].some(
            (relativePath) =>
              newPathText ===
              join(crossDeviceLinkFault.projectRoot!, relativePath),
          ) &&
          !existingPathText.startsWith(
            `${join(dirname(newPathText), ".ai-qa-transaction-")}`,
          )
        ) {
          throw Object.assign(new Error("cross-device hard link"), {
            code: "EXDEV",
          });
        }
        if (
          newPathText === publicLinkFault.destinationPath &&
          (existingPathText.endsWith(".original.recovery") ||
            existingPathText.endsWith(".backup.recovery"))
        ) {
          publicLinkFault.destinationPath = undefined;
          await actual.writeFile(newPath, publicLinkFault.externalContent!);
        }
        await actual.link(existingPath, newPath);
      },
    ),
    unlink: vi.fn(async (path: import("node:fs").PathLike) => {
      const pathText = String(path);
      if (
        cleanupFault.transactionId !== undefined &&
        pathText.includes(cleanupFault.transactionId)
      ) {
        cleanupFault.attemptedPaths.push(pathText);
        if (cleanupFault.failuresRemaining > 0) {
          cleanupFault.failuresRemaining -= 1;
          throw Object.assign(new Error("injected cleanup unlink failure"), {
            code: "EACCES",
          });
        }
      }
      await actual.unlink(path);
    }),
    rename: vi.fn(
      async (
        oldPath: import("node:fs").PathLike,
        newPath: import("node:fs").PathLike,
      ) => {
        if (String(oldPath) === publicDeletionFault.destinationPath) {
          publicDeletionFault.destinationPath = undefined;
          await actual.unlink(oldPath);
        }
        const destinationPath = publicMutationFault.destinationPath;
        if (
          destinationPath !== undefined &&
          (String(oldPath) === destinationPath ||
            String(newPath) === destinationPath)
        ) {
          publicMutationFault.destinationPath = undefined;
          await actual.unlink(destinationPath).catch((error: unknown) => {
            if (
              !(error instanceof Error) ||
              !("code" in error) ||
              error.code !== "ENOENT"
            ) {
              throw error;
            }
          });
          await actual.writeFile(
            destinationPath,
            publicMutationFault.externalContent!,
          );
        }
        await actual.rename(oldPath, newPath);
      },
    ),
    open: vi.fn(
      async (
        path: import("node:fs").PathLike,
        flags: string | number,
        mode?: import("node:fs").Mode,
      ) => {
        const pathText = String(path);
        if (flags === "r" && pathText === publicSyncFault.directoryPath) {
          const action = publicSyncFault.action;
          const errorMessage = publicSyncFault.errorMessage;
          publicSyncFault.directoryPath = undefined;
          publicSyncFault.action = undefined;
          publicSyncFault.errorMessage = undefined;
          await action?.();
          if (errorMessage !== undefined) throw new Error(errorMessage);
        }
        if (flags === "r" && pathText === rollbackSyncFault.directoryPath) {
          rollbackSyncFault.directoryPath = undefined;
          throw new Error("injected rollback namespace sync failure");
        }
        const handle =
          mode === undefined
            ? await actual.open(path, flags)
            : await actual.open(path, flags, mode);
        const purpose = pathText.endsWith(".stage")
          ? "stage"
          : pathText.includes(".backup")
            ? "backup"
            : undefined;
        if (purpose === undefined || purpose !== ownedFileFault.purpose) {
          return handle;
        }
        if (ownedFileFault.operation === "write") {
          vi.spyOn(handle, "writeFile").mockImplementation(() =>
            Promise.reject(new Error(`injected ${purpose} write failure`)),
          );
        } else if (ownedFileFault.operation === "sync") {
          vi.spyOn(handle, "sync").mockRejectedValue(
            new Error(`injected ${purpose} sync failure`),
          );
        } else if (ownedFileFault.operation === "initial-stat") {
          vi.spyOn(handle, "stat").mockRejectedValue(
            new Error(`injected ${purpose} initial-stat failure`),
          );
        } else {
          let synced = false;
          const actualSync = handle.sync.bind(handle);
          const actualStat = handle.stat.bind(handle);
          vi.spyOn(handle, "sync").mockImplementation(async () => {
            await actualSync();
            synced = true;
          });
          vi.spyOn(handle, "stat").mockImplementation((options) => {
            if (synced) {
              return Promise.reject(
                new Error(`injected ${purpose} stat failure`),
              );
            }
            return actualStat(options);
          });
        }
        return handle;
      },
    ),
  };
});

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

const execFileAsync = promisify(execFile);

const CONFIG_PATH = ".ai-qa/config.yaml";
const SKILL_PATH = ".agents/skills/ai-qa-project/SKILL.md";
const SECRET_REFERENCES = { login: "QA_TEST_PASSWORD" };

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

function recoveryPathsFromFailure(failure: unknown): string[] {
  if (!(failure instanceof AiQaError)) return [];
  const paths: unknown = failure.details.recoveryPaths;
  if (!Array.isArray(paths)) return [];
  const relativePaths: string[] = [];
  for (const path of paths as unknown[]) {
    if (typeof path === "string") relativePaths.push(path);
  }
  return relativePaths;
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

async function trustProject(projectRoot: string, aiQaHome: string) {
  await confirmProjectTrust({
    projectRoot,
    aiQaHome,
    confirmed: true,
    now: new Date("2026-07-13T00:00:00.000Z"),
  });
}

async function transactionReadSet(
  projectRoot: string,
  files: Parameters<typeof applyProjectFileTransaction>[0]["readSet"]["files"],
): Promise<Parameters<typeof applyProjectFileTransaction>[0]["readSet"]> {
  const repository = await readRepositoryIdentity(projectRoot);
  return {
    repository: {
      canonicalPath: repository.canonicalPath,
      fingerprint: repository.fingerprint,
    },
    files,
  };
}

async function applyPreviewTransactionForTest(
  projectRoot: string,
  preview: ProjectSetupPreview,
  hooks?: Parameters<typeof applyProjectFileTransaction>[0]["hooks"],
): Promise<void> {
  const writes: ProjectFileWrite[] = preview.writePaths.map((relativePath) =>
    relativePath === CONFIG_PATH
      ? {
          relativeSegments: [".ai-qa", "config.yaml"],
          content: stringify(preview.config, { sortMapEntries: true }),
        }
      : {
          relativeSegments: [".agents", "skills", "ai-qa-project", "SKILL.md"],
          content: preview.projectSkill.content,
        },
  );
  await applyProjectFileTransaction({
    projectRoot,
    writes,
    readSet: await transactionReadSet(projectRoot, preview.destinations),
    ...(hooks === undefined ? {} : { hooks }),
  });
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

describe("project Skill CLI", () => {
  it("rejects the global replacement flag before project trust, reads, or writes", async () => {
    const projectRoot = await temporaryProject("ai-qa-skill-scope-cli-");
    const aiQaHome = await temporaryProject("ai-qa-untrusted-home-");
    const originalConfig = await writeConfig(
      projectRoot,
      projectConfigV2("project-skill"),
    );
    const originalSkill = prepareProjectSkill({
      source: projectSkillSource(),
      secretReferences: SECRET_REFERENCES,
    }).content;
    await writeSkill(projectRoot, originalSkill);
    const captured = createCapturedCli({
      cwd: tmpdir(),
      env: { AI_QA_HOME: aiQaHome },
      readStdin: () => Promise.reject(new Error("stdin must not be read")),
    });

    expect(
      await runCli(
        [
          "--project",
          projectRoot,
          "skill",
          "sync",
          "--stdin-json",
          "--confirm-managed-replacement",
        ],
        captured.context,
      ),
    ).toBe(1);
    expect(JSON.parse(captured.stderr.join(""))).toMatchObject({
      error: { code: "skill.conflicting_scope_options" },
    });
    expect(captured.stdout).toEqual([]);
    await expect(
      readFile(join(projectRoot, CONFIG_PATH), "utf8"),
    ).resolves.toBe(originalConfig);
    await expect(readFile(join(projectRoot, SKILL_PATH), "utf8")).resolves.toBe(
      originalSkill,
    );
  });

  it("generates only a missing Project Skill through preview and checksum confirmation", async () => {
    const projectRoot = await temporaryProject("ai-qa-skill-generate-cli-");
    const aiQaHome = await temporaryProject("ai-qa-home-");
    await trustProject(projectRoot, aiQaHome);
    const originalConfig = await writeConfig(
      projectRoot,
      projectConfigV2("project-skill"),
    );
    const input = JSON.stringify({
      projectSkill: request().projectSkill,
    });
    const missingConfirmation = createCapturedCli({
      cwd: tmpdir(),
      env: { AI_QA_HOME: aiQaHome },
      readStdin: () => Promise.reject(new Error("stdin must not be read")),
    });
    expect(
      await runCli(
        ["--project", projectRoot, "skill", "generate", "--stdin-json"],
        missingConfirmation.context,
      ),
    ).toBe(1);
    expect(JSON.parse(missingConfirmation.stderr.join(""))).toMatchObject({
      error: { code: "setup.confirmation_required" },
    });

    const previewCli = createCapturedCli({
      cwd: tmpdir(),
      env: { AI_QA_HOME: aiQaHome },
      readStdin: () => Promise.resolve(input),
    });
    expect(
      await runCli(
        [
          "--project",
          projectRoot,
          "skill",
          "generate",
          "--stdin-json",
          "--preview",
        ],
        previewCli.context,
      ),
    ).toBe(0);
    const preview = JSON.parse(previewCli.stdout.join("")) as {
      checksum: string;
      writePaths: string[];
    };
    expect(preview.writePaths).toEqual([SKILL_PATH]);
    await expect(
      readFile(join(projectRoot, CONFIG_PATH), "utf8"),
    ).resolves.toBe(originalConfig);
    await expectMissing(join(projectRoot, SKILL_PATH));

    const applyCli = createCapturedCli({
      cwd: tmpdir(),
      env: { AI_QA_HOME: aiQaHome },
      readStdin: () => Promise.resolve(input),
    });
    expect(
      await runCli(
        [
          "--project",
          projectRoot,
          "skill",
          "generate",
          "--stdin-json",
          "--confirm-checksum",
          preview.checksum,
        ],
        applyCli.context,
      ),
    ).toBe(0);
    expect(JSON.parse(applyCli.stdout.join(""))).toMatchObject({
      operation: "skill-generate",
      writePaths: [SKILL_PATH],
      recordingMode: "project-skill",
      createdDirectories: [],
    });
    await expect(
      readFile(join(projectRoot, CONFIG_PATH), "utf8"),
    ).resolves.toBe(originalConfig);

    const repeated = createCapturedCli({
      cwd: tmpdir(),
      env: { AI_QA_HOME: aiQaHome },
      readStdin: () => Promise.resolve(input),
    });
    expect(
      await runCli(
        [
          "--project",
          projectRoot,
          "skill",
          "generate",
          "--stdin-json",
          "--preview",
        ],
        repeated.context,
      ),
    ).toBe(1);
    expect(JSON.parse(repeated.stderr.join(""))).toMatchObject({
      error: { code: "skill.already_installed" },
    });
  });

  it("syncs only an installed Project Skill while preserving config and user content", async () => {
    const projectRoot = await temporaryProject("ai-qa-skill-sync-cli-");
    const aiQaHome = await temporaryProject("ai-qa-home-");
    await trustProject(projectRoot, aiQaHome);
    const originalConfig = await writeConfig(
      projectRoot,
      projectConfigV2("project-skill"),
    );
    const updateInput = JSON.stringify({
      projectSkill: request("Record with the updated procedure.").projectSkill,
    });
    const missing = createCapturedCli({
      cwd: tmpdir(),
      env: { AI_QA_HOME: aiQaHome },
      readStdin: () => Promise.resolve(updateInput),
    });
    expect(
      await runCli(
        [
          "--project",
          projectRoot,
          "skill",
          "sync",
          "--stdin-json",
          "--preview",
        ],
        missing.context,
      ),
    ).toBe(1);
    expect(JSON.parse(missing.stderr.join(""))).toMatchObject({
      error: { code: "skill.not_installed" },
    });

    const userRegion =
      "\r\npassword: ${QA_TEST_PASSWORD}  \r\nRequire ${QA_TEST_PASSWORD:?missing}.\r\nPowerShell reads $env:QA_TEST_PASSWORD.\r\nKeep this project note.\t\r\n";
    const installed = prepareProjectSkill({
      source: projectSkillSource("Record with the former procedure."),
      secretReferences: SECRET_REFERENCES,
    }).content.replace(
      "<!-- ai-qa:user:start -->\n<!-- ai-qa:user:end -->",
      `<!-- ai-qa:user:start -->${userRegion}<!-- ai-qa:user:end -->`,
    );
    await writeSkill(projectRoot, installed);
    const previewCli = createCapturedCli({
      cwd: tmpdir(),
      env: { AI_QA_HOME: aiQaHome },
      readStdin: () => Promise.resolve(updateInput),
    });
    expect(
      await runCli(
        [
          "--project",
          projectRoot,
          "skill",
          "sync",
          "--stdin-json",
          "--preview",
        ],
        previewCli.context,
      ),
    ).toBe(0);
    const preview = JSON.parse(previewCli.stdout.join("")) as {
      checksum: string;
    };
    const applyCli = createCapturedCli({
      cwd: tmpdir(),
      env: { AI_QA_HOME: aiQaHome },
      readStdin: () => Promise.resolve(updateInput),
    });
    expect(
      await runCli(
        [
          "--project",
          projectRoot,
          "skill",
          "sync",
          "--stdin-json",
          "--confirm-checksum",
          preview.checksum,
        ],
        applyCli.context,
      ),
    ).toBe(0);
    const synchronized = await readFile(join(projectRoot, SKILL_PATH), "utf8");
    expect(synchronized).toContain("Record with the updated procedure.");
    expect(synchronized).toContain(
      `<!-- ai-qa:user:start -->${userRegion}<!-- ai-qa:user:end -->`,
    );
    await expect(
      readFile(join(projectRoot, CONFIG_PATH), "utf8"),
    ).resolves.toBe(originalConfig);
  });

  it.each([
    {
      expectedCode: "skill.literal_secret",
      userContent: "password: literal-value",
    },
    {
      expectedCode: "skill.unknown_secret_reference",
      userContent: "password: $UNDECLARED_PASSWORD",
    },
    {
      expectedCode: "skill.unknown_secret_reference",
      userContent: "Read ${UNDECLARED_PASSWORD:-fallback}.",
    },
    {
      expectedCode: "skill.unknown_secret_reference",
      userContent: "PowerShell reads $env:UNDECLARED_PASSWORD.",
    },
    {
      expectedCode: "skill.unsupported_secret_reference",
      userContent: "Indirect expansion ${!QA_TEST_PASSWORD} is forbidden.",
    },
    {
      expectedCode: "skill.unsupported_secret_reference",
      userContent: "Substring expansion ${QA_TEST_PASSWORD:0:4} is forbidden.",
    },
  ])(
    "refuses to sync an installed user region containing $expectedCode",
    async ({ expectedCode, userContent }) => {
      const projectRoot = await temporaryProject("ai-qa-skill-sync-secret-");
      const aiQaHome = await temporaryProject("ai-qa-home-");
      await trustProject(projectRoot, aiQaHome);
      const originalConfig = await writeConfig(
        projectRoot,
        projectConfigV2("project-skill"),
      );
      const originalSkill = prepareProjectSkill({
        source: projectSkillSource("Record with the former procedure."),
        secretReferences: SECRET_REFERENCES,
      }).content.replace(
        "<!-- ai-qa:user:start -->\n<!-- ai-qa:user:end -->",
        `<!-- ai-qa:user:start -->\n${userContent}\n<!-- ai-qa:user:end -->`,
      );
      await writeSkill(projectRoot, originalSkill);
      const updateInput = JSON.stringify({
        projectSkill: request("Record with the updated safe procedure.")
          .projectSkill,
      });
      const captured = createCapturedCli({
        cwd: tmpdir(),
        env: { AI_QA_HOME: aiQaHome },
        readStdin: () => Promise.resolve(updateInput),
      });

      expect(
        await runCli(
          [
            "--project",
            projectRoot,
            "skill",
            "sync",
            "--stdin-json",
            "--preview",
          ],
          captured.context,
        ),
      ).toBe(1);
      expect(JSON.parse(captured.stderr.join(""))).toMatchObject({
        error: { code: expectedCode },
      });
      expect(captured.stdout).toEqual([]);
      await expect(
        readFile(join(projectRoot, CONFIG_PATH), "utf8"),
      ).resolves.toBe(originalConfig);
      await expect(
        readFile(join(projectRoot, SKILL_PATH), "utf8"),
      ).resolves.toBe(originalSkill);
    },
  );

  it.each([
    { expected: "missing", installed: undefined, exitCode: 1 },
    {
      expected: "compatible",
      installed: prepareProjectSkill({
        source: projectSkillSource(),
        secretReferences: SECRET_REFERENCES,
      }).content,
      exitCode: 0,
    },
    {
      expected: "compatible",
      installed: prepareProjectSkill({
        source: projectSkillSource(),
        secretReferences: SECRET_REFERENCES,
      }).content.replace(
        "<!-- ai-qa:user:start -->\n<!-- ai-qa:user:end -->",
        "<!-- ai-qa:user:start -->\npassword: ${QA_TEST_PASSWORD}\n<!-- ai-qa:user:end -->",
      ),
      exitCode: 0,
    },
    {
      expected: "incompatible",
      installed: prepareProjectSkill({
        source: projectSkillSource(),
        secretReferences: SECRET_REFERENCES,
      }).content.replace(
        "<!-- ai-qa:user:start -->\n<!-- ai-qa:user:end -->",
        "<!-- ai-qa:user:start -->\npassword: $UNDECLARED_PASSWORD\n<!-- ai-qa:user:end -->",
      ),
      exitCode: 1,
    },
    {
      expected: "incompatible",
      installed: prepareProjectSkill({
        source: projectSkillSource(),
        secretReferences: SECRET_REFERENCES,
      }).content.replace(
        "<!-- ai-qa:user:start -->\n<!-- ai-qa:user:end -->",
        "<!-- ai-qa:user:start -->\nRead ${UNDECLARED_PASSWORD:?missing}.\n<!-- ai-qa:user:end -->",
      ),
      exitCode: 1,
    },
    {
      expected: "incompatible",
      installed: prepareProjectSkill({
        source: projectSkillSource(),
        secretReferences: SECRET_REFERENCES,
      }).content.replace(
        "<!-- ai-qa:user:start -->\n<!-- ai-qa:user:end -->",
        "<!-- ai-qa:user:start -->\nPowerShell reads $env:UNDECLARED_PASSWORD.\n<!-- ai-qa:user:end -->",
      ),
      exitCode: 1,
    },
    {
      expected: "incompatible",
      installed: prepareProjectSkill({
        source: projectSkillSource(),
        secretReferences: SECRET_REFERENCES,
      }).content.replace(
        "<!-- ai-qa:user:start -->\n<!-- ai-qa:user:end -->",
        "<!-- ai-qa:user:start -->\nIndirect ${!QA_TEST_PASSWORD} is forbidden.\n<!-- ai-qa:user:end -->",
      ),
      exitCode: 1,
    },
    {
      expected: "incompatible",
      installed: prepareProjectSkill({
        source: projectSkillSource(),
        secretReferences: SECRET_REFERENCES,
      }).content.replace(
        "<!-- ai-qa:user:start -->\n<!-- ai-qa:user:end -->",
        "<!-- ai-qa:user:start -->\npassword: literal-value\n<!-- ai-qa:user:end -->",
      ),
      exitCode: 1,
    },
    {
      expected: "conflict",
      installed: prepareProjectSkill({
        source: projectSkillSource(),
        secretReferences: SECRET_REFERENCES,
      }).content.replace("Run the existing", "Run a modified"),
      exitCode: 1,
    },
    {
      expected: "incompatible",
      installed: prepareProjectSkill({
        source: projectSkillSource(),
        secretReferences: SECRET_REFERENCES,
      }).content.replace(
        "aiQaProjectSkillVersion: 1.0.0",
        "aiQaProjectSkillVersion: 2.0.0",
      ),
      exitCode: 1,
    },
  ])(
    "checks $expected Project Skill state without writing",
    async ({ expected, installed, exitCode }) => {
      const projectRoot = await temporaryProject("ai-qa-skill-check-cli-");
      const aiQaHome = await temporaryProject("ai-qa-home-");
      await trustProject(projectRoot, aiQaHome);
      await writeConfig(projectRoot);
      if (installed !== undefined) await writeSkill(projectRoot, installed);
      const before = installed;
      const captured = createCapturedCli({
        cwd: tmpdir(),
        env: { AI_QA_HOME: aiQaHome },
        readStdin: () => Promise.reject(new Error("stdin must not be read")),
      });

      expect(
        await runCli(
          ["--project", projectRoot, "skill", "check"],
          captured.context,
        ),
      ).toBe(exitCode);
      expect(JSON.parse(captured.stdout.join(""))).toMatchObject({
        status: expected,
        destination: join(await realpath(projectRoot), SKILL_PATH),
      });
      if (before === undefined) {
        await expectMissing(join(projectRoot, SKILL_PATH));
      } else {
        await expect(
          readFile(join(projectRoot, SKILL_PATH), "utf8"),
        ).resolves.toBe(before);
      }
    },
  );

  it("checks installed references against the exact current project config", async () => {
    const projectRoot = await temporaryProject("ai-qa-skill-check-reference-");
    const aiQaHome = await temporaryProject("ai-qa-home-");
    const configuredReference = "PROJECT_ADMIN_PASSWORD";
    await trustProject(projectRoot, aiQaHome);
    await writeConfig(projectRoot, {
      ...projectConfigV2("project-skill"),
      secretReferences: { admin: configuredReference },
    });
    const installed = prepareProjectSkill({
      source: projectSkillSource()
        .replaceAll("QA_TEST_PASSWORD", configuredReference)
        .replace(
          "<!-- ai-qa:user:start -->\n<!-- ai-qa:user:end -->",
          `<!-- ai-qa:user:start -->\npassword: \${${configuredReference}}\n<!-- ai-qa:user:end -->`,
        ),
      secretReferences: { admin: configuredReference },
    }).content;
    await writeSkill(projectRoot, installed);

    const allowed = createCapturedCli({
      cwd: tmpdir(),
      env: { AI_QA_HOME: aiQaHome },
    });
    expect(
      await runCli(
        ["--project", projectRoot, "skill", "check"],
        allowed.context,
      ),
    ).toBe(0);
    expect(JSON.parse(allowed.stdout.join(""))).toMatchObject({
      status: "compatible",
    });

    await writeConfig(projectRoot, projectConfigV2("project-skill"));
    const noLongerAllowed = createCapturedCli({
      cwd: tmpdir(),
      env: { AI_QA_HOME: aiQaHome },
    });
    expect(
      await runCli(
        ["--project", projectRoot, "skill", "check"],
        noLongerAllowed.context,
      ),
    ).toBe(1);
    expect(JSON.parse(noLongerAllowed.stdout.join(""))).toMatchObject({
      status: "incompatible",
    });
    await expect(readFile(join(projectRoot, SKILL_PATH), "utf8")).resolves.toBe(
      installed,
    );
  });

  it.each([
    { configBytes: undefined, label: "missing" },
    { configBytes: "schemaVersion: [", label: "invalid YAML" },
    {
      configBytes: stringify(
        { ...projectConfigV2(), secretReferences: { login: "literal-value" } },
        { sortMapEntries: true },
      ),
      label: "invalid schema",
    },
  ])(
    "uses the existing project-config error semantics when config is $label",
    async ({ configBytes }) => {
      const projectRoot = await temporaryProject("ai-qa-skill-check-config-");
      const aiQaHome = await temporaryProject("ai-qa-home-");
      await trustProject(projectRoot, aiQaHome);
      if (configBytes !== undefined) {
        await mkdir(join(projectRoot, ".ai-qa"), { recursive: true });
        await writeFile(join(projectRoot, CONFIG_PATH), configBytes);
      }
      const installed = prepareProjectSkill({
        source: projectSkillSource(),
        secretReferences: SECRET_REFERENCES,
      }).content;
      await writeSkill(projectRoot, installed);
      const sync = createCapturedCli({
        cwd: tmpdir(),
        env: { AI_QA_HOME: aiQaHome },
        readStdin: () =>
          Promise.resolve(
            JSON.stringify({ projectSkill: request().projectSkill }),
          ),
      });
      const check = createCapturedCli({
        cwd: tmpdir(),
        env: { AI_QA_HOME: aiQaHome },
        readStdin: () => Promise.reject(new Error("stdin must not be read")),
      });

      expect(
        await runCli(
          [
            "--project",
            projectRoot,
            "skill",
            "sync",
            "--stdin-json",
            "--preview",
          ],
          sync.context,
        ),
      ).toBe(1);
      expect(
        await runCli(
          ["--project", projectRoot, "skill", "check"],
          check.context,
        ),
      ).toBe(1);
      expect(check.stdout).toEqual([]);
      const syncError = JSON.parse(sync.stderr.join("")) as {
        error: { code: string };
      };
      expect(JSON.parse(check.stderr.join(""))).toMatchObject({
        error: { code: syncError.error.code },
      });
      await expect(
        readFile(join(projectRoot, SKILL_PATH), "utf8"),
      ).resolves.toBe(installed);
    },
  );
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

  it("maps deletion after the final destination check to a safe checksum mismatch", async () => {
    const projectRoot = await temporaryProject("ai-qa-setup-final-delete-");
    const originalConfig = await writeConfig(
      projectRoot,
      projectConfigV2("local-only"),
    );
    await writeSkill(
      projectRoot,
      prepareProjectSkill({
        source: projectSkillSource(
          "Record results using the original procedure.",
        ),
        secretReferences: SECRET_REFERENCES,
      }).content,
    );
    const setupRequest = request(
      "Record results using the proposed procedure.",
    );
    const preview = await previewProjectSetup({
      operation: "configure",
      projectRoot,
      request: setupRequest,
    });
    publicDeletionFault.destinationPath = join(
      await realpath(projectRoot),
      SKILL_PATH,
    );
    let failure: unknown;

    try {
      await applyProjectSetup({
        operation: "configure",
        projectRoot,
        request: setupRequest,
        confirmChecksum: preview.checksum,
      });
    } catch (error: unknown) {
      failure = error;
    } finally {
      publicDeletionFault.destinationPath = undefined;
    }

    expect(failure).toMatchObject({
      code: "setup.checksum_mismatch",
      details: { relativePath: SKILL_PATH },
    });
    expect(JSON.stringify(failure)).not.toContain(await realpath(projectRoot));
    expect(JSON.stringify(failure)).not.toContain("recovery");
    await expect(
      readFile(join(projectRoot, CONFIG_PATH), "utf8"),
    ).resolves.toBe(originalConfig);
    await expectMissing(join(projectRoot, SKILL_PATH));
  });

  it("publishes each destination from a same-parent transaction namespace", async () => {
    const projectRoot = await temporaryProject("ai-qa-setup-same-device-");
    const setupRequest = request();
    const preview = await previewProjectSetup({
      operation: "init",
      projectRoot,
      request: setupRequest,
    });
    crossDeviceLinkFault.projectRoot = await realpath(projectRoot);

    try {
      await applyProjectSetup({
        operation: "init",
        projectRoot,
        request: setupRequest,
        confirmChecksum: preview.checksum,
      });
    } finally {
      crossDeviceLinkFault.projectRoot = undefined;
    }

    await expect(
      readFile(join(projectRoot, CONFIG_PATH), "utf8"),
    ).resolves.toContain("schemaVersion: 2");
    await expect(
      readFile(join(projectRoot, SKILL_PATH), "utf8"),
    ).resolves.toContain("name: ai-qa-project");
  });

  it("fails safely before publication when hard links are unsupported", async () => {
    const projectRoot = await temporaryProject(
      "ai-qa-setup-hardlink-unsupported-",
    );
    const setupRequest = request();
    const preview = await previewProjectSetup({
      operation: "init",
      projectRoot,
      request: setupRequest,
    });
    hardLinkCapabilityFault.enabled = true;
    let failure: unknown;

    try {
      await applyProjectSetup({
        operation: "init",
        projectRoot,
        request: setupRequest,
        confirmChecksum: preview.checksum,
      });
    } catch (error: unknown) {
      failure = error;
    } finally {
      hardLinkCapabilityFault.enabled = false;
    }

    expect(failure).toMatchObject({
      code: "storage.transaction_unsupported",
      details: { causeCode: "EPERM" },
    });
    expect(JSON.stringify(failure)).not.toContain(await realpath(projectRoot));
    await expectMissing(join(projectRoot, CONFIG_PATH));
    await expectMissing(join(projectRoot, SKILL_PATH));
  });

  it("preserves a probe target replaced after capability verification", async () => {
    const projectRoot = await temporaryProject(
      "ai-qa-setup-hardlink-probe-replaced-",
    );
    const setupRequest = request();
    const preview = await previewProjectSetup({
      operation: "init",
      projectRoot,
      request: setupRequest,
    });
    const transactionId = "00000000-0000-4000-8000-000000000030";
    vi.mocked(randomUUID).mockReturnValueOnce(transactionId);
    const probeTarget = join(
      await realpath(projectRoot),
      ".agents",
      "skills",
      "ai-qa-project",
      `.ai-qa-transaction-${transactionId}-0000.hardlink-probe.link`,
    );
    const externalContent = "external probe replacement\n";

    await expect(
      applyProjectSetup({
        operation: "init",
        projectRoot,
        request: setupRequest,
        confirmChecksum: preview.checksum,
        hooks: {
          beforePublish: async ({ publishIndex }) => {
            if (publishIndex !== 0) return;
            await writeFile(probeTarget, externalContent);
            throw new Error("injected after probe verification");
          },
        },
      }),
    ).rejects.toThrow("injected after probe verification");

    await expect(readFile(probeTarget, "utf8")).resolves.toBe(externalContent);
    await expectMissing(join(projectRoot, CONFIG_PATH));
    await expectMissing(join(projectRoot, SKILL_PATH));
  });

  it("preserves a destination replaced after ownership check and before pathname mutation", async () => {
    const projectRoot = await temporaryProject(
      "ai-qa-setup-check-mutation-replaced-",
    );
    const originalConfig = await writeConfig(
      projectRoot,
      projectConfigV2("local-only"),
    );
    await writeSkill(
      projectRoot,
      prepareProjectSkill({
        source: projectSkillSource(
          "Record results using the original procedure.",
        ),
        secretReferences: SECRET_REFERENCES,
      }).content,
    );
    const setupRequest = request(
      "Record results using the proposed procedure.",
    );
    const preview = await previewProjectSetup({
      operation: "configure",
      projectRoot,
      request: setupRequest,
    });
    const externalSkill = "external bytes from the mutation window\n";
    publicMutationFault.destinationPath = join(
      await realpath(projectRoot),
      SKILL_PATH,
    );
    publicMutationFault.externalContent = externalSkill;
    let failure: unknown;

    try {
      await applyProjectSetup({
        operation: "configure",
        projectRoot,
        request: setupRequest,
        confirmChecksum: preview.checksum,
      });
    } catch (error: unknown) {
      failure = error;
    } finally {
      publicMutationFault.destinationPath = undefined;
      publicMutationFault.externalContent = undefined;
    }

    expect(failure).toMatchObject({ code: "storage.rollback_failed" });
    const recoveryPaths = recoveryPathsFromFailure(failure);
    expect(recoveryPaths).not.toEqual([]);
    expect(recoveryPaths).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^(?:[^/]+\/)*\.ai-qa-transaction-[a-f0-9-]+-\d{4}\/.+\.recovery$/,
        ),
      ]),
    );
    const preservedContents = await Promise.all(
      [SKILL_PATH, ...recoveryPaths].map(async (relativePath) =>
        readFile(join(projectRoot, String(relativePath)), "utf8").catch(
          () => undefined,
        ),
      ),
    );
    expect(preservedContents).toContain(externalSkill);
    await expect(
      readFile(join(projectRoot, CONFIG_PATH), "utf8"),
    ).resolves.toBe(originalConfig);
  });

  it("continues rolling back owned destinations after an ownership conflict", async () => {
    const projectRoot = await temporaryProject(
      "ai-qa-setup-rollback-aggregate-",
    );
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
    const externalConfig = "external config during rollback\n";
    publicSyncFault.directoryPath = join(await realpath(projectRoot), ".ai-qa");
    publicSyncFault.action = async () => {
      await unlink(join(projectRoot, CONFIG_PATH));
      await writeFile(join(projectRoot, CONFIG_PATH), externalConfig);
    };
    publicSyncFault.errorMessage = "injected failure after both publishes";

    let failure: unknown;
    try {
      await applyPreviewTransactionForTest(projectRoot, preview);
    } catch (error: unknown) {
      failure = error;
    } finally {
      publicSyncFault.directoryPath = undefined;
      publicSyncFault.action = undefined;
      publicSyncFault.errorMessage = undefined;
    }

    expect(failure).toMatchObject({ code: "storage.rollback_failed" });
    const recoveryPaths = recoveryPathsFromFailure(failure);
    const preservedContents = await Promise.all(
      [CONFIG_PATH, ...recoveryPaths].map(async (relativePath) =>
        readFile(join(projectRoot, String(relativePath)), "utf8").catch(
          () => undefined,
        ),
      ),
    );
    expect(preservedContents).toContain(externalConfig);
    expect(preservedContents).toContain(originalConfig);
    await expect(readFile(join(projectRoot, SKILL_PATH), "utf8")).resolves.toBe(
      originalSkill,
    );
  });

  it("keeps original recovery bytes when no-replace restore finds a new destination", async () => {
    const projectRoot = await temporaryProject(
      "ai-qa-setup-restore-no-replace-",
    );
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
    const externalConfig = "new external config before restore\n";
    publicLinkFault.destinationPath = join(
      await realpath(projectRoot),
      CONFIG_PATH,
    );
    publicLinkFault.externalContent = externalConfig;
    publicSyncFault.directoryPath = join(await realpath(projectRoot), ".ai-qa");
    publicSyncFault.errorMessage = "injected post-publish failure";
    let failure: unknown;

    try {
      await applyPreviewTransactionForTest(projectRoot, preview);
    } catch (error: unknown) {
      failure = error;
    } finally {
      publicLinkFault.destinationPath = undefined;
      publicLinkFault.externalContent = undefined;
      publicSyncFault.directoryPath = undefined;
      publicSyncFault.action = undefined;
      publicSyncFault.errorMessage = undefined;
    }

    expect(failure).toMatchObject({ code: "storage.rollback_failed" });
    await expect(
      readFile(join(projectRoot, CONFIG_PATH), "utf8"),
    ).resolves.toBe(externalConfig);
    await expect(readFile(join(projectRoot, SKILL_PATH), "utf8")).resolves.toBe(
      originalSkill,
    );
    const recoveryPaths = recoveryPathsFromFailure(failure);
    expect(recoveryPaths).not.toEqual([]);
    const recoveryContents = await Promise.all(
      recoveryPaths.map((relativePath) =>
        readFile(join(projectRoot, String(relativePath)), "utf8"),
      ),
    );
    expect(recoveryContents).toContain(originalConfig);
  });

  it.each(["before", "after"] as const)(
    "rejects a repository identity changed %s a skill-only publish",
    async (changeTiming) => {
      const projectRoot = await temporaryProject(
        `ai-qa-setup-repository-${changeTiming}-publish-`,
      );
      await execFileAsync("git", ["init", projectRoot]);
      await writeConfig(projectRoot, projectConfigV2("project-skill"));
      const setupRequest = request();
      const preview = await previewProjectSetup({
        operation: "skill-generate",
        projectRoot,
        request: setupRequest,
      });
      const changeRepositoryIdentity = async () => {
        await execFileAsync("git", [
          "-C",
          projectRoot,
          "remote",
          "add",
          "origin",
          `https://example.invalid/${changeTiming}.git`,
        ]);
      };
      const canonicalRoot = await realpath(projectRoot);

      const application = (() => {
        if (changeTiming === "before") {
          return applyProjectSetup({
            operation: "skill-generate",
            projectRoot,
            request: setupRequest,
            confirmChecksum: preview.checksum,
            hooks: { beforePublish: changeRepositoryIdentity },
          });
        }
        publicSyncFault.directoryPath = join(
          canonicalRoot,
          ".agents",
          "skills",
          "ai-qa-project",
        );
        publicSyncFault.action = changeRepositoryIdentity;
        return applyPreviewTransactionForTest(projectRoot, preview);
      })();
      try {
        await expect(application).rejects.toMatchObject({
          code: "setup.checksum_mismatch",
        });
      } finally {
        publicSyncFault.directoryPath = undefined;
        publicSyncFault.action = undefined;
        publicSyncFault.errorMessage = undefined;
      }

      await expectMissing(join(projectRoot, SKILL_PATH));
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

  it.each([
    ["missing", "regular-file"],
    ["regular", "regular-file"],
    ["missing", "symlink"],
    ["regular", "symlink"],
  ] as const)(
    "preserves a %s published destination replaced by an external %s",
    async (originalState, replacementKind) => {
      const projectRoot = await temporaryProject(
        `ai-qa-setup-published-${originalState}-${replacementKind}-replaced-`,
      );
      const outside = await temporaryProject("ai-qa-setup-external-skill-");
      const outsideSkill = join(outside, "SKILL.md");
      const originalConfig = await writeConfig(
        projectRoot,
        projectConfigV2("local-only"),
      );
      if (originalState === "regular") {
        await writeSkill(
          projectRoot,
          prepareProjectSkill({
            source: projectSkillSource(
              "Record results using the original procedure.",
            ),
            secretReferences: SECRET_REFERENCES,
          }).content,
        );
      }
      const setupRequest = request(
        "Record results using the proposed procedure.",
      );
      const preview = await previewProjectSetup({
        operation: "configure",
        projectRoot,
        request: setupRequest,
      });
      const externalSkill = `external replacement for ${originalState}\n`;

      let failure: unknown;
      try {
        await applyProjectSetup({
          operation: "configure",
          projectRoot,
          request: setupRequest,
          confirmChecksum: preview.checksum,
          hooks: {
            beforePublish: async ({ publishIndex }) => {
              if (publishIndex === 0) return;
              await unlink(join(projectRoot, SKILL_PATH));
              if (replacementKind === "regular-file") {
                await writeFile(join(projectRoot, SKILL_PATH), externalSkill);
              } else {
                await writeFile(outsideSkill, externalSkill);
                await symlink(outsideSkill, join(projectRoot, SKILL_PATH));
              }
              throw new Error("injected second publish failure");
            },
          },
        });
      } catch (error: unknown) {
        failure = error;
      }

      expect(failure).toMatchObject({ code: "storage.rollback_failed" });
      const recoveryPaths = recoveryPathsFromFailure(failure);
      expect(recoveryPaths.length).toBeGreaterThan(0);
      expect(recoveryPaths).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /^(?:[^/]+\/)*\.ai-qa-transaction-[0-9a-f-]+-\d{4}\/write-\d{4}\.rollback\.recovery$/,
          ),
        ]),
      );
      const preservedContents = await Promise.all(
        [SKILL_PATH, ...recoveryPaths].map((relativePath) =>
          readFile(join(projectRoot, relativePath), "utf8").catch(
            () => undefined,
          ),
        ),
      );
      expect(preservedContents).toContain(externalSkill);
      if (replacementKind === "symlink") {
        await expect(readFile(outsideSkill, "utf8")).resolves.toBe(
          externalSkill,
        );
      }
      await expect(
        readFile(join(projectRoot, CONFIG_PATH), "utf8"),
      ).resolves.toBe(originalConfig);
    },
  );

  it.each([
    ["skill-generate", "before"],
    ["skill-generate", "after"],
    ["skill-sync", "before"],
    ["skill-sync", "after"],
  ] as const)(
    "%s rejects a config dependency changed %s publish",
    async (operation, changeTiming) => {
      const projectRoot = await temporaryProject(
        `ai-qa-${operation}-config-${changeTiming}-publish-`,
      );
      await writeConfig(projectRoot, projectConfigV2("project-skill"));
      const originalSkill =
        operation === "skill-sync"
          ? prepareProjectSkill({
              source: projectSkillSource(
                "Record results using the original procedure.",
              ),
              secretReferences: SECRET_REFERENCES,
            }).content
          : undefined;
      if (originalSkill !== undefined) {
        await writeSkill(projectRoot, originalSkill);
      }
      const setupRequest = request(
        "Record results using the proposed procedure.",
      );
      const preview = await previewProjectSetup({
        operation,
        projectRoot,
        request: setupRequest,
      });
      const externalConfig = `external config ${changeTiming} publish\n`;
      const replaceConfig = async () => {
        await writeFile(join(projectRoot, CONFIG_PATH), externalConfig);
      };

      const application = (() => {
        if (changeTiming === "before") {
          return applyProjectSetup({
            operation,
            projectRoot,
            request: setupRequest,
            confirmChecksum: preview.checksum,
            hooks: { beforePublish: replaceConfig },
          });
        }
        publicSyncFault.directoryPath = join(
          preview.projectRoot,
          ".agents",
          "skills",
          "ai-qa-project",
        );
        publicSyncFault.action = replaceConfig;
        return applyPreviewTransactionForTest(projectRoot, preview);
      })();
      try {
        await expect(application).rejects.toMatchObject({
          code: "setup.checksum_mismatch",
        });
      } finally {
        publicSyncFault.directoryPath = undefined;
        publicSyncFault.action = undefined;
        publicSyncFault.errorMessage = undefined;
      }

      await expect(
        readFile(join(projectRoot, CONFIG_PATH), "utf8"),
      ).resolves.toBe(externalConfig);
      if (originalSkill === undefined) {
        await expectMissing(join(projectRoot, SKILL_PATH));
      } else {
        await expect(
          readFile(join(projectRoot, SKILL_PATH), "utf8"),
        ).resolves.toBe(originalSkill);
      }
    },
  );

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

  it("does not forward runtime-only transaction hooks through the public setup API", async () => {
    const projectRoot = await temporaryProject("ai-qa-setup-public-hooks-");
    const setupRequest = request();
    const preview = await previewProjectSetup({
      operation: "init",
      projectRoot,
      request: setupRequest,
    });
    let afterPublishCalled = false;
    const runtimeHooks: NonNullable<ApplyProjectSetupInput["hooks"]> = {};
    Object.defineProperty(runtimeHooks, "afterPublish", {
      enumerable: true,
      value: () => {
        afterPublishCalled = true;
        return Promise.resolve();
      },
    });

    await applyProjectSetup({
      operation: "init",
      projectRoot,
      request: setupRequest,
      confirmChecksum: preview.checksum,
      hooks: runtimeHooks,
    });

    expect(afterPublishCalled).toBe(false);
  });
});

describe("project file transaction ownership", () => {
  it("retains every viable original source after an unexpected rollback error", async () => {
    const projectRoot = await temporaryProject(
      "ai-qa-rollback-unexpected-recovery-",
    );
    const originalConfig = await writeConfig(
      projectRoot,
      projectConfigV2("local-only"),
    );
    const preview = await previewProjectSetup({
      operation: "configure",
      projectRoot,
      request: request(),
    });
    const configSnapshot = preview.destinations.find(
      ({ relativePath }) => relativePath === CONFIG_PATH,
    )!;
    const transactionId = "00000000-0000-4000-8000-000000000020";
    vi.mocked(randomUUID).mockReturnValueOnce(transactionId);
    const namespaceRelative = `.ai-qa/.ai-qa-transaction-${transactionId}-0000`;
    const originalRelative = `${namespaceRelative}/write-0000.original.recovery`;
    const backupRelative = `${namespaceRelative}/write-0000.backup.recovery`;
    const canonicalRoot = await realpath(projectRoot);
    rollbackSyncFault.directoryPath = join(canonicalRoot, namespaceRelative);
    publicSyncFault.directoryPath = join(canonicalRoot, ".ai-qa");
    publicSyncFault.errorMessage = "injected post-publish sync failure";
    let failure: unknown;

    try {
      await applyProjectFileTransaction({
        projectRoot,
        writes: [
          {
            relativeSegments: [".ai-qa", "config.yaml"],
            content: "replacement config\n",
          },
        ],
        readSet: await transactionReadSet(projectRoot, [configSnapshot]),
      });
    } catch (error: unknown) {
      failure = error;
    } finally {
      publicSyncFault.directoryPath = undefined;
      publicSyncFault.action = undefined;
      publicSyncFault.errorMessage = undefined;
      rollbackSyncFault.directoryPath = undefined;
    }

    expect(failure).toMatchObject({ code: "storage.rollback_failed" });
    expect(recoveryPathsFromFailure(failure)).toEqual(
      expect.arrayContaining([originalRelative, backupRelative]),
    );
    await expect(
      readFile(join(projectRoot, originalRelative), "utf8"),
    ).resolves.toBe(originalConfig);
    await expect(
      readFile(join(projectRoot, backupRelative), "utf8"),
    ).resolves.toBe(originalConfig);
    await expectMissing(join(projectRoot, CONFIG_PATH));
  });

  it("restores the moved original inode before using the byte-copy fallback", async () => {
    const projectRoot = await temporaryProject(
      "ai-qa-rollback-original-inode-",
    );
    const originalConfig = await writeConfig(
      projectRoot,
      projectConfigV2("local-only"),
    );
    const configPath = join(projectRoot, CONFIG_PATH);
    const aliasPath = join(projectRoot, "original-config-alias.yaml");
    await link(configPath, aliasPath);
    const aliasIdentity = await lstat(aliasPath, { bigint: true });
    const setupRequest = request();
    const preview = await previewProjectSetup({
      operation: "configure",
      projectRoot,
      request: setupRequest,
    });
    publicSyncFault.directoryPath = join(await realpath(projectRoot), ".ai-qa");
    publicSyncFault.errorMessage = "injected post-publish sync failure";

    try {
      await expect(
        applyProjectSetup({
          operation: "configure",
          projectRoot,
          request: setupRequest,
          confirmChecksum: preview.checksum,
        }),
      ).rejects.toThrow("injected post-publish sync failure");
    } finally {
      publicSyncFault.directoryPath = undefined;
      publicSyncFault.action = undefined;
      publicSyncFault.errorMessage = undefined;
    }

    await expect(readFile(configPath, "utf8")).resolves.toBe(originalConfig);
    const restoredIdentity = await lstat(configPath, { bigint: true });
    expect(restoredIdentity.dev).toBe(aliasIdentity.dev);
    expect(restoredIdentity.ino).toBe(aliasIdentity.ino);
  });

  it("keeps a pre-existing empty transaction parent directory", async () => {
    const projectRoot = await temporaryProject(
      "ai-qa-existing-transaction-parent-",
    );
    const transactionParent = join(projectRoot, ".ai-qa", ".transactions");
    await mkdir(transactionParent, { recursive: true });

    await applyProjectFileTransaction({
      projectRoot,
      writes: [
        {
          relativeSegments: [".ai-qa", "config.yaml"],
          content: "new config\n",
        },
      ],
      readSet: await transactionReadSet(projectRoot, [
        { relativePath: CONFIG_PATH, state: "missing" },
      ]),
    });

    await expect(readdir(transactionParent)).resolves.toEqual([]);
  });

  it.each([
    ["stage", "write"],
    ["stage", "sync"],
    ["stage", "initial-stat"],
    ["stage", "stat"],
    ["backup", "write"],
    ["backup", "sync"],
    ["backup", "initial-stat"],
    ["backup", "stat"],
  ] as const)(
    "cleans an owned %s when %s fails after exclusive create",
    async (purpose, operation) => {
      const projectRoot = await temporaryProject(
        `ai-qa-${purpose}-${operation}-failure-`,
      );
      const originalConfig =
        purpose === "backup" ? await writeConfig(projectRoot) : undefined;
      const setupRequest = request();
      const preview = await previewProjectSetup({
        operation: purpose === "backup" ? "configure" : "init",
        projectRoot,
        request: setupRequest,
      });
      const configSnapshot = preview.destinations.find(
        ({ relativePath }) => relativePath === CONFIG_PATH,
      )!;
      ownedFileFault.purpose = purpose;
      ownedFileFault.operation = operation;

      try {
        await expect(
          applyProjectFileTransaction({
            projectRoot,
            writes: [
              {
                relativeSegments: [".ai-qa", "config.yaml"],
                content: "replacement config\n",
              },
            ],
            readSet: await transactionReadSet(projectRoot, [configSnapshot]),
          }),
        ).rejects.toThrow(`injected ${purpose} ${operation} failure`);
      } finally {
        ownedFileFault.purpose = undefined;
        ownedFileFault.operation = undefined;
      }

      if (originalConfig === undefined) {
        await expectMissing(join(projectRoot, CONFIG_PATH));
      } else {
        await expect(
          readFile(join(projectRoot, CONFIG_PATH), "utf8"),
        ).resolves.toBe(originalConfig);
      }
      expect(
        (await readdir(projectRoot, { recursive: true })).filter((path) =>
          /\.(?:stage|backup)$/.test(path),
        ),
      ).toEqual([]);
    },
  );

  it("keeps the publish error primary and attempts every private cleanup", async () => {
    const projectRoot = await temporaryProject("ai-qa-cleanup-aggregate-");
    const transactionId = "00000000-0000-4000-8000-000000000010";
    vi.mocked(randomUUID).mockReturnValueOnce(transactionId);
    cleanupFault.transactionId = transactionId;
    cleanupFault.failuresRemaining = 1;
    cleanupFault.attemptedPaths = [];
    let failure: unknown;

    try {
      await applyProjectFileTransaction({
        projectRoot,
        writes: [
          {
            relativeSegments: [".ai-qa", "config.yaml"],
            content: "new config\n",
          },
          {
            relativeSegments: [
              ".agents",
              "skills",
              "ai-qa-project",
              "SKILL.md",
            ],
            content: "new skill\n",
          },
        ],
        readSet: await transactionReadSet(projectRoot, [
          { relativePath: CONFIG_PATH, state: "missing" },
          { relativePath: SKILL_PATH, state: "missing" },
        ]),
        hooks: {
          beforePublish: () =>
            Promise.reject(new Error("primary publish failure")),
        },
      });
    } catch (error: unknown) {
      failure = error;
    } finally {
      cleanupFault.transactionId = undefined;
      cleanupFault.failuresRemaining = 0;
    }

    expect(failure).toMatchObject({ message: "primary publish failure" });
    if (!(failure instanceof Error)) {
      throw new Error("expected the primary publish error");
    }
    const cleanupCauses = JSON.stringify(
      (failure as Error & { cleanupCauses?: unknown }).cleanupCauses,
    );
    expect(cleanupCauses).toContain('"phase":"cleanup-unlink"');
    expect(cleanupCauses).toContain(transactionId);
    expect(cleanupFault.attemptedPaths).toHaveLength(6);
  });

  it("does not let cleanup failure override rollback_failed", async () => {
    const projectRoot = await temporaryProject(
      "ai-qa-cleanup-rollback-precedence-",
    );
    const transactionId = "00000000-0000-4000-8000-000000000011";
    vi.mocked(randomUUID).mockReturnValueOnce(transactionId);
    cleanupFault.transactionId = transactionId;
    cleanupFault.failuresRemaining = 100;
    cleanupFault.attemptedPaths = [];
    const externalSkill = "external skill during rollback\n";
    let failure: unknown;

    try {
      try {
        await applyProjectFileTransaction({
          projectRoot,
          writes: [
            {
              relativeSegments: [".ai-qa", "config.yaml"],
              content: "new config\n",
            },
            {
              relativeSegments: [
                ".agents",
                "skills",
                "ai-qa-project",
                "SKILL.md",
              ],
              content: "new skill\n",
            },
          ],
          readSet: await transactionReadSet(projectRoot, [
            { relativePath: CONFIG_PATH, state: "missing" },
            { relativePath: SKILL_PATH, state: "missing" },
          ]),
          hooks: {
            beforePublish: async ({ publishIndex }) => {
              if (publishIndex !== 1) return;
              await unlink(join(projectRoot, SKILL_PATH));
              await writeFile(join(projectRoot, SKILL_PATH), externalSkill);
              throw new Error("second publish failure");
            },
          },
        });
      } catch (error: unknown) {
        failure = error;
      }
    } finally {
      cleanupFault.transactionId = undefined;
      cleanupFault.failuresRemaining = 0;
    }

    expect(failure).toMatchObject({ code: "storage.rollback_failed" });
    const recoveryPaths = recoveryPathsFromFailure(failure);
    const preservedContents = await Promise.all(
      [SKILL_PATH, ...recoveryPaths].map(async (relativePath) =>
        readFile(join(projectRoot, String(relativePath)), "utf8").catch(
          () => undefined,
        ),
      ),
    );
    expect(preservedContents).toContain(externalSkill);
    expect(cleanupFault.attemptedPaths.length).toBeGreaterThan(0);
  });

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
        readSet: await transactionReadSet(projectRoot, [
          { relativePath: CONFIG_PATH, state: "missing" },
        ]),
      }),
    ).resolves.toBeUndefined();

    await expect(readFile(unowned, "utf8")).resolves.toBe("unowned fixture\n");
    await expect(
      readFile(join(projectRoot, CONFIG_PATH), "utf8"),
    ).resolves.toBe("new config\n");
  });

  it("detects a replaced private stage and rolls back", async () => {
    const projectRoot = await temporaryProject("ai-qa-setup-stage-replaced-");
    const uuid = "00000000-0000-4000-8000-000000000001";
    const canonicalRoot = await realpath(projectRoot);
    const configStage = join(
      canonicalRoot,
      ".ai-qa",
      `.ai-qa-transaction-${uuid}-0001`,
      "write-0001.stage",
    );
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
        readSet: await transactionReadSet(projectRoot, [
          { relativePath: CONFIG_PATH, state: "missing" },
          { relativePath: SKILL_PATH, state: "missing" },
        ]),
        hooks: {
          beforePublish: async ({ publishIndex }) => {
            if (publishIndex !== 1) return;
            await unlink(configStage);
            await writeFile(configStage, "private replacement\n");
          },
        },
      }),
    ).rejects.toMatchObject({ code: "storage.integrity_error" });

    await expectMissing(join(projectRoot, CONFIG_PATH));
    await expectMissing(join(projectRoot, SKILL_PATH));
    await expectMissing(configStage);
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
    await writeFile(backup, "unowned backup\n");
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
        readSet: await transactionReadSet(projectRoot, [configSnapshot]),
        hooks: {
          beforePublish: () =>
            Promise.reject(new Error("injected before publish")),
        },
      }),
    ).rejects.toThrow("injected before publish");

    await expect(readFile(backup, "utf8")).resolves.toBe("unowned backup\n");
    await expect(
      readFile(join(projectRoot, CONFIG_PATH), "utf8"),
    ).resolves.toBe(originalConfig);
  });

  it("does not publish a replaced second stage and rolls back the first file", async () => {
    const projectRoot = await temporaryProject("ai-qa-stage-publish-replaced-");
    const uuid = "00000000-0000-4000-8000-000000000003";
    const canonicalRoot = await realpath(projectRoot);
    const configStage = join(
      canonicalRoot,
      ".ai-qa",
      `.ai-qa-transaction-${uuid}-0001`,
      "write-0001.stage",
    );
    vi.mocked(randomUUID).mockReturnValueOnce(uuid);

    await expect(
      applyProjectFileTransaction({
        projectRoot,
        writes: [
          {
            relativeSegments: [".ai-qa", "config.yaml"],
            content: "expected config stage\n",
          },
          {
            relativeSegments: [
              ".agents",
              "skills",
              "ai-qa-project",
              "SKILL.md",
            ],
            content: "expected skill stage\n",
          },
        ],
        readSet: await transactionReadSet(projectRoot, [
          { relativePath: CONFIG_PATH, state: "missing" },
          { relativePath: SKILL_PATH, state: "missing" },
        ]),
        hooks: {
          beforePublish: async ({ publishIndex }) => {
            if (publishIndex !== 1) return;
            await unlink(configStage);
            await writeFile(configStage, "unowned replacement stage\n");
          },
        },
      }),
    ).rejects.toMatchObject({ code: "storage.integrity_error" });

    await expectMissing(join(projectRoot, CONFIG_PATH));
    await expectMissing(join(projectRoot, SKILL_PATH));
    await expectMissing(configStage);
  });

  it("does not publish an in-place modified second stage and rolls back", async () => {
    const projectRoot = await temporaryProject("ai-qa-stage-publish-modified-");
    const uuid = "00000000-0000-4000-8000-000000000004";
    const canonicalRoot = await realpath(projectRoot);
    const configStage = join(
      canonicalRoot,
      ".ai-qa",
      `.ai-qa-transaction-${uuid}-0001`,
      "write-0001.stage",
    );
    vi.mocked(randomUUID).mockReturnValueOnce(uuid);

    await expect(
      applyProjectFileTransaction({
        projectRoot,
        writes: [
          {
            relativeSegments: [".ai-qa", "config.yaml"],
            content: "expected config stage\n",
          },
          {
            relativeSegments: [
              ".agents",
              "skills",
              "ai-qa-project",
              "SKILL.md",
            ],
            content: "expected skill stage\n",
          },
        ],
        readSet: await transactionReadSet(projectRoot, [
          { relativePath: CONFIG_PATH, state: "missing" },
          { relativePath: SKILL_PATH, state: "missing" },
        ]),
        hooks: {
          beforePublish: async ({ publishIndex }) => {
            if (publishIndex === 1) {
              await writeFile(configStage, "modified stage bytes\n");
            }
          },
        },
      }),
    ).rejects.toMatchObject({ code: "storage.integrity_error" });

    await expectMissing(join(projectRoot, CONFIG_PATH));
    await expectMissing(join(projectRoot, SKILL_PATH));
    await expectMissing(configStage);
  });

  it("does not use a replaced byte-copy backup while the moved original is viable", async () => {
    const projectRoot = await temporaryProject(
      "ai-qa-backup-restore-replaced-",
    );
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
    const uuid = "00000000-0000-4000-8000-000000000005";
    const canonicalRoot = await realpath(projectRoot);
    const skillBackup = join(
      canonicalRoot,
      ".agents",
      "skills",
      "ai-qa-project",
      `.ai-qa-transaction-${uuid}-0000`,
      "write-0000.backup.recovery",
    );
    const unownedBackup = "unowned replacement backup\n";
    vi.mocked(randomUUID).mockReturnValueOnce(uuid);

    let failure: unknown;
    try {
      await applyProjectSetup({
        operation: "configure",
        projectRoot,
        request: setupRequest,
        confirmChecksum: preview.checksum,
        hooks: {
          beforePublish: async ({ publishIndex }) => {
            if (publishIndex === 0) {
              await unlink(skillBackup);
              await writeFile(skillBackup, unownedBackup);
              return;
            }
            throw new Error("injected second publish failure");
          },
        },
      });
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toMatchObject({
      message: "injected second publish failure",
    });
    expect(recoveryPathsFromFailure(failure)).toEqual([]);
    await expectMissing(skillBackup);
    await expect(
      readFile(join(projectRoot, CONFIG_PATH), "utf8"),
    ).resolves.toBe(originalConfig);
    await expect(readFile(join(projectRoot, SKILL_PATH), "utf8")).resolves.toBe(
      originalSkill,
    );
  });
});
