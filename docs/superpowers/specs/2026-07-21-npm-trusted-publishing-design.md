# npm Trusted Publishing Design

**Date:** 2026-07-21

## Goal

Publish the AI QA CLI as the public npm package `@narra-im/ai-qa` at version `0.1.0`, then configure GitHub Actions trusted publishing so later releases use short-lived OIDC credentials instead of a stored npm token.

## Package metadata

Update `package.json` with the following release metadata:

- `name`: `@narra-im/ai-qa`
- `version`: `0.1.0`
- `private`: `false`
- `license`: `MIT`
- `repository`: `git+https://github.com/protagolabs/ai-qa.git`
- `homepage`: `https://github.com/protagolabs/ai-qa#readme`
- `bugs`: `https://github.com/protagolabs/ai-qa/issues`
- `publishConfig.access`: `public`
- `publishConfig.registry`: `https://registry.npmjs.org/`

Add a standard MIT `LICENSE` file with `Copyright (c) 2026 Protagolabs`.

The existing `bin` and `files` declarations remain unchanged. The release tarball therefore contains the compiled `dist` tree, README, package metadata, and license, while excluding source, fixtures, tests, and local artifacts.

## First-release bootstrap

npm only permits trusted-publisher configuration for packages that already exist in the registry. Version `0.1.0` therefore uses a one-time interactive bootstrap:

1. Apply and verify the package metadata and license changes.
2. Run `pnpm check`.
3. Run a package dry-run and inspect the manifest and file list.
4. Commit and push the release metadata while no tag-triggered publish workflow exists.
5. Create and push the `v0.1.0` Git tag.
6. Publish `@narra-im/ai-qa@0.1.0` interactively with public access using the already authenticated `john-cqig` npm account.
7. Complete the npm two-factor prompt if npm requests one.
8. Verify the published package metadata and execute the installed CLI help command.

This ordering preserves a source tag for `0.1.0` without accidentally starting an unauthenticated workflow or attempting to publish the same immutable npm version twice.

## Trusted publishing workflow

After the bootstrap release, add `.github/workflows/publish.yml` and push it to `main`. The workflow will:

- trigger on pushed tags matching `v*`;
- run on a GitHub-hosted Ubuntu runner;
- grant only `contents: read` and `id-token: write` permissions;
- use Node.js 24 and pnpm 11.9.0;
- install dependencies with the frozen lockfile;
- reject a tag whose version does not exactly match `package.json`;
- run `pnpm check` before publication;
- publish the public package to the npm registry with an npm CLI version that supports trusted publishing; and
- rely on npm's automatic provenance generation for public packages published from public GitHub repositories.

No npm token or other long-lived registry credential will be stored in GitHub Actions secrets.

## Trust configuration

Once `0.1.0` exists and `publish.yml` is present on GitHub, configure the package's npm trusted publisher with:

- provider: GitHub Actions
- GitHub organization or user: `protagolabs`
- repository: `ai-qa`
- workflow filename: `publish.yml`
- allowed action: `npm publish`

Verify the saved relationship before relying on it. The local npm CLI is currently `11.6.2`, while the `npm trust` command requires `11.15.0` or newer. Configuration must therefore use the npm website or an explicitly selected newer npm CLI without modifying the project's dependency graph.

## Later releases

Starting with `0.1.1`, each release follows this sequence:

1. Bump `package.json` to a new semantic version.
2. Run the repository quality checks.
3. Commit and push the version change.
4. Create and push the matching `vX.Y.Z` tag.
5. Monitor the publish workflow.
6. Verify the npm version, provenance, and CLI execution.

The workflow must fail before publication when the tag and package version differ, checks fail, OIDC authentication is unavailable, the npm version already exists, or npm rejects organization permissions.

## Validation and recovery

Before either the bootstrap or an automated release, inspect the package dry-run to ensure it contains no credentials, local state, fixtures, or unintended files. A failed pre-publication check is safe to retry after correcting the repository or trust configuration.

Published npm versions are immutable and must never be overwritten or reused. If publication succeeds but post-publication CLI verification exposes a defect, publish a corrected patch version rather than trying to replace `0.1.0`. Do not unpublish automatically.

## Out of scope

- Private package access
- Stored npm automation tokens
- Automated semantic-version selection
- Changelog or GitHub Release generation
- Refactoring the CLI or changing runtime behavior
