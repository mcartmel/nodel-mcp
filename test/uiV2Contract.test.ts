import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  decodeV2Contract,
  getV2Component,
  listV2Components,
  PINNED_V2_CONTRACT,
  PINNED_V2_PROVENANCE,
  selectV2Contract,
} from "../src/domain/ui/v2/contract.js";
import { V2_GUIDANCE, V2_QUICKSTART_STARTER } from "../src/nodel/v2/guidance.js";

const sample = () => structuredClone(PINNED_V2_CONTRACT);

void test("pinned contract has provenance and decodes from unknown", async () => {
  assert.equal(decodeV2Contract(sample()).ok, true);
  assert.match(String(PINNED_V2_PROVENANCE.sha256), /^[a-f0-9]{64}$/);
  assert.equal(PINNED_V2_PROVENANCE.revision, "b4f9f03dd40ac4670d48efa749ae8d5ad96c2980");
  assert.ok(Object.isFrozen(PINNED_V2_CONTRACT));
  assert.ok(Object.isFrozen(PINNED_V2_CONTRACT.elements));
  assert.ok(Object.isFrozen(PINNED_V2_CONTRACT.elements[0].attributes[0]));
  assert.ok(Object.isFrozen(PINNED_V2_PROVENANCE));
});

void test("schema-1 consumer tolerates additive fields while rejecting unsupported schemas and known semantics", async () => {
  const value = sample() as typeof PINNED_V2_CONTRACT & { additive?: { nested: boolean } };
  value.additive = { nested: true };
  (value.elements[0] as unknown as Record<string, unknown>).newProducerField = "ignored";
  assert.equal(decodeV2Contract(value).ok, true);
  assert.equal(decodeV2Contract({ ...value, schemaVersion: 2 }).ok, false);
  const bad = sample();
  bad.elements[0].audience = "magical" as never;
  assert.match(decodeV2Contract(bad).errors.join(" "), /unsupported audience/);
});

void test("validates duplicate names, numeric constraints, binding references, safe map keys and composition references", async () => {
  const duplicates = sample();
  duplicates.elements.push(duplicates.elements[0]);
  assert.match(decodeV2Contract(duplicates).errors.join(" "), /duplicate name/);
  const numeric = sample();
  numeric.commonAttributes[0].numeric = { min: 10, max: 1 };
  assert.match(decodeV2Contract(numeric).errors.join(" "), /minimum exceeds maximum/);
  const exclusiveRange = sample();
  const numericAttribute = exclusiveRange.elements
    .flatMap(({ attributes }) => attributes)
    .find(({ numeric }) => numeric !== undefined);
  assert.ok(numericAttribute);
  numericAttribute.numeric = { min: 1, max: 1, exclusiveMin: true };
  assert.match(decodeV2Contract(exclusiveRange).errors.join(" "), /exclusive minimum cannot equal maximum/);
  const missingMetadata = sample();
  delete (missingMetadata.commonAttributes[0] as { valueType?: string }).valueType;
  assert.match(decodeV2Contract(missingMetadata).errors.join(" "), /valueType: expected non-empty bounded string/);
  const invalidAggregation = sample();
  const signalOwner = invalidAggregation.elements.find(({ signalBindings }) => signalBindings.length > 0);
  assert.ok(signalOwner);
  signalOwner.signalBindings[0].targets[0].aggregations = ["potato"];
  assert.match(decodeV2Contract(invalidAggregation).errors.join(" "), /aggregation must be any or all/);
  const invalidDefaultTarget = sample();
  const targetOwner = invalidDefaultTarget.elements.find(({ signalBindings }) => signalBindings.length > 0);
  assert.ok(targetOwner);
  targetOwner.signalBindings[0].defaultTarget = "missing";
  assert.match(decodeV2Contract(invalidDefaultTarget).errors.join(" "), /undefined signal target/);
  const invalidAutoHost = sample();
  const autoHost = invalidAutoHost.elements.find(({ registration }) => registration === "auto-host");
  assert.ok(autoHost);
  autoHost.audience = "custom";
  autoHost.completion = "recommended";
  assert.match(decodeV2Contract(invalidAutoHost).errors.join(" "), /auto-host elements must be internal, hidden/);
  const reference = sample();
  const actionOwner = reference.elements.find(({ actionBindings }) => actionBindings.length > 0);
  assert.ok(actionOwner);
  actionOwner.actionBindings[0].attribute = "made-up";
  assert.match(decodeV2Contract(reference).errors.join(" "), /undefined attribute/);
  assert.match(
    decodeV2Contract(
      JSON.parse(
        '{"schemaVersion":1,"packageVersion":"1","commonAttributes":[],"elements":[],"styles":{"semanticClasses":[],"stateClasses":[],"tailwindUtilities":[]},"constructor":{}}',
      ),
    ).errors.join(" "),
    /unsafe object key/,
  );
});

void test("deployed contract is selected as one authority; fallback retains failure and stays unverified", async () => {
  const old = sample();
  old.elements = old.elements.filter(({ name }) => name !== "nodel-fader");
  const chosen = selectV2Contract(old, "asset unavailable");
  assert.equal(chosen.kind, "deployed");
  assert.equal(getV2Component("nodel-fader", chosen.contract), undefined);
  const fallback = selectV2Contract(undefined, "401 from contract endpoint");
  assert.equal(fallback.kind, "bundled");
  assert.equal(fallback.compatibility, "unverified");
  assert.match(fallback.detectionFailure, /401/);
  assert.ok(getV2Component("nodel-fader", fallback.contract));
  assert.ok(Object.isFrozen(fallback.contract));
});

void test("reference index defaults to recommended custom components, bounds and pages results", async () => {
  const page = listV2Components(PINNED_V2_CONTRACT, { limit: 2 });
  assert.equal(page.components.length, 2);
  assert.ok(page.hasMore);
  assert.ok(page.components.every((item) => item.completion === "recommended" && item.audience !== "internal"));
  assert.ok(
    listV2Components(undefined, { completion: "advanced", audience: "all", limit: 100 }).components.some(
      (item) => item.completion === "advanced",
    ),
  );
  const internal = listV2Components(undefined, { audience: "internal", completion: "all" }).components;
  assert.ok(internal.length > 0);
  assert.ok(internal.every((item) => item.audience === "internal"));
  assert.ok(internal.some(({ name }) => name === "nodel-toast-host"));
  const everything = listV2Components(undefined, { audience: "all", completion: "all", limit: 100 });
  assert.equal(everything.total, PINNED_V2_CONTRACT.elements.length);
  assert.ok(everything.components.some(({ completion }) => completion === "advanced"));
  assert.equal(listV2Components(undefined, { offset: 0, limit: 10000 }).limit, 100);
});

void test("starter and guidance use safe stable entry references and identify primary-page impact", async () => {
  assert.ok(
    V2_QUICKSTART_STARTER.indexOf("./v2/nodel-webui.css") < V2_QUICKSTART_STARTER.indexOf("./v2/nodel-webui.js"),
  );
  assert.match(V2_QUICKSTART_STARTER, /theme="dark"/);
  assert.doesNotMatch(V2_QUICKSTART_STARTER, /\/src\/|data-nodel-runtime="memory"|catalogue/i);
  assert.ok(V2_GUIDANCE.workflow.some((item) => item.includes("default selection")));
  const originalLimitationsLength = V2_GUIDANCE.limitations.length;
  assert.ok(Object.isFrozen(V2_GUIDANCE.limitations));
  assert.throws(() => {
    V2_GUIDANCE.limitations.length = 0;
  }, TypeError);
  assert.equal(V2_GUIDANCE.limitations.length, originalLimitationsLength);
  const provenanceFile = await readFile(new URL("../src/nodel/v2/provenance.json", import.meta.url), "utf8");
  assert.equal(
    (JSON.parse(provenanceFile) as { sha256: string }).sha256,
    String((PINNED_V2_PROVENANCE as { sha256: string }).sha256),
  );
  const [packagedContract, packagedProvenance] = await Promise.all([
    readFile(new URL("../dist/nodel/v2/contract.json", import.meta.url)),
    readFile(new URL("../dist/nodel/v2/provenance.json", import.meta.url), "utf8"),
  ]);
  const packaged = JSON.parse(packagedProvenance) as { contentHash: string; sha256: string };
  const packagedHash = createHash("sha256").update(packagedContract).digest("hex");
  assert.equal(packagedHash, packaged.contentHash);
  assert.equal(packagedHash, packaged.sha256);
});
