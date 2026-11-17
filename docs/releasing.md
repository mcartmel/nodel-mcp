# Releasing

This project is distributed through the [nodel-mcp repository](https://github.com/mcartmel/nodel-mcp)
and GitHub Releases only. The v0.1 runtime/package/service remains `nodel-ai`
for compatibility. `v0.1.0` is not published to npm and no container image is
produced.

## Checklist

1. Confirm the release is an unsupported pre-1.0 public preview and review
   [SUPPORT.md](../SUPPORT.md) and [SECURITY.md](../SECURITY.md).
2. Confirm `package.json`, `package-lock.json`, and the intended tag use the
   same version. Keep `private: true` to prevent accidental npm publication.
3. Review the complete Git history and final tree for secrets, credentials,
   personal/internal data, host-specific paths, and unreviewed copied content.
   Rotate credentials before any history rewrite.
4. Verify `LICENSE`, `THIRD_PARTY_NOTICES.md`, upstream Nodel revision
   `19756071383d696682688ab436c77c0a1f80c783`, nodel-recipes MIT provenance,
   and the pinned v2 contract/starter MPL-2.0 provenance and SHA-256 values in
   `src/nodel/v2/provenance.json`. Record the license/provenance review in the
   release notes. The runtime `parse5` dependency is MIT-licensed and appears in
   the lockfile-specific dependency report.
5. Generate `reports/dependency-licenses.json` from the exact lockfile with
   `npm run license:report`; review the report and release archive for
   compatible redistribution terms. For dependency maintenance, update direct
   pins and `package-lock.json` together, use `npm update` only for compatible
   ranges, then run `npm ci` followed by `npm run license:report`. Review the
   report's lockfile SHA and dependency/license changes; `npm run license:check`
   rejects drift and must remain enabled.
6. Run `npm ci`, fetch the official Caddy v2.11.3 Linux amd64 validator with
   the CI-only checked helper, then run `npm run release:check` and
   `npm run release:determinism`. The dependency gate blocks high
   severity production findings. Any reviewed lower-severity exception must
   be recorded here with advisory, rationale, owner, mitigation, and an
   expiry date; expired exceptions fail the release review.

   For a local release check, set both variables explicitly; printed helper
   output is informational and does not export them:

   ```sh
    CADDY_BIN=/absolute/path/to/verified/caddy-2.11.3 CADDY_REQUIRED=true npm run release:check
   ```

7. Review the changelog and add migration notes for any pre-1.0 breaking MCP
   tool or schema changes.
8. Create a protected `v<package-version>` tag only after the checks pass. The
   tag workflow requires a successful compatibility run for the exact commit,
   creates `artifacts/nodel-ai-v<version>.tar.gz` plus separately downloadable
   `SHA256SUMS`, `SBOM.cdx.json`, `dependency-licenses.json`, and
   `ARTIFACT-MANIFEST.json` assets, and opens a **draft** GitHub Release. It
   never publishes npm packages or containers.

Before a public export, use the exact reviewed 40-character commit SHA:

```sh
npm run public:check -- --source-sha "$(git rev-parse HEAD)"
EXPORT_DIR=/path/outside/the/source/repository
node scripts/public-export.mjs --output "$EXPORT_DIR" --source-sha "$(git rev-parse HEAD)"
```

The export command reads `git archive`, not the working filesystem. Its audit
manifest is written beside the export and must not be copied into the public tree.

The source export and binary release package are intentionally separate inputs:
the export validates the complete reviewed source tree, while release packaging
builds an allowlisted compiled artifact. Both run the same public-candidate path,
content, mode, symlink, private-link, host-path, and secret policy before output.

The build copies the pinned v2 contract, starter and provenance into
`dist/nodel/v2/`; the release allowlist packages that compiled directory and
`THIRD_PARTY_NOTICES.md`. Builds verify the contract/starter hashes and need no
`nodel-webui-v2` sibling checkout or network access. To refresh the pin, first
review an immutable upstream revision and local contract/catalogue files, then
run the explicit maintainer script (the script writes only `src/nodel/v2/`).
The recommended `--catalogue` mode requires `npm run build` first and reuses the
compiled bounded HTML parser for local `components.html`: at most 4 MiB, 100,000
allocated nodes, depth 512, 128 attributes per tag, 65,536 characters per markup token,
200 parser error events and 2,000,000 tree-work units. It rejects incomplete,
truncated or erroneous HTML before extraction or any pin writes. It
requires exactly one marked Quickstart page/code block, decodes HTML text once,
preserves its contents and writes the pinned single trailing newline. A direct
`--starter` file remains available for an already extracted, strictly UTF-8
starter; this mode does not require compiled helpers. `--revision` must be a full
40-hex-character commit SHA; branch names such as `main` are rejected before any
file I/O. The refresh script is a source-checkout maintainer tool, not a command
included in release archives.

```sh
npm run build # required before --catalogue (also run by npm test)
node scripts/refresh-v2-reference.mjs --refresh \
  --artifact /path/to/reviewed/v2/nodel-components.json \
  --catalogue /path/to/reviewed/components.html \
  --repository https://github.com/mcartmel/nodel-webui-v2 \
  --revision <40-character-commit-sha> \
  --package-version <upstream-version> --schema-version 1 --license MPL-2.0
node scripts/refresh-v2-reference.mjs --check \
  --artifact /path/to/reviewed/v2/nodel-components.json \
  --catalogue /path/to/reviewed/components.html \
  --repository https://github.com/mcartmel/nodel-webui-v2 \
  --revision <40-character-commit-sha> \
  --package-version <upstream-version> --schema-version 1 --license MPL-2.0
npm run build
```

The refresh/check command requires explicit provenance and compares exact
contract bytes and the precisely extracted starter; it does not download
upstream content or vendor the catalogue. Review updates to
`THIRD_PARTY_NOTICES.md` and the dependency license report along with the pin.

The isolated browser qualification verifies that the runtime-served component
contract hash matches the pinned reference. It records the runtime distribution
used, but does not independently verify the source commit/build revision of
those runtime assets; do not treat the contract hash as complete build
provenance.

## Installing a release archive

Extract `nodel-ai-v<version>.tar.gz`, copy `.env.example` to `.env`, set
`NODEL_STATE_DIR` to a private directory, and run:

```sh
cp .env.example .env
chmod 600 .env
npm ci --omit=dev
node dist/index.js
```

The archive is already compiled; do not run a build and do not install
TypeScript or other development dependencies. The four evidence files are
included in the archive and attached separately to the draft release. `SHA256SUMS`
covers the archive and every evidence asset except itself. `release:determinism`
rebuilds all evidence twice with the checked-out commit timestamp and fails on
any hash difference.

## Compatibility gate sequence

Manually dispatch the compatibility workflow from the release commit and wait
for it to succeed. Then create and push the protected `v<version>` tag. The tag
workflow checks the GitHub Actions API for a completed successful run with the
exact commit SHA and fails closed when that run is absent or stale.

Repository administrators must configure protected `main` and `v*` tags,
required CI checks, private vulnerability reporting, dependency/security alerts,
and immutable releases as manual GitHub repository gates before changing
visibility. `private: true` remains set in package metadata.

### Stage 9 Documentation Readiness (this stage)

| Artifact                                                  | Status                                 |
| --------------------------------------------------------- | -------------------------------------- |
| Public-facing README rewrite                              | Complete                               |
| Architecture + security model docs                        | Complete                               |
| Operations guide                                          | Complete                               |
| Existing-build migration guide (`docs/migration-v0.1.md`) | Complete                               |
| Tool reference drift check                                | Run `npm run docs:check` in CI         |
| Check evidence capture                                    | Complete when release gate is reviewed |

The release process does not claim transactional behavior for external Nodel
changes and does not provide an SLA or guaranteed contribution review.

## Release review record

Complete this table in the release pull request or release notes. A blank item
is a release blocker.

| Review                                                     | Result  | Reviewer/date | Evidence |
| ---------------------------------------------------------- | ------- | ------------- | -------- |
| Full-history secret and private-data scan                  | Pending |               |          |
| Nodel-derived source provenance and MPL-2.0 review         | Pending |               |          |
| Runtime dependency license report and compatibility review | Pending |               |          |
| Documentation consistency checks                           | Pending |               |          |

The coordinated dependency-security and compatible-tooling update recorded on
2026-11-17 cleared all known audit findings by updating the coverage toolchain,
ESLint family, and TypeScript runner. Re-run both the production and full
development dependency audits for every release; an audit result is time-bound
and does not replace the manual history, provenance, or license sign-offs,
which remain release-review items and are intentionally Pending here.

The supported application runtime remains Node.js 22 or newer. Development
tooling has a higher minimum: use Node.js 22.13 or newer on the Node 22 line,
or Node.js 24 or newer. Node.js 23 is not supported by ESLint 10. CI continues
to test on Node 22, so development and release checks use a runtime that meets
that tooling requirement. The committed
`@types/node` version intentionally targets Node 22 APIs; do not advance it to
the newest Node major just to follow the host runtime or expose APIs outside the
supported baseline. Dependabot major updates for Node typings are ignored so a
new typings major receives an explicit supported-runtime-baseline review; patch
and minor updates remain allowed.

The `c8` 12 coverage tool depends on `test-exclude` 8, whose declared `glob`
13 and `minimatch` 10 ranges have no releases outside current audit advisories.
The narrow `test-exclude` overrides therefore select patched `glob` 14.0.6 and
`minimatch` 11.0.9. The regression suite exercises the real include/exclude
glob behavior, and the normal c8 run still checks remapped TypeScript source
and existing statement/branch thresholds.

The clean full audit reported on 2026-11-17 was time-bound. A subsequent refresh
identified GHSA-fc5q-39xc-vjpf, a high-severity `picomatch` advisory affecting
versions through 4.0.7, in the development-only dependency tree; current npm
metadata yields nine high findings through that chain and zero production
findings. The registry's latest `picomatch` is 4.0.7, with no patched release,
and latest `tinyglobby` 0.2.17 still uses `^4.0.4`. The latest
`typescript-eslint` 8.73 supports ESLint 10 and TypeScript below 6.1, so the
compatible tooling pins do not offer a safe route around this advisory. Do not
force a downgrade, add a misleading override, waive the advisory, or weaken the
production dependency gate. Recheck the full audit before release; until a
patched compatible dependency is available, the unresolved development advisory
means the full audit has not passed even though the production audit is clean.
