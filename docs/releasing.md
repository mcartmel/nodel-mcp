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
   `19756071383d696682688ab436c77c0a1f80c783`, and nodel-recipes MIT
   provenance. Record the license/provenance review in the release notes.
5. Generate `reports/dependency-licenses.json` from the exact lockfile with
   `npm run license:report`; review the report and release archive for
   compatible redistribution terms. `npm run license:check` rejects drift.
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

The production audit is clean at high severity. The current full audit has one
development-only low-severity `esbuild` advisory,
`GHSA-g7r4-m6w7-qqqr` (Windows development-server file read); it does not
affect production dependencies or constitute a production exception. Manual
history, provenance, and license sign-offs remain release-review items and are
intentionally Pending here.
