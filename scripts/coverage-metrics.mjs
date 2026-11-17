function counts(values) {
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
    throw new Error("Invalid coverage hit count");
  }
  return { covered: values.filter((value) => value > 0).length, total: values.length };
}

export function fileMetrics(entry) {
  if (!entry.s || !entry.statementMap || !entry.b || !entry.f) {
    throw new Error("Incomplete Istanbul coverage entry");
  }
  // Istanbul derives line coverage from statement start lines. Several
  // statements on one line count as one line, hit if any statement is hit.
  // c8's coverage-final.json normally has no `l` property at all.
  const lines = new Map();
  for (const [id, hits] of Object.entries(entry.s)) {
    const line = entry.statementMap[id]?.start.line;
    if (!Number.isInteger(line) || line < 1) throw new Error(`Missing statement location: ${id}`);
    counts([hits]);
    lines.set(line, Math.max(lines.get(line) ?? 0, hits));
  }
  const branches = Object.values(entry.b);
  if (branches.some((branch) => !Array.isArray(branch))) throw new Error("Invalid Istanbul branch counts");
  return {
    lines: counts([...lines.values()]),
    statements: counts(Object.values(entry.s)),
    branches: counts(branches.flat()),
    functions: counts(Object.values(entry.f)),
  };
}

export function reportMetrics(report) {
  const totals = Object.fromEntries(
    ["lines", "statements", "branches", "functions"].map((metric) => [metric, { covered: 0, total: 0 }]),
  );
  for (const entry of Object.values(report)) {
    for (const [metric, value] of Object.entries(fileMetrics(entry))) {
      totals[metric].covered += value.covered;
      totals[metric].total += value.total;
    }
  }
  return totals;
}

export function percentage({ covered, total }) {
  return total === 0 ? 100 : (covered / total) * 100;
}
