# Third-Party Notices

## `museumsvictoria/nodel`

The legacy v1 XML/XSLT UI catalog and guidance contain facts derived from
the upstream Nodel source repository:

- Repository: https://github.com/museumsvictoria/nodel
- Revision: `19756071383d696682688ab436c77c0a1f80c783`
- Source paths: `nodel-webui-js/src/index.xml`, `index.xsl`, `templates.xsl`, `nodel.js`, and `theme.less`
- License: Mozilla Public License 2.0 (MPL-2.0)

Each physically split catalog source file carries an SPDX and provenance
notice naming this repository and revision. `shared.ts` centralizes the URL
and revision constants used by those notices.

The derived catalog is included for interoperability and attribution. It is
not an endorsement of this project, and this project is independent of the
upstream project and Museum Victoria. The complete MPL-2.0 text is in
[LICENSE](LICENSE).

## `museumsvictoria/nodel-recipes`

The public recipe listing and reading tools use content from:

- Repository: https://github.com/museumsvictoria/nodel-recipes
- License: MIT
- Provenance: public recipes and examples are retrieved from the upstream repository at runtime; individual files may carry their own notices.

This project does not claim ownership of upstream recipes. Users must retain
the upstream notices when redistributing copied recipe content.

## `mcartmel/nodel-webui-v2` authoring reference

The bundled v2 component contract and Quickstart starter used for offline UI
authoring advice are derived from the upstream v2 project:

- Repository: https://github.com/mcartmel/nodel-webui-v2
- Revision: `b4f9f03dd40ac4670d48efa749ae8d5ad96c2980`
- Source artifact: `v2/nodel-components.json` (schema 1, package version `0.2.0`)
- Contract SHA-256: `47ca302aea65ed7a47002b6c312f978471aa681f923c10878bc7b2782210d2a8`
- Starter SHA-256: `b401e1a972dad38d853343bdaea61f708eff624cb11a435220f6b8a12dd6f8ae`
- License: Mozilla Public License 2.0 (MPL-2.0)

These pinned reference assets are distributed in `src/nodel/v2/` and copied
into `dist/nodel/v2/` by the build. They are a drafting reference, not evidence
that a target deployment supports this contract. The complete MPL-2.0 text is
in [LICENSE](LICENSE); the exact revision and content hashes are recorded in
`src/nodel/v2/provenance.json` and checked during build.

The runtime HTML parser `parse5` is a separately version-pinned MIT-licensed
dependency; its lockfile-specific attribution is included in
`reports/dependency-licenses.json`.

## Runtime dependencies

The npm dependencies in `package-lock.json` are third-party works with their
own licenses. Release validation must generate a dependency license report
from the exact lockfile, review compatibility with MPL-2.0 distribution, and
include the resulting report or archive notice set with the release artifact.
This intent is documented here so dependency-license generation is a required
release step rather than an implicit assumption.

The generated lockfile-specific report is
`reports/dependency-licenses.json`; CI runs `npm run license:check` and the
release gate runs the high-severity production `npm audit` check.
