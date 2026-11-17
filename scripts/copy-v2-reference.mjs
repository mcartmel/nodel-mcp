#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "src/nodel/v2");
const output = resolve(root, "dist/nodel/v2");
const contract = await readFile(resolve(source, "contract.json"));
const starter = await readFile(resolve(source, "quickstart.json"));
const provenance = JSON.parse(await readFile(resolve(source, "provenance.json"), "utf8"));
const contractHash = createHash("sha256").update(contract).digest("hex");
const starterData = JSON.parse(starter.toString("utf8"));
if (provenance.sha256 !== contractHash || provenance.contentHash !== contractHash)
  throw new Error("Pinned contract bytes do not match source and packaged content hashes");
if (createHash("sha256").update(starterData).digest("hex") !== provenance.starterSha256)
  throw new Error("Pinned Quickstart bytes do not match source provenance");
await mkdir(output, { recursive: true });
await Promise.all([
  writeFile(resolve(output, "contract.json"), contract),
  writeFile(resolve(output, "quickstart.json"), starter),
  writeFile(resolve(output, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`),
]);
console.log(`Copied pinned v2 reference with verified sha256 ${contractHash}`);
