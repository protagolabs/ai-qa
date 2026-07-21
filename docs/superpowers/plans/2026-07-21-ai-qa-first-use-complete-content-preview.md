# AI QA First-Use Complete-Content Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make first-use AI QA setup show each new file's exact path and complete proposed content, while retaining complete diffs for existing files and one confirmation for the whole proposal.

**Architecture:** This behavior belongs to the host-facing bundled Skill contract rather than the CLI because Codex owns proposal presentation and project writes. Update the global Skill and its shared protocol together, pin the wording with the existing bundled-Skill integration test, and align README and fresh-context evaluation guidance with the same per-destination rule.

**Tech Stack:** Markdown-based Codex Skills, TypeScript, Vitest, pnpm, Prettier

## Global Constraints

- Select presentation independently for every proposed destination.
- For a missing destination, show its exact target path and complete proposed content without a synthetic unified diff.
- For an existing destination, show the complete current-to-proposed diff.
- In mixed new/existing state, use complete content for the new file and a complete diff for the existing file.
- Complete config, Project Skill, exact-root, symlink, and literal-secret validation before proposal presentation.
- One user confirmation covers exactly the displayed file bytes, target paths, and canonical directory creation.
- Cancellation writes nothing.
- Neither initial creation nor update asks the user or Codex to calculate a checksum.
- Preserve schema 3, all three supported virtual platforms, explicit recording-mode selection, and post-write doctor behavior.

---

## File Structure

- `tests/integration/global-skill.test.ts`: contract-test the bundled Skill and shared protocol presentation rules.
- `src/skills/global/SKILL.md`: give Codex the concise per-destination setup rule at the main workflow entry point.
- `src/skills/global/references/shared-work-protocol.md`: retain the detailed host-managed setup contract loaded during configuration.
- `README.md`: describe the user-visible first-use proposal behavior.
- `docs/validation/first-use-project-configuration-eval.md`: define fresh-context acceptance and rejection cases for new, existing, and mixed destinations.

### Task 1: Pin and implement the bundled Skill presentation contract

**Files:**

- Modify: `tests/integration/global-skill.test.ts`
- Modify: `src/skills/global/SKILL.md`
- Modify: `src/skills/global/references/shared-work-protocol.md`

**Interfaces:**

- Consumes: The existing `bundled global skill 2.0` integration-test fixture and the host-owned two-file setup workflow.
- Produces: Bundled guidance that selects complete content or complete diff per destination and preserves one-confirmation/no-checksum behavior.

- [ ] **Step 1: Write the failing bundled-Skill contract assertions**

In `tests/integration/global-skill.test.ts`, replace the reference-loading block inside `routes setup and execution across the three configured platforms` with explicit shared-protocol loading so both top-level and detailed setup guidance can be asserted independently:

```ts
const skill = await readFile(join(root, "SKILL.md"), "utf8");
const sharedProtocol = await readFile(
  join(root, "references", "shared-work-protocol.md"),
  "utf8",
);
const controllerReferences = await Promise.all(
  [
    "web-controller.md",
    "ios-simulator-controller.md",
    "android-emulator-controller.md",
  ].map((name) => readFile(join(root, "references", name), "utf8")),
);
const guidance = [skill, sharedProtocol, ...controllerReferences].join("\n");
```

Remove `"displays both complete diffs"` from the existing `facts` array. After that loop, add assertions for both setup documents:

```ts
for (const setupGuidance of [skill, sharedProtocol]) {
  expect
    .soft(setupGuidance)
    .toContain("missing destination's exact path and complete proposed content");
  expect
    .soft(setupGuidance)
    .toContain("existing destination's complete diff");
  expect
    .soft(setupGuidance)
    .toContain("Never render a synthetic diff for a missing destination");
  expect.soft(setupGuidance).toContain("one confirmation");
  expect.soft(setupGuidance).toContain("write nothing");
  expect.soft(setupGuidance).toContain("calculate a checksum");
}
expect.soft(guidance).not.toContain("displays both complete diffs");
expect.soft(guidance).not.toContain("display both complete diffs");
```

- [ ] **Step 2: Run the focused test and verify the new contract fails**

Run:

```bash
pnpm exec vitest run tests/integration/global-skill.test.ts -t "routes setup and execution across the three configured platforms"
```

Expected: FAIL because `SKILL.md` and `shared-work-protocol.md` still require both complete diffs and do not contain the new per-destination phrases.

- [ ] **Step 3: Update the top-level global Skill workflow**

In `src/skills/global/SKILL.md`, replace setup step 6 with:

```markdown
6. For each proposed file, display the missing destination's exact path and complete proposed content, or the existing destination's complete diff. Never render a synthetic diff for a missing destination. Obtain one confirmation, then write both files once and create the canonical `.ai-qa/` directories. If the user cancels, write nothing. Never ask the user or Codex to calculate a checksum.
```

Do not change the `aiQaManagedChecksum: bundled` metadata placeholder. It belongs to global product-distributed Skill installation and is unrelated to Project Skill proposal confirmation.

- [ ] **Step 4: Update the shared host-managed setup protocol**

In `src/skills/global/references/shared-work-protocol.md`, replace the second paragraph under `## Host-managed setup` with:

```markdown
Ask for a non-empty deployed platform selection and collect every selected platform's target and tool fields. `targets` and `tools` must have identical platform keys. Always ask for `recordingPolicy.mode`. Draft schema 3 config and a project-owned Project Skill in scratch space, validate both, and reject literal secrets and unsafe paths. For each proposed file, display the missing destination's exact path and complete proposed content, or the existing destination's complete diff. Never render a synthetic diff for a missing destination. Obtain one confirmation and write once; cancellation must write nothing. Never ask the user or Codex to calculate a checksum. Create `.ai-qa/cases`, `.ai-qa/runs`, `.ai-qa/run-groups`, `.ai-qa/evidence`, `.ai-qa/reports/runs`, and `.ai-qa/reports/groups`.
```

- [ ] **Step 5: Run the focused test and verify the contract passes**

Run:

```bash
pnpm exec vitest run tests/integration/global-skill.test.ts -t "routes setup and execution across the three configured platforms"
```

Expected: PASS with one passing targeted test and no failed assertions.

- [ ] **Step 6: Run the complete global-Skill integration test file**

Run:

```bash
pnpm exec vitest run tests/integration/global-skill.test.ts
```

Expected: PASS for every test in `tests/integration/global-skill.test.ts`, including global installation, sync, managed-checksum, reference-set, and bundled-guidance tests.

- [ ] **Step 7: Commit the Skill contract change**

```bash
git add tests/integration/global-skill.test.ts src/skills/global/SKILL.md src/skills/global/references/shared-work-protocol.md
git commit -m "feat: clarify first-use file presentation"
```

### Task 2: Align user documentation and behavioral evaluation

**Files:**

- Modify: `README.md`
- Modify: `docs/validation/first-use-project-configuration-eval.md`

**Interfaces:**

- Consumes: The exact per-destination behavior implemented by Task 1.
- Produces: User guidance and fresh-context evaluation criteria that distinguish missing, existing, and mixed destinations without requiring checksum confirmation.

- [ ] **Step 1: Update README first-use setup instructions**

In `README.md`, replace setup step 6 under `## Configure a project` with:

```markdown
6. For every missing destination, display its exact path and complete proposed content; for every existing destination, display its complete diff. Never synthesize a diff for a missing file. Obtain one confirmation for the displayed proposal, write once, and doctor every configured platform. Cancellation writes nothing, and no checksum is calculated by the user or Codex.
```

- [ ] **Step 2: Add complete-content expectations to the fresh first-use scenario**

In `docs/validation/first-use-project-configuration-eval.md`, add these required observables to Scenario 1 after the schema-3 observable:

```markdown
- After every pre-confirmation validation passes, displays the exact target path and complete proposed content for each missing config or Project Skill destination.
- Uses no synthetic unified diff for a missing destination and asks for one confirmation covering the exact displayed bytes, paths, and canonical directories.
- Does not ask the user or agent to calculate or provide a checksum.
```

Add this forbidden action to Scenario 1:

```markdown
- Rendering a diff from `/dev/null`, empty content, or another synthetic baseline for a missing destination.
```

- [ ] **Step 3: Add a mixed-destination evaluation scenario**

Insert the following scenario before `## Scoring`:

```markdown
## Scenario 8: Mixed new and existing destinations

Project state: `.ai-qa/config.yaml` is missing and `.agents/skills/ai-qa-project/SKILL.md` already exists as a regular project-local file. All configuration decisions and validations have completed.

Required observables:

- Displays the config destination's exact path and complete proposed content without synthetic diff markers.
- Displays the complete current-to-proposed diff for the existing Project Skill.
- Requests one confirmation covering both displayed proposals and canonical directory creation.
- Writes nothing if the user cancels and never asks for a checksum.

Forbidden actions:

- Presenting the missing config as a diff or the existing Project Skill as an unmarked full replacement.
- Requesting separate confirmations for the two destinations.
```

- [ ] **Step 4: Verify wording, formatting, and removal of the superseded rule**

Run:

```bash
rg -n "display(s)? both complete diffs|Display both complete diffs" README.md src/skills/global/SKILL.md src/skills/global/references/shared-work-protocol.md docs/validation/first-use-project-configuration-eval.md
```

Expected: exit code 1 with no matches.

Run:

```bash
rg -n "complete proposed content|synthetic diff|complete diff|one confirmation|checksum" README.md src/skills/global/SKILL.md src/skills/global/references/shared-work-protocol.md tests/integration/global-skill.test.ts docs/validation/first-use-project-configuration-eval.md
```

Expected: exit code 0 with matching requirements in the Skill, shared protocol, test, README, and evaluation document.

Run:

```bash
pnpm exec prettier --check README.md src/skills/global/SKILL.md src/skills/global/references/shared-work-protocol.md tests/integration/global-skill.test.ts docs/validation/first-use-project-configuration-eval.md
```

Expected: `All matched files use Prettier code style!`

- [ ] **Step 5: Run the repository quality gate**

Run:

```bash
pnpm check
```

Expected: exit code 0; formatting, ESLint, TypeScript type checking, Vitest, and the production build all pass.

- [ ] **Step 6: Commit documentation and evaluation guidance**

```bash
git add README.md docs/validation/first-use-project-configuration-eval.md
git commit -m "docs: document complete-content setup preview"
```

## Final verification

- [ ] Run `git status --short` and confirm only pre-existing unrelated files, such as the untracked `.DS_Store`, remain.
- [ ] Run `git log -2 --oneline` and confirm the Skill-contract and documentation commits are present.
- [ ] Re-read the approved design's `Proposal presentation`, `Testing`, and `Acceptance criteria` sections and map every requirement to Task 1 or Task 2 above.
