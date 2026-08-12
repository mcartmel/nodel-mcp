export function validateProductionLicenses(dependencies, exceptions = []) {
  const allowed = new Map(exceptions.map((exception) => [exception.package, exception]));
  const failures = Object.entries(dependencies).filter(([name, details]) => {
    const license = String(details.licenses ?? details.license ?? "")
      .trim()
      .toUpperCase();
    if (license && !["UNKNOWN", "UNLICENSED", "MISSING"].includes(license)) return false;
    const exception = allowed.get(name);
    return !exception?.advisory || !exception.rationale || !exception.owner || !exception.expiry;
  });
  if (failures.length)
    throw new Error(`Production dependency license review required: ${failures.map(([name]) => name).join(", ")}`);
}
