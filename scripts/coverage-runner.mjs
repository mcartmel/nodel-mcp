import { readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { assertCanonicalCoverage } from "./coverage-loader.mjs";

const c8Args = [
  "--reporter=text",
  "--reporter=json",
  "--temp-directory=coverage/tmp",
  "--all",
  "--exclude-after-remap",
  "--exclude",
  "dist/**",
  "--exclude",
  "scripts/**",
  "--exclude",
  "test/**",
  "--exclude",
  "src/**/*.d.ts",
  "--exclude",
  "src/nodel/v1UiCatalog.ts",
  "--exclude",
  "src/nodel/v1UiCatalog/**",
  "--exclude",
  "src/nodel/uiGuidelines.ts",
  "--exclude",
  "src/nodel/guidelines.ts",
];

const testFiles = (await readdir("test")).filter((file) => file.endsWith(".test.mjs") || file.endsWith(".test.ts"));

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("node_modules/.bin/c8", args, { stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`coverage subprocess exited ${code}`))));
  });
}

// Every test worker uses the same loader stack and the same dist module URLs.
// Merging tsc and tsx output for src/*.ts combines incompatible V8 offsets and
// can invent branch/function hits even when the TS suite merely imports a file.
await run([
  ...c8Args,
  process.execPath,
  "--import",
  "./scripts/coverage-register.mjs",
  "--test",
  ...testFiles.map((file) => `test/${file}`),
]);
for (const file of await readdir("coverage/tmp")) {
  if (!file.endsWith(".json")) continue;
  const raw = JSON.parse(await readFile(`coverage/tmp/${file}`, "utf8"));
  if (raw.result) assertCanonicalCoverage(raw.result);
}
await import("./check-coverage.mjs");
