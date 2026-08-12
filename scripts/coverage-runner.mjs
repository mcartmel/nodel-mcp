import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";

const c8Args = [
  "--reporter=text",
  "--reporter=json",
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
const mjs = testFiles.filter((file) => file.endsWith(".mjs")).map((file) => `test/${file}`);
const ts = testFiles.filter((file) => file.endsWith(".ts")).map((file) => `test/${file}`);

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("node_modules/.bin/c8", args, { stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`coverage subprocess exited ${code}`))));
  });
}

await run([...c8Args, "node", "--test", ...mjs]);
await run([...c8Args, "--clean=false", "tsx", "--test", ...ts]);
await import("./check-coverage.mjs");
