export function releaseMode(relativePath, directory) {
  if (directory) return 0o755;
  if (
    relativePath === "scripts/install-systemd-user.sh" ||
    relativePath === "scripts/install-systemd-system.sh" ||
    relativePath === "scripts/caddy-render.mjs" ||
    relativePath === "scripts/caddy-check.mjs"
  )
    return 0o755;
  return 0o644;
}
