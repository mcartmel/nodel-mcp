export const CADDY_TEMPLATE_PATH = "deploy/caddy/nodel-mcp.Caddyfile.in";
const CADDY_RELEASE_SCRIPTS = new Set(["scripts/caddy-render.mjs", "scripts/caddy-check.mjs"]);

function isGeneratedCaddyfile(basename) {
  const lowerCase = basename.toLowerCase();
  return (
    lowerCase === "caddyfile" ||
    (lowerCase.startsWith("caddyfile.") && lowerCase.length > "caddyfile.".length) ||
    (lowerCase.endsWith(".caddy") && lowerCase.length > ".caddy".length)
  );
}

export function isForbiddenCaddyReleaseMember(member) {
  const normalized = member.replaceAll("\\", "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return (
    /^(?:caddy(?:\.exe)?|caddy[-_][^/]+)$/iu.test(basename) ||
    /^caddy[^/]*\.(?:tar|tar\.gz|tgz|zip|deb|rpm)$/iu.test(basename) ||
    isGeneratedCaddyfile(basename) ||
    /\.(?:pem|key|crt|cer|der|p12|pfx|p7b|csr)$/iu.test(basename) ||
    /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|.*private.*)$/iu.test(basename)
  );
}

export function assertCaddyReleaseMembers(members, archiveRoot = "") {
  const prefix = archiveRoot ? `${archiveRoot}/` : "";
  const deployDirectory = `${prefix}deploy/caddy`;
  const expectedTemplate = `${prefix}${CADDY_TEMPLATE_PATH}`;
  for (const member of members) {
    const normalized = member.replaceAll("\\", "/");
    if (normalized.endsWith("/") || normalized === deployDirectory) continue;
    if (CADDY_RELEASE_SCRIPTS.has(normalized.replace(prefix, ""))) continue;
    if (normalized.startsWith(`${deployDirectory}/`) && normalized !== expectedTemplate)
      throw new Error(`Unexpected deploy/caddy release member: ${member}`);
    if (isForbiddenCaddyReleaseMember(normalized))
      throw new Error(`Forbidden Caddy executable, archive, configuration, or certificate artifact: ${member}`);
  }
}
