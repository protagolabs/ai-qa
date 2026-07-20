# AI QA Project Clear Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an idempotent, non-interactive `ai-qa clear` command that removes project configuration by default and removes all project-local AI QA state when `--records` is supplied.

**Architecture:** A focused project-clear service owns the fixed deletion set, project containment checks, symlink-safe removal, and structured result. The existing project-root resolver gains a `clear` mode for initialized-ancestor discovery with Git-root fallback, while a thin Commander module resolves the target, invokes the service, and emits JSON.

**Tech Stack:** TypeScript 5.9, Node.js 22/24 filesystem APIs, Commander 14, Vitest 4, pnpm 11.9.

## Global Constraints

- `ai-qa clear` is non-interactive; invoking the command is the deletion confirmation.
- The operation is idempotent. Missing targets succeed and are omitted from `removedPaths`.
- Default mode removes only `.ai-qa/config.yaml` and the complete `.agents/skills/ai-qa-project/` entry.
- `--records` removes the complete `.ai-qa/` entry and the complete `.agents/skills/ai-qa-project/` entry.
- Other entries under `.agents/skills/` and now-empty parent directories remain untouched.
- Explicit `--project <path>` always wins. Implicit resolution prefers the nearest configured ancestor, then the Git root.
- A final-target symlink is unlinked, never followed. Symlinked or invalid ancestors fail with `storage.integrity_error` before any deletion.
- Output uses project-relative removed paths and exactly the fields `status`, `projectRoot`, `records`, and `removedPaths`.
- No backups, interactive prompts, selective record categories, new dependencies, or unrelated refactors.
- Run the existing complete TypeScript/Node quality gate before completion.

---

## File structure

- Create `src/services/project-clear/clear-project.ts`: validate the fixed project-local targets, preflight all targets, remove them safely, and return the public result.
- Create `tests/integration/project-clear.test.ts`: exercise deletion scope, idempotency, preservation, and symlink containment at the service boundary.
- Modify `src/services/project-root/resolve-project-root.ts`: add clear-specific Git-root fallback and error copy.
- Modify `tests/unit/project-root.test.ts`: cover clear resolution before and after configuration removal.
- Create `src/cli/commands/clear.ts`: register `ai-qa clear`, read global `--project`, resolve the root, call the service, and emit JSON.
- Modify `src/cli/program.ts`: register the new top-level command.
- Create `tests/integration/clear-cli.test.ts`: verify the public command and JSON contract end to end.
- Modify `tests/cli/help.test.ts`: verify clear command discovery and `--records` help.
- Modify `README.md`: document both destructive command modes and their retained/deleted data.

### Task 1: Project-clear service

**Files:**
- Create: `src/services/project-clear/clear-project.ts`
- Create: `tests/integration/project-clear.test.ts`

**Interfaces:**
- Consumes: a canonical or canonicalizable project root supplied by the project-root layer.
- Produces: `clearProject(input: { projectRoot: string; records: boolean }): Promise<ClearProjectResult>`.
- Produces: `ClearProjectResult = { status: "cleared"; projectRoot: string; records: boolean; removedPaths: string[] }`.

- [ ] **Step 1: Write failing scope, idempotency, and symlink-safety tests**

Create `tests/integration/project-clear.test.ts` with the initial behavior tests:

```ts
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearProject } from "../../src/services/project-clear/clear-project.js";

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

async function createInitializedProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ai-qa-clear-project-"));
  await Promise.all([
    mkdir(join(root, ".ai-qa", "cases", "login"), { recursive: true }),
    mkdir(join(root, ".ai-qa", "runs", "run-1"), { recursive: true }),
    mkdir(join(root, ".ai-qa", "run-groups", "group-1"), {
      recursive: true,
    }),
    mkdir(join(root, ".ai-qa", "evidence", "run-1"), { recursive: true }),
    mkdir(join(root, ".ai-qa", "reports", "runs", "run-1"), {
      recursive: true,
    }),
    mkdir(join(root, ".agents", "skills", "ai-qa-project", "references"), {
      recursive: true,
    }),
    mkdir(join(root, ".agents", "skills", "other-skill"), {
      recursive: true,
    }),
  ]);
  await Promise.all([
    writeFile(join(root, ".ai-qa", "config.yaml"), "schemaVersion: 3\n"),
    writeFile(join(root, ".ai-qa", "cases", "login", "case.yaml"), "case"),
    writeFile(join(root, ".ai-qa", "runs", "run-1", "events.jsonl"), "run"),
    writeFile(
      join(root, ".ai-qa", "run-groups", "group-1", "manifest.json"),
      "group",
    ),
    writeFile(join(root, ".ai-qa", "evidence", "run-1", "index.jsonl"), "evidence"),
    writeFile(
      join(root, ".ai-qa", "reports", "runs", "run-1", "recording.jsonl"),
      "receipt",
    ),
    writeFile(
      join(root, ".agents", "skills", "ai-qa-project", "SKILL.md"),
      "project skill",
    ),
    writeFile(
      join(
        root,
        ".agents",
        "skills",
        "ai-qa-project",
        "references",
        "procedure.md",
      ),
      "procedure",
    ),
    writeFile(
      join(root, ".agents", "skills", "other-skill", "SKILL.md"),
      "other skill",
    ),
  ]);
  return root;
}

describe("clearProject", () => {
  it("clears configuration while preserving every QA record by default", async () => {
    const root = await createInitializedProject();

    await expect(clearProject({ projectRoot: root, records: false })).resolves.toEqual({
      status: "cleared",
      projectRoot: await realpath(root),
      records: false,
      removedPaths: [
        ".ai-qa/config.yaml",
        ".agents/skills/ai-qa-project",
      ],
    });

    await expectMissing(join(root, ".ai-qa", "config.yaml"));
    await expectMissing(join(root, ".agents", "skills", "ai-qa-project"));
    await expect(
      readFile(join(root, ".ai-qa", "cases", "login", "case.yaml"), "utf8"),
    ).resolves.toBe("case");
    await expect(
      readFile(join(root, ".ai-qa", "runs", "run-1", "events.jsonl"), "utf8"),
    ).resolves.toBe("run");
    await expect(
      readFile(
        join(root, ".ai-qa", "run-groups", "group-1", "manifest.json"),
        "utf8",
      ),
    ).resolves.toBe("group");
    await expect(
      readFile(join(root, ".ai-qa", "evidence", "run-1", "index.jsonl"), "utf8"),
    ).resolves.toBe("evidence");
    await expect(
      readFile(
        join(root, ".ai-qa", "reports", "runs", "run-1", "recording.jsonl"),
        "utf8",
      ),
    ).resolves.toBe("receipt");
    await expect(
      readFile(join(root, ".agents", "skills", "other-skill", "SKILL.md"), "utf8"),
    ).resolves.toBe("other skill");
  });

  it("clears all AI QA state when records are requested", async () => {
    const root = await createInitializedProject();

    await expect(clearProject({ projectRoot: root, records: true })).resolves.toEqual({
      status: "cleared",
      projectRoot: await realpath(root),
      records: true,
      removedPaths: [".ai-qa", ".agents/skills/ai-qa-project"],
    });

    await expectMissing(join(root, ".ai-qa"));
    await expectMissing(join(root, ".agents", "skills", "ai-qa-project"));
    await expect(
      readFile(join(root, ".agents", "skills", "other-skill", "SKILL.md"), "utf8"),
    ).resolves.toBe("other skill");
  });

  it("is idempotent when all targets are already absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-qa-clear-empty-"));

    await expect(clearProject({ projectRoot: root, records: false })).resolves.toEqual({
      status: "cleared",
      projectRoot: await realpath(root),
      records: false,
      removedPaths: [],
    });
    await expect(clearProject({ projectRoot: root, records: true })).resolves.toEqual({
      status: "cleared",
      projectRoot: await realpath(root),
      records: true,
      removedPaths: [],
    });
  });

  it("unlinks final-target symlinks without touching outside data", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-qa-clear-symlink-project-"));
    const outside = await mkdtemp(join(tmpdir(), "ai-qa-clear-symlink-outside-"));
    await mkdir(join(root, ".agents", "skills"), { recursive: true });
    await writeFile(join(outside, "config.yaml"), "outside config");
    await mkdir(join(outside, "project-skill"));
    await writeFile(join(outside, "project-skill", "SKILL.md"), "outside skill");
    await mkdir(join(root, ".ai-qa"));
    await symlink(join(outside, "config.yaml"), join(root, ".ai-qa", "config.yaml"));
    await symlink(
      join(outside, "project-skill"),
      join(root, ".agents", "skills", "ai-qa-project"),
    );

    await expect(
      clearProject({ projectRoot: root, records: false }),
    ).resolves.toMatchObject({
      removedPaths: [".ai-qa/config.yaml", ".agents/skills/ai-qa-project"],
    });
    await expect(readFile(join(outside, "config.yaml"), "utf8")).resolves.toBe(
      "outside config",
    );
    await expect(
      readFile(join(outside, "project-skill", "SKILL.md"), "utf8"),
    ).resolves.toBe("outside skill");
  });

  it("preflights every target before rejecting a symlinked ancestor", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-qa-clear-ancestor-project-"));
    const outside = await mkdtemp(join(tmpdir(), "ai-qa-clear-ancestor-outside-"));
    await mkdir(join(root, ".ai-qa"));
    await writeFile(join(root, ".ai-qa", "config.yaml"), "inside config");
    await symlink(outside, join(root, ".agents"));

    await expect(
      clearProject({ projectRoot: root, records: false }),
    ).rejects.toMatchObject({ code: "storage.integrity_error" });
    await expect(
      readFile(join(root, ".ai-qa", "config.yaml"), "utf8"),
    ).resolves.toBe("inside config");
  });

  it("unlinks a symlinked .ai-qa entry in records mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-qa-clear-record-link-project-"));
    const outside = await mkdtemp(join(tmpdir(), "ai-qa-clear-record-link-outside-"));
    await writeFile(join(outside, "history.jsonl"), "outside history");
    await symlink(outside, join(root, ".ai-qa"));

    await expect(
      clearProject({ projectRoot: root, records: true }),
    ).resolves.toMatchObject({ removedPaths: [".ai-qa"] });
    await expect(
      readFile(join(outside, "history.jsonl"), "utf8"),
    ).resolves.toBe("outside history");
  });
});
```

- [ ] **Step 2: Run the service tests to verify they fail**

Run:

```bash
pnpm exec vitest run tests/integration/project-clear.test.ts
```

Expected: FAIL because `src/services/project-clear/clear-project.ts` does not exist.

- [ ] **Step 3: Implement the fixed-scope clear service**

Create `src/services/project-clear/clear-project.ts`:

```ts
import { lstat, realpath, rm, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { AiQaError } from "../../core/errors.js";

interface ClearProjectInput {
  projectRoot: string;
  records: boolean;
}

export interface ClearProjectResult {
  status: "cleared";
  projectRoot: string;
  records: boolean;
  removedPaths: string[];
}

interface TargetSpec {
  segments: readonly string[];
  expected: "file" | "directory";
}

interface Identity {
  dev: bigint;
  ino: bigint;
}

type InspectedTarget =
  | {
      state: "missing";
      spec: TargetSpec;
      path: string;
      relativePath: string;
    }
  | {
      state: "present";
      spec: TargetSpec;
      path: string;
      relativePath: string;
      entryKind: "file" | "directory" | "symlink";
      identity: Identity;
    };

const projectSkillTarget: TargetSpec = {
  segments: [".agents", "skills", "ai-qa-project"],
  expected: "directory",
};

export async function clearProject(
  input: ClearProjectInput,
): Promise<ClearProjectResult> {
  const projectRoot = await realpath(input.projectRoot);
  const targets: readonly TargetSpec[] = [
    input.records
      ? { segments: [".ai-qa"], expected: "directory" }
      : { segments: [".ai-qa", "config.yaml"], expected: "file" },
    projectSkillTarget,
  ];
  const inspected = await Promise.all(
    targets.map((target) => inspectTarget(projectRoot, target)),
  );
  const removedPaths: string[] = [];
  for (const target of inspected) {
    if (await removeInspectedTarget(projectRoot, target)) {
      removedPaths.push(target.relativePath);
    }
  }
  return {
    status: "cleared",
    projectRoot,
    records: input.records,
    removedPaths,
  };
}

async function inspectTarget(
  projectRoot: string,
  spec: TargetSpec,
): Promise<InspectedTarget> {
  const path = resolve(projectRoot, ...spec.segments);
  const relativePath = spec.segments.join("/");
  let current = projectRoot;
  for (const segment of spec.segments.slice(0, -1)) {
    current = resolve(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) {
        return { state: "missing", spec, path, relativePath };
      }
      throw storageError("Project-local removal ancestor inspection failed", current, error);
    }
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      (await realpath(current)) !== current
    ) {
      throw storageError("Project-local removal ancestor is not a real directory", current);
    }
  }

  let stats;
  try {
    stats = await lstat(path, { bigint: true });
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { state: "missing", spec, path, relativePath };
    }
    throw storageError("Project-local removal target inspection failed", path, error);
  }
  const entryKind = stats.isSymbolicLink()
    ? "symlink"
    : stats.isFile()
      ? "file"
      : stats.isDirectory()
        ? "directory"
        : undefined;
  if (
    entryKind === undefined ||
    (entryKind !== "symlink" && entryKind !== spec.expected)
  ) {
    throw storageError("Project-local removal target has an invalid type", path);
  }
  return {
    state: "present",
    spec,
    path,
    relativePath,
    entryKind,
    identity: { dev: stats.dev, ino: stats.ino },
  };
}

async function removeInspectedTarget(
  projectRoot: string,
  target: InspectedTarget,
): Promise<boolean> {
  if (target.state === "missing") return false;
  const current = await inspectTarget(projectRoot, target.spec);
  if (current.state === "missing") return false;
  if (
    current.identity.dev !== target.identity.dev ||
    current.identity.ino !== target.identity.ino ||
    current.entryKind !== target.entryKind
  ) {
    throw storageError("Project-local removal target changed during verification", target.path);
  }
  try {
    if (current.entryKind === "directory") {
      await rm(current.path, { recursive: true });
    } else {
      await unlink(current.path);
    }
    return true;
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function storageError(message: string, path: string, cause?: unknown): AiQaError {
  return new AiQaError("storage.integrity_error", message, {
    path,
    ...(nodeErrorCode(cause) === undefined
      ? {}
      : { causeCode: nodeErrorCode(cause) }),
  });
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string"
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function isNodeError(error: unknown, code: string): boolean {
  return nodeErrorCode(error) === code;
}
```

- [ ] **Step 4: Run the service tests to verify the basic behavior passes**

Run:

```bash
pnpm exec vitest run tests/integration/project-clear.test.ts
```

Expected: PASS with 6 tests. If any symlink case fails, fix only `clear-project.ts`; do not weaken the assertions or follow a symlink.

- [ ] **Step 5: Run focused static checks**

Run:

```bash
pnpm exec eslint src/services/project-clear/clear-project.ts tests/integration/project-clear.test.ts
pnpm typecheck
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit the service**

```bash
git add src/services/project-clear/clear-project.ts tests/integration/project-clear.test.ts
git commit -m "feat: add project clear service"
```

### Task 2: Clear-aware project resolution

**Files:**
- Modify: `src/services/project-root/resolve-project-root.ts:4-76`
- Modify: `tests/unit/project-root.test.ts:1-47`

**Interfaces:**
- Consumes: `ResolveProjectRootInput` and the existing `ResolvedProjectRoot` result.
- Produces: support for `command: "clear"` with configured-ancestor-first, Git-root-second resolution.
- Preserves: existing `"init"` and `"other"` behavior.

- [ ] **Step 1: Add failing clear-resolution tests**

Add these tests inside the existing `describe("resolveProjectRoot", ...)` block in `tests/unit/project-root.test.ts`:

```ts
it("falls back to the Git root when clear has no stored config", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-qa-clear-git-root-"));
  const nested = join(root, "packages", "app");
  await mkdir(join(root, ".git"));
  await mkdir(nested, { recursive: true });

  await expect(
    resolveProjectRoot({ command: "clear", cwd: nested }),
  ).resolves.toEqual({ root: await realpath(root), source: "git-root" });
});

it("prefers a configured ancestor over the Git root for clear", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-qa-clear-config-root-"));
  const nestedProject = join(root, "packages", "app");
  const workingDirectory = join(nestedProject, "src");
  await mkdir(join(root, ".git"));
  await mkdir(join(nestedProject, ".ai-qa"), { recursive: true });
  await mkdir(workingDirectory, { recursive: true });
  await writeFile(
    join(nestedProject, ".ai-qa", "config.yaml"),
    "schemaVersion: 3\n",
  );

  await expect(
    resolveProjectRoot({ command: "clear", cwd: workingDirectory }),
  ).resolves.toEqual({
    root: await realpath(nestedProject),
    source: "config-ancestor",
  });
});

it("requires an explicit clear target outside Git after config removal", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-qa-clear-no-git-"));

  await expect(
    resolveProjectRoot({ command: "clear", cwd: root }),
  ).rejects.toMatchObject({
    code: "project.explicit_required",
    message: "clear outside Git requires --project <path>",
  });
});
```

- [ ] **Step 2: Run the resolver tests to verify they fail**

Run:

```bash
pnpm exec vitest run tests/unit/project-root.test.ts
```

Expected: FAIL at TypeScript transform/collection because `"clear"` is not assignable to the current command union.

- [ ] **Step 3: Add the clear resolver mode**

In `src/services/project-root/resolve-project-root.ts`, change the command type and fallback branch to:

```ts
export interface ResolveProjectRootInput {
  command: "init" | "clear" | "other";
  cwd: string;
  explicitProject?: string;
}
```

Replace the existing `if (input.command === "init")` block with:

```ts
if (input.command !== "other") {
  const gitRoot = await findAncestor(input.cwd, async (candidate) => {
    const dotGit = join(candidate, ".git");
    if (!(await exists(dotGit))) return false;
    try {
      await readFile(dotGit, "utf8");
    } catch {
      return true;
    }
    return true;
  });
  if (gitRoot !== undefined) return { root: gitRoot, source: "git-root" };
  throw new AiQaError(
    "project.explicit_required",
    `${input.command} outside Git requires --project <path>`,
  );
}
```

Leave the final `project.not_found` branch unchanged for configured-project commands.

- [ ] **Step 4: Run resolver and adjacent doctor tests**

Run:

```bash
pnpm exec vitest run tests/unit/project-root.test.ts tests/integration/doctor-cli.test.ts
```

Expected: PASS. The existing init and doctor behavior must remain unchanged.

- [ ] **Step 5: Commit project resolution**

```bash
git add src/services/project-root/resolve-project-root.ts tests/unit/project-root.test.ts
git commit -m "feat: resolve projects for clear command"
```

### Task 3: Public CLI command and documentation

**Files:**
- Create: `src/cli/commands/clear.ts`
- Modify: `src/cli/program.ts:3-53`
- Create: `tests/integration/clear-cli.test.ts`
- Modify: `tests/cli/help.test.ts:10-53`
- Modify: `README.md:27-46`

**Interfaces:**
- Consumes: `resolveProjectRoot({ command: "clear", cwd, explicitProject? })` from Task 2.
- Consumes: `clearProject({ projectRoot, records })` from Task 1.
- Produces: `registerClearCommand(program: Command, context: CliContext): void`.
- Produces: public `ai-qa clear [--records]` command with structured JSON output.

- [ ] **Step 1: Write failing CLI integration tests**

Create `tests/integration/clear-cli.test.ts`:

```ts
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/program.js";
import { createCapturedCli } from "../helpers/cli-context.js";

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

async function createCliProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ai-qa-clear-cli-"));
  await Promise.all([
    mkdir(join(root, ".ai-qa", "runs", "run-1"), { recursive: true }),
    mkdir(join(root, ".agents", "skills", "ai-qa-project"), {
      recursive: true,
    }),
  ]);
  await Promise.all([
    writeFile(join(root, ".ai-qa", "config.yaml"), "schemaVersion: 3\n"),
    writeFile(join(root, ".ai-qa", "runs", "run-1", "events.jsonl"), "run"),
    writeFile(
      join(root, ".agents", "skills", "ai-qa-project", "SKILL.md"),
      "skill",
    ),
  ]);
  return root;
}

describe("clear CLI", () => {
  it("clears only configuration for the exact explicit project", async () => {
    const ancestor = await createCliProject();
    const nested = await createCliProject();
    const captured = createCapturedCli({ cwd: ancestor });

    expect(
      await runCli(["--project", nested, "clear"], captured.context),
    ).toBe(0);
    expect(JSON.parse(captured.stdout.join(""))).toEqual({
      status: "cleared",
      projectRoot: await realpath(nested),
      records: false,
      removedPaths: [
        ".ai-qa/config.yaml",
        ".agents/skills/ai-qa-project",
      ],
    });
    expect(captured.stderr).toEqual([]);
    await expectMissing(join(nested, ".ai-qa", "config.yaml"));
    await expect(
      readFile(join(nested, ".ai-qa", "runs", "run-1", "events.jsonl"), "utf8"),
    ).resolves.toBe("run");
    await expect(
      readFile(join(ancestor, ".ai-qa", "config.yaml"), "utf8"),
    ).resolves.toBe("schemaVersion: 3\n");
  });

  it("clears records and remains repeatable through Git-root fallback", async () => {
    const root = await createCliProject();
    await mkdir(join(root, ".git"));
    const first = createCapturedCli({ cwd: root });

    expect(await runCli(["clear", "--records"], first.context)).toBe(0);
    expect(JSON.parse(first.stdout.join(""))).toMatchObject({
      status: "cleared",
      records: true,
      removedPaths: [".ai-qa", ".agents/skills/ai-qa-project"],
    });
    await expectMissing(join(root, ".ai-qa"));

    const second = createCapturedCli({ cwd: root });
    expect(await runCli(["clear", "--records"], second.context)).toBe(0);
    expect(JSON.parse(second.stdout.join(""))).toEqual({
      status: "cleared",
      projectRoot: await realpath(root),
      records: true,
      removedPaths: [],
    });
  });
});
```

- [ ] **Step 2: Add failing help assertions**

In `tests/cli/help.test.ts`, add this test:

```ts
it("documents the clear command and destructive records option", async () => {
  const captured = createCapturedCli();

  expect(await runCli(["--help"], captured.context)).toBe(0);
  expect(captured.stdout.join("")).toMatch(/^\s+clear\s/m);

  captured.stdout.length = 0;
  expect(await runCli(["clear", "--help"], captured.context)).toBe(0);
  const help = captured.stdout.join("");
  expect(help).toContain("--records");
  expect(help).toContain("delete all project-local AI QA records");
});
```

- [ ] **Step 3: Run CLI tests to verify they fail**

Run:

```bash
pnpm exec vitest run tests/integration/clear-cli.test.ts tests/cli/help.test.ts
```

Expected: FAIL because `clear` is not registered.

- [ ] **Step 4: Implement the thin Commander module**

Create `src/cli/commands/clear.ts`:

```ts
import type { Command } from "commander";
import { clearProject } from "../../services/project-clear/clear-project.js";
import { resolveProjectRoot } from "../../services/project-root/resolve-project-root.js";
import type { CliContext } from "../context.js";
import { writeJson } from "../io.js";

function explicitProject(command: Command): string | undefined {
  const value: unknown = command.optsWithGlobals().project;
  return typeof value === "string" ? value : undefined;
}

export function registerClearCommand(
  program: Command,
  context: CliContext,
): void {
  const clearCommand = program
    .command("clear")
    .description("clear project-local AI QA configuration")
    .option("--records", "delete all project-local AI QA records");

  clearCommand.action(async (options: { records?: boolean }) => {
    const selectedProject = explicitProject(clearCommand);
    const project = await resolveProjectRoot({
      command: "clear",
      cwd: context.cwd,
      ...(selectedProject === undefined
        ? {}
        : { explicitProject: selectedProject }),
    });
    writeJson(
      context,
      await clearProject({
        projectRoot: project.root,
        records: options.records === true,
      }),
    );
  });
}
```

- [ ] **Step 5: Register the command**

Add this import near the other command imports in `src/cli/program.ts`:

```ts
import { registerClearCommand } from "./commands/clear.js";
```

Register it before `registerConfigCommands` so the top-level help remains alphabetically readable in that section:

```ts
registerCaseCommands(program, context);
registerClearCommand(program, context);
registerConfigCommands(program, context);
```

- [ ] **Step 6: Run CLI, service, resolver, and help tests**

Run:

```bash
pnpm exec vitest run tests/integration/clear-cli.test.ts tests/integration/project-clear.test.ts tests/unit/project-root.test.ts tests/cli/help.test.ts
```

Expected: PASS.

- [ ] **Step 7: Document the destructive behavior**

Insert this section in `README.md` after “State and authority” and before “Configure a project”:

````markdown
## Clear project configuration and records

Clear the selected project's AI QA configuration without deleting cases, runs, evidence, or reports:

```bash
ai-qa clear
ai-qa --project /exact/project/path clear
```

This immediately removes `.ai-qa/config.yaml` and the complete `.agents/skills/ai-qa-project/` directory. The command is idempotent and does not prompt for confirmation.

To also delete every project-local AI QA record, including cases, runs, RunGroups, evidence, reports, and recording receipts:

```bash
ai-qa clear --records
```

`--records` immediately removes the complete `.ai-qa/` directory. Other project skills remain untouched.
````

- [ ] **Step 8: Run focused formatting and static validation**

Run:

```bash
pnpm exec prettier --check src/cli/commands/clear.ts src/cli/program.ts src/services/project-clear/clear-project.ts tests/integration/clear-cli.test.ts tests/integration/project-clear.test.ts tests/unit/project-root.test.ts tests/cli/help.test.ts README.md
pnpm exec eslint src/cli/commands/clear.ts src/cli/program.ts src/services/project-clear/clear-project.ts tests/integration/clear-cli.test.ts tests/integration/project-clear.test.ts tests/unit/project-root.test.ts tests/cli/help.test.ts
pnpm typecheck
```

Expected: all three commands exit 0. If Prettier reports differences, run `pnpm exec prettier --write` with the same explicit file list, inspect the diff, then rerun the check.

- [ ] **Step 9: Commit the public command**

```bash
git add src/cli/commands/clear.ts src/cli/program.ts tests/integration/clear-cli.test.ts tests/cli/help.test.ts README.md
git commit -m "feat: add project clear command"
```

### Task 4: Full regression and completion gate

**Files:**
- Verify only; do not modify unrelated files to silence failures.

**Interfaces:**
- Consumes: all Task 1–3 commits.
- Produces: evidence that the complete repository remains formatted, lint-clean, type-safe, tested, and buildable.

- [ ] **Step 1: Run the complete quality gate**

Run:

```bash
pnpm check
```

Expected: `format:check`, `lint`, `typecheck`, the complete Vitest suite, and `build` all exit 0.

- [ ] **Step 2: Inspect the final diff and commit sequence**

Run:

```bash
git status --short
git diff --check
git log -5 --oneline --decorate
```

Expected:

- `git status --short` is empty;
- `git diff --check` emits no output;
- the log contains the design and plan commits followed by the service, resolver, and CLI commits.

- [ ] **Step 3: Perform a manual built-CLI smoke test in a disposable target**

Run these commands one at a time. The first `mkdir` must succeed; if the exact path already exists, stop and choose a new explicit path before running any later command:

```bash
mkdir /tmp/ai-qa-clear-smoke-20260720
mkdir -p /tmp/ai-qa-clear-smoke-20260720/.ai-qa/runs/run-1
mkdir -p /tmp/ai-qa-clear-smoke-20260720/.agents/skills/ai-qa-project
touch /tmp/ai-qa-clear-smoke-20260720/.ai-qa/config.yaml
touch /tmp/ai-qa-clear-smoke-20260720/.ai-qa/runs/run-1/events.jsonl
touch /tmp/ai-qa-clear-smoke-20260720/.agents/skills/ai-qa-project/SKILL.md
node dist/cli/main.js --project /tmp/ai-qa-clear-smoke-20260720 clear
test -f /tmp/ai-qa-clear-smoke-20260720/.ai-qa/runs/run-1/events.jsonl
test ! -e /tmp/ai-qa-clear-smoke-20260720/.ai-qa/config.yaml
test ! -e /tmp/ai-qa-clear-smoke-20260720/.agents/skills/ai-qa-project
node dist/cli/main.js --project /tmp/ai-qa-clear-smoke-20260720 clear --records
test ! -e /tmp/ai-qa-clear-smoke-20260720/.ai-qa
```

Expected: both CLI calls emit `status: "cleared"`; every `test` command exits 0. Remove only the exact disposable directory after recording the result.

- [ ] **Step 4: Report completion evidence**

Report the `pnpm check` result, focused clear-test count, built-CLI smoke result, commits created, and the exact behavior of default versus `--records`. Do not claim completion unless every preceding verification is green.
