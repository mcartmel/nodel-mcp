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

## Read-Only Quick Start (Intended Release Path)

The v0.1 release path is a versioned GitHub Release archive. Extract it and run
the precompiled application without a build:

1. Extract `nodel-ai-v<version>.tar.gz` and enter its directory.
2. Install production dependencies:

   ```sh
   npm ci --omit=dev
   ```

3. Copy the example environment and keep write tools disabled by default:

   ```sh
   cp .env.example .env
   ```

4. Start the service:

   ```sh
   node dist/index.js
   ```

5. Confirm liveness:

   ```sh
   curl -s http://127.0.0.1:8765/healthz
   ```

For non-loopback access, use the tested Caddy renderer documented in
[`docs/operations.md`](docs/operations.md). Caddy is never bundled or
auto-installed; keep the out-of-band token in a `0600` `.env`.

**Host warning:** this host currently exposes plaintext/basic-auth `8080` and
unauthenticated `8085`. The host is not secure until those listeners are
firewalled or rebound; the renderer only warns.

The service is read-only by default. No write, lifecycle, or delete operations are
enabled until you explicitly enable them in `.env`.

Release downloads also include `SHA256SUMS`, `SBOM.cdx.json`,
`dependency-licenses.json`, and `ARTIFACT-MANIFEST.json`. These files are both
inside the archive and attached as separate draft-release assets; checksums cover
all of them except `SHA256SUMS` itself.

## Required and Optional Environment

| Variable                        | Default                 | Purpose                                                                                                            |
| ------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `NODEL_BASE_URL`                | `http://127.0.0.1:8085` | Local Nodel REST base URL                                                                                          |
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

## Minimal Installation Modes

### Read-only

```sh
NODEL_ENABLE_WRITES=false
NODEL_ENABLE_NODE_LIFECYCLE=false
NODEL_ENABLE_DELETES=false
NODEL_REQUIRE_WRITE_APPROVAL=true
```

### Maintenance write mode

```sh
NODEL_ENABLE_WRITES=true
NODEL_ENABLE_NODE_LIFECYCLE=true
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
