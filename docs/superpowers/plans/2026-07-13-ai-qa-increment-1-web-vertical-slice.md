# AI QA Increment 1 Web Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first working `ai-qa` increment: a globally installable Node.js CLI and global Agent Skill that complete one evidence-backed Web exploratory-to-regression vertical slice with project-local reports.

**Architecture:** The AI agent remains the orchestrator and controls Web through Chrome DevTools MCP; the CLI never embeds an MCP client. The CLI is an ESM TypeScript package whose domain services own project resolution, machine-local trust, append-only run journals, immutable evidence, case revisions, replay validation, and local reports under each target project's `.ai-qa/` directory. Public commands call typed services only; no public generic event append API exists.

**Tech Stack:** Node.js 22 and 24, TypeScript strict mode, ESM, pnpm 11.9.0, Commander, Zod, YAML, proper-lockfile, Vitest, ESLint, and Prettier.

**Design Spec:** `docs/superpowers/specs/2026-07-13-ai-qa-design.md`

## Global Constraints

- Support Node.js 22 and Node.js 24 LTS; Node.js 20 is unsupported.
- Emit ESM and enable TypeScript strict type checking.
- Keep the provisional package private at version `0.0.0` during increment 1; public npm naming and release automation are outside this plan.
- Install the executable globally, but store every target project's config, runs, cases, evidence, and reports only under that project's `.ai-qa/` directory.
- Store repository trust outside projects in `~/.ai-qa/trust.json`; tests override this root with `AI_QA_HOME`.
- Install the canonical global skill explicitly under `~/.agents/skills/ai-qa/`; npm installation must not overwrite it silently.
- Use Chrome DevTools MCP for Web control through the AI agent. The CLI must not call MCP servers or infer unobserved UI state.
- Require typed write-back for every meaningful action, observation, assertion, evidence item, recovery decision, blocker, and verdict. Do not expose a generic event append command.
- Use immutable raw evidence and SHA-256 verification on add, resume, finish, report generation, and export.
- Require a confirmed exploratory goal and stable acceptance-criterion IDs before run creation.
- Freeze every work order and enforce finite defaults: 100 tool calls, 10 recovery actions, and 30 minutes for exploratory runs; regression runs use the formulas in the approved design.
- A product `pass` requires complete criterion, assertion, and evidence coverage. Keep `fail`, `blocked`, and `not_verified` distinct.
- Increment 1 supports Markdown and JSON reports with project-local storage only. External command storage, RunGroup aggregation, agent-runner CI templates, iOS, Android, and real devices are separate plans.
- Read-only inspection may run without setup consent. Any environment mutation requires a separate approved setup plan; increment 1 performs no automated setup mutation.

## Increment Boundary and File Map

The approved design has five independently testable increments. This plan covers increment 1 only. It must leave a complete Web path working before RunGroup/CI, Pepper, and Appium work begins.

```text
ai-qa/
|-- .github/workflows/ci.yml              Node 22/24 package quality checks
|-- package.json                          Package metadata, scripts, bin entry
|-- pnpm-lock.yaml                        Reproducible dependency graph
|-- tsconfig.json                         Editor/test TypeScript settings
|-- tsconfig.build.json                   Production build boundary
|-- eslint.config.js                      Type-aware lint rules
|-- vitest.config.ts                      Test configuration
|-- scripts/
|   |-- clean.mjs                         Remove generated output
|   `-- copy-assets.mjs                   Copy skill assets into dist
|-- src/
|   |-- cli/
|   |   |-- context.ts                    Injectable process boundary
|   |   |-- io.ts                         JSON stdin/stdout helpers
|   |   |-- program.ts                    Commander composition root
|   |   |-- main.ts                       Executable entry point
|   |   `-- commands/                     One file per command group
|   |-- core/
|   |   |-- errors.ts                     Stable typed error contract
|   |   |-- ids.ts                        UUID-backed domain IDs
|   |   |-- canonical-json.ts             Stable content hashing input
|   |   |-- fs/                           Atomic writes and JSONL journals
|   |   |-- config/                       Config schema and repository
|   |   |-- runs/                         Work order, event, and lifecycle domain
|   |   |-- evidence/                     Evidence schema and integrity checks
|   |   |-- cases/                        Immutable case revisions
|   |   `-- verdicts/                     Verdict schemas and coverage rules
|   |-- services/
|   |   |-- project-root/                 Root resolution
|   |   |-- trust/                        Repository identity and trust store
|   |   |-- initialization/               Init/configure transaction
|   |   |-- doctor/                       Read-only Web readiness
|   |   |-- run-protocol/                 Typed agent write-back operations
|   |   |-- case-promotion/               Exploratory-to-case normalization
|   |   `-- report-generation/            JSON/Markdown reports
|   |-- skills/global/                    Canonical global Agent Skill assets
|   `-- schemas/                          Exported schema/protocol versions
|-- tests/
|   |-- helpers/                          Temporary project and CLI harness
|   |-- unit/                             Pure domain tests
|   |-- integration/                      Filesystem/CLI tests
|   `-- e2e/                              Complete protocol vertical slice
`-- docs/validation/web-live-acceptance.md Live Chrome DevTools MCP runbook
```

---

### Task 1: Bootstrap the ESM Package and CLI Test Harness

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `eslint.config.js`
- Create: `vitest.config.ts`
- Create: `.prettierignore`
- Create: `.gitignore`
- Create: `scripts/clean.mjs`
- Create: `src/cli/context.ts`
- Create: `src/cli/program.ts`
- Create: `src/cli/main.ts`
- Create: `tests/helpers/cli-context.ts`
- Create: `tests/cli/help.test.ts`
- Create: `.github/workflows/ci.yml`
- Generate: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Nothing; this is the package foundation.
- Produces: `CliContext`, `createDefaultContext()`, `createProgram(context)`, and `runCli(args, context): Promise<number>` for every later CLI task.

- [ ] **Step 1: Create package and toolchain configuration**

Create `package.json` with this initial content; dependency installation in the next step fills the empty dependency objects and lockfile:

```json
{
  "name": "ai-qa",
  "version": "0.0.0",
  "private": true,
  "description": "Agent-orchestrated QA CLI and skill",
  "license": "UNLICENSED",
  "type": "module",
  "packageManager": "pnpm@11.9.0",
  "engines": {
    "node": "^22.0.0 || ^24.0.0"
  },
  "bin": {
    "ai-qa": "./dist/cli/main.js"
  },
  "files": [
    "dist",
    "README.md"
  ],
  "scripts": {
    "clean": "node scripts/clean.mjs",
    "build": "pnpm clean && tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test": "vitest run",
    "test:watch": "vitest",
    "check": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build",
    "prepack": "pnpm check"
  },
  "dependencies": {},
  "devDependencies": {}
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "useUnknownInCatchVariables": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"]
}
```

Create `tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["tests", "dist"]
}
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
    },
  },
});
```

Create `eslint.config.js`:

```js
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'coverage',
      'dist',
      'node_modules',
      'eslint.config.js',
      'scripts/**/*.mjs',
      'fixtures/**/*.mjs',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error'
    },
  },
);
```

Create `.gitignore`:

```gitignore
coverage/
dist/
node_modules/
*.tgz
```

Create `.prettierignore`:

```text
coverage
dist
node_modules
pnpm-lock.yaml
docs/superpowers
**/.ai-qa
```

Create `scripts/clean.mjs`:

```js
import { rm } from 'node:fs/promises';

await Promise.all([
  rm(new URL('../dist', import.meta.url), { force: true, recursive: true }),
  rm(new URL('../coverage', import.meta.url), { force: true, recursive: true }),
]);
```

- [ ] **Step 2: Install runtime and development dependencies**

Run:

```bash
pnpm add commander diff proper-lockfile semver yaml zod
pnpm add -D @eslint/js @types/node @types/proper-lockfile @types/semver @vitest/coverage-v8 eslint prettier typescript typescript-eslint vitest
```

Expected: `package.json` receives exact resolved ranges and `pnpm-lock.yaml` is created with no peer-dependency errors.

- [ ] **Step 3: Write failing CLI harness tests**

Create `tests/helpers/cli-context.ts`:

```ts
import type { CliContext } from '../../src/cli/context.js';

export interface CapturedCli {
  context: CliContext;
  stdout: string[];
  stderr: string[];
}

export function createCapturedCli(overrides: Partial<CliContext> = {}): CapturedCli {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const context: CliContext = {
    cwd: process.cwd(),
    env: {},
    homeDir: process.cwd(),
    now: () => new Date('2026-07-13T00:00:00.000Z'),
    readStdin: async () => '',
    writeStdout: (value) => stdout.push(value),
    writeStderr: (value) => stderr.push(value),
    ...overrides,
  };
  return { context, stdout, stderr };
}
```

Create `tests/cli/help.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/program.js';
import { createCapturedCli } from '../helpers/cli-context.js';

describe('ai-qa CLI shell', () => {
  it('prints help and exits successfully', async () => {
    const captured = createCapturedCli();

    const exitCode = await runCli(['--help'], captured.context);

    expect(exitCode).toBe(0);
    expect(captured.stdout.join('')).toContain('Usage: ai-qa');
  });

  it('returns a stable structured error for an unknown command', async () => {
    const captured = createCapturedCli();

    const exitCode = await runCli(['unknown-command'], captured.context);

    expect(exitCode).toBe(1);
    expect(captured.stderr.join('')).toContain('commander.unknownCommand');
  });
});
```

- [ ] **Step 4: Run the CLI test to verify the missing module failure**

Run: `pnpm test -- tests/cli/help.test.ts`

Expected: FAIL because `src/cli/context.ts` and `src/cli/program.ts` do not exist.

- [ ] **Step 5: Implement the injectable CLI shell**

Create `src/cli/context.ts`:

```ts
import { homedir } from 'node:os';

export interface CliContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  now: () => Date;
  readStdin: () => Promise<string>;
  writeStdout: (value: string) => void;
  writeStderr: (value: string) => void;
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createDefaultContext(): CliContext {
  return {
    cwd: process.cwd(),
    env: process.env,
    homeDir: homedir(),
    now: () => new Date(),
    readStdin: readProcessStdin,
    writeStdout: (value) => process.stdout.write(value),
    writeStderr: (value) => process.stderr.write(value),
  };
}
```

Create `src/cli/program.ts`:

```ts
import { Command, CommanderError } from 'commander';
import type { CliContext } from './context.js';

export function createProgram(context: CliContext): Command {
  return new Command()
    .name('ai-qa')
    .description('Agent-orchestrated QA state and evidence CLI')
    .version('0.0.0')
    .option('--project <path>', 'explicit target-project root')
    .exitOverride()
    .configureOutput({
      writeOut: (value) => context.writeStdout(value),
      writeErr: (value) => context.writeStderr(value),
    });
}

export async function runCli(args: readonly string[], context: CliContext): Promise<number> {
  const program = createProgram(context);
  try {
    await program.parseAsync([...args], { from: 'user' });
    return 0;
  } catch (error: unknown) {
    if (error instanceof CommanderError) {
      if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') {
        return 0;
      }
      context.writeStderr(`${JSON.stringify({ error: { code: error.code, message: error.message } })}\n`);
      return error.exitCode === 0 ? 1 : error.exitCode;
    }
    throw error;
  }
}
```

Create `src/cli/main.ts`:

```ts
#!/usr/bin/env node
import { createDefaultContext } from './context.js';
import { runCli } from './program.js';

process.exitCode = await runCli(process.argv.slice(2), createDefaultContext());
```

- [ ] **Step 6: Run unit and build checks**

Run:

```bash
pnpm test -- tests/cli/help.test.ts
pnpm typecheck
pnpm build
node dist/cli/main.js --help
```

Expected: both tests PASS, typecheck/build exit 0, and the built CLI prints `Usage: ai-qa`.

- [ ] **Step 7: Add the Node 22/24 quality workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  quality:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [22, 24]
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v6
        with:
          version: 11.9.0
          run_install: false
      - uses: actions/setup-node@v6
        with:
          node-version: ${{ matrix.node }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm check
```

Run: `pnpm check`

Expected: format, lint, typecheck, tests, and build all exit 0.

- [ ] **Step 8: Commit the package foundation**

```bash
git add package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json eslint.config.js vitest.config.ts .prettierignore .gitignore scripts/clean.mjs src/cli tests/cli tests/helpers/cli-context.ts .github/workflows/ci.yml
git commit -m "chore: bootstrap ai-qa CLI package"
```

---

### Task 2: Enforce Project Resolution, Machine Trust, and Confirmed Configuration

**Files:**
- Create: `src/core/errors.ts`
- Create: `src/core/fs/atomic-write.ts`
- Create: `src/core/config/schema.ts`
- Create: `src/core/config/repository.ts`
- Create: `src/services/project-root/resolve-project-root.ts`
- Create: `src/services/project-root/resolve-trusted-project.ts`
- Create: `src/services/trust/repository-identity.ts`
- Create: `src/services/trust/trust-store.ts`
- Create: `src/services/trust/confirm-project-trust.ts`
- Create: `src/services/initialization/initialize-project.ts`
- Create: `src/cli/io.ts`
- Create: `src/cli/commands/init.ts`
- Create: `src/cli/commands/trust.ts`
- Create: `tests/unit/project-root.test.ts`
- Create: `tests/integration/init.test.ts`
- Modify: `src/cli/program.ts`

**Interfaces:**
- Consumes: `CliContext` and `createProgram()` from Task 1.
- Produces: `ProjectConfig`, `resolveProjectRoot()`, `resolveTrustedProject()`, `TrustStore`, `initializeProject()`, `readProjectConfig()`, and `writeProjectConfig()` for all stateful commands.

- [ ] **Step 1: Write failing project-boundary tests**

Create `tests/unit/project-root.test.ts`:

```ts
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveProjectRoot } from '../../src/services/project-root/resolve-project-root.js';

describe('resolveProjectRoot', () => {
  it('lets explicit --project select a nested project over an ancestor config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-qa-root-'));
    const nested = join(root, 'packages', 'app');
    await mkdir(join(root, '.ai-qa'), { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, '.ai-qa', 'config.yaml'), 'schemaVersion: 1\n');

    const resolved = await resolveProjectRoot({
      command: 'init',
      cwd: nested,
      explicitProject: nested,
    });

    expect(resolved.root).toBe(nested);
    expect(resolved.source).toBe('explicit');
  });

  it('refuses implicit init outside Git when no ancestor config exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-qa-no-git-'));

    await expect(resolveProjectRoot({ command: 'init', cwd: root })).rejects.toMatchObject({
      code: 'project.explicit_required',
    });
  });
});
```

Create `tests/integration/init.test.ts`:

```ts
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { ProjectConfig } from '../../src/core/config/schema.js';
import { initializeProject } from '../../src/services/initialization/initialize-project.js';
import { confirmProjectTrust } from '../../src/services/trust/confirm-project-trust.js';

const confirmedConfig: ProjectConfig = {
  schemaVersion: 1,
  project: { id: 'sample-web', name: 'Sample Web' },
  targets: { web: { entryUrl: 'http://127.0.0.1:3000' } },
  environments: {},
  tools: { web: { controller: 'chrome-devtools-mcp' } },
  evidencePolicy: { screenshots: 'required', defaultSensitivity: 'internal', retentionDays: 30 },
  reportPolicy: { formats: ['markdown', 'json'], audience: 'engineering', detail: 'full' },
  storagePolicy: { adapter: 'project-local' },
  gitPolicy: { config: 'track', artifacts: 'ignore' },
  ciPolicy: { nonPassExit: 'failure' },
  secretReferences: {},
};

describe('initializeProject', () => {
  it('writes project state locally and trust only to the machine store', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'ai-qa-project-'));
    const aiQaHome = await mkdtemp(join(tmpdir(), 'ai-qa-home-'));

    await confirmProjectTrust({
      projectRoot,
      aiQaHome,
      confirmed: true,
      now: new Date('2026-07-13T00:00:00.000Z'),
    });

    await initializeProject({
      projectRoot,
      aiQaHome,
      config: confirmedConfig,
    });

    const config = parse(await readFile(join(projectRoot, '.ai-qa', 'config.yaml'), 'utf8'));
    const trust = JSON.parse(await readFile(join(aiQaHome, 'trust.json'), 'utf8')) as {
      entries: unknown[];
    };
    expect(config.project.id).toBe('sample-web');
    expect(trust.entries).toHaveLength(1);
    await expect(readFile(join(projectRoot, '.ai-qa', 'trust.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not accept project config as proof of trust', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'ai-qa-untrusted-'));
    const aiQaHome = await mkdtemp(join(tmpdir(), 'ai-qa-home-'));

    await expect(
      initializeProject({
        projectRoot,
        aiQaHome,
        config: confirmedConfig,
      }),
    ).rejects.toMatchObject({ code: 'trust.not_trusted' });
  });
});
```

Add one isolation case to this file: trust and initialize Project A and Project B with different IDs using the same `aiQaHome`, then assert each `.ai-qa/config.yaml` contains only its own ID and neither project contains the other's path or config. Add one schema case proving `secretReferences: { login: 'correct-horse' }` is rejected while `secretReferences: { login: 'AI_QA_LOGIN_PASSWORD' }` is accepted.

- [ ] **Step 2: Run the project tests to verify they fail**

Run: `pnpm test -- tests/unit/project-root.test.ts tests/integration/init.test.ts`

Expected: FAIL because the project-root, initialization, config, and trust modules do not exist.

- [ ] **Step 3: Implement stable errors and atomic writes**

Create `src/core/errors.ts`:

```ts
export class AiQaError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'AiQaError';
    this.code = code;
    this.details = details;
  }
}
```

Create `src/core/fs/atomic-write.ts`:

```ts
import { mkdir, open, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function atomicWriteFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, path);
}
```

- [ ] **Step 4: Implement the confirmed config schema and repository**

Create `src/core/config/schema.ts`:

```ts
import { z } from 'zod';

export const projectConfigSchema = z.object({
  schemaVersion: z.literal(1),
  project: z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
    name: z.string().min(1),
  }),
  targets: z.object({
    web: z.object({
      entryUrl: z.string().url(),
      readinessUrl: z.string().url().optional(),
    }),
  }),
  environments: z.record(z.string(), z.unknown()),
  tools: z.object({
    web: z.object({ controller: z.literal('chrome-devtools-mcp') }),
  }),
  evidencePolicy: z.object({
    screenshots: z.enum(['required', 'on-failure', 'optional']),
    defaultSensitivity: z.enum(['public', 'internal', 'sensitive']),
    retentionDays: z.number().int().positive(),
  }),
  reportPolicy: z.object({
    formats: z.array(z.enum(['markdown', 'json'])).min(1),
    audience: z.string().min(1),
    detail: z.enum(['summary', 'full']),
  }),
  storagePolicy: z.object({ adapter: z.literal('project-local') }),
  gitPolicy: z.object({
    config: z.enum(['track', 'ignore']),
    artifacts: z.enum(['track', 'ignore']),
  }),
  ciPolicy: z.object({ nonPassExit: z.literal('failure') }),
  secretReferences: z.record(
    z.string(),
    z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'Use an environment-variable name, not a secret value'),
  ),
});

export type ProjectConfig = z.infer<typeof projectConfigSchema>;
```

Create `src/core/config/repository.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { atomicWriteFile } from '../fs/atomic-write.js';
import { projectConfigSchema, type ProjectConfig } from './schema.js';

export async function readProjectConfig(projectRoot: string): Promise<ProjectConfig> {
  const value: unknown = parse(await readFile(join(projectRoot, '.ai-qa', 'config.yaml'), 'utf8'));
  return projectConfigSchema.parse(value);
}

export async function writeProjectConfig(
  projectRoot: string,
  config: ProjectConfig,
): Promise<void> {
  const validated = projectConfigSchema.parse(config);
  await atomicWriteFile(
    join(projectRoot, '.ai-qa', 'config.yaml'),
    stringify(validated, { sortMapEntries: true }),
  );
}
```

- [ ] **Step 5: Implement exact project-root resolution**

Create `src/services/project-root/resolve-project-root.ts` with these exports and precedence rules:

```ts
import { access, realpath, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { AiQaError } from '../../core/errors.js';

export interface ResolveProjectRootInput {
  command: 'init' | 'other';
  cwd: string;
  explicitProject?: string;
}

export interface ResolvedProjectRoot {
  root: string;
  source: 'explicit' | 'config-ancestor' | 'git-root';
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function canonical(path: string): Promise<string> {
  return realpath(isAbsolute(path) ? path : resolve(path));
}

async function findAncestor(start: string, predicate: (path: string) => Promise<boolean>): Promise<string | undefined> {
  let current = await canonical(start);
  for (;;) {
    if (await predicate(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export async function resolveProjectRoot(
  input: ResolveProjectRootInput,
): Promise<ResolvedProjectRoot> {
  if (input.explicitProject !== undefined) {
    return { root: await canonical(resolve(input.cwd, input.explicitProject)), source: 'explicit' };
  }
  const configRoot = await findAncestor(input.cwd, (candidate) =>
    exists(join(candidate, '.ai-qa', 'config.yaml')),
  );
  if (configRoot !== undefined) {
    return { root: configRoot, source: 'config-ancestor' };
  }
  if (input.command === 'init') {
    const gitRoot = await findAncestor(input.cwd, async (candidate) => {
      const dotGit = join(candidate, '.git');
      if (!(await exists(dotGit))) return false;
      try {
        await readFile(dotGit, 'utf8');
      } catch {
        return true;
      }
      return true;
    });
    if (gitRoot !== undefined) return { root: gitRoot, source: 'git-root' };
    throw new AiQaError(
      'project.explicit_required',
      'init outside Git requires --project <path>',
    );
  }
  throw new AiQaError('project.not_found', 'No .ai-qa/config.yaml found');
}
```

- [ ] **Step 6: Implement repository identity and machine-local trust**

Create `src/services/trust/repository-identity.ts`:

```ts
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

export interface RepositoryIdentity {
  canonicalPath: string;
  fingerprint: string;
  remoteUrl?: string;
}

export async function readRepositoryIdentity(projectRoot: string): Promise<RepositoryIdentity> {
  const canonicalPath = await realpath(projectRoot);
  let remoteUrl: string | undefined;
  try {
    const result = await execFileAsync('git', ['-C', canonicalPath, 'config', '--get', 'remote.origin.url']);
    const value = result.stdout.trim();
    if (value.length > 0) remoteUrl = value;
  } catch {
    remoteUrl = undefined;
  }
  const identitySource = remoteUrl === undefined ? canonicalPath : `${canonicalPath}\n${remoteUrl}`;
  return {
    canonicalPath,
    fingerprint: createHash('sha256').update(identitySource).digest('hex'),
    ...(remoteUrl === undefined ? {} : { remoteUrl }),
  };
}
```

Create `src/services/trust/trust-store.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteFile } from '../../core/fs/atomic-write.js';
import type { RepositoryIdentity } from './repository-identity.js';

const trustFileSchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(
    z.object({
      canonicalPath: z.string(),
      fingerprint: z.string().length(64),
      confirmedAt: z.string().datetime(),
    }),
  ),
});

type TrustFile = z.infer<typeof trustFileSchema>;

export class TrustStore {
  constructor(private readonly aiQaHome: string) {}

  private get path(): string {
    return join(this.aiQaHome, 'trust.json');
  }

  private async read(): Promise<TrustFile> {
    try {
      return trustFileSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: 1, entries: [] };
      }
      throw error;
    }
  }

  async trust(identity: RepositoryIdentity, confirmedAt: Date): Promise<void> {
    const current = await this.read();
    const entry = {
      canonicalPath: identity.canonicalPath,
      fingerprint: identity.fingerprint,
      confirmedAt: confirmedAt.toISOString(),
    };
    const entries = current.entries.filter((value) => value.canonicalPath !== identity.canonicalPath);
    await atomicWriteFile(
      this.path,
      `${JSON.stringify({ schemaVersion: 1, entries: [...entries, entry] }, null, 2)}\n`,
    );
  }

  async isTrusted(identity: RepositoryIdentity): Promise<boolean> {
    const current = await this.read();
    return current.entries.some(
      (entry) =>
        entry.canonicalPath === identity.canonicalPath && entry.fingerprint === identity.fingerprint,
    );
  }
}
```

Create `src/services/project-root/resolve-trusted-project.ts`:

```ts
import { AiQaError } from '../../core/errors.js';
import { resolveProjectRoot } from './resolve-project-root.js';
import { readRepositoryIdentity } from '../trust/repository-identity.js';
import { TrustStore } from '../trust/trust-store.js';

export async function resolveTrustedProject(input: {
  cwd: string;
  explicitProject?: string;
  aiQaHome: string;
}): Promise<{ projectRoot: string }> {
  const resolved = await resolveProjectRoot({
    command: 'other',
    cwd: input.cwd,
    ...(input.explicitProject === undefined ? {} : { explicitProject: input.explicitProject }),
  });
  const identity = await readRepositoryIdentity(resolved.root);
  if (!(await new TrustStore(input.aiQaHome).isTrusted(identity))) {
    throw new AiQaError('trust.not_trusted', 'Trust this repository before loading project data');
  }
  return { projectRoot: resolved.root };
}
```

All commands after `init` must call this helper before `readProjectConfig()`, reading a project skill, or accessing `.ai-qa/` content.

Every stateful subcommand reads the inherited root option with `command.optsWithGlobals().project`; no command implements a different project-resolution rule.

Create `src/services/trust/confirm-project-trust.ts`:

```ts
import { AiQaError } from '../../core/errors.js';
import { readRepositoryIdentity } from './repository-identity.js';
import { TrustStore } from './trust-store.js';

export async function confirmProjectTrust(input: {
  projectRoot: string;
  aiQaHome: string;
  confirmed: boolean;
  now: Date;
}): Promise<{ canonicalPath: string; fingerprint: string; confirmedAt: string }> {
  if (!input.confirmed) {
    throw new AiQaError('trust.confirmation_required', 'Explicit user confirmation is required');
  }
  const identity = await readRepositoryIdentity(input.projectRoot);
  await new TrustStore(input.aiQaHome).trust(identity, input.now);
  return {
    canonicalPath: identity.canonicalPath,
    fingerprint: identity.fingerprint,
    confirmedAt: input.now.toISOString(),
  };
}
```

- [ ] **Step 7: Implement the initialization transaction**

Create `src/services/initialization/initialize-project.ts`:

```ts
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AiQaError } from '../../core/errors.js';
import { projectConfigSchema, type ProjectConfig } from '../../core/config/schema.js';
import { writeProjectConfig } from '../../core/config/repository.js';
import { readRepositoryIdentity } from '../trust/repository-identity.js';
import { TrustStore } from '../trust/trust-store.js';

export interface InitializeProjectInput {
  projectRoot: string;
  aiQaHome: string;
  config: ProjectConfig;
}

export async function initializeProject(input: InitializeProjectInput): Promise<void> {
  const config = projectConfigSchema.parse(input.config);
  const identity = await readRepositoryIdentity(input.projectRoot);
  if (!(await new TrustStore(input.aiQaHome).isTrusted(identity))) {
    throw new AiQaError('trust.not_trusted', 'Confirm repository trust before initialization');
  }
  await Promise.all(
    ['cases', 'runs', 'evidence', 'reports/runs'].map((directory) =>
      mkdir(join(input.projectRoot, '.ai-qa', directory), { recursive: true }),
    ),
  );
  await writeProjectConfig(input.projectRoot, config);
}
```

- [ ] **Step 8: Wire structured init/configure CLI input**

Create `src/cli/io.ts`:

```ts
import { z } from 'zod';
import { AiQaError } from '../core/errors.js';
import type { CliContext } from './context.js';

export async function readJsonInput<T>(context: CliContext, schema: z.ZodType<T>): Promise<T> {
  const source = await context.readStdin();
  try {
    return schema.parse(JSON.parse(source));
  } catch (error: unknown) {
    throw new AiQaError('input.invalid_json', 'stdin must contain schema-valid JSON', {
      cause: String(error),
    });
  }
}

export function writeJson(context: CliContext, value: unknown): void {
  context.writeStdout(`${JSON.stringify(value)}\n`);
}
```

Create `src/cli/commands/init.ts` with `registerInitCommands(program, context)`. Its input schema is:

```ts
const initInputSchema = z.object({
  config: projectConfigSchema,
});
```

Create `src/cli/commands/trust.ts` and register:

```text
ai-qa trust confirm --project <path> --stdin-json
ai-qa trust status --project <path>
```

`confirm` accepts exactly `{ "confirmed": true }`, resolves only the explicit target, calls `confirmProjectTrust()`, and returns its fingerprint result. It may read canonical path and Git remote metadata but no project config, skill, or instructions. `status` calculates the identity and calls `TrustStore.isTrusted()` without writing.

The `init` action must resolve `--project`, calculate `AI_QA_HOME ?? join(context.homeDir, '.ai-qa')`, verify existing machine trust, call `initializeProject()`, and return exactly:

```ts
{
  projectRoot: resolved.root,
  configPath: join(resolved.root, '.ai-qa', 'config.yaml'),
  trustStore: join(aiQaHome, 'trust.json'),
  gitPolicy: input.config.gitPolicy,
  createdDirectories: ['cases', 'runs', 'evidence', 'reports/runs'],
}
```

Add `configure` in the same command module. It resolves an existing project, verifies `TrustStore.isTrusted(identity)`, requires a complete `ProjectConfig` on stdin, preserves `project.id`, and calls `writeProjectConfig()`. Register `registerInitCommands(program, context)` from `createProgram()`.

Extend `runCli()` to catch `AiQaError`, write `{ "error": { "code", "message", "details" } }` to stderr, and return exit code 1. Catch `ZodError` separately as `schema.validation_failed` with its issue paths; do not expose stack traces in normal CLI output.

- [ ] **Step 9: Run project and CLI integration checks**

Run:

```bash
pnpm test -- tests/unit/project-root.test.ts tests/integration/init.test.ts
pnpm typecheck
pnpm lint
```

Expected: all project-root and init tests PASS; typecheck and lint exit 0.

- [ ] **Step 10: Commit the project boundary**

```bash
git add src/core src/services/project-root src/services/trust src/services/initialization src/cli/io.ts src/cli/commands/init.ts src/cli/commands/trust.ts src/cli/program.ts tests/unit/project-root.test.ts tests/integration/init.test.ts
git commit -m "feat: add trusted project initialization"
```

---

### Task 3: Install and Safely Synchronize the Global Agent Skill

**Files:**
- Create: `src/skills/global/SKILL.md`
- Create: `src/skills/global/references/web-work-protocol.md`
- Create: `src/services/skill-management/managed-skill.ts`
- Create: `src/services/skill-management/global-skill.ts`
- Create: `src/cli/commands/skill.ts`
- Create: `scripts/copy-assets.mjs`
- Create: `tests/unit/managed-skill.test.ts`
- Create: `tests/integration/global-skill.test.ts`
- Modify: `package.json`
- Modify: `src/cli/program.ts`

**Interfaces:**
- Consumes: `CliContext`, `AiQaError`, and `atomicWriteFile()`.
- Produces: `mergeManagedSkill()`, `previewGlobalSkillSync()`, `syncGlobalSkill()`, `checkGlobalSkill()`, and installed metadata fields `aiQaSkillVersion`, `aiQaProtocolRange`, and `aiQaManagedChecksum`. Task 4 and the final live run use the installed workflow.

- [ ] **Step 1: Write failing managed-region tests**

Create `tests/unit/managed-skill.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mergeManagedSkill } from '../../src/services/skill-management/managed-skill.js';

const source = `---
name: ai-qa
description: Canonical AI QA workflow
metadata:
  aiQaSkillVersion: 1.0.0
  aiQaProtocolRange: ^1.0.0
  aiQaManagedChecksum: bundled
---
<!-- ai-qa:managed:start -->
Canonical workflow
<!-- ai-qa:managed:end -->
<!-- ai-qa:user:start -->
<!-- ai-qa:user:end -->
`;

describe('mergeManagedSkill', () => {
  it('preserves the existing user region byte-for-byte', () => {
    const existing = source.replace(
      '<!-- ai-qa:user:start -->\n<!-- ai-qa:user:end -->',
      '<!-- ai-qa:user:start -->\nMy local note  \n<!-- ai-qa:user:end -->',
    );

    const result = mergeManagedSkill({ source, existing, confirmManagedReplacement: true });

    expect(result.content).toContain('My local note  \n<!-- ai-qa:user:end -->');
    expect(result.content).not.toContain('aiQaManagedChecksum: bundled');
  });

  it('requires confirmation when the installed managed region was edited', () => {
    const existing = source.replace('Canonical workflow', 'Locally edited workflow');

    expect(() =>
      mergeManagedSkill({ source, existing, confirmManagedReplacement: false }),
    ).toThrowError(expect.objectContaining({ code: 'skill.managed_conflict' }));
  });
});
```

Create `tests/integration/global-skill.test.ts`:

```ts
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  previewGlobalSkillSync,
  syncGlobalSkill,
} from '../../src/services/skill-management/global-skill.js';

describe('syncGlobalSkill', () => {
  it('installs explicitly and refuses silent replacement', async () => {
    const agentsHome = await mkdtemp(join(tmpdir(), 'ai-qa-agents-'));
    const sourceDirectory = join(agentsHome, 'canonical');
    const sourcePath = join(sourceDirectory, 'SKILL.md');
    await mkdir(join(sourceDirectory, 'references'), { recursive: true });
    await writeFile(
      sourcePath,
      `---\nname: ai-qa\ndescription: QA\nmetadata:\n  aiQaSkillVersion: 1.0.0\n  aiQaProtocolRange: ^1.0.0\n  aiQaManagedChecksum: bundled\n---\n<!-- ai-qa:managed:start -->\nflow\n<!-- ai-qa:managed:end -->\n<!-- ai-qa:user:start -->\n<!-- ai-qa:user:end -->\n`,
    );
    await writeFile(join(sourceDirectory, 'references', 'web-work-protocol.md'), '# Protocol\n');

    await syncGlobalSkill({ agentsHome, sourcePath, confirmManagedReplacement: false });
    const destination = join(agentsHome, 'skills', 'ai-qa', 'SKILL.md');
    expect(await readFile(destination, 'utf8')).toContain('aiQaSkillVersion: 1.0.0');
    expect(
      await readFile(
        join(agentsHome, 'skills', 'ai-qa', 'references', 'web-work-protocol.md'),
        'utf8',
      ),
    ).toBe('# Protocol\n');

    await mkdir(join(agentsHome, 'skills', 'ai-qa'), { recursive: true });
    await writeFile(destination, (await readFile(destination, 'utf8')).replace('flow', 'edited'));
    const preview = await previewGlobalSkillSync({ agentsHome, sourcePath });
    expect(preview).toMatchObject({ changed: true, requiresConfirmation: true });
    expect(preview.unifiedDiff).toContain('-edited');
    expect(preview.unifiedDiff).toContain('+flow');
    await expect(
      syncGlobalSkill({ agentsHome, sourcePath, confirmManagedReplacement: false }),
    ).rejects.toMatchObject({ code: 'skill.managed_conflict' });
  });
});
```

- [ ] **Step 2: Run skill tests to verify they fail**

Run: `pnpm test -- tests/unit/managed-skill.test.ts tests/integration/global-skill.test.ts`

Expected: FAIL because the skill-management modules do not exist.

- [ ] **Step 3: Create the canonical global skill assets**

Create `src/skills/global/SKILL.md`:

```markdown
---
name: ai-qa
description: Perform evidence-backed exploratory and regression QA with the ai-qa CLI and platform control tools.
metadata:
  aiQaSkillVersion: 1.0.0
  aiQaProtocolRange: ^1.0.0
  aiQaManagedChecksum: bundled
---

<!-- ai-qa:managed:start -->
# AI QA Workflow

Use this skill when the user asks to configure QA, manually test Web behavior, capture QA evidence, promote a run, or replay a regression case.

1. Resolve the exact target project. Never assume an ancestor project when the user names a nested project.
2. Confirm repository trust with the user, record it through `ai-qa trust confirm --project <path> --stdin-json`, and only then read `.ai-qa/config.yaml`, a project skill, or project instructions.
3. Discuss targets, environment, evidence, report, storage, Git, and secret-reference policy with the user. Pipe only confirmed JSON to `ai-qa init` or `ai-qa configure`.
4. Use Chrome DevTools MCP read-only to observe capability and entry-page readiness, then pipe those observations to `ai-qa doctor --platform web --json --stdin-json`. The CLI does not control the browser.
5. Before an exploratory run, confirm a goal and stable acceptance criteria with required evidence. Reject a returned work order whose protocol version is outside `^1.0.0` before invoking a platform tool.
6. Before every Chrome DevTools MCP invocation, including read-only observation and screenshot capture, call `ai-qa action plan`; after the browser call, record `completed` or `unknown` before continuing. This is how the CLI enforces the frozen tool-call budget.
7. Record before/after observations, assertions, screenshots, recovery decisions, blockers, and the verdict through typed CLI commands.
8. Never claim `pass` from a successful tool response alone. Cite criterion, assertion, observation, and evidence IDs.
9. Promote only complete exploratory runs. Review the generated draft with the user before activation.
10. During regression, follow the pinned work order in order. Recovery actions must reference the affected required step and remain inside the frozen budget.

Read `references/web-work-protocol.md` before the first Web run in a project.
<!-- ai-qa:managed:end -->

<!-- ai-qa:user:start -->
<!-- ai-qa:user:end -->
```

Create `src/skills/global/references/web-work-protocol.md`:

```markdown
# Web Work Protocol

## Exploratory

1. Discuss goal, criterion IDs, descriptions, and required evidence.
2. Start with `ai-qa run start --kind exploratory --platform web --execution local --stdin-json`.
3. Capture initial browser state with Chrome DevTools MCP and register it.
4. For each browser operation: plan action, invoke MCP, complete or mark unknown, observe, assert, and register evidence.
5. Set one evidence-backed verdict and finish the run.

## Promotion

1. Build the draft payload only from recorded action, observation, assertion, and evidence IDs.
2. Run `ai-qa case draft --from-run <run-id>` with the reviewed payload on stdin.
3. Validate and activate the immutable revision after user review.

## Regression

1. Start the active case on Web and retain the returned work order.
2. Execute required steps in order. Use only step-linked bounded recovery.
3. Finish only after every criterion cites assertion and evidence IDs.
4. Generate Markdown and JSON reports and show their project-local paths.

## Safety

- Do not retry destructive or externally visible operations after an unknown result until a fresh observation resolves whether the action applied.
- A tool, permission, environment, data, or evidence-capture blocker is not a product failure.
- Missing coverage without a concrete external blocker is `not_verified`.
```

- [ ] **Step 4: Implement managed-region parsing, checksum validation, and merge**

Create `src/services/skill-management/managed-skill.ts` with these exact exports:

```ts
import { createHash } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { AiQaError } from '../../core/errors.js';

const MANAGED_START = '<!-- ai-qa:managed:start -->';
const MANAGED_END = '<!-- ai-qa:managed:end -->';
const USER_START = '<!-- ai-qa:user:start -->';
const USER_END = '<!-- ai-qa:user:end -->';

const skillFrontmatterSchema = z.object({
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
  description: z.string().min(1).max(1024),
  metadata: z
    .object({
      aiQaSkillVersion: z.string(),
      aiQaProtocolRange: z.string(),
      aiQaManagedChecksum: z.string(),
    })
    .passthrough(),
}).passthrough();

interface SkillParts {
  frontmatter: Record<string, unknown>;
  managed: string;
  user: string;
}

export interface MergeManagedSkillInput {
  source: string;
  existing?: string;
  confirmManagedReplacement: boolean;
}

export interface MergeManagedSkillResult {
  content: string;
  managedChecksum: string;
  changed: boolean;
}

function between(content: string, start: string, end: string): string {
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  if (startIndex < 0 || endIndex < startIndex) {
    throw new AiQaError('skill.invalid_markers', `Missing or misordered ${start} and ${end}`);
  }
  return content.slice(startIndex + start.length, endIndex);
}

function parseSkill(content: string): SkillParts {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(content);
  if (match?.[1] === undefined) {
    throw new AiQaError('skill.invalid_frontmatter', 'SKILL.md requires YAML frontmatter');
  }
  return {
    frontmatter: skillFrontmatterSchema.parse(parse(match[1])) as Record<string, unknown>,
    managed: between(content, MANAGED_START, MANAGED_END),
    user: between(content, USER_START, USER_END),
  };
}

function checksum(frontmatter: Record<string, unknown>, managed: string): string {
  const metadata = { ...((frontmatter.metadata as Record<string, unknown>) ?? {}) };
  delete metadata.aiQaManagedChecksum;
  const normalized = stringify({ ...frontmatter, metadata }, { sortMapEntries: true });
  return createHash('sha256').update(`${normalized}\n${managed.replace(/\r\n/g, '\n')}`).digest('hex');
}

export function mergeManagedSkill(input: MergeManagedSkillInput): MergeManagedSkillResult {
  const source = parseSkill(input.source);
  const managedChecksum = checksum(source.frontmatter, source.managed);
  if (input.existing !== undefined) {
    const existing = parseSkill(input.existing);
    const metadata = (existing.frontmatter.metadata as Record<string, unknown>) ?? {};
    const recorded = metadata.aiQaManagedChecksum;
    const actual = checksum(existing.frontmatter, existing.managed);
    if (recorded !== actual && !input.confirmManagedReplacement) {
      throw new AiQaError('skill.managed_conflict', 'Installed managed region was edited', {
        recorded,
        actual,
        proposed: managedChecksum,
      });
    }
  }
  const metadata = { ...((source.frontmatter.metadata as Record<string, unknown>) ?? {}) };
  metadata.aiQaManagedChecksum = managedChecksum;
  const frontmatter = stringify({ ...source.frontmatter, metadata }, { sortMapEntries: true }).trimEnd();
  const user = input.existing === undefined ? source.user : parseSkill(input.existing).user;
  const content = `---\n${frontmatter}\n---\n${MANAGED_START}${source.managed}${MANAGED_END}\n${USER_START}${user}${USER_END}\n`;
  return { content, managedChecksum, changed: content !== input.existing };
}
```

- [ ] **Step 5: Implement global installation, check, and sync**

Create `src/services/skill-management/global-skill.ts`. Export:

```ts
export interface SyncGlobalSkillInput {
  agentsHome: string;
  sourcePath: string;
  confirmManagedReplacement: boolean;
}

export interface GlobalSkillStatus {
  destination: string;
  changed: boolean;
  managedChecksum: string;
}

export async function previewGlobalSkillSync(input: {
  agentsHome: string;
  sourcePath: string;
}): Promise<{
  destination: string;
  changed: boolean;
  requiresConfirmation: boolean;
  unifiedDiff: string;
}>;
export async function syncGlobalSkill(input: SyncGlobalSkillInput): Promise<GlobalSkillStatus>;
export async function checkGlobalSkill(input: {
  agentsHome: string;
  sourcePath: string;
}): Promise<{ status: 'compatible' | 'missing' | 'stale' | 'conflict'; destination: string }>;
```

Implement these functions with `readFile`, `mkdir`, `atomicWriteFile`, `mergeManagedSkill()`, and `createTwoFilesPatch()` from `diff`. Resolve the destination exactly as `join(agentsHome, 'skills', 'ai-qa', 'SKILL.md')`. `previewGlobalSkillSync()` merges with replacement enabled in memory, returns a unified installed-versus-proposed diff, and sets `requiresConfirmation` when the installed managed checksum or a reference hash differs. Treat `dirname(sourcePath)/references/` as CLI-managed assets: compare each source/destination SHA-256 hash, require `confirmManagedReplacement` before replacing a differing installed reference, copy missing references, and do not delete unrelated user files. `checkGlobalSkill()` compares `aiQaSkillVersion`, uses `semver.satisfies(WORK_PROTOCOL_VERSION, aiQaProtocolRange)`, verifies the recomputed managed checksum, and verifies every bundled reference hash; it must not write.

Create `scripts/copy-assets.mjs`:

```js
import { chmod, cp } from 'node:fs/promises';

await cp(new URL('../src/skills', import.meta.url), new URL('../dist/skills', import.meta.url), {
  recursive: true,
});
await chmod(new URL('../dist/cli/main.js', import.meta.url), 0o755);
```

Change `package.json` build script to:

```json
"build": "pnpm clean && tsc -p tsconfig.build.json && node scripts/copy-assets.mjs"
```

- [ ] **Step 6: Wire the skill command group**

Create `src/cli/commands/skill.ts` and register:

```text
ai-qa skill install --global [--confirm-managed-replacement]
ai-qa skill sync --global [--confirm-managed-replacement]
ai-qa skill check --global
```

Use `AI_QA_AGENTS_HOME ?? join(context.homeDir, '.agents')`. Resolve the bundled source with:

```ts
const sourcePath = fileURLToPath(new URL('../../skills/global/SKILL.md', import.meta.url));
```

Both mutating commands call `previewGlobalSkillSync()` first. If confirmation is required and the flag is absent, return the unified diff with `skill.confirmation_required` and exit 1 without writing. Otherwise call `syncGlobalSkill()` and return `GlobalSkillStatus` as JSON. `check` calls `checkGlobalSkill()` and returns exit code 1 for `missing`, `stale`, or `conflict`. Register this command group in `createProgram()`.

- [ ] **Step 7: Run skill and packaged-asset checks**

Run:

```bash
pnpm test -- tests/unit/managed-skill.test.ts tests/integration/global-skill.test.ts
pnpm build
test -f dist/skills/global/SKILL.md
pnpm typecheck
```

Expected: both tests PASS, the canonical skill exists in `dist/skills/global/`, and typecheck exits 0.

- [ ] **Step 8: Commit global skill management**

```bash
git add package.json scripts/copy-assets.mjs src/skills src/services/skill-management src/cli/commands/skill.ts src/cli/program.ts tests/unit/managed-skill.test.ts tests/integration/global-skill.test.ts
git commit -m "feat: install and sync global QA skill"
```

---

### Task 4: Add Read-Only Web Doctor Checks

**Files:**
- Create: `src/services/doctor/web-doctor.ts`
- Create: `src/cli/commands/doctor.ts`
- Create: `tests/unit/web-doctor.test.ts`
- Create: `tests/integration/doctor-cli.test.ts`
- Modify: `src/cli/context.ts`
- Modify: `tests/helpers/cli-context.ts`
- Modify: `src/cli/program.ts`

**Interfaces:**
- Consumes: trusted `ProjectConfig`, `CliContext`, and project-root resolution.
- Produces: `runWebDoctor(input): Promise<WebDoctorResult>`. Later run start uses `WebDoctorResult.status === 'ready'` as the preflight evidence supplied by the global skill.

- [ ] **Step 1: Write failing Web doctor tests**

Create `tests/unit/web-doctor.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { runWebDoctor } from '../../src/services/doctor/web-doctor.js';

describe('runWebDoctor', () => {
  it('is ready only when the configured URL and agent-observed MCP capability are ready', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 200 }));

    const result = await runWebDoctor({
      entryUrl: 'http://127.0.0.1:3000',
      readinessUrl: 'http://127.0.0.1:3000/health',
      chromeDevtoolsMcp: {
        status: 'ready',
        observedAt: '2026-07-13T00:00:00.000Z',
        evidence: 'Chrome DevTools MCP listed the target page',
      },
      globalSkillStatus: 'compatible',
      fetchImpl,
    });

    expect(result.status).toBe('ready');
    expect(result.checks.map((check) => check.code)).toEqual([
      'web.entry_url',
      'web.readiness_url',
      'web.chrome_devtools_mcp',
      'agent.global_skill',
    ]);
  });

  it('reports missing MCP as a tool readiness failure, not a product verdict', async () => {
    const result = await runWebDoctor({
      entryUrl: 'http://127.0.0.1:3000',
      chromeDevtoolsMcp: {
        status: 'missing',
        observedAt: '2026-07-13T00:00:00.000Z',
        evidence: 'No Chrome DevTools MCP capability was available',
      },
      globalSkillStatus: 'compatible',
      fetchImpl: vi.fn<typeof fetch>(),
    });

    expect(result.status).toBe('not_ready');
    expect(result.checks.find((check) => check.code === 'web.chrome_devtools_mcp')).toMatchObject({
      status: 'fail',
    });
    expect(result).not.toHaveProperty('verdict');
  });
});
```

- [ ] **Step 2: Run the doctor test to verify it fails**

Run: `pnpm test -- tests/unit/web-doctor.test.ts`

Expected: FAIL because `runWebDoctor()` does not exist.

- [ ] **Step 3: Implement the doctor result contract**

Create `src/services/doctor/web-doctor.ts`:

```ts
export interface AgentCapabilityObservation {
  status: 'ready' | 'missing' | 'unknown';
  observedAt: string;
  evidence: string;
}

export interface DoctorCheck {
  code:
    | 'web.entry_url'
    | 'web.entry_page'
    | 'web.readiness_url'
    | 'web.chrome_devtools_mcp'
    | 'agent.global_skill';
  status: 'pass' | 'fail' | 'agent_confirmation_required';
  message: string;
}

export interface WebDoctorResult {
  platform: 'web';
  status: 'ready' | 'not_ready';
  checks: DoctorCheck[];
}

export interface WebDoctorInput {
  entryUrl: string;
  readinessUrl?: string;
  entryPage?: AgentCapabilityObservation;
  chromeDevtoolsMcp: AgentCapabilityObservation;
  globalSkillStatus: 'compatible' | 'missing' | 'stale' | 'conflict';
  fetchImpl: typeof fetch;
}

export async function runWebDoctor(input: WebDoctorInput): Promise<WebDoctorResult> {
  const checks: DoctorCheck[] = [
    { code: 'web.entry_url', status: 'pass', message: `Configured ${input.entryUrl}` },
  ];
  if (input.readinessUrl !== undefined) {
    try {
      const response = await input.fetchImpl(input.readinessUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(5_000),
      });
      checks.push({
        code: 'web.readiness_url',
        status: response.ok ? 'pass' : 'fail',
        message: `HTTP ${response.status}`,
      });
    } catch (error: unknown) {
      checks.push({
        code: 'web.readiness_url',
        status: 'fail',
        message: String(error),
      });
    }
  } else {
    const entryPage = input.entryPage ?? {
      status: 'unknown' as const,
      observedAt: new Date(0).toISOString(),
      evidence: 'No readiness URL or agent entry-page observation was supplied',
    };
    checks.push({
      code: 'web.entry_page',
      status:
        entryPage.status === 'ready'
          ? 'pass'
          : entryPage.status === 'missing'
            ? 'fail'
            : 'agent_confirmation_required',
      message: entryPage.evidence,
    });
  }
  checks.push({
    code: 'web.chrome_devtools_mcp',
    status:
      input.chromeDevtoolsMcp.status === 'ready'
        ? 'pass'
        : input.chromeDevtoolsMcp.status === 'missing'
          ? 'fail'
          : 'agent_confirmation_required',
    message: input.chromeDevtoolsMcp.evidence,
  });
  checks.push({
    code: 'agent.global_skill',
    status: input.globalSkillStatus === 'compatible' ? 'pass' : 'fail',
    message: `Global skill status: ${input.globalSkillStatus}`,
  });
  return {
    platform: 'web',
    status: checks.every((check) => check.status === 'pass') ? 'ready' : 'not_ready',
    checks,
  };
}
```

- [ ] **Step 4: Wire doctor without giving the CLI MCP control**

Add `fetchImpl: typeof fetch` to `CliContext`, set it to `globalThis.fetch` in `createDefaultContext()`, and set it to a Vitest mock in `createCapturedCli()`.

Create `src/cli/commands/doctor.ts`. The command is:

```text
ai-qa doctor --platform web --json --stdin-json
```

The stdin schema is:

```ts
z.object({
  entryPage: z
    .object({
      status: z.enum(['ready', 'missing', 'unknown']),
      observedAt: z.string().datetime(),
      evidence: z.string().min(1),
    })
    .optional(),
  chromeDevtoolsMcp: z.object({
    status: z.enum(['ready', 'missing', 'unknown']),
    observedAt: z.string().datetime(),
    evidence: z.string().min(1),
  }),
})
```

Resolve the trusted project, read its config, call `checkGlobalSkill()` to obtain `globalSkillStatus`, call `runWebDoctor()` with the configured URLs and `context.fetchImpl`, and emit `WebDoctorResult`. The command performs no filesystem write and never returns a run verdict. Register it in `createProgram()`.

Create `tests/integration/doctor-cli.test.ts` with a trusted initialized project and a compatible skill installed into a temporary `AI_QA_AGENTS_HOME`. Snapshot the complete JSON result and compare the `.ai-qa/` directory file list before and after the command. The two lists must be identical.

- [ ] **Step 5: Run doctor and consent-boundary checks**

Run:

```bash
pnpm test -- tests/unit/web-doctor.test.ts tests/integration/doctor-cli.test.ts
pnpm typecheck
pnpm lint
```

Expected: doctor tests PASS, the integration test proves no project mutation, and static checks exit 0.

- [ ] **Step 6: Commit Web readiness checks**

```bash
git add src/services/doctor src/cli/context.ts src/cli/commands/doctor.ts src/cli/program.ts tests/helpers/cli-context.ts tests/unit/web-doctor.test.ts tests/integration/doctor-cli.test.ts
git commit -m "feat: add read-only web doctor"
```

---

### Task 5: Create Immutable Work Orders and the Append-Only Run Journal

**Files:**
- Create: `src/core/ids.ts`
- Create: `src/core/canonical-json.ts`
- Create: `src/core/fs/json-lines.ts`
- Create: `src/schemas/versions.ts`
- Create: `src/core/runs/schema.ts`
- Create: `src/core/runs/journal.ts`
- Create: `src/core/runs/repository.ts`
- Create: `src/services/run-protocol/start-exploratory-run.ts`
- Create: `src/cli/commands/run.ts`
- Create: `tests/unit/work-order.test.ts`
- Create: `tests/integration/run-journal.test.ts`
- Modify: `src/cli/program.ts`

**Interfaces:**
- Consumes: trusted project config, `WebDoctorResult`, `atomicWriteFile()`, and `CliContext.now()`.
- Produces: `AcceptanceCriterion`, `ExecutionBudget`, `WorkOrder`, `RunEvent`, `RunJournal`, `RunRepository`, and `startExploratoryRun()`. Tasks 6–11 append only through `RunJournal.append()`.

- [ ] **Step 1: Write failing work-order and journal tests**

Create `tests/unit/work-order.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  createExploratoryWorkOrder,
  exploratoryRunInputSchema,
} from '../../src/core/runs/schema.js';

describe('exploratory work orders', () => {
  it('requires stable criterion IDs and freezes finite defaults', () => {
    const input = exploratoryRunInputSchema.parse({
      goal: 'Verify successful login',
      acceptanceCriteria: [
        {
          id: 'authenticated-home-visible',
          description: 'Authenticated home is visible',
          requiredEvidence: ['post-action-screenshot'],
        },
      ],
      readiness: {
        platform: 'web',
        status: 'ready',
        checks: [],
      },
    });

    const workOrder = createExploratoryWorkOrder({
      projectId: 'sample-web',
      runId: 'run-1',
      input,
      evidencePolicy: { screenshots: 'required', defaultSensitivity: 'internal' },
      startedAt: new Date('2026-07-13T00:00:00.000Z'),
    });

    expect(workOrder.budget).toEqual({
      maxToolCalls: 100,
      maxRecoveryActions: 10,
      deadline: '2026-07-13T00:30:00.000Z',
    });
    expect(Object.isFrozen(workOrder)).toBe(true);
  });

  it('rejects duplicate criterion IDs', () => {
    expect(() =>
      exploratoryRunInputSchema.parse({
        goal: 'Verify login',
        acceptanceCriteria: [
          { id: 'home', description: 'Home', requiredEvidence: ['screenshot'] },
          { id: 'home', description: 'Account', requiredEvidence: ['text'] },
        ],
        readiness: { platform: 'web', status: 'ready', checks: [] },
      }),
    ).toThrow();
  });
});
```

Create `tests/integration/run-journal.test.ts`:

```ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunJournal } from '../../src/core/runs/journal.js';

describe('RunJournal', () => {
  it('serializes sequence numbers and makes idempotent retries stable', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'ai-qa-journal-'));
    const journal = await RunJournal.create(projectRoot, 'run-1', () =>
      new Date('2026-07-13T00:00:00.000Z'),
    );
    const eventInput = {
      type: 'run' as const,
      actor: 'ai-qa' as const,
      platform: 'web' as const,
      tool: 'ai-qa',
      idempotencyKey: 'start-run-1',
      payload: { phase: 'started' },
      relatedIds: [],
    };

    const first = await journal.append(eventInput);
    const retry = await journal.append(eventInput);

    expect(first.sequence).toBe(1);
    expect(retry.id).toBe(first.id);
    expect(await journal.readAll()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run work-order tests to verify they fail**

Run: `pnpm test -- tests/unit/work-order.test.ts tests/integration/run-journal.test.ts`

Expected: FAIL because run schemas and journal services do not exist.

- [ ] **Step 3: Implement IDs, canonical JSON, and JSON Lines parsing**

Create `src/core/ids.ts`:

```ts
import { randomUUID } from 'node:crypto';

export function createId(prefix: 'run' | 'event' | 'evidence' | 'case' | 'step'): string {
  return `${prefix}-${randomUUID()}`;
}
```

Create `src/core/canonical-json.ts`:

```ts
import { createHash } from 'node:crypto';

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function sha256Canonical(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}
```

Create `src/core/fs/json-lines.ts`:

```ts
import { readFile } from 'node:fs/promises';
import type { z } from 'zod';

export async function readJsonLines<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
  const content = await readFile(path, 'utf8');
  if (content.length === 0) return [];
  return content
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => schema.parse(JSON.parse(line)));
}
```

Create `src/schemas/versions.ts`:

```ts
export const CONFIG_SCHEMA_VERSION = 1 as const;
export const EVENT_SCHEMA_VERSION = 1 as const;
export const EVIDENCE_SCHEMA_VERSION = 1 as const;
export const CASE_SCHEMA_VERSION = 1 as const;
export const WORK_ORDER_SCHEMA_VERSION = 1 as const;
export const REPORT_SCHEMA_VERSION = 1 as const;
export const WORK_PROTOCOL_VERSION = '1.0.0' as const;
```

- [ ] **Step 4: Implement exploratory input, budget, work-order, and event schemas**

Create `src/core/runs/schema.ts` with these public schemas and types:

```ts
import { z } from 'zod';
import { WORK_ORDER_SCHEMA_VERSION, WORK_PROTOCOL_VERSION } from '../../schemas/versions.js';

export const acceptanceCriterionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  description: z.string().min(1),
  requiredEvidence: z.array(z.string().min(1)).min(1),
});

export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;

export const readinessSchema = z.object({
  platform: z.literal('web'),
  status: z.enum(['ready', 'not_ready']),
  checks: z.array(z.unknown()),
});

export const exploratoryRunInputSchema = z
  .object({
    goal: z.string().min(1),
    acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1),
    readiness: readinessSchema,
  })
  .superRefine((value, context) => {
    const ids = value.acceptanceCriteria.map((criterion) => criterion.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', message: 'Acceptance criterion IDs must be unique' });
    }
  });

export type ExploratoryRunInput = z.infer<typeof exploratoryRunInputSchema>;

export const executionBudgetSchema = z.object({
  maxToolCalls: z.number().int().positive(),
  maxRecoveryActions: z.number().int().nonnegative(),
  deadline: z.string().datetime(),
});

export type ExecutionBudget = z.infer<typeof executionBudgetSchema>;

export const workOrderSchema = z.object({
  schemaVersion: z.literal(WORK_ORDER_SCHEMA_VERSION),
  protocolVersion: z.literal(WORK_PROTOCOL_VERSION),
  runId: z.string(),
  kind: z.enum(['exploratory', 'regression']),
  execution: z.enum(['local', 'ci']),
  projectId: z.string(),
  platform: z.literal('web'),
  startedAt: z.string().datetime(),
  goal: z.string(),
  acceptanceCriteria: z.array(acceptanceCriterionSchema),
  requiredSteps: z.array(z.unknown()),
  readiness: readinessSchema,
  evidencePolicy: z.object({
    screenshots: z.enum(['required', 'on-failure', 'optional']),
    defaultSensitivity: z.enum(['public', 'internal', 'sensitive']),
  }),
  budget: executionBudgetSchema,
  pinnedCase: z
    .object({
      caseId: z.string(),
      revision: z.number().int().positive(),
      caseContentHash: z.string(),
      platformVariantHash: z.string(),
    })
    .optional(),
});

export type WorkOrder = z.infer<typeof workOrderSchema>;

export function createExploratoryWorkOrder(input: {
  projectId: string;
  runId: string;
  input: ExploratoryRunInput;
  evidencePolicy: { screenshots: 'required' | 'on-failure' | 'optional'; defaultSensitivity: 'public' | 'internal' | 'sensitive' };
  startedAt: Date;
}): Readonly<WorkOrder> {
  const deadline = new Date(input.startedAt.getTime() + 30 * 60 * 1000).toISOString();
  const value = workOrderSchema.parse({
    schemaVersion: WORK_ORDER_SCHEMA_VERSION,
    protocolVersion: WORK_PROTOCOL_VERSION,
    runId: input.runId,
    kind: 'exploratory',
    execution: 'local',
    projectId: input.projectId,
    platform: 'web',
    startedAt: input.startedAt.toISOString(),
    goal: input.input.goal,
    acceptanceCriteria: input.input.acceptanceCriteria,
    requiredSteps: [],
    readiness: input.input.readiness,
    evidencePolicy: input.evidencePolicy,
    budget: { maxToolCalls: 100, maxRecoveryActions: 10, deadline },
  });
  return Object.freeze(value);
}

export const runEventSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  runId: z.string(),
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime(),
  actor: z.enum(['agent', 'user', 'ai-qa']),
  platform: z.literal('web'),
  tool: z.string(),
  type: z.enum([
    'run',
    'action',
    'observation',
    'assertion',
    'evidence',
    'decision',
    'blocker',
    'verdict',
    'recovery',
  ]),
  idempotencyKey: z.string().optional(),
  payload: z.unknown(),
  relatedIds: z.array(z.string()),
});

export type RunEvent = z.infer<typeof runEventSchema>;
export type AppendRunEvent = Omit<RunEvent, 'schemaVersion' | 'id' | 'runId' | 'sequence' | 'timestamp'>;
```

- [ ] **Step 5: Implement the one-writer run journal**

Create `src/core/runs/journal.ts`. Use `proper-lockfile` on `events.jsonl` with `realpath: false`, three retries, and a 50 ms minimum timeout. Export:

```ts
export class RunJournal {
  static async create(projectRoot: string, runId: string, now: () => Date): Promise<RunJournal>;
  static open(projectRoot: string, runId: string, now: () => Date): RunJournal;
  readAll(): Promise<RunEvent[]>;
  append(input: AppendRunEvent): Promise<RunEvent>;
}
```

`create()` creates `.ai-qa/runs/<run-id>/events.jsonl` with `flag: 'wx'`. `append()` must:

1. Acquire the file lock.
2. Parse every existing line with `runEventSchema`.
3. If `idempotencyKey` already exists with canonical-equal input, return that event.
4. If the key exists with different input, throw `event.idempotency_conflict`.
5. Set `sequence` to the last sequence plus one, use `createId('event')`, and timestamp with the injected clock.
6. Append one JSON line, open the file, call `sync()`, close it, and release the lock in `finally`.

- [ ] **Step 6: Implement the run repository and exploratory start transaction**

Create `src/core/runs/repository.ts` with:

```ts
export class RunRepository {
  constructor(private readonly projectRoot: string, private readonly now: () => Date) {}
  async create(workOrder: WorkOrder): Promise<{ journal: RunJournal; workOrderHash: string }>;
  async readVerifiedWorkOrder(runId: string): Promise<WorkOrder>;
  journal(runId: string): RunJournal;
}
```

`create()` writes immutable `.ai-qa/runs/<run-id>/work-order.json` through an `open(path, 'wx', 0o600)` handle, calls `sync()`, creates the journal, and appends a `run` event with `{ phase: 'started', workOrderHash }`. Calculate `workOrderHash` with `sha256Canonical()` and never rewrite the work-order file. `readVerifiedWorkOrder()` parses with `workOrderSchema`, recalculates its hash, compares it with the started event, and throws `work_order.integrity_error` on mismatch. Every later service reads work orders only through this verified method.

Create `src/services/run-protocol/start-exploratory-run.ts`:

```ts
import { createId } from '../../core/ids.js';
import { AiQaError } from '../../core/errors.js';
import { readProjectConfig } from '../../core/config/repository.js';
import {
  createExploratoryWorkOrder,
  exploratoryRunInputSchema,
  type ExploratoryRunInput,
  type WorkOrder,
} from '../../core/runs/schema.js';
import { RunRepository } from '../../core/runs/repository.js';

export async function startExploratoryRun(input: {
  projectRoot: string;
  payload: ExploratoryRunInput;
  now: () => Date;
}): Promise<WorkOrder> {
  const config = await readProjectConfig(input.projectRoot);
  const payload = exploratoryRunInputSchema.parse(input.payload);
  if (payload.readiness.status !== 'ready') {
    throw new AiQaError('doctor.not_ready', 'Normal execution requires a ready Web doctor result');
  }
  const workOrder = createExploratoryWorkOrder({
    projectId: config.project.id,
    runId: createId('run'),
    input: payload,
    evidencePolicy: {
      screenshots: config.evidencePolicy.screenshots,
      defaultSensitivity: config.evidencePolicy.defaultSensitivity,
    },
    startedAt: input.now(),
  });
  await new RunRepository(input.projectRoot, input.now).create(workOrder);
  return workOrder;
}
```

- [ ] **Step 7: Wire exploratory run start**

Create `src/cli/commands/run.ts` and register:

```text
ai-qa run start --kind exploratory --platform web --execution local --stdin-json
```

Reject other kind/platform/execution combinations in this task. Resolve and trust-check the project, parse stdin with `exploratoryRunInputSchema`, call `startExploratoryRun()`, and return the full immutable work order as JSON. Register the command group in `createProgram()`.

- [ ] **Step 8: Run work-order, journal, and CLI checks**

Run:

```bash
pnpm test -- tests/unit/work-order.test.ts tests/integration/run-journal.test.ts
pnpm typecheck
pnpm lint
```

Expected: work-order and journal tests PASS; static checks exit 0.

- [ ] **Step 9: Commit work orders and journal**

```bash
git add src/core/ids.ts src/core/canonical-json.ts src/core/fs/json-lines.ts src/schemas src/core/runs src/services/run-protocol/start-exploratory-run.ts src/cli/commands/run.ts src/cli/program.ts tests/unit/work-order.test.ts tests/integration/run-journal.test.ts
git commit -m "feat: add immutable run work orders"
```

---

### Task 6: Register Immutable Evidence and Verify Integrity

**Files:**
- Create: `src/core/evidence/schema.ts`
- Create: `src/core/evidence/repository.ts`
- Create: `src/services/run-protocol/register-evidence.ts`
- Create: `src/cli/commands/evidence.ts`
- Create: `tests/integration/evidence.test.ts`
- Modify: `src/cli/program.ts`

**Interfaces:**
- Consumes: `RunRepository`, `RunJournal`, `createId()`, and SHA-256 hashing.
- Produces: `EvidenceRecord`, `EvidenceRepository.registerRaw()`, `EvidenceRepository.verifyAll()`, and `registerEvidence()`. Finalization and reports must call `verifyAll()`.

- [ ] **Step 1: Write failing evidence integrity tests**

Create `tests/integration/evidence.test.ts`:

```ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EvidenceRepository } from '../../src/core/evidence/repository.js';

describe('EvidenceRepository', () => {
  it('copies raw evidence, hashes it, and detects later tampering', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'ai-qa-evidence-'));
    const source = join(projectRoot, 'screen.png');
    await writeFile(source, Buffer.from('original-image'));
    const repository = new EvidenceRepository(projectRoot, 'run-1', () =>
      new Date('2026-07-13T00:00:00.000Z'),
    );

    const record = await repository.registerRaw({
      sourcePath: source,
      mediaType: 'image/png',
      sourceTool: 'chrome-devtools-mcp',
      sensitivity: 'internal',
      evidenceKinds: ['post-action-screenshot'],
      captureActionId: 'event-capture-action',
      idempotencyKey: 'capture-home',
    });

    expect(record.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await readFile(join(projectRoot, record.projectRelativePath), 'utf8')).toBe(
      'original-image',
    );
    await writeFile(join(projectRoot, record.projectRelativePath), 'tampered');
    await expect(repository.verifyAll()).rejects.toMatchObject({ code: 'evidence.integrity_error' });
  });
});
```

- [ ] **Step 2: Run the evidence test to verify it fails**

Run: `pnpm test -- tests/integration/evidence.test.ts`

Expected: FAIL because the evidence schema and repository do not exist.

- [ ] **Step 3: Implement the evidence schema**

Create `src/core/evidence/schema.ts`:

```ts
import { z } from 'zod';

export const evidenceRecordSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  runId: z.string(),
  projectRelativePath: z.string(),
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  mediaType: z.string().min(1),
  platform: z.literal('web'),
  sourceTool: z.string().min(1),
  capturedAt: z.string().datetime(),
  classification: z.enum(['raw', 'redacted', 'annotated']),
  sensitivity: z.enum(['public', 'internal', 'sensitive']),
  evidenceKinds: z.array(z.string().min(1)).min(1),
  captureActionId: z.string(),
  parentEvidenceId: z.string().optional(),
  idempotencyKey: z.string().min(1),
});

export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;
```

- [ ] **Step 4: Implement per-run evidence storage and integrity checks**

Create `src/core/evidence/repository.ts`. Export:

```ts
export interface RegisterRawEvidenceInput {
  sourcePath: string;
  mediaType: string;
  sourceTool: string;
  sensitivity: 'public' | 'internal' | 'sensitive';
  evidenceKinds: string[];
  captureActionId: string;
  idempotencyKey: string;
}

export class EvidenceRepository {
  constructor(projectRoot: string, runId: string, now: () => Date);
  registerRaw(input: RegisterRawEvidenceInput): Promise<EvidenceRecord>;
  readAll(): Promise<EvidenceRecord[]>;
  verifyAll(): Promise<EvidenceRecord[]>;
}
```

Use `.ai-qa/evidence/<run-id>/index.jsonl`, `.ai-qa/evidence/<run-id>/files/`, and a lock on `index.jsonl`. `registerRaw()` must lock, return an existing canonical-equal record for the same idempotency key, otherwise copy with `COPYFILE_EXCL` to `files/<evidence-id>-<sanitized-basename>`, calculate SHA-256 from the copied bytes, append and fsync one validated index line, and return the record. Store only a project-relative POSIX path. `verifyAll()` recalculates every registered file hash and throws `AiQaError('evidence.integrity_error', ...)` with evidence ID, expected hash, and actual hash on the first mismatch.

- [ ] **Step 5: Append typed evidence events and expose the command**

Create `src/services/run-protocol/register-evidence.ts`:

```ts
export async function registerEvidence(input: {
  projectRoot: string;
  runId: string;
  payload: RegisterRawEvidenceInput;
  criterionIds: string[];
  observationIds: string[];
  now: () => Date;
}): Promise<EvidenceRecord>;
```

The function verifies the run exists, verifies `captureActionId` is a completed `evidence-capture` planned action, calls `EvidenceRepository.registerRaw()`, and appends one `evidence` event whose payload contains the complete `EvidenceRecord` plus `criterionIds` and `observationIds`. Use the evidence idempotency key for the event so retry repairs a copied/indexed record that lacks its run event.

Create `src/cli/commands/evidence.ts` for:

```text
ai-qa evidence add --run <run-id> --file <path> --stdin-json
```

Stdin contains `mediaType`, `sourceTool`, `sensitivity`, `evidenceKinds`, `captureActionId`, `idempotencyKey`, `criterionIds`, and `observationIds`. Resolve a relative `--file` against `context.cwd`, reject a source inside another project's `.ai-qa/`, call `registerEvidence()`, and return the record. Register the command group.

- [ ] **Step 6: Run evidence and static checks**

Run:

```bash
pnpm test -- tests/integration/evidence.test.ts
pnpm typecheck
pnpm lint
```

Expected: evidence copy/hash/tamper tests PASS; static checks exit 0.

- [ ] **Step 7: Commit evidence storage**

```bash
git add src/core/evidence src/services/run-protocol/register-evidence.ts src/cli/commands/evidence.ts src/cli/program.ts tests/integration/evidence.test.ts
git commit -m "feat: register immutable QA evidence"
```

---

### Task 7: Enforce the Typed Action, Observation, Assertion, and Recovery Protocol

**Files:**
- Create: `src/core/runs/event-payloads.ts`
- Create: `src/services/run-protocol/run-protocol-service.ts`
- Create: `src/cli/commands/action.ts`
- Create: `src/cli/commands/observation.ts`
- Create: `src/cli/commands/assertion.ts`
- Create: `src/cli/commands/decision.ts`
- Create: `src/cli/commands/recovery.ts`
- Create: `tests/integration/typed-protocol.test.ts`
- Modify: `src/cli/program.ts`

**Interfaces:**
- Consumes: `RunRepository`, work-order criteria/budgets, and `RunJournal`.
- Produces: `RunProtocolService.planAction()`, `completeAction()`, `addObservation()`, `recordAssertion()`, `recordDecision()`, and `resolveUnknownAction()`. Finalization and case promotion consume these typed payloads.

- [ ] **Step 1: Write failing typed-protocol tests**

Create `tests/integration/typed-protocol.test.ts` with a fixture that starts one exploratory run, then assert:

```ts
const planned = await service.planAction({
  idempotencyKey: 'click-login',
  kind: 'interaction',
  intent: 'Submit valid credentials',
  tool: 'chrome-devtools-mcp',
  target: { description: 'Login submit button', selector: '[data-testid="login"]' },
});
expect(planned.payload).toMatchObject({ phase: 'planned', stepId: expect.any(String) });

await service.completeAction({
  actionId: planned.id,
  phase: 'unknown',
  toolResult: { summary: 'MCP connection closed before response' },
});

await expect(
  service.resolveUnknownAction({
    actionId: planned.id,
    resolution: 'not_applied',
    observationId: 'missing-observation',
    rationale: 'No transition occurred',
  }),
).rejects.toMatchObject({ code: 'recovery.fresh_observation_required' });
```

Also inspect `createProgram(context).commands` and assert no top-level `event` command exists.

- [ ] **Step 2: Run the protocol test to verify it fails**

Run: `pnpm test -- tests/integration/typed-protocol.test.ts`

Expected: FAIL because typed payloads and `RunProtocolService` do not exist.

- [ ] **Step 3: Define all typed payload schemas**

Create `src/core/runs/event-payloads.ts` with Zod schemas for these exact payloads:

```ts
export type ActionPayload =
  | {
      phase: 'planned';
      kind: 'interaction' | 'observation' | 'evidence-capture';
      intent: string;
      stepId: string;
      target: { description: string; selector?: string };
      recoveryForStepId?: string;
    }
  | {
      phase: 'completed' | 'unknown';
      actionId: string;
      toolResult: { summary: string; data?: unknown };
    };

export interface ObservationPayload {
  summary: string;
  state: Record<string, unknown>;
  stepId?: string;
  actionId: string;
}

export interface AssertionPayload {
  criterionId: string;
  status: 'satisfied' | 'violated' | 'indeterminate';
  assertionKinds: string[];
  actual: string;
  expected: string;
  observationIds: string[];
  evidenceIds: string[];
  stepId?: string;
}

export interface DecisionPayload {
  kind: 'semantic' | 'recovery-policy';
  rationale: string;
  relatedIds: string[];
}

export interface RecoveryPayload {
  actionId: string;
  resolution: 'applied' | 'not_applied' | 'indeterminate';
  observationId: string;
  rationale: string;
}
```

Export a Zod schema matching each interface. Require non-empty strings and IDs, and reject unknown object keys.

- [ ] **Step 4: Implement typed protocol invariants**

Create `src/services/run-protocol/run-protocol-service.ts`:

```ts
export class RunProtocolService {
  constructor(
    private readonly projectRoot: string,
    private readonly runId: string,
    private readonly now: () => Date,
  ) {}

  planAction(input: {
    idempotencyKey: string;
    kind: 'interaction' | 'observation' | 'evidence-capture';
    intent: string;
    tool: string;
    target: { description: string; selector?: string };
    stepId?: string;
    recoveryForStepId?: string;
  }): Promise<RunEvent>;

  completeAction(input: {
    actionId: string;
    phase: 'completed' | 'unknown';
    toolResult: { summary: string; data?: unknown };
  }): Promise<RunEvent>;

  addObservation(input: ObservationPayload): Promise<RunEvent>;
  recordAssertion(input: AssertionPayload): Promise<RunEvent>;
  recordDecision(input: DecisionPayload): Promise<RunEvent>;
  resolveUnknownAction(input: RecoveryPayload): Promise<RunEvent>;
}
```

For every method, read and validate the work order and current event log before append. Enforce these rules:

- `planAction()` rejects when planned action count equals `maxToolCalls` or the injected clock has reached the frozen deadline. Exploratory actions without `stepId` receive `createId('step')`; regression behavior is added in Task 10.
- `completeAction()` requires one matching planned action, uses `complete:<actionId>` as its deterministic event idempotency key, returns the existing canonical-equal terminal event on retry, and rejects a conflicting second terminal result.
- `addObservation()` records the current UI only; it cannot claim a criterion result. It requires an `observation` action ID with a completed terminal event, so read-only MCP calls count against the same budget.
- `recordAssertion()` requires a criterion ID from the work order and at least one `assertionKinds` value. `observationIds` are run event IDs; `evidenceIds` are `EvidenceRecord.id` values and must resolve through evidence-event payloads. Reject either kind of dangling citation.
- `resolveUnknownAction()` requires an unknown terminal action and an observation event with a greater sequence than that unknown event.
- `not_applied` permits a later planned retry; `applied` continues the same step; `indeterminate` remains unresolved for pass/finalization.
- Recovery actions count only when `recoveryForStepId` exists and cannot exceed `maxRecoveryActions`.

- [ ] **Step 5: Expose typed commands without a generic append escape hatch**

Create command modules for:

```text
ai-qa action plan --run <run-id> [--step <step-id>] --stdin-json
ai-qa action complete <action-id> --run <run-id> --stdin-json
ai-qa observation add --run <run-id> --stdin-json
ai-qa assertion record --run <run-id> [--step <step-id>] --stdin-json
ai-qa decision record --run <run-id> --stdin-json
ai-qa recovery resolve <action-id> --run <run-id> --stdin-json
```

Each module parses only its own payload schema, calls the matching `RunProtocolService` method, and returns `{ eventId, sequence, payload, permittedNextActions }`. Do not register an `event` command or export `RunJournal.append()` from a CLI module.

- [ ] **Step 6: Run typed-protocol and static checks**

Run:

```bash
pnpm test -- tests/integration/typed-protocol.test.ts
pnpm typecheck
pnpm lint
```

Expected: action pairing, observation-before-recovery, budget, criterion-link, and no-generic-command tests PASS.

- [ ] **Step 7: Commit the typed protocol**

```bash
git add src/core/runs/event-payloads.ts src/services/run-protocol/run-protocol-service.ts src/cli/commands/action.ts src/cli/commands/observation.ts src/cli/commands/assertion.ts src/cli/commands/decision.ts src/cli/commands/recovery.ts src/cli/program.ts tests/integration/typed-protocol.test.ts
git commit -m "feat: enforce typed QA write-back"
```

---

### Task 8: Validate Verdicts, Resume Safely, and Finalize Runs

**Files:**
- Create: `src/core/verdicts/schema.ts`
- Create: `src/services/run-protocol/verdict-service.ts`
- Create: `src/services/run-protocol/finalize-run.ts`
- Create: `src/services/run-protocol/run-lifecycle.ts`
- Create: `src/services/run-protocol/create-preflight-result-run.ts`
- Create: `src/cli/commands/verdict.ts`
- Create: `src/cli/commands/blocker.ts`
- Create: `tests/unit/verdict-classification.test.ts`
- Create: `tests/integration/run-finalize.test.ts`
- Modify: `src/cli/commands/run.ts`
- Modify: `src/cli/program.ts`

**Interfaces:**
- Consumes: complete run events, `EvidenceRepository.verifyAll()`, work-order criteria, and typed protocol payloads.
- Produces: `VerdictPayload`, `VerdictService`, `finalizeRun()`, `resumeRun()`, and `cancelRun()`. Case promotion requires a completed exploratory run with an effective verdict.

- [ ] **Step 1: Write failing verdict and finalization tests**

Create `tests/unit/verdict-classification.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { verdictPayloadSchema } from '../../src/core/verdicts/schema.js';

describe('verdictPayloadSchema', () => {
  it('requires a subtype and blocker IDs for blocked', () => {
    expect(() =>
      verdictPayloadSchema.parse({
        classification: 'blocked',
        summary: 'Screenshot capture failed',
        criterionResults: [],
      }),
    ).toThrow();
  });

  it('keeps not_verified distinct from blocked evidence', () => {
    expect(
      verdictPayloadSchema.parse({
        classification: 'not_verified',
        reasonCode: 'budget_exhausted',
        summary: 'The work order budget ended before all criteria were checked',
        criterionResults: [],
      }).classification,
    ).toBe('not_verified');
  });
});
```

Create `tests/integration/run-finalize.test.ts` with a started exploratory run whose work order has one required criterion. Record an observation and set `pass` without an assertion/evidence citation:

```ts
await verdicts.set({
  classification: 'pass',
  summary: 'Login appeared successful',
  criterionResults: [
    {
      criterionId: 'authenticated-home-visible',
      status: 'satisfied',
      assertionIds: [],
      evidenceIds: [],
    },
  ],
});

await expect(finalizeRun({ projectRoot, runId, now })).rejects.toMatchObject({
  code: 'verdict.unsupported_pass',
});
```

Add a second test that registers a screenshot, tampers with the copied raw file, and expects `evidence.integrity_error` before completion.

Add two preflight cases to the same integration file: `agent.global_skill` with status `fail` must produce `blocked:tool`, while a doctor result containing only `agent_confirmation_required` checks must produce `not_verified/incomplete_coverage`. Both runs must be completed and reportable without an executable work order being returned to the agent.

- [ ] **Step 2: Run verdict tests to verify they fail**

Run: `pnpm test -- tests/unit/verdict-classification.test.ts tests/integration/run-finalize.test.ts`

Expected: FAIL because verdict and finalization modules do not exist.

- [ ] **Step 3: Define criterion results, blockers, and verdicts**

Create `src/core/verdicts/schema.ts`:

```ts
import { z } from 'zod';

export const criterionResultSchema = z.object({
  criterionId: z.string().min(1),
  status: z.enum(['satisfied', 'violated', 'indeterminate']),
  assertionIds: z.array(z.string()),
  evidenceIds: z.array(z.string()),
});

export const blockerPayloadSchema = z.object({
  subtype: z.enum(['environment', 'tool', 'permission', 'data', 'evidence']),
  condition: z.string().min(1),
  attemptEventIds: z.array(z.string()).min(1),
  criterionIds: z.array(z.string()),
});

const common = {
  summary: z.string().min(1),
  criterionResults: z.array(criterionResultSchema),
  supersedes: z.string().optional(),
};

export const verdictPayloadSchema = z.discriminatedUnion('classification', [
  z.object({ classification: z.literal('pass'), ...common }),
  z.object({ classification: z.literal('fail'), ...common }),
  z.object({
    classification: z.literal('blocked'),
    ...common,
    blockerSubtype: z.enum(['environment', 'tool', 'permission', 'data', 'evidence']),
    blockerIds: z.array(z.string()).min(1),
  }),
  z.object({
    classification: z.literal('not_verified'),
    ...common,
    reasonCode: z.enum([
      'budget_exhausted',
      'cancelled',
      'incomplete_coverage',
      'unknown_action',
    ]),
  }),
]);

export type BlockerPayload = z.infer<typeof blockerPayloadSchema>;
export type VerdictPayload = z.infer<typeof verdictPayloadSchema>;
```

- [ ] **Step 4: Implement explicit verdict set/revise semantics**

Create `src/services/run-protocol/verdict-service.ts` and export:

```ts
export class VerdictService {
  constructor(projectRoot: string, runId: string, now: () => Date);
  recordBlocker(input: BlockerPayload): Promise<RunEvent>;
  set(input: VerdictPayload): Promise<RunEvent>;
  revise(input: VerdictPayload & { supersedes: string }): Promise<RunEvent>;
  effectiveVerdict(): Promise<RunEvent | undefined>;
}
```

`recordBlocker()` verifies all attempt event IDs and criterion IDs exist. `set()` rejects if any verdict event already exists. `revise()` requires `supersedes` to equal the current effective verdict ID and rejects a completed/cancelled run. `effectiveVerdict()` follows the explicit supersession chain and throws `verdict.multiple_effective` for multiple unsuperseded verdicts; it never uses implicit last-wins behavior.

- [ ] **Step 5: Implement finalization coverage and integrity gates**

Create `src/services/run-protocol/finalize-run.ts`:

```ts
export interface FinalizeRunResult {
  runId: string;
  status: 'completed';
  verdict: 'pass' | 'fail' | 'blocked' | 'not_verified';
  completedAt: string;
}

export async function finalizeRun(input: {
  projectRoot: string;
  runId: string;
  now: () => Date;
}): Promise<FinalizeRunResult>;
```

Perform these checks in this order:

1. Parse the immutable work order and complete journal.
2. Return the existing derived `FinalizeRunResult` for an already completed run with the same effective verdict; reject cancelled runs and conflicting completion state.
3. Call `EvidenceRepository.verifyAll()`.
4. Require one effective verdict.
5. Require every planned action to have exactly one completed/unknown terminal event.
6. Require every unknown action to have a recovery event; `indeterminate` prevents pass.
7. Recount planned tool calls and recovery actions against the frozen budget.
8. For `pass`, require one `satisfied` result per work-order criterion; each result must cite at least one existing assertion, and every `requiredEvidence` identifier must be represented by either a cited assertion's `assertionKinds` or a cited evidence record's `evidenceKinds`.
9. Enforce frozen screenshot policy: `required` needs a cited `post-action-screenshot` for every satisfied or violated criterion; `on-failure` needs one for every violated criterion; `optional` adds no global screenshot requirement.
10. For `fail`, require at least one `violated` criterion backed by an assertion and evidence.
11. For `blocked`, require cited blocker events of the declared subtype. `blocked:evidence` requires at least one capture/register/read/integrity attempt event.
12. For `not_verified`, require at least one uncovered or indeterminate criterion or a matching reason event.
13. Append a `run` event with `{ phase: 'completed', verdictId }` and return the result.

If `now()` is after the deadline, only `blocked`, `fail`, or `not_verified` can complete; reject `pass` with `run.deadline_exceeded`.

- [ ] **Step 6: Implement resume and cancel lifecycle behavior**

Create `src/services/run-protocol/run-lifecycle.ts`:

```ts
export async function resumeRun(input: {
  projectRoot: string;
  runId: string;
  now: () => Date;
}): Promise<{ runId: string; status: 'running'; requiresFreshObservation: true }>;

export async function cancelRun(input: {
  projectRoot: string;
  runId: string;
  reason: string;
  now: () => Date;
}): Promise<{ runId: string; status: 'cancelled'; verdict: 'not_verified' }>;
```

`resumeRun()` rejects terminal runs, verifies all evidence hashes, appends `run/interrupted` when the previous lifecycle event is `started` or `resumed`, then appends `run/resumed` with `requiresFreshObservation: true`. Modify `RunProtocolService.planAction()` to reject with `run.fresh_observation_required` until an observation newer than the resume event exists.

`cancelRun()` rejects completed/cancelled runs, records or revises an effective `not_verified` verdict with reason `cancelled`, appends `run/cancelled`, and never calls normal finalization.

- [ ] **Step 7: Make failed doctor or skill compatibility a reportable blocked run**

Create `src/services/run-protocol/create-preflight-result-run.ts`:

```ts
export async function createPreflightResultRun(input: {
  projectRoot: string;
  kind: 'exploratory';
  exploratoryPayload: ExploratoryRunInput;
  execution: 'local';
  readiness: WebDoctorResult & { status: 'not_ready' };
  now: () => Date;
}): Promise<
  | { runId: string; status: 'completed'; verdict: 'blocked'; blockerSubtype: 'tool' | 'environment' }
  | { runId: string; status: 'completed'; verdict: 'not_verified'; reasonCode: 'incomplete_coverage' }
>;
```

Create the same immutable work order that normal start would have created, but do not return it for agent execution. For a concrete failed check, append a blocker citing the `run/started` event and failing doctor codes: classify missing/stale/conflicting global skill or Chrome DevTools MCP as `blocked:tool`, and classify an unreachable readiness/entry page as `blocked:environment`. If all non-pass checks are only `agent_confirmation_required`, record `not_verified` with `incomplete_coverage` instead of inventing a blocker. Append the effective verdict and `run/completed`, then return the reportable result. This service is the only path that may complete without actions because preflight ended before platform execution.

Modify the exploratory CLI start path to call `checkGlobalSkill()` itself using `AI_QA_AGENTS_HOME ?? join(context.homeDir, '.agents')`; do not trust a caller-supplied ready result for skill compatibility. Merge any incompatible status into a failed `agent.global_skill` doctor check. A fully ready result follows normal start; every not-ready result calls `createPreflightResultRun()`. This fulfills the skill/CLI version-skew and missing-tool contract without handing an incompatible skill a work order. Task 10 extends the same service for regression after active-case loading exists.

- [ ] **Step 8: Wire blocker, verdict, finish, resume, and cancel commands**

Create command modules for:

```text
ai-qa blocker record --run <run-id> --stdin-json
ai-qa verdict set --run <run-id> --stdin-json
ai-qa verdict revise --run <run-id> --supersedes <verdict-id> --stdin-json
ai-qa run resume <run-id>
ai-qa run cancel <run-id> --reason <reason>
ai-qa run finish <run-id>
```

Every command resolves a trusted project, calls the typed service, and returns JSON containing current state and permitted next actions. Register the blocker/verdict command groups and extend the run command group.

- [ ] **Step 9: Run verdict, lifecycle, and finalization checks**

Run:

```bash
pnpm test -- tests/unit/verdict-classification.test.ts tests/integration/run-finalize.test.ts
pnpm typecheck
pnpm lint
```

Expected: classification, unsupported-pass, verdict supersession, evidence tamper, resume-observation, deadline, cancel, and incompatible-skill preflight tests PASS.

- [ ] **Step 10: Commit verdict and lifecycle enforcement**

```bash
git add src/core/verdicts src/services/run-protocol/verdict-service.ts src/services/run-protocol/finalize-run.ts src/services/run-protocol/run-lifecycle.ts src/services/run-protocol/create-preflight-result-run.ts src/cli/commands/verdict.ts src/cli/commands/blocker.ts src/cli/commands/run.ts src/cli/program.ts tests/unit/verdict-classification.test.ts tests/integration/run-finalize.test.ts
git commit -m "feat: validate and finalize QA verdicts"
```

---

### Task 9: Promote Completed Exploratory Runs into Immutable Case Revisions

**Files:**
- Create: `src/core/cases/schema.ts`
- Create: `src/core/cases/repository.ts`
- Create: `src/services/case-promotion/draft-case.ts`
- Create: `src/cli/commands/case.ts`
- Create: `tests/unit/case-hash.test.ts`
- Create: `tests/integration/case-promotion.test.ts`
- Modify: `src/cli/program.ts`

**Interfaces:**
- Consumes: completed exploratory work orders/events and effective verdicts.
- Produces: `CaseRevision`, `CaseRepository`, `draftCaseFromRun()`, `validateCaseRevision()`, and `activateCaseRevision()`. Task 10 pins active revision hashes into regression work orders.

- [ ] **Step 1: Write failing case revision tests**

Create `tests/unit/case-hash.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { calculateCaseContentHash } from '../../src/core/cases/schema.js';

describe('calculateCaseContentHash', () => {
  it('ignores the stored contentHash field and key order', () => {
    const left = {
      schemaVersion: 1 as const,
      caseId: 'login-success',
      revision: 1,
      contentHash: 'sha256:old',
      title: 'Login',
      promotion: { sourceRunId: 'run-source', validationIssues: [] },
      acceptanceCriteria: [
        { id: 'home-visible', description: 'Home is visible', requiredEvidence: ['screenshot'] },
      ],
      variants: {
        web: {
          steps: [
            {
              id: 'step-1-submit-login',
              sourceActionId: 'event-action',
              intent: 'Submit login',
              tool: 'chrome-devtools-mcp' as const,
              target: {
                description: 'Login button',
                stability: 'stable' as const,
                stabilityRationale: 'Unique data-testid owned by the fixture',
              },
              expectedState: 'Home',
              assertionStrategy: 'Visible home',
              evidenceCheckpoints: ['screenshot'],
            },
          ],
        },
      },
    };
    const right = { ...left, contentHash: 'sha256:different' };

    expect(calculateCaseContentHash(left)).toBe(calculateCaseContentHash(right));
  });
});
```

Create `tests/integration/case-promotion.test.ts` around a completed exploratory run and assert:

```ts
const draft = await draftCaseFromRun({
  projectRoot,
  runId,
  input: {
    caseId: 'login-success',
    title: 'Successful login',
    webSteps: [
      {
        sourceActionId: plannedActionId,
        intent: 'Submit valid credentials',
        target: {
          description: 'Login button',
          selector: '[data-testid="login"]',
          stability: 'stable',
          stabilityRationale: 'Unique data-testid owned by the application',
        },
        expectedState: 'Authenticated home is visible',
        assertionStrategy: 'URL and visible account text',
        evidenceCheckpoints: ['post-action-screenshot'],
      },
    ],
    excludedActions: [],
  },
});
expect(draft.revision).toBe(1);
await activateCaseRevision({
  projectRoot,
  caseId: 'login-success',
  revision: 1,
  reviewConfirmed: true,
  now: () => new Date('2026-07-13T00:00:00.000Z'),
});
await expect(writeFile(revisionPath, 'changed')).resolves.toBeUndefined();
await expect(validateCaseRevision({ projectRoot, caseId: 'login-success', revision: 1 })).rejects.toMatchObject({
  code: 'case.content_hash_mismatch',
});
```

- [ ] **Step 2: Run case tests to verify they fail**

Run: `pnpm test -- tests/unit/case-hash.test.ts tests/integration/case-promotion.test.ts`

Expected: FAIL because case schemas, repository, and promotion service do not exist.

- [ ] **Step 3: Define case index, immutable revision, and Web step schemas**

Create `src/core/cases/schema.ts` with:

```ts
import { z } from 'zod';
import { acceptanceCriterionSchema } from '../runs/schema.js';
import { sha256Canonical } from '../canonical-json.js';

export const webCaseStepSchema = z.object({
  id: z.string(),
  sourceActionId: z.string(),
  intent: z.string().min(1),
  tool: z.literal('chrome-devtools-mcp'),
  target: z.object({
    description: z.string().min(1),
    selector: z.string().min(1).optional(),
    stability: z.enum(['stable', 'review-required']),
    stabilityRationale: z.string().min(1),
  }),
  expectedState: z.string().min(1),
  assertionStrategy: z.string().min(1),
  evidenceCheckpoints: z.array(z.string().min(1)).min(1),
});

export const caseRevisionSchema = z.object({
  schemaVersion: z.literal(1),
  caseId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  revision: z.number().int().positive(),
  contentHash: z.string(),
  title: z.string().min(1),
  promotion: z.object({
    sourceRunId: z.string(),
    validationIssues: z.array(
      z.object({ code: z.string(), message: z.string(), relatedIds: z.array(z.string()) }),
    ),
  }),
  acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1),
  variants: z.object({ web: z.object({ steps: z.array(webCaseStepSchema).min(1) }) }),
});

export type CaseRevision = z.infer<typeof caseRevisionSchema>;
export type WebCaseStep = z.infer<typeof webCaseStepSchema>;

export const caseIndexSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  title: z.string(),
  activeRevision: z.number().int().positive().optional(),
  revisions: z.array(
    z.object({
      revision: z.number().int().positive(),
      status: z.enum(['draft', 'active', 'superseded', 'retired']),
      contentHash: z.string(),
      activation: z
        .object({ confirmedBy: z.literal('user'), confirmedAt: z.string().datetime() })
        .optional(),
    }),
  ),
});

export function calculateCaseContentHash(
  revision: Omit<CaseRevision, 'contentHash'> | CaseRevision,
): string {
  const { contentHash: ignored, ...content } = revision as CaseRevision;
  void ignored;
  return sha256Canonical(content);
}

export function calculateWebVariantHash(revision: CaseRevision): string {
  return sha256Canonical(revision.variants.web);
}
```

- [ ] **Step 4: Implement immutable revision storage and activation**

Create `src/core/cases/repository.ts` and export:

```ts
export class CaseRepository {
  constructor(projectRoot: string, now: () => Date);
  createDraft(input: Omit<CaseRevision, 'revision' | 'contentHash'>): Promise<CaseRevision>;
  readRevision(caseId: string, revision: number): Promise<CaseRevision>;
  validateRevision(caseId: string, revision: number): Promise<CaseRevision>;
  activate(
    caseId: string,
    revision: number,
    confirmation: { confirmedBy: 'user'; confirmedAt: string },
  ): Promise<CaseRevision>;
  readActive(caseId: string): Promise<CaseRevision>;
}
```

Store `.ai-qa/cases/<case-id>/case.yaml` and `.ai-qa/cases/<case-id>/revisions/<revision>.yaml`. Revision lifecycle status exists only in `case.yaml`; it is not executable revision content and is not part of `contentHash`. `createDraft()` locks `case.yaml`, selects `max(revisions)+1`, calculates the hash with the hash field omitted, writes the revision once with `flag: 'wx'`, and atomically updates the index. `activate()` validates content, changes only the index entries from draft to active and from the previous active revision to superseded, and never rewrites a revision file. Future edits create another draft revision.

- [ ] **Step 5: Implement evidence-backed case promotion**

Create `src/services/case-promotion/draft-case.ts`:

```ts
export interface DraftCaseInput {
  caseId: string;
  title: string;
  webSteps: Array<{
    sourceActionId: string;
    intent: string;
    target: {
      description: string;
      selector?: string;
      stability: 'stable' | 'review-required';
      stabilityRationale: string;
    };
    expectedState: string;
    assertionStrategy: string;
    evidenceCheckpoints: string[];
  }>;
  excludedActions: Array<{ actionId: string; reason: string }>;
}

export interface CaseValidationResult {
  revision: CaseRevision;
  valid: boolean;
  issues: Array<{ code: string; message: string; relatedIds: string[] }>;
}

export async function draftCaseFromRun(input: {
  projectRoot: string;
  runId: string;
  input: DraftCaseInput;
}): Promise<CaseRevision>;

export async function validateCaseRevision(input: {
  projectRoot: string;
  caseId: string;
  revision: number;
}): Promise<CaseValidationResult>;

export async function activateCaseRevision(input: {
  projectRoot: string;
  caseId: string;
  revision: number;
  reviewConfirmed: boolean;
  now: () => Date;
}): Promise<CaseRevision>;
```

Draft creation requires a completed exploratory run and records promotion provenance in `promotion.sourceRunId`. It calculates `promotion.validationIssues` for a non-pass source verdict, unresolved unknown/indeterminate actions, missing action write-back, unmapped interactions, unstable targets, missing criterion coverage, or invalid evidence. Every non-recovery `interaction` planned action must either appear exactly once as a proposed `sourceActionId` or appear exactly once in `excludedActions` with a non-empty review rationale; the same action cannot be both. Observation and evidence-capture actions supply checkpoints but do not become product steps. This lets exploratory detours stay auditable without forcing them into regression. Generate stable step IDs from the 1-based order plus a slug of the intent and write tool `chrome-devtools-mcp`.

`validateCaseRevision()` recalculates hashes and returns all structured validation issues. `activateCaseRevision()` requires `reviewConfirmed: true`, effective source verdict `pass`, an empty `promotion.validationIssues` array, integrity-valid evidence, every target marked `stable` with a non-empty rationale, complete criterion coverage, and existing evidence checkpoints. It stores `{ confirmedBy: 'user', confirmedAt: now().toISOString() }` only in the case index. Invalid or unreviewed exploratory material therefore remains inspectable as a draft but can never become active.

- [ ] **Step 6: Wire draft, validate, and activate commands**

Create `src/cli/commands/case.ts` for:

```text
ai-qa case draft --from-run <run-id> --stdin-json
ai-qa case validate <case-id> --revision <revision>
ai-qa case activate <case-id> --revision <revision> --stdin-json
```

Activate stdin must be exactly `{ "reviewConfirmed": true }`; the global skill asks the user immediately before sending it. Return the full revision for draft, `CaseValidationResult` for validate, and `{ caseId, activeRevision, contentHash, activation }` for activate. Register the case command group.

- [ ] **Step 7: Run case revision and promotion checks**

Run:

```bash
pnpm test -- tests/unit/case-hash.test.ts tests/integration/case-promotion.test.ts
pnpm typecheck
pnpm lint
```

Expected: hash, immutable-active, source-action coverage, unknown-action rejection, and activation tests PASS.

- [ ] **Step 8: Commit case promotion**

```bash
git add src/core/cases src/services/case-promotion src/cli/commands/case.ts src/cli/program.ts tests/unit/case-hash.test.ts tests/integration/case-promotion.test.ts
git commit -m "feat: promote runs into immutable cases"
```

---

### Task 10: Start Pinned Regression Runs and Enforce Replay Fidelity

**Files:**
- Create: `src/services/run-protocol/start-regression-run.ts`
- Create: `src/services/run-protocol/regression-fidelity.ts`
- Create: `tests/unit/regression-budget.test.ts`
- Create: `tests/integration/regression-replay.test.ts`
- Modify: `src/core/runs/schema.ts`
- Modify: `src/services/run-protocol/run-protocol-service.ts`
- Modify: `src/services/run-protocol/finalize-run.ts`
- Modify: `src/services/run-protocol/create-preflight-result-run.ts`
- Modify: `src/cli/commands/run.ts`

**Interfaces:**
- Consumes: `CaseRepository.readActive()`, `CaseRevision`, `RunRepository`, and typed run events.
- Produces: `calculateRegressionBudget()`, `startRegressionRun()`, and `validateRegressionFidelity()`. Report generation consumes completed pinned runs.

- [ ] **Step 1: Write failing regression budget and fidelity tests**

Create `tests/unit/regression-budget.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { calculateRegressionBudget } from '../../src/services/run-protocol/start-regression-run.js';

describe('calculateRegressionBudget', () => {
  it('uses the approved bounded formulas', () => {
    expect(calculateRegressionBudget(4, new Date('2026-07-13T00:00:00.000Z'))).toEqual({
      maxToolCalls: 34,
      maxRecoveryActions: 3,
      deadline: '2026-07-13T00:10:00.000Z',
    });
    expect(calculateRegressionBudget(20, new Date('2026-07-13T00:00:00.000Z'))).toEqual({
      maxToolCalls: 100,
      maxRecoveryActions: 10,
      deadline: '2026-07-13T00:30:00.000Z',
    });
  });
});
```

Create `tests/integration/regression-replay.test.ts` from an active two-step case. Attempt to plan step 2 before step 1 and expect:

```ts
await expect(
  service.planAction({
    idempotencyKey: 'skip-to-account',
    kind: 'interaction',
    intent: 'Assert account',
    tool: 'chrome-devtools-mcp',
    target: { description: 'Account label' },
    stepId: 'step-2-account-visible',
  }),
).rejects.toMatchObject({ code: 'replay.step_out_of_order' });
```

Then complete both required steps in order with observations, assertions, evidence, and a pass verdict; `finalizeRun()` must return completed. Add a second test where a recovery action omits `recoveryForStepId` and is rejected.

- [ ] **Step 2: Run regression tests to verify they fail**

Run: `pnpm test -- tests/unit/regression-budget.test.ts tests/integration/regression-replay.test.ts`

Expected: FAIL because regression start and fidelity services do not exist.

- [ ] **Step 3: Replace unknown required steps with the exact schema**

In `src/core/runs/schema.ts`, add:

```ts
export const requiredStepSchema = z.object({
  id: z.string(),
  order: z.number().int().nonnegative(),
  intent: z.string(),
  tool: z.literal('chrome-devtools-mcp'),
  target: z.object({
    description: z.string(),
    selector: z.string().optional(),
    stability: z.literal('stable'),
    stabilityRationale: z.string().min(1),
  }),
  expectedState: z.string(),
  assertionStrategy: z.string(),
  evidenceCheckpoints: z.array(z.string()).min(1),
});
```

Change `workOrderSchema.requiredSteps` from `z.array(z.unknown())` to `z.array(requiredStepSchema)`. Export `RequiredStep`.

- [ ] **Step 4: Implement active-revision pinning and budget formulas**

Create `src/services/run-protocol/start-regression-run.ts`:

```ts
export function calculateRegressionBudget(
  requiredStepCount: number,
  startedAt: Date,
): ExecutionBudget {
  const maxToolCalls = Math.min(100, 10 + requiredStepCount * 6);
  const maxRecoveryActions = Math.min(10, Math.max(3, Math.ceil(requiredStepCount / 2)));
  const minutes = Math.min(30, Math.max(10, requiredStepCount * 2));
  return {
    maxToolCalls,
    maxRecoveryActions,
    deadline: new Date(startedAt.getTime() + minutes * 60_000).toISOString(),
  };
}

export async function startRegressionRun(input: {
  projectRoot: string;
  caseId: string;
  execution: 'local' | 'ci';
  readiness: WebDoctorResult;
  now: () => Date;
}): Promise<WorkOrder>;
```

`startRegressionRun()` reads project config and the validated active case, converts Web steps to ordered required steps, calls `calculateCaseContentHash()` and `calculateWebVariantHash()`, freezes both values in `pinnedCase`, freezes the configured screenshot/default-sensitivity evidence policy, uses the case title as goal and its criteria as the only criterion set, creates the immutable run through `RunRepository`, and returns the work order.

Extend `createPreflightResultRun()` with a regression input containing `caseId` and `execution`. It must load and pin the active revision before recording the preflight result, so even a blocked or not-verified regression report identifies the exact case revision and platform variant that could not execute.

- [ ] **Step 5: Enforce ordered required steps and bounded recovery**

Create `src/services/run-protocol/regression-fidelity.ts`:

```ts
export interface RegressionFidelityResult {
  requiredStepIds: string[];
  completedStepIds: string[];
  unresolvedActionIds: string[];
  toolCallCount: number;
  recoveryActionCount: number;
  valid: boolean;
}

export function validateRegressionFidelity(
  workOrder: WorkOrder,
  events: RunEvent[],
): RegressionFidelityResult;
```

The next normal `interaction` planned action must use the first required step without a completed terminal interaction. An `observation` or `evidence-capture` action may reference the current or just-completed required step, counts toward tool-call budget, and never advances step order. A recovery interaction must set `recoveryForStepId` to a started required step, stays associated with that step, and cannot advance required-step order. Actions cannot introduce unknown step IDs. The validator returns `valid: true` only when every required step has exactly one successful normal interaction path, every planned tool call is terminal/resolved, order is monotonic, required observation/evidence checkpoints are linked, and frozen budgets are respected.

Modify `RunProtocolService.planAction()` to call this validator before append. Modify `finalizeRun()` to require `valid: true` for regression and to re-hash the pinned case revision and Web variant from disk before accepting any verdict.

- [ ] **Step 6: Extend run start for regression**

Support:

```text
ai-qa run start --kind regression --case <case-id> --platform web --execution local|ci --stdin-json
```

Stdin contains the ready `WebDoctorResult`. Call `startRegressionRun()` and return the pinned work order. Retain the exploratory path unchanged.

- [ ] **Step 7: Run replay fidelity checks**

Run:

```bash
pnpm test -- tests/unit/regression-budget.test.ts tests/integration/regression-replay.test.ts
pnpm typecheck
pnpm lint
```

Expected: formula boundary, pinned hash, ordered steps, linked recovery, skipped/replaced-step rejection, and complete replay tests PASS.

- [ ] **Step 8: Commit regression replay**

```bash
git add src/core/runs/schema.ts src/services/run-protocol/start-regression-run.ts src/services/run-protocol/regression-fidelity.ts src/services/run-protocol/run-protocol-service.ts src/services/run-protocol/finalize-run.ts src/services/run-protocol/create-preflight-result-run.ts src/cli/commands/run.ts tests/unit/regression-budget.test.ts tests/integration/regression-replay.test.ts
git commit -m "feat: enforce pinned regression replay"
```

---

### Task 11: Generate Integrity-Checked JSON and Markdown Run Reports

**Files:**
- Create: `src/core/reports/schema.ts`
- Create: `src/services/report-generation/generate-run-report.ts`
- Create: `src/services/report-generation/render-markdown.ts`
- Create: `src/cli/commands/report.ts`
- Create: `tests/unit/render-markdown.test.ts`
- Create: `tests/integration/report-generation.test.ts`
- Modify: `src/cli/program.ts`

**Interfaces:**
- Consumes: completed run journal, immutable work order, effective verdict, case pins, and verified evidence records.
- Produces: `RunReport`, `generateRunReport()`, and `renderRunReportMarkdown()`. The end-to-end test and live acceptance use the returned project-local paths.

- [ ] **Step 1: Write failing report tests**

Create `tests/unit/render-markdown.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { renderRunReportMarkdown } from '../../src/services/report-generation/render-markdown.js';

describe('renderRunReportMarkdown', () => {
  it('preserves verdict classification and criterion/evidence IDs', () => {
    const markdown = renderRunReportMarkdown({
      schemaVersion: 1,
      generatedAt: '2026-07-13T00:10:00.000Z',
      project: { id: 'sample-web', name: 'Sample Web' },
      reportPolicy: { audience: 'engineering', detail: 'full' },
      run: {
        id: 'run-1',
        kind: 'regression',
        execution: 'local',
        platform: 'web',
        status: 'completed',
      },
      verdict: {
        classification: 'pass',
        summary: 'Login verified',
        criterionResults: [
          {
            criterionId: 'authenticated-home-visible',
            status: 'satisfied',
            assertionIds: ['event-assertion'],
            evidenceIds: ['evidence-home'],
          },
        ],
      },
      workOrder: {
        goal: 'Verify login',
        acceptanceCriteria: [
          {
            id: 'authenticated-home-visible',
            description: 'Authenticated home is visible',
            requiredEvidence: ['post-action-screenshot'],
          },
        ],
        evidencePolicy: { screenshots: 'required', defaultSensitivity: 'internal' },
        pinnedCase: {
          caseId: 'login-success',
          revision: 1,
          caseContentHash: `sha256:${'b'.repeat(64)}`,
          platformVariantHash: `sha256:${'c'.repeat(64)}`,
        },
      },
      evidence: [
        {
          id: 'evidence-home',
          contentHash: `sha256:${'a'.repeat(64)}`,
          path: '.ai-qa/evidence/run-1/files/home.png',
          evidenceKinds: ['post-action-screenshot'],
        },
      ],
      timeline: [
        {
          sequence: 1,
          eventId: 'event-observation',
          type: 'observation',
          summary: 'Authenticated home is visible',
          relatedIds: ['evidence-home'],
        },
      ],
      integrity: { status: 'verified', verifiedAt: '2026-07-13T00:10:00.000Z' },
    });

    expect(markdown).toContain('Verdict: `pass`');
    expect(markdown).toContain('authenticated-home-visible');
    expect(markdown).toContain('evidence-home');
  });
});
```

Create `tests/integration/report-generation.test.ts` from a completed regression run. Assert that `generateRunReport()` creates both files under `.ai-qa/reports/runs/<run-id>/`, parses the JSON with `runReportSchema`, and refuses generation after raw evidence tampering.

- [ ] **Step 2: Run report tests to verify they fail**

Run: `pnpm test -- tests/unit/render-markdown.test.ts tests/integration/report-generation.test.ts`

Expected: FAIL because report schema and render/generation services do not exist.

- [ ] **Step 3: Define the single-run report schema**

Create `src/core/reports/schema.ts`:

```ts
import { z } from 'zod';
import { criterionResultSchema } from '../verdicts/schema.js';

export const runReportSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime(),
  project: z.object({ id: z.string(), name: z.string() }),
  reportPolicy: z.object({ audience: z.string(), detail: z.enum(['summary', 'full']) }),
  run: z.object({
    id: z.string(),
    kind: z.enum(['exploratory', 'regression']),
    execution: z.enum(['local', 'ci']),
    platform: z.literal('web'),
    status: z.literal('completed'),
  }),
  verdict: z.object({
    classification: z.enum(['pass', 'fail', 'blocked', 'not_verified']),
    summary: z.string(),
    criterionResults: z.array(criterionResultSchema),
    blockerSubtype: z.enum(['environment', 'tool', 'permission', 'data', 'evidence']).optional(),
    reasonCode: z.string().optional(),
  }),
  workOrder: z.object({
    goal: z.string(),
    acceptanceCriteria: z.array(
      z.object({
        id: z.string(),
        description: z.string(),
        requiredEvidence: z.array(z.string()),
      }),
    ),
    evidencePolicy: z.object({
      screenshots: z.enum(['required', 'on-failure', 'optional']),
      defaultSensitivity: z.enum(['public', 'internal', 'sensitive']),
    }),
    pinnedCase: z
      .object({
        caseId: z.string(),
        revision: z.number().int().positive(),
        caseContentHash: z.string(),
        platformVariantHash: z.string(),
      })
      .optional(),
  }),
  evidence: z.array(
    z.object({
      id: z.string(),
      contentHash: z.string(),
      path: z.string(),
      evidenceKinds: z.array(z.string()).min(1),
    }),
  ),
  timeline: z.array(
    z.object({
      sequence: z.number().int().positive(),
      eventId: z.string(),
      type: z.enum([
        'run',
        'action',
        'observation',
        'assertion',
        'evidence',
        'decision',
        'blocker',
        'verdict',
        'recovery',
      ]),
      summary: z.string(),
      relatedIds: z.array(z.string()),
    }),
  ),
  integrity: z.object({ status: z.literal('verified'), verifiedAt: z.string().datetime() }),
});

export type RunReport = z.infer<typeof runReportSchema>;
```

- [ ] **Step 4: Implement deterministic Markdown rendering**

Create `src/services/report-generation/render-markdown.ts`:

```ts
import type { RunReport } from '../../core/reports/schema.js';

export function renderRunReportMarkdown(report: RunReport): string {
  const criteria = report.verdict.criterionResults
    .map(
      (result) => {
        const criterion = report.workOrder.acceptanceCriteria.find(
          (candidate) => candidate.id === result.criterionId,
        );
        return `- \`${result.criterionId}\` ${criterion?.description ?? ''}: **${result.status}**\n  - Required proof: ${criterion?.requiredEvidence.map((kind) => `\`${kind}\``).join(', ') ?? 'none'}\n  - Assertions: ${result.assertionIds.map((id) => `\`${id}\``).join(', ') || 'none'}\n  - Evidence: ${result.evidenceIds.map((id) => `\`${id}\``).join(', ') || 'none'}`;
      },
    )
    .join('\n');
  const evidence = report.evidence
    .map(
      (item) =>
        `- \`${item.id}\` — ${item.evidenceKinds.map((kind) => `\`${kind}\``).join(', ')} — \`${item.contentHash}\` — \`${item.path}\``,
    )
    .join('\n');
  const timeline = report.timeline
    .map(
      (event) =>
        `${event.sequence}. \`${event.type}\` \`${event.eventId}\` — ${event.summary}`,
    )
    .join('\n');
  const pinned = report.workOrder.pinnedCase;
  return `# AI QA Run ${report.run.id}\n\n- Project: ${report.project.name} (\`${report.project.id}\`)\n- Audience: ${report.reportPolicy.audience}\n- Detail: \`${report.reportPolicy.detail}\`\n- Platform: \`${report.run.platform}\`\n- Kind: \`${report.run.kind}\`\n- Verdict: \`${report.verdict.classification}\`\n- Screenshot policy: \`${report.workOrder.evidencePolicy.screenshots}\`\n- Generated: ${report.generatedAt}\n${pinned === undefined ? '' : `- Case: \`${pinned.caseId}\` revision ${pinned.revision}\n- Case hash: \`${pinned.caseContentHash}\`\n- Web variant hash: \`${pinned.platformVariantHash}\`\n`}\n## Goal\n\n${report.workOrder.goal}\n\n## Summary\n\n${report.verdict.summary}\n\n## Acceptance Criteria\n\n${criteria}\n\n## Evidence\n\n${evidence}\n\n## Timeline\n\n${timeline}\n\n## Integrity\n\nVerified at ${report.integrity.verifiedAt}.\n`;
}
```

- [ ] **Step 5: Implement report generation and project-local export**

Create `src/services/report-generation/generate-run-report.ts`:

```ts
export interface GeneratedRunReport {
  report: RunReport;
  jsonPath?: string;
  markdownPath?: string;
}

export async function generateRunReport(input: {
  projectRoot: string;
  runId: string;
  now: () => Date;
}): Promise<GeneratedRunReport>;
```

Require a completed run, call `EvidenceRepository.verifyAll()`, load the effective verdict and project config, and construct a schema-valid report. Preserve the confirmed audience/detail policy; `full` includes every timeline event, while `summary` includes lifecycle, blocker, verdict, assertion, and evidence events but omits low-level action/observation/decision/recovery details. Write only configured formats to `.ai-qa/reports/runs/<run-id>/report.json` and `report.md` with `atomicWriteFile()`. Store project-relative evidence paths and return project-relative report paths. Re-running with unchanged source state must produce canonical-equal JSON except for `generatedAt`; it must never modify run/evidence data.

Create `src/cli/commands/report.ts` for:

```text
ai-qa report generate <run-id>
ai-qa report export <run-id> --adapter project-local
```

`generate` calls `generateRunReport()`. Increment 1's `export` validates `--adapter project-local`, re-verifies integrity, and returns the already generated project-local paths; reject every other adapter with `adapter.unsupported_in_increment_1`. Register the report command group.

- [ ] **Step 6: Run report and integrity checks**

Run:

```bash
pnpm test -- tests/unit/render-markdown.test.ts tests/integration/report-generation.test.ts
pnpm typecheck
pnpm lint
```

Expected: JSON schema, Markdown identity, configured-format, idempotent generation, and tamper refusal tests PASS.

- [ ] **Step 7: Commit local reporting**

```bash
git add src/core/reports src/services/report-generation src/cli/commands/report.ts src/cli/program.ts tests/unit/render-markdown.test.ts tests/integration/report-generation.test.ts
git commit -m "feat: generate local QA run reports"
```

---

### Task 12: Prove the Complete Web Vertical Slice and Package Boundary

**Files:**
- Create: `tests/e2e/web-vertical-slice.test.ts`
- Create: `tests/e2e/cli-web-vertical-slice.test.ts`
- Create: `fixtures/web-app/server.mjs`
- Create: `fixtures/web-app/.gitignore`
- Create: `docs/validation/web-live-acceptance.md`
- Create: `README.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: every increment-1 public CLI command and the installed global skill.
- Produces: one automated protocol proof, one live Chrome DevTools MCP acceptance runbook, a clean global-install tarball, and the handoff boundary for increment 2.

- [ ] **Step 1: Write the failing automated vertical-slice test**

Create `tests/e2e/web-vertical-slice.test.ts`. Use one temporary target project and call the public services/CLI in this exact order:

```ts
const exploratory = await startExploratoryRun({ projectRoot, payload: exploratoryInput, now });
const protocol = new RunProtocolService(projectRoot, exploratory.runId, now);
const beforeCall = await protocol.planAction({
  idempotencyKey: 'observe-login-page',
  kind: 'observation',
  intent: 'Observe the initial login page',
  tool: 'chrome-devtools-mcp',
  target: { description: 'Current browser page' },
});
await protocol.completeAction({
  actionId: beforeCall.id,
  phase: 'completed',
  toolResult: { summary: 'Page state captured' },
});
const before = await protocol.addObservation({
  summary: 'Login page is visible',
  state: { url: 'http://127.0.0.1:4173/login' },
  actionId: beforeCall.id,
});
const action = await protocol.planAction({
  idempotencyKey: 'submit-valid-login',
  kind: 'interaction',
  intent: 'Submit valid credentials',
  tool: 'chrome-devtools-mcp',
  target: { description: 'Login submit button', selector: '[data-testid="login-submit"]' },
});
await protocol.completeAction({
  actionId: action.id,
  phase: 'completed',
  toolResult: { summary: 'Click completed' },
});
const afterCall = await protocol.planAction({
  idempotencyKey: 'observe-authenticated-home',
  kind: 'observation',
  intent: 'Observe state after login',
  tool: 'chrome-devtools-mcp',
  target: { description: 'Current browser page' },
});
await protocol.completeAction({
  actionId: afterCall.id,
  phase: 'completed',
  toolResult: { summary: 'Page state captured' },
});
const after = await protocol.addObservation({
  summary: 'Authenticated home is visible',
  state: { url: 'http://127.0.0.1:4173/home', account: 'qa@example.test' },
  actionId: afterCall.id,
});
```

Plan and complete an `evidence-capture` action, create a temporary PNG-like byte fixture, and register it with that capture action ID, evidence kind `post-action-screenshot`, the criterion ID, and `after.id`. Record a satisfied assertion with assertion kind `structured-text-assertion`, set pass, finish, draft, validate, and activate. Use a shared replay helper to start and complete the active revision twice with fresh run IDs; each replay plans every observation and screenshot MCP call, executes every required interaction step, finishes pass, and generates both report formats. Assert:

```ts
expect(result).toMatchObject({
  exploratoryVerdict: 'pass',
  activeRevision: 1,
  regressionVerdicts: ['pass', 'pass'],
  uniqueRegressionRunIds: 2,
  reportFormats: ['json', 'markdown'],
});
```

The test must use only public typed services used by CLI commands; it may not call `RunJournal.append()` directly.

Create `tests/e2e/cli-web-vertical-slice.test.ts` with an in-memory command helper:

```ts
async function command<T>(args: string[], stdin: unknown = undefined): Promise<T> {
  const captured = createCapturedCli({
    cwd: projectRoot,
    homeDir: machineHome,
    env: { AI_QA_HOME: aiQaHome, AI_QA_AGENTS_HOME: agentsHome },
    readStdin: async () => (stdin === undefined ? '' : JSON.stringify(stdin)),
    fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response('ok', { status: 200 })),
  });
  const exitCode = await runCli(args, captured.context);
  expect(exitCode, captured.stderr.join('')).toBe(0);
  return JSON.parse(captured.stdout.at(-1) ?? 'null') as T;
}
```

Drive these exact public commands, carrying IDs from each JSON response into the next payload: `skill install --global`, `trust confirm`, `init`, `doctor`, exploratory `run start`, initial `observation add`, `action plan`, `action complete`, final `observation add`, `evidence add`, `assertion record`, `verdict set`, `run finish`, `case draft`, `case validate`, `case activate`, two complete regression `run start`/typed replay/`verdict set`/`run finish` sequences, and `report generate` for all three runs. Assert the same result object as the service-level test and assert that stderr stays empty for every command.

- [ ] **Step 2: Run the end-to-end protocol and CLI tests**

Run: `pnpm test -- tests/e2e/web-vertical-slice.test.ts tests/e2e/cli-web-vertical-slice.test.ts`

Expected: both tests PASS. Any failure means an earlier task's published interface was not implemented as specified; stop at that owning task and correct the mismatch before continuing.

- [ ] **Step 3: Add the deterministic live Web fixture**

Create `fixtures/web-app/server.mjs` as a dependency-free Node HTTP server:

```js
import { createServer } from 'node:http';

const host = '127.0.0.1';
const port = 4173;
const page = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>AI QA Web Fixture</title></head>
  <body>
    <main id="app">
      <h1>Sign in</h1>
      <form id="login-form">
        <label>Email <input data-testid="email" name="email" type="email"></label>
        <label>Password <input data-testid="password" name="password" type="password"></label>
        <button data-testid="login-submit" type="submit">Sign in</button>
      </form>
    </main>
    <script>
      const form = document.querySelector('#login-form');
      const app = document.querySelector('#app');
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const data = new FormData(form);
        if (data.get('email') === 'qa@example.test' && data.get('password') === 'correct-horse') {
          history.pushState({}, '', '/home');
          app.innerHTML = '<h1 data-testid="authenticated-home">Authenticated home</h1><p data-testid="current-account">qa@example.test</p>';
          return;
        }
        const existing = document.querySelector('[data-testid="login-error"]');
        if (existing === null) {
          form.insertAdjacentHTML('afterend', '<p data-testid="login-error">Invalid credentials</p>');
        }
      });
    </script>
  </body>
</html>`;

const server = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('ok');
    return;
  }
  if (request.url === '/' || request.url === '/login' || request.url === '/home') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page);
    return;
  }
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('not found');
});

server.listen(port, host, () => {
  process.stdout.write(`Fixture listening at http://${host}:${port}/login\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
```

The server does not log form values or the password and closes on `SIGINT`/`SIGTERM`.

Create `fixtures/web-app/.gitignore`:

```gitignore
.ai-qa/
```

Add to `package.json`:

```json
"fixture:web": "node fixtures/web-app/server.mjs"
```

- [ ] **Step 4: Write the exact live Chrome DevTools MCP acceptance runbook**

Create `docs/validation/web-live-acceptance.md` with:

```markdown
# Web Live Acceptance

## Target

- Project root: `fixtures/web-app`
- Entry URL: `http://127.0.0.1:4173/login`
- Readiness URL: `http://127.0.0.1:4173/health`
- Controller: Chrome DevTools MCP
- Account: `qa@example.test`
- Password source: provide `correct-horse` at runtime; do not write it to `.ai-qa/`

## Acceptance criteria

1. `authenticated-home-visible`: `[data-testid="authenticated-home"]` is visible after login. Required evidence: `post-action-screenshot`.
2. `current-account-visible`: `[data-testid="current-account"]` contains `qa@example.test`. Required evidence: `structured-text-assertion` and `post-action-screenshot`.

## Confirmed fixture config

    {
      "schemaVersion": 1,
      "project": { "id": "ai-qa-web-fixture", "name": "AI QA Web Fixture" },
      "targets": {
        "web": {
          "entryUrl": "http://127.0.0.1:4173/login",
          "readinessUrl": "http://127.0.0.1:4173/health"
        }
      },
      "environments": {},
      "tools": { "web": { "controller": "chrome-devtools-mcp" } },
      "evidencePolicy": {
        "screenshots": "required",
        "defaultSensitivity": "internal",
        "retentionDays": 30
      },
      "reportPolicy": {
        "formats": ["markdown", "json"],
        "audience": "engineering",
        "detail": "full"
      },
      "storagePolicy": { "adapter": "project-local" },
      "gitPolicy": { "config": "ignore", "artifacts": "ignore" },
      "ciPolicy": { "nonPassExit": "failure" },
      "secretReferences": { "loginPassword": "AI_QA_WEB_FIXTURE_PASSWORD" }
    }

## Execution

1. Run `pnpm fixture:web` in one terminal.
2. Build and globally install the package into a temporary npm prefix.
3. Explicitly install the global `ai-qa` skill into a temporary agents home.
4. Activate the skill, trust `fixtures/web-app`, discuss and write the confirmed config, and run Web doctor.
5. Use Chrome DevTools MCP for one exploratory login while recording all typed events and a raw screenshot.
6. Finish with `pass`, draft `login-success`, review it, validate it, and activate revision 1.
7. Execute revision 1 twice with fresh run IDs. Both replays must pass consecutively against the same case and Web variant hashes.
8. Generate JSON and Markdown for the exploratory run and both regression runs.
9. Verify every raw evidence hash with report generation and inspect the three reports.

## Required proof

- One exploratory run ID and two consecutive regression run IDs.
- The active case revision and pinned case/Web variant hashes.
- Raw screenshot evidence IDs and SHA-256 hashes for all three runs.
- Three `pass` verdicts with criterion, assertion, observation, and evidence IDs.
- Project-local JSON and Markdown report paths.
- No `.ai-qa/` data outside `fixtures/web-app` and no trust data inside it.
```

- [ ] **Step 5: Add operator documentation**

Create `README.md`:

````markdown
# ai-qa

`ai-qa` is an agent-orchestrated QA CLI. The AI controls Web through Chrome DevTools MCP; the CLI owns trusted project configuration, typed run events, immutable evidence, regression cases, verdict validation, and project-local reports.

## Increment 1 status

This increment supports one complete local Web workflow. RunGroup aggregation, Codex/Claude CI runner templates, external storage, Pepper iOS, Appium Android, real devices, and public npm publication are not included yet.

## Develop

```bash
corepack enable
pnpm install
pnpm check
pnpm build
```

## Install from a packed build

```bash
pnpm pack
npm install --global ./ai-qa-0.0.0.tgz
ai-qa skill install --global
```

The npm install does not overwrite user instructions. The explicit skill command previews managed changes and installs the canonical skill at `~/.agents/skills/ai-qa/`.

## Target-project state

Project records stay under `<target>/.ai-qa/`: confirmed config, run work orders and JSONL journals, per-run evidence indexes/files, immutable case revisions, and reports. Repository trust stays per machine at `~/.ai-qa/trust.json`; project config cannot authorize itself.

## Workflow

1. Confirm trust with `ai-qa trust confirm --project <target> --stdin-json`.
2. Discuss configuration with the user and pipe the confirmed JSON to `ai-qa init`.
3. Use Chrome DevTools MCP read-only and pipe its observations to `ai-qa doctor --platform web --json --stdin-json`.
4. Start exploratory QA with a goal and stable acceptance criteria.
5. Plan every MCP invocation, then record its terminal result, observations, assertions, evidence, and verdict through typed commands.
6. Finish the run, draft/review/activate a case, and replay its pinned Web steps.
7. Generate reports under `.ai-qa/reports/runs/<run-id>/`.

There is no public generic event append command. A successful MCP response alone is never a QA pass.
````

- [ ] **Step 6: Run the full automated quality gate**

Run:

```bash
pnpm format
pnpm check
```

Expected: format, lint, typecheck, all unit/integration/e2e tests, and build exit 0 on the local supported Node version. Before merge, use an authorized repository push/PR workflow and require the configured `pnpm check` job to pass on Node 22 and 24; plan execution itself does not authorize an external push.

- [ ] **Step 7: Pack and globally install in an isolated prefix**

Run:

```bash
PACK_DIR="$(mktemp -d)"
PREFIX="$(mktemp -d)"
AGENTS_HOME="$(mktemp -d)"
pnpm pack --pack-destination "$PACK_DIR"
npm install --global --prefix "$PREFIX" "$PACK_DIR/ai-qa-0.0.0.tgz"
AI_QA_AGENTS_HOME="$AGENTS_HOME" "$PREFIX/bin/ai-qa" skill install --global
"$PREFIX/bin/ai-qa" --help
tar -tf "$PACK_DIR/ai-qa-0.0.0.tgz"
```

Expected: install exits 0, the isolated executable prints help, the skill is valid under `$AGENTS_HOME/skills/ai-qa/`, and the tar listing contains `dist/`, `README.md`, and package metadata but no `.git/`, `.ai-qa/`, `tests/`, `fixtures/`, credentials, or evidence.

- [ ] **Step 8: Execute and record the live Web acceptance**

Follow `docs/validation/web-live-acceptance.md` using the installed tarball and Chrome DevTools MCP. Do not substitute HTTP calls or mocked browser events for MCP interaction. Confirm two consecutive regression passes and retain the `.ai-qa/` records under the fixture project for inspection during review; keep them git-ignored.

Expected: the required proof list in the runbook is complete. A tool or evidence problem yields its typed non-pass result and must be resolved by a fresh run rather than relabeled pass.

- [ ] **Step 9: Commit the complete increment**

```bash
git add tests/e2e/web-vertical-slice.test.ts tests/e2e/cli-web-vertical-slice.test.ts fixtures/web-app/server.mjs fixtures/web-app/.gitignore docs/validation/web-live-acceptance.md README.md package.json pnpm-lock.yaml
git commit -m "feat: complete web QA vertical slice"
```

- [ ] **Step 10: Verify the final commit and clean worktree**

Run:

```bash
pnpm check
git status --short
git log --oneline -12
```

Expected: `pnpm check` exits 0, `git status --short` prints nothing, and the log shows one focused commit for each task.

## Plan Self-Review Coverage

- Package/runtime constraints: Task 1 and Task 12.
- Project isolation, root resolution, config dialogue output, and machine trust: Task 2.
- Explicit global skill install, managed/user regions, and version metadata: Task 3.
- Read-only Web readiness with agent-owned Chrome DevTools MCP: Task 4.
- Frozen exploratory criteria and budgets: Task 5.
- Immutable per-run evidence and integrity verification: Task 6, Task 8, and Task 11.
- Typed two-phase actions, observations, assertions, unknown recovery, and no generic append: Task 7.
- Four-way verdicts, exact supersession, cancellation, resume, and evidence-before-verdict: Task 8.
- Draft/review/activate and immutable case hashes: Task 9.
- Pinned regression replay, ordered steps, and bounded adaptive recovery: Task 10.
- Project-local JSON/Markdown reports with preserved verdict identity: Task 11.
- Automated and live exploratory → promotion → two consecutive regression replays → reports: Task 12.
- RunGroup, named suite behavior, external agent CI templates, external storage, Pepper, Appium, and public npm release stay outside increment 1 and receive separate implementation plans.

## Version References

- GitHub checkout action: <https://github.com/actions/checkout>
- GitHub Node setup action: <https://github.com/actions/setup-node>
- pnpm setup action: <https://github.com/pnpm/action-setup>
