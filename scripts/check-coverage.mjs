import { readFile } from "node:fs/promises";

const report = JSON.parse(await readFile("coverage/coverage-final.json", "utf8"));
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
  return Object.entries(report).find(([file]) => file.endsWith(suffix))?.[1];
}

const failures = [];
for (const [metric, threshold] of Object.entries(globalTargets)) {
  const key = metric[0] === "l" ? "l" : metric[0] === "s" ? "s" : metric[0] === "b" ? "b" : "f";
  const counts = Object.values(report).reduce(
    (total, entry) => {
      const values = entry[key] ? Object.values(entry[key]) : [];
      return {
        covered: total.covered + values.filter((count) => count > 0).length,
        total: total.total + values.length,
      };
    },
    { covered: 0, total: 0 },
  );
  const percent = counts.total === 0 ? 100 : (counts.covered / counts.total) * 100;
  if (percent < threshold) failures.push(`global ${metric}: ${percent.toFixed(1)}%, required ${threshold}%`);
}
for (const [file, threshold] of branchTargets) {
  const entry = entryFor(file);
  if (!entry) {
    failures.push(`${file}: not measured`);
    continue;
  }
  const branches = Object.values(entry.b);
  const covered = branches.filter((count) => count > 0).length;
  const percent = branches.length === 0 ? 100 : (covered / branches.length) * 100;
  if (percent < threshold) failures.push(`${file}: ${percent.toFixed(1)}% branches, required ${threshold}%`);
}

if (failures.length > 0) {
  console.error("Targeted branch coverage regression:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
}
