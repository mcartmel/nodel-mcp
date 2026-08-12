import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";

const files = [
  ...new Set(
    execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean),
  ),
];
const publicFiles = files
  .filter((file) => !/(?:^|\/)(?:\.kilo|\.state|node_modules|dist|coverage|artifacts)(?:\/|$)/u.test(file))
  .filter((file) => /(?:^|\/)(?:.*\.md|\.env\.example|.*\.json|.*\.yml|.*\.yaml)$/u.test(file));
const errors = [];
const privateRepository =
  /(?:https?:\/\/(?:www\.)?github\.com\/mcartmel\/nodel-ai(?:[/.#?]|$)|git@github\.com:mcartmel\/nodel-ai(?:\.git)?(?:$|[/:])|git\+ssh:\/\/git@github\.com\/mcartmel\/nodel-ai(?:\.git)?(?:$|[/:]))/iu;
const privateHistory =
  /(?:private[-\s]+(?:builds?|formats?|repository|repo|history|source)|private\/main|private commit|source-private)/iu;
const markdownLink = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu;
for (const file of publicFiles.filter((item) => item.endsWith(".md"))) {
  const content = await readFile(file, "utf8");
  if (content.includes("/home/nodel")) errors.push(`${file}: host-specific /home/nodel path`);
  if (privateRepository.test(content)) errors.push(`${file}: private repository link`);
  if (privateHistory.test(content)) errors.push(`${file}: private source-history reference`);
  for (const match of content.matchAll(markdownLink)) {
    const target = match[1].split("#", 1)[0];
    if (!target || /^(?:https?:|mailto:|#)/u.test(target)) continue;
    const path = resolve(dirname(file), target);
    try {
      await readFile(path);
    } catch {
      errors.push(`${file}: broken relative link ${target}`);
    }
  }
}
for (const file of publicFiles.filter((item) => !item.endsWith(".md"))) {
  const content = await readFile(file, "utf8");
  if (content.includes("/home/nodel") && file !== "systemd/nodel-ai.service")
    errors.push(`${file}: host-specific /home/nodel path`);
  if (privateRepository.test(content)) errors.push(`${file}: private repository link`);
  if (privateHistory.test(content)) errors.push(`${file}: private source-history reference`);
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`Documentation links and public paths checked (${publicFiles.length} candidate files).`);
