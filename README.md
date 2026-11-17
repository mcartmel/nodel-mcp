# Nodel AI MCP Sidecar

Model Context Protocol sidecar for a local Nodel runtime. This release is an
independent unsupported preview (`v0.1.x`), is not affiliated with Museum Victoria,
and does **not** imply upstream endorsement.

The source and release repository is [`mcartmel/nodel-mcp`](https://github.com/mcartmel/nodel-mcp).
For compatibility, the v0.1 runtime, package, service, state paths, and release
artifacts remain named `nodel-ai`.

Clone the repository for development:

```sh
git clone https://github.com/mcartmel/nodel-mcp.git
```

Released archives and checksums are published on the [GitHub Releases](https://github.com/mcartmel/nodel-mcp/releases) page.

## Preview and Support Posture

- Supported shape: Linux + Node.js 22, with `systemd` as the supported service
  manager.
- Support status: unsupported public preview, no SLA, and no commitment to review
  issues or pull requests.
- Security posture: single-operator deployment patterns only (not multi-user,
  multi-tenant).
- Compatibility stance: pre-1.0 MCP/HTTP interface; patch releases should avoid
  intentional breaking changes, while minor releases may break with notes.
- Nodel baseline: 2.2.1.542 is the validated baseline compatibility target; other
  versions are best effort until listed in the compatibility matrix.

## Quick Start (Read-Only by Default)

The v0.1 release path is a versioned GitHub Release archive. Extract it and run
the precompiled application without a build. Before starting, choose the Nodel
runtime to connect to and whether this sidecar should expose write tools.

1. Extract `nodel-ai-v<version>.tar.gz` and enter its directory.
2. Install production dependencies:

   ```sh
   npm ci --omit=dev
   ```

3. Copy the example environment:

   ```sh
   cp .env.example .env
   ```

4. Set the primary Nodel runtime in `.env`.

   If Nodel and this sidecar run on the same host, keep the default:

   ```env
   NODEL_BASE_URL=http://127.0.0.1:8085
   ```

   If Nodel runs on another trusted host, replace it with that host's reachable
   REST base URL, for example:

   ```env
   NODEL_BASE_URL=http://nodel-host.example.internal:8085
   ```

   `127.0.0.1` always means the sidecar's own network namespace. When running
   the sidecar in a container or on another machine, use an address it can
   actually reach. Do not point `NODEL_BASE_URL` at an untrusted service or
   expose Nodel's REST port directly to an untrusted network.

5. Choose an access mode in `.env`.

   No changes are required for read-only operation. To enable parameter,
   binding, recipe/file, and action writes while retaining short-lived operator
   approvals, set:

   ```env
   NODEL_ENABLE_WRITES=true
   NODEL_REQUIRE_WRITE_APPROVAL=true
   ```

   Create and restart operations require one additional gate:

   ```env
   NODEL_ENABLE_NODE_LIFECYCLE=true
   ```

   Deletion is a separate, cumulative opt-in and requires all three gates:

   ```env
   NODEL_ENABLE_WRITES=true
   NODEL_ENABLE_NODE_LIFECYCLE=true
   NODEL_ENABLE_DELETES=true
   NODEL_REQUIRE_WRITE_APPROVAL=true
   ```

   Keep `NODEL_REQUIRE_WRITE_APPROVAL=true` for normal operation. Approval IDs
   are workflow controls, not authentication; keep the MCP listener loopback-only
   or configure the token and reverse-proxy protections described below.

6. Start the service:

   ```sh
   node dist/index.js
   ```

7. Confirm sidecar liveness and connectivity to the configured Nodel runtime:

   ```sh
   curl -s http://127.0.0.1:8765/healthz
   curl -s http://127.0.0.1:8765/readyz
   ```

   `/healthz` confirms that the sidecar is running. `/readyz` confirms that it
   can reach `NODEL_BASE_URL`. Add the configured bearer token when
   `NODEL_MCP_TOKEN` is set.

For non-loopback access, use the tested Caddy renderer documented in
[`docs/operations.md`](docs/operations.md). Caddy is never bundled or
auto-installed; keep the out-of-band token in a `0600` `.env`.

**Host warning:** this host currently exposes plaintext/basic-auth `8080` and
unauthenticated `8085`. The host is not secure until those listeners are
firewalled or rebound; the renderer only warns.

The service is read-only by default. Write, lifecycle, and delete capabilities
are enabled independently and cumulatively through the gates above.

Release downloads also include `SHA256SUMS`, `SBOM.cdx.json`,
`dependency-licenses.json`, and `ARTIFACT-MANIFEST.json`. These files are both
inside the archive and attached as separate draft-release assets; checksums cover
all of them except `SHA256SUMS` itself.

## Required and Optional Environment

| Variable                        | Default                 | Purpose                                                                                                            |
| ------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `NODEL_BASE_URL`                | `http://127.0.0.1:8085` | Primary trusted Nodel REST base URL; defaults to Nodel in the sidecar's host/network namespace                     |
| `MCP_BIND_ADDRESS`              | `127.0.0.1`             | Listener bind address                                                                                              |
| `MCP_PORT`                      | `8765`                  | Listener port                                                                                                      |
| `NODEL_MCP_TOKEN`               | unset                   | Inbound bearer token for `/mcp` and `/readyz`                                                                      |
| `MCP_ALLOWED_ORIGINS`           | unset                   | Exact allowed browser Origins for HTTP requests                                                                    |
| `NODEL_ALLOWED_RUNTIME_ORIGINS` | unset                   | Exact allowed runtime origins for explicit `runtimeUrl` operations. The `NODEL_BASE_URL` origin is always allowed. |
| `NODEL_STATE_DIR`               | `.state`                | Persistent approval/audit/backup state                                                                             |
| `NODEL_ENABLE_WRITES`           | `false`                 | Enable maintenance writes/actions                                                                                  |
| `NODEL_ENABLE_NODE_LIFECYCLE`   | `false`                 | Enable `create_node`/`restart_node` when writes are enabled                                                        |
| `NODEL_ENABLE_DELETES`          | `false`                 | Enable `delete_node` with lifecycle + writes                                                                       |
| `NODEL_REQUIRE_WRITE_APPROVAL`  | `true`                  | Require workflow approval ids for writes                                                                           |

Set additional request/retention limits as needed:

- `MCP_REQUEST_BODY_LIMIT_BYTES` (default: 1048576)
- `NODEL_AUDIT_MAX_BYTES` (default: 10485760)
- `NODEL_AUDIT_RETENTION_FILES` (default: 5)
- `NODEL_BACKUP_RETENTION_DAYS` (default: 30)
- `NODEL_BACKUP_RETENTION_PER_NODE_KIND` (default: 50)

## Access Modes Reference

### Read-only

```sh
NODEL_ENABLE_WRITES=false
NODEL_ENABLE_NODE_LIFECYCLE=false
NODEL_ENABLE_DELETES=false
NODEL_REQUIRE_WRITE_APPROVAL=true
```

### Writes and actions

```sh
NODEL_ENABLE_WRITES=true
NODEL_ENABLE_NODE_LIFECYCLE=false
NODEL_ENABLE_DELETES=false
NODEL_REQUIRE_WRITE_APPROVAL=true
```

### Writes plus create/restart

```sh
NODEL_ENABLE_WRITES=true
NODEL_ENABLE_NODE_LIFECYCLE=true
NODEL_ENABLE_DELETES=false
NODEL_REQUIRE_WRITE_APPROVAL=true
```

### Delete mode

```sh
# Writes + lifecycle + deletes + approval must all be enabled for delete mode
NODEL_ENABLE_WRITES=true
NODEL_ENABLE_NODE_LIFECYCLE=true
NODEL_ENABLE_DELETES=true
NODEL_REQUIRE_WRITE_APPROVAL=true
```

Writes remain experimental and require operator workflow discipline.

## Trusted Network Access Model

- Loopback use (`127.0.0.1`) is the direct mode. For any non-loopback bind,
  configure a high-entropy `NODEL_MCP_TOKEN` and set a strict
  `MCP_ALLOWED_ORIGINS` allowlist.
- The sidecar rejects arbitrary caller-supplied hostnames and only contacts
  configured/local-discovered endpoints.
- Use a reverse proxy for transport hardening where needed; this component does
  not provide TLS termination.

If `NODEL_MCP_TOKEN` is present, send this header on MCP requests:

```http
Authorization: Bearer <NODEL_MCP_TOKEN>
```

### MCP endpoint behavior

- `GET /healthz`: unauthenticated liveness with minimal fields (`ok`, `version`).
- `GET /readyz`: protected Nodel readiness probe.
- `POST /mcp`: MCP Streamable HTTP endpoint behind token/origin policies.

When a token is configured, unauthenticated `/mcp` and `/readyz` requests must
return `401`; `/healthz` is the unauthenticated `200` preflight.

## Approval and Write Flow

This project treats write approval as a human workflow control, not a security
boundary. Operational flow is:

1. `read/propose` or `dryRun`
2. Operator review and confirmation
3. `nodel.approve_write` as a fallback when MCP elicitation is unavailable
4. Apply tool with `approvalId`
5. Read-back / readiness verification based on tool capability

`nodel.request_write_approval` is the MCP-native path when supported by the
client and falls back to manual confirmation guidance when unsupported.

## Operations and Service Deployment

A release may be run directly (`node dist/index.js`) or under `systemd`.

### Recommended service layout

The system installer supports configurable paths:

- App directory: configurable (example `/opt/nodel-ai`)
- Env file: configurable (example `/etc/nodel-ai.env`)
- State directory: configurable (example `/var/lib/nodel-ai`)

The user and system installers render units with configurable paths and service
account. User defaults use the extracted directory, `.env`, and `.state`; system
defaults use `/opt/nodel-ai`, `/etc/nodel-ai.env`, and `/var/lib/nodel-ai`.

- `scripts/install-systemd-user.sh`
- `scripts/install-systemd-system.sh`

For service guidance and recovery steps (backups, log interpretation, upgrade,
rollback, health/readiness, and turning writes back off), see
[`docs/operations.md`](docs/operations.md).

## Tools

The README no longer maintains a manual tool list. Use the generated
reference to avoid drift:

- [`docs/tool-reference.generated.md`](docs/tool-reference.generated.md)

The list is generated from canonical tool definitions and includes capability,
stability, and gate information.

### Advisory v1/v2 UI authoring

No-argument UI guidance/reference calls remain local v1 XML reads. Use
`format=v2` for HTML custom-element guidance (offline bundled reference without a
node), or `format=auto,node=...,path=...` to inspect an existing page without
migrating it. Auto selection preserves a completely recognized saved format,
independently of host support. Mixed/incomplete recognition and uncertain support
return options instead of guessing. A new HTML path returning HTTP 404 is
conditional absence evidence, not permission to create or replace a page. XML
paths remain v1 paths even when missing; non-UI paths never become HTML starters.
Explicit v2 guidance/reference calls do not read a saved page for recognition.

Each node-aware guidance/reference operation pins one trusted target and one
capability observation. Resolve, bounded file reads and capability probes share a
10-second absolute deadline, respecting lower configured request timeouts and
cancelling pending HTTP reads. `refresh=true` re-resolves and refreshes that one
observation. Available contract/entry assets do not prove full runtime deployment
or browser operation. Unsupported/malformed/inaccessible contracts use a pinned
bundled reference with `contractSource=bundled`, `deploymentApplicable=false` and
unverified compatibility; starter provenance is separate from a live contract.
The offline pin is `nodel-webui-v2` revision
`b4f9f03dd40ac4670d48efa749ae8d5ad96c2980` (contract SHA-256
`47ca302aea65ed7a47002b6c312f978471aa681f923c10878bc7b2782210d2a8`);
attribution, MPL-2.0 terms and starter hash are in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

V2 component references return a recommended custom-component **index only** by
default. Pass up to 20 unique component names for focused details and one shared
common-attribute page. `includeCore=true` exposes advanced core entries; hidden,
non-catalogue and internal hosts are not ordinary recommendations (exact names
remain available with internal-host warnings). Responses project supported
fields recursively, ignore unknown additive metadata and cap serialized MCP text
at 64 KiB, including styles and metadata. Truncation is explicit. Use
`indexOffset/indexLimit`, `stylesOffset/stylesLimit`,
`attributesOffset/attributesLimit`, `commonOffset/commonLimit` and
`detailsOffset/detailsLimit` to page; `limit`/`returned` reflect actual returned
items, `requestedLimit` records the request and `nextOffset` advances by returned
items. Oversized component overviews retain the component identity and return
`field_selection_required` instead of an empty, non-advancing detail page.

Use the v2-only `field` selector for supported field details and complete tails:
`attributes`, `commonAttributes`, `attribute.values`, `commonAttribute.values`,
`actionBinding.phases`, `signalBinding.targets`, `signalTarget.aggregations`,
`event.detailFields`, composition children and aggregate signal targets. The
response lists all selectors, including component/style scalar fields. Select
one exact component; use `attributeName`, `bindingAttribute`, `targetName` or
`eventName` where applicable, then advance `fieldOffset/fieldLimit`. Every
supported string in field mode returns exact `text` segments with its own
`offset`, `returned`, `total`, `hasMore` and `nextOffset`; use
`textOffset/textLimit` (UTF-16 code units) to retrieve long descriptions, names,
syntax or source snippets without inserted ellipses. `field=components` can
recover full component names. Exact snippets are data, never executed. Each call
still obeys the aggregate 64 KiB budget; budget-limited pages advance or explicitly
direct the caller to a field selector. Unknown additive data is never returned.

Inspect the existing page → obtain matching guidance/reference → inspect node
actions/signals/schemas → propose or exact-edit → normal approval/save → verify
read-back hashes separately from advisory UI checks and isolated browser results.
Verifier calls with omitted format/path retain the legacy `content/index.xml`
default, including XML parse errors for malformed candidates, unless supplied
content positively identifies v2. Explicit `format=auto` is conservative for
unknown supplied content; an explicitly supplied canonical XML path still runs
XML validation. Explicit v2 and positively recognized v2 content use
`content/index.html`. Adding/replacing
a primary page can change navigation/default selection; do not delete XML or
change runtime defaults as part of authoring. UI advice never authorizes writes,
installs a runtime or establishes browser correctness.

The six existing supporting-file text/base64 proposal/save and exact-edit
proposal/apply tools accept `uiFeedback=auto|skip|v1|v2` (default `auto`). Recognized
UI candidates receive static advice for the **exact normalized candidate bytes**,
including `includeContent=false`, dry-run and no-change results. Original page
evidence retains recognition when edits remove the final v2 marker. Plain
unmarked HTML/XML and unrelated support files receive no extra UI envelope or
advisory requests. `skip` explicitly reports `not_run` for UI candidates without
advisory network reads; explicit v1/v2 selects analysis only, never conversion.

Automatic enrichment has a cancellable 3-second aggregate deadline and a default
200-issue output limit. Invalid UTF-8 or candidates over 2 MiB receive exact-hash
`not_run` advice without changing their bytes. Saves attach advice **after** the
normal mutation/read-back sequence and lock release; advisory errors, policy
failures or unavailable evidence cannot undo a successful save. Mutation status,
audit operation ID and byte verification remain separate. Selections, live
evidence and advisory provenance never enter approval hashes; normal write,
approval, expected-hash and path gates remain enforced. `verify_write_plan`
summarizes supplied advice separately as unverified, not as authorization.

## MCP Client Configuration

Point MCP clients at `http://127.0.0.1:8765/mcp` for local testing.

### Minimal JSON config example

```json
{
  "mcp": {
    "nodel": {
      "type": "remote",
      "url": "http://127.0.0.1:8765/mcp"
    }
  }
}
```

Add bearer auth in the MCP client only when `NODEL_MCP_TOKEN` is configured.
Codex clients should use `bearer_token_env_var = "NODEL_MCP_TOKEN"`, never a
literal token in client configuration.

## Documentation

- [`docs/architecture.md`](docs/architecture.md): trust boundaries and contract
  model
- [`docs/security-model.md`](docs/security-model.md): security assumptions and
  failure model
- [`docs/operations.md`](docs/operations.md): operational runbooks
- [`docs/operations.md#trusted-reverse-proxy-tls-example-caddy`](docs/operations.md#trusted-reverse-proxy-tls-example-caddy): tested Caddy renderer and rollout workflow
- [`docs/migration-v0.1.md`](docs/migration-v0.1.md): migration from an earlier local build
  to `v0.1.x`
- [`docs/releasing.md`](docs/releasing.md): maintainer release procedure
- [`SUPPORT.md`](SUPPORT.md), [`SECURITY.md`](SECURITY.md),
  [`CHANGELOG.md`](CHANGELOG.md),
  [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)

## Compatibility and Compatibility Notes

Before `1.0.0`, patch releases should avoid intentional breaking changes.
Before enabling writes, complete the migration checklist in
[`docs/migration-v0.1.md`](docs/migration-v0.1.md).
