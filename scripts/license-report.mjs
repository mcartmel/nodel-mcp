import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { validateProductionLicenses } from "./license-policy.mjs";

export const outputPath = "reports/dependency-licenses.json";
export const reviewedExceptions = [];

const lockfile = await readFile("package-lock.json");
const lockfileSha256 = createHash("sha256").update(lockfile).digest("hex");

const raw = await new Promise((resolve, reject) => {
  const child = spawn("node_modules/.bin/license-checker", ["--production", "--json", "--start", "."]);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.on("error", reject);
  child.on("close", (code) =>
    code === 0 ? resolve(stdout) : reject(new Error(stderr || `license-checker exited ${code}`)),
  );
});

const dependencies = JSON.parse(raw);
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const sanitizedDependencies = Object.fromEntries(
  Object.entries(dependencies).map(([name, details]) => {
    const { path: _path, licenseFile: _licenseFile, ...safeDetails } = details;
    return [name, safeDetails];
  }),
);
for (const name of Object.keys(sanitizedDependencies)) {
  if (name === "." || name.startsWith(`${packageJson.name}@`)) delete sanitizedDependencies[name];
}
validateProductionLicenses(sanitizedDependencies, reviewedExceptions);
const report = {
  generatedFrom: "package-lock.json",
  lockfileSha256,
  project: { name: packageJson.name, version: packageJson.version, license: "MPL-2.0" },
  dependencies: Object.fromEntries(Object.entries(sanitizedDependencies).sort(([a], [b]) => a.localeCompare(b))),
};
const content = `${JSON.stringify(report, null, 2)}\n`;
await mkdir("reports", { recursive: true });
if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  if (current !== content) {
    console.error(`Dependency license report is stale. Run npm run license:report (${outputPath}).`);
    process.exitCode = 1;
  }
} else {
  await writeFile(outputPath, content);
}
