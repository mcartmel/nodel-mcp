import { readFile, writeFile } from "node:fs/promises";

function unitValue(value) {
  return String(value).replace(/[\\\s#;&"%]/gu, (character) => {
    if (character === "%") return "%%";
    return `\\x${character.codePointAt(0).toString(16).padStart(2, "0")}`;
  });
}

export function renderUnit(template, values) {
  return template.replace(/__([A-Z_]+)__/gu, (_, name) => {
    if (!(name in values)) throw new Error(`Missing systemd template value: ${name}`);
    return unitValue(values[name]);
  });
}

if (process.argv[1]?.endsWith("systemd-render.mjs")) {
  const [templatePath, outputPath, ...entries] = process.argv.slice(2);
  if (!templatePath || !outputPath) {
    console.error("Usage: systemd-render.mjs TEMPLATE OUTPUT KEY=VALUE ...");
    process.exit(2);
  }
  const values = Object.fromEntries(
    entries.map((entry) => {
      const index = entry.indexOf("=");
      if (index < 1) throw new Error(`Invalid renderer argument: ${entry}`);
      return [entry.slice(0, index), entry.slice(index + 1)];
    }),
  );
  await writeFile(outputPath, renderUnit(await readFile(templatePath, "utf8"), values), { mode: 0o644 });
}
