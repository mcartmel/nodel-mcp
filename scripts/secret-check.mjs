import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const files = [
  ...new Set(
    execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean),
  ),
];
const suspicious = /(AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA|EC|OPENSSH|PRIVATE) KEY-----|gh[pousr]_[A-Za-z0-9_]{20,})/u;
const findings = [];
for (const file of files) {
  if (file.startsWith("node_modules/") || file === "package-lock.json") continue;
  const content = await readFile(file, "utf8").catch(() => "");
  if (suspicious.test(content)) findings.push(file);
}
if (findings.length) {
  console.error(`Potential secret material found in: ${findings.join(", ")}`);
  process.exitCode = 1;
}
