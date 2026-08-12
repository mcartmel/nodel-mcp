import { execFileSync, spawnSync } from "node:child_process";

const checks = [
  ["format:check"],
  ["lint"],
  ["typecheck"],
  ["test"],
  ["coverage"],
  ["docs:check"],
  ["public:check", "--", "--source-sha", execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()],
  ["license:check"],
  ["dependency:check"],
  ["shell:check"],
  ["caddy:check"],
  ["secret:check"],
  ["build"],
  ["release:determinism"],
  ["release:package"],
  ["release:smoke"],
];
for (const check of checks) {
  const [script, ...args] = check;
  const result = spawnSync("npm", ["run", script, ...args], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
