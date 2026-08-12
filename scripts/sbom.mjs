export function packageNameFromLockPath(path) {
  const marker = "/node_modules/";
  const index = path.lastIndexOf(marker);
  const name = index < 0 ? path.replace(/^node_modules\//u, "") : path.slice(index + marker.length);
  return name;
}

export function npmPurl(name, version) {
  const encodedVersion = encodeURIComponent(version);
  if (name.startsWith("@")) {
    const slash = name.indexOf("/");
    return `pkg:npm/${encodeURIComponent(name.slice(0, slash))}/${encodeURIComponent(name.slice(slash + 1))}@${encodedVersion}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodedVersion}`;
}

export function cyclonedxComponents(packages) {
  const components = new Map();
  for (const [path, value] of Object.entries(packages)) {
    if (path === "" || !value?.version || value.dev) continue;
    const name = packageNameFromLockPath(path);
    const purl = npmPurl(name, value.version);
    if (!components.has(purl)) {
      components.set(purl, {
        type: "library",
        name,
        version: value.version,
        purl,
        licenses: value.license
          ? [
              {
                license: /^[A-Za-z][A-Za-z0-9.+-]*$/u.test(value.license)
                  ? { id: value.license }
                  : { name: value.license },
              },
            ]
          : [],
      });
    }
  }
  return [...components.values()].sort((a, b) => a.purl.localeCompare(b.purl));
}
