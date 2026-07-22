# npm Trusted Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `@narra-im/ai-qa@0.1.0` as a public MIT-licensed npm package, then configure tag-triggered GitHub Actions trusted publishing for later releases.

**Architecture:** Bootstrap the first immutable npm version interactively because npm cannot attach a trusted publisher to a package that does not yet exist. After the bootstrap, add a dedicated tag-triggered workflow that validates the Git tag, runs the repository quality gate, and publishes through GitHub OIDC without an npm token.

**Tech Stack:** Node.js 24, npm 11.18.0 for trusted-publishing operations, pnpm 11.9.0, GitHub Actions, npm public registry, OIDC

## Global Constraints

- Package name is exactly `@narra-im/ai-qa`.
- Initial version is exactly `0.1.0` and the matching Git tag is `v0.1.0`.
- Package visibility is public.
- License is MIT with `Copyright (c) 2026 Protagolabs`.
- Repository metadata points to `https://github.com/protagolabs/ai-qa`.
- No npm token or other long-lived registry write credential may be added to the repository or GitHub Actions secrets.
- The first version is published interactively before `.github/workflows/publish.yml` exists on the pushed tag.
- Later releases are triggered only by pushed `v*` tags whose value exactly matches `v` plus the `package.json` version.
- Do not add `.DS_Store` to Git or any release commit.
- Do not unpublish an npm version automatically if post-publication verification fails.

---

### Task 1: Prepare public package metadata and license

**Files:**
- Modify: `package.json:2-18`
- Create: `LICENSE`

**Interfaces:**
- Consumes: Existing `bin`, `files`, `prepack`, build, and quality-check configuration in `package.json`.
- Produces: Public npm identity `@narra-im/ai-qa@0.1.0` and the MIT license included by npm in the release tarball.

- [ ] **Step 1: Run a metadata assertion that proves the current package is not publish-ready**

Run:

```bash
node --input-type=module -e 'import assert from "node:assert/strict"; import { readFileSync } from "node:fs"; const p = JSON.parse(readFileSync("package.json", "utf8")); assert.equal(p.name, "@narra-im/ai-qa"); assert.equal(p.version, "0.1.0"); assert.equal(p.private, false); assert.equal(p.license, "MIT");'
```

Expected: FAIL with an assertion showing the current name is `ai-qa` instead of `@narra-im/ai-qa`.

- [ ] **Step 2: Update the package release metadata**

Change the beginning of `package.json` to retain all existing fields and add the following exact values:

```json
{
  "name": "@narra-im/ai-qa",
  "version": "0.1.0",
  "private": false,
  "description": "Agent-orchestrated QA CLI and skill",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/protagolabs/ai-qa.git"
  },
  "homepage": "https://github.com/protagolabs/ai-qa#readme",
  "bugs": {
    "url": "https://github.com/protagolabs/ai-qa/issues"
  },
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org/"
  },
  "type": "module",
  "packageManager": "pnpm@11.9.0"
}
```

Do not remove or change `engines`, `bin`, `files`, `scripts`, dependencies, or dev dependencies from the existing file.

- [ ] **Step 3: Add the MIT license**

Create `LICENSE` with this exact content:

```text
MIT License

Copyright (c) 2026 Protagolabs

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 4: Verify the metadata and license**

Run:

```bash
node --input-type=module -e 'import assert from "node:assert/strict"; import { readFileSync } from "node:fs"; const p = JSON.parse(readFileSync("package.json", "utf8")); assert.deepEqual({ name: p.name, version: p.version, private: p.private, license: p.license, repository: p.repository, homepage: p.homepage, bugs: p.bugs, publishConfig: p.publishConfig }, { name: "@narra-im/ai-qa", version: "0.1.0", private: false, license: "MIT", repository: { type: "git", url: "git+https://github.com/protagolabs/ai-qa.git" }, homepage: "https://github.com/protagolabs/ai-qa#readme", bugs: { url: "https://github.com/protagolabs/ai-qa/issues" }, publishConfig: { access: "public", registry: "https://registry.npmjs.org/" } }); assert.equal(p.bin["ai-qa"], "./dist/cli/main.js"); assert.deepEqual(p.files, ["dist", "README.md"]); assert.match(readFileSync("LICENSE", "utf8"), /Copyright \(c\) 2026 Protagolabs/);'
```

Expected: exit 0 with no output.

- [ ] **Step 5: Run focused formatting checks**

Run:

```bash
pnpm exec prettier --check package.json
git diff --check
```

Expected: Prettier reports `package.json` formatted and `git diff --check` exits 0.

- [ ] **Step 6: Commit only the release metadata and license**

Run:

```bash
git add package.json LICENSE
git diff --cached --check
git commit -m "chore: prepare npm package release"
```

Expected: one commit containing `package.json` and `LICENSE`; `.DS_Store` remains untracked.

---

### Task 2: Validate and bootstrap `0.1.0`

**Files:**
- Verify: `package.json`
- Verify: `LICENSE`
- Verify generated package contents from `dist`, `README.md`, and npm-required metadata

**Interfaces:**
- Consumes: The public package metadata from Task 1 and the existing `prepack` script.
- Produces: Published package `@narra-im/ai-qa@0.1.0` and source tag `v0.1.0`.

- [ ] **Step 1: Confirm the workflow does not yet exist**

Run:

```bash
test ! -e .github/workflows/publish.yml
```

Expected: exit 0. Stop if the file exists, because pushing `v0.1.0` could trigger an unauthenticated or duplicate publication.

- [ ] **Step 2: Run the complete repository quality gate**

Run:

```bash
pnpm check
```

Expected: formatting, lint, typecheck, tests, and build all exit 0.

- [ ] **Step 3: Inspect the exact npm package dry-run**

Run:

```bash
npm pack --dry-run --json | jq -e '.[0] | .name == "@narra-im/ai-qa" and .version == "0.1.0" and ([.files[].path] | index("package.json") != null and index("README.md") != null and index("LICENSE") != null and any(startswith("dist/")) and index(".DS_Store") == null)'
```

Expected: `true`. Review the preceding npm notices and JSON file list; stop if credentials, fixtures, tests, source files, or local state appear.

- [ ] **Step 4: Confirm the registry version and Git tag are unused**

Run these guarded checks:

```bash
if npm view @narra-im/ai-qa@0.1.0 version >/dev/null 2>&1; then echo "npm version already exists"; exit 1; fi
if git rev-parse --verify refs/tags/v0.1.0 >/dev/null 2>&1; then echo "local tag already exists"; exit 1; fi
if git ls-remote --exit-code --tags origin refs/tags/v0.1.0 >/dev/null 2>&1; then echo "remote tag already exists"; exit 1; fi
```

Expected: exit 0 with no output, proving that the npm version and local/remote tag do not exist. Stop instead of publishing if any check finds an existing version or tag.

- [ ] **Step 5: Push the reviewed release commit to `main`**

Run:

```bash
git status --short --branch
git push origin main
```

Expected: only `.DS_Store` is untracked, and `main` is pushed successfully.

- [ ] **Step 6: Create and push the immutable source tag before the publish workflow exists**

Run:

```bash
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin refs/tags/v0.1.0
```

Expected: annotated tag `v0.1.0` points to the release metadata commit and is present on GitHub without starting `publish.yml`.

- [ ] **Step 7: Publish the first public version interactively**

Run:

```bash
npm publish --access public
```

Expected: npm requests two-factor confirmation when required, then reports `+ @narra-im/ai-qa@0.1.0`. Do not retry with an automation token if authentication fails.

- [ ] **Step 8: Verify the registry and installed CLI**

Run:

```bash
npm view @narra-im/ai-qa@0.1.0 name version license repository.url dist.tarball --json
npx --yes @narra-im/ai-qa@0.1.0 --help
```

Expected: registry metadata identifies version `0.1.0`, license `MIT`, and the Protagolabs repository; the second command exits 0 and prints the AI QA CLI help.

---

### Task 3: Add the tag-triggered OIDC publish workflow

**Files:**
- Create: `.github/workflows/publish.yml`

**Interfaces:**
- Consumes: A pushed tag in the form `vX.Y.Z`, the matching `package.json` version, the pnpm lockfile, and GitHub's OIDC identity token.
- Produces: A public npm publication request authenticated by GitHub OIDC, with no stored npm token.

- [ ] **Step 1: Prove the publish workflow is not yet present**

Run:

```bash
test -f .github/workflows/publish.yml
```

Expected: exit 1 because the workflow has not been created.

- [ ] **Step 2: Create the trusted-publishing workflow**

Create `.github/workflows/publish.yml` with this exact content:

```yaml
name: Publish Package

on:
  push:
    tags:
      - "v*"

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v6
        with:
          version: 11.9.0
          run_install: false
      - uses: actions/setup-node@v6
        with:
          node-version: 24
          cache: pnpm
          registry-url: https://registry.npmjs.org
      - run: pnpm install --frozen-lockfile
      - name: Verify tag matches package version
        run: |
          package_version="$(node --print "require('./package.json').version")"
          expected_tag="v${package_version}"
          if [ "$GITHUB_REF_NAME" != "$expected_tag" ]; then
            echo "::error::tag $GITHUB_REF_NAME does not match package version $package_version"
            exit 1
          fi
      - run: pnpm check
      - run: npm install --global npm@11.18.0
      - run: npm publish --access public
```

- [ ] **Step 3: Parse and format-check the workflow**

Run:

```bash
node --input-type=module -e 'import assert from "node:assert/strict"; import { readFileSync } from "node:fs"; import { parse } from "yaml"; const workflow = parse(readFileSync(".github/workflows/publish.yml", "utf8")); assert.deepEqual(workflow.permissions, { contents: "read", "id-token": "write" }); assert.equal(workflow.jobs.publish["runs-on"], "ubuntu-latest"); assert.equal(workflow.jobs.publish.steps.at(-1).run, "npm publish --access public");'
pnpm exec prettier --check .github/workflows/publish.yml
git diff --check
```

Expected: YAML assertions pass, Prettier reports the workflow formatted, and `git diff --check` exits 0.

- [ ] **Step 4: Exercise both tag-version validation branches locally**

Run the success case:

```bash
GITHUB_REF_NAME=v0.1.0 bash -euo pipefail -c 'package_version="$(node --print "require(\"./package.json\").version")"; expected_tag="v${package_version}"; if [ "$GITHUB_REF_NAME" != "$expected_tag" ]; then exit 1; fi'
```

Expected: exit 0.

Run the mismatch case:

```bash
GITHUB_REF_NAME=v9.9.9 bash -euo pipefail -c 'package_version="$(node --print "require(\"./package.json\").version")"; expected_tag="v${package_version}"; if [ "$GITHUB_REF_NAME" != "$expected_tag" ]; then echo "tag mismatch"; exit 1; fi'
```

Expected: exit 1 and output `tag mismatch`.

- [ ] **Step 5: Run the complete quality gate with the workflow present**

Run:

```bash
pnpm check
```

Expected: all checks, tests, and build steps exit 0.

- [ ] **Step 6: Commit only the workflow**

Run:

```bash
git add .github/workflows/publish.yml
git diff --cached --check
git commit -m "ci: add npm trusted publishing"
```

Expected: one commit containing only `.github/workflows/publish.yml`; `.DS_Store` remains untracked.

- [ ] **Step 7: Push and confirm GitHub recognizes the workflow**

Run:

```bash
git push origin main
gh workflow view publish.yml
```

Expected: `main` is pushed and GitHub reports a workflow named `Publish Package` from `publish.yml`.

---

### Task 4: Configure and verify npm trust

**Files:**
- Verify: `.github/workflows/publish.yml`
- Verify: `package.json`

**Interfaces:**
- Consumes: Existing npm package `@narra-im/ai-qa`, GitHub repository `protagolabs/ai-qa`, and workflow filename `publish.yml`.
- Produces: One npm trusted-publisher relationship authorized only for `npm publish` from the specified GitHub Actions workflow.

- [ ] **Step 1: Reconfirm prerequisites before mutating npm trust settings**

Run:

```bash
npm whoami
npm view @narra-im/ai-qa@0.1.0 version
gh repo view protagolabs/ai-qa --json nameWithOwner,visibility,url
gh workflow view publish.yml
```

Expected: npm user is `john-cqig`, version is `0.1.0`, repository visibility is `PUBLIC`, and GitHub recognizes `publish.yml`.

- [ ] **Step 2: Create the exact GitHub OIDC trust relationship**

Run:

```bash
pnpm dlx npm@11.18.0 trust github @narra-im/ai-qa --file publish.yml --repo protagolabs/ai-qa --allow-publish
```

Expected: npm requests interactive two-factor confirmation if needed and creates one trusted publisher for GitHub repository `protagolabs/ai-qa`, workflow `publish.yml`, with direct publish permission. Do not grant staged-publish permission or store a token.

- [ ] **Step 3: Read back and inspect the saved trust relationship**

Run:

```bash
pnpm dlx npm@11.18.0 trust list @narra-im/ai-qa --json
```

Expected: one GitHub Actions relationship referencing `protagolabs/ai-qa` and `publish.yml`, with `npm publish` allowed. Stop and revoke the relationship if the repository or workflow differs.

- [ ] **Step 4: Perform final local and remote verification**

Run:

```bash
git status --short --branch
git log -3 --oneline --decorate
git ls-remote --exit-code --tags origin refs/tags/v0.1.0
npm view @narra-im/ai-qa@0.1.0 name version license repository.url --json
npx --yes @narra-im/ai-qa@0.1.0 --help
```

Expected: local `main` tracks `origin/main`, only `.DS_Store` remains untracked, tag `v0.1.0` exists remotely, npm metadata is correct, and the installed CLI help exits 0.

- [ ] **Step 5: Record the next-release procedure in the completion handoff**

Record these exact commands for the first automated patch release after its code is ready and verified:

```bash
npm version 0.1.1
git push origin main
git push origin refs/tags/v0.1.1
gh run watch --exit-status
npm view @narra-im/ai-qa@0.1.1 version --json
```

Expected: the handoff states that future tags must match `package.json`, that GitHub OIDC performs publication, and that npm versions are immutable.
