import { readFile } from "node:fs/promises";
import { fileMetrics, percentage, reportMetrics } from "./coverage-metrics.mjs";

const report = JSON.parse(await readFile(process.argv[2] ?? "coverage/coverage-final.json", "utf8"));
const globalTargets = { lines: 80, statements: 80, branches: 78, functions: 85 };
const branchTargets = [
  ["src/config.ts", 80],
  ["src/nodel/client.ts", 70],
  ["src/nodel/resolution/resolver.ts", 70],
  ["src/state/approvals.ts", 75],
  ["src/state/store.ts", 70],
  ["src/domain/config/writes.ts", 70],
  ["src/domain/bindings/writes.ts", 60],
  ["src/domain/recipes/service.ts", 60],
  ["src/nodel/pathPolicy.ts", 80],
  ["src/mcp/server.ts", 70],
];

function entryFor(suffix) {
  return Object.entries(report).find(([file]) => file.endsWith(`/${suffix}`) || file === suffix)?.[1];
}

const failures = [];
const totals = reportMetrics(report);
for (const [metric, threshold] of Object.entries(globalTargets)) {
  if (totals[metric].total === 0) {
    failures.push(`global ${metric}: not measured`);
    continue;
  }
  const percent = percentage(totals[metric]);
  if (percent < threshold) failures.push(`global ${metric}: ${percent.toFixed(1)}%, required ${threshold}%`);
}
for (const [file, threshold] of branchTargets) {
  const entry = entryFor(file);
  if (!entry) {
    failures.push(`${file}: not measured`);
    continue;
  }
  const percent = percentage(fileMetrics(entry).branches);
  if (percent < threshold) failures.push(`${file}: ${percent.toFixed(1)}% branches, required ${threshold}%`);
}

if (failures.length > 0) {
  console.error("Targeted branch coverage regression:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
}
