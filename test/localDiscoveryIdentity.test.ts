import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTestConfig } from "../src/config.js";
import { NodelClient } from "../src/nodel/client.js";
import { registerRecipeWriteTools } from "../src/mcp/tools/recipeWrites.js";
import { remoteNodeBaseUrl } from "../src/nodel/resolution/matching.js";
import { NodeResolutionInconclusiveError, NodeResolutionNotFoundError } from "../src/nodel/resolution/resolver.js";
import { deleteNode, verifyDeletedNode } from "../src/domain/recipes/service.js";

// Expected routes are independent fixtures from Java Nodel.reduce semantics:
// -- and // terminate, parenthetical comments resume, ASCII punctuation drops.
// The host decodes before splitting, then compares SimpleName case-insensitively.
const cases = [
  ["Allowed---Backup", "Allowed", "allowedbackup"],
  ["Allowed-//Backup", "Allowed", "allowedbackup"],
  ["Allowed-(note)Backup", "AllowedBackup", "allowed"],
  ["Allowed-/雪%25", "Allowed雪25", "allowed"],
  ["Allowed-(note)Backup", "AllowedBackup", "Allowed--other"],
] as const;

for (const [name, segment, neighbor] of cases) {
  void test(`local discovery routes authorized identity, not fuzzy alias: ${name}`, async () => {
    const requests: string[] = [];
    const lookups: string[] = [];
    const extraNodes: Record<string, { name: string }> = {};
    const neighborAllowed = neighbor.startsWith("Allowed-");
    const neighborRoute = neighborAllowed ? "allowed" : neighbor;
    const original = '<nodel-button action="AllowedAction">original</nodel-button>';
    const secret = '<nodel-button action="SecretAction">NEIGHBOR SECRET</nodel-button>';
    const http = createServer((request, response) => {
      const path = request.url!;
      requests.push(path);
      const send = (body: string, mime = "application/json", status = 200) => {
        response.writeHead(status, { "content-type": mime });
        response.end(body);
      };
      if (path === "/prefix/REST")
        return send(JSON.stringify({ nodes: { approved: { name }, neighbor: { name: neighbor }, ...extraNodes } }));
      // Independent host routing model for the already-reduced fixture routes.
      const parts = decodeURIComponent(path.split("?")[0]!).split("/");
      if (parts[2] !== "nodes") return send("[]", "application/json", 404);
      const key = parts[3]!.toLowerCase();
      lookups.push(key);
      const isAllowed = key === segment.toLowerCase();
      if (!isAllowed && key !== neighborRoute) return send("{}", "application/json", 404);
      const endpoint = parts.slice(4).join("/");
      if (endpoint === "REST/files/contents") return send(isAllowed ? original : secret, "text/html");
      if (endpoint === "REST/actions")
        return send(JSON.stringify({ [isAllowed ? "AllowedAction" : "SecretAction"]: {} }));
      if (endpoint === "REST/files") return send("[]");
      if (endpoint.startsWith("v2/")) return send("not installed", "text/plain", 404);
      return send("{}");
    });
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const address = http.address();
    assert(address && typeof address !== "string");
    const config = createTestConfig({
      nodelBaseUrl: `http://127.0.0.1:${address.port}/prefix`,
      allowedNodePrefixes: ["Allowed-"],
      nodelRequestTimeoutMs: 1000,
      writesEnabled: true,
      writeApprovalRequired: false,
    });
    const client = new NodelClient(config);
    const mcp = new McpServer({ name: "local-identity", version: "1" });
    registerRecipeWriteTools(mcp, client, config);
    const sdk = new Client({ name: "local-identity-client", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await mcp.connect(st);
    await sdk.connect(ct);
    try {
      if (!neighborAllowed) await assert.rejects(client.resolveNode(neighbor), { code: "POLICY" });
      assert.deepEqual(lookups, [], "denied display name must not issue a node request");
      const resolved = await client.resolveNode(name);
      assert.equal(resolved.name, name);
      assert.equal(resolved.restPathSegment, segment);
      assert.equal(resolved.nodeBaseUrl, `${config.nodelBaseUrl}/nodes/${encodeURIComponent(segment)}/`);
      const local = await client.listLocalNodes(true);
      assert.equal(local.length, neighborAllowed ? 2 : 1);
      assert.equal(local[0]!.url, `/nodes/${encodeURIComponent(segment)}`);

      const result = await sdk.callTool({
        name: "nodel.propose_node_file_edit",
        arguments: {
          node: name,
          path: "content/control.html",
          edits: [{ oldText: "original", newText: "edited" }],
          includeContent: true,
        },
      });
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      assert.notEqual(result.isError, true, text);
      const body = JSON.parse(text) as {
        proposedContent: string;
        currentHash: string;
        uiFeedback: { advisory: boolean };
      };
      assert.equal(body.proposedContent, original.replace("original", "edited"));
      assert.equal(body.uiFeedback.advisory, true);
      assert(!text.includes("NEIGHBOR SECRET"));
      assert(!text.includes("SecretAction"));
      const dryRun = await sdk.callTool({
        name: "nodel.apply_node_file_edit",
        arguments: {
          node: name,
          path: "content/control.html",
          edits: [{ oldText: "original", newText: "edited" }],
          expectedHash: body.currentHash,
          dryRun: true,
        },
      });
      assert.notEqual(dryRun.isError, true, JSON.stringify(dryRun));
      assert(
        requests.some((path) => path.includes("/v2/")),
        "advisory assets must exercise real routing",
      );
      assert(
        requests.some((path) => path.endsWith("/REST/actions")),
        "advisory points must exercise real routing",
      );
      assert(lookups.length > 1);
      assert(
        lookups.every((key) => key === segment.toLowerCase()),
        "no request may reach the denied neighbor",
      );
      assert(!requests.some((path) => path.includes("/save")), "proposal must remain read-only");
      if (neighborAllowed) {
        extraNodes.duplicate = { name };
        await assert.rejects(client.resolveNode(name), /ambiguous/u);
        delete extraNodes.duplicate;
        extraNodes.equivalent = { name: "Allowed-(different)Backup" };
        await assert.rejects(client.resolveNode("AllowedBackup"), /ambiguous/u);
      }
    } finally {
      await sdk.close();
      await mcp.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });
}

void test("remote discovery retains supplied routes; only missing route fallback reduces the display name", () => {
  assert.equal(
    remoteNodeBaseUrl({ name: "Allowed---Backup", address: "http://example.test/" }),
    "http://example.test/nodes/Allowed/",
  );
  assert.equal(
    remoteNodeBaseUrl({ name: "Allowed---Backup", address: "http://example.test/prefix/nodes/TrustedRoute/" }),
    "http://example.test/prefix/nodes/TrustedRoute/",
  );
});

void test("unrouteable unrelated discovery does not block valid identity or establish absence", async () => {
  const requests: string[] = [];
  const nodes: Record<string, { name: string }> = {
    valid: { name: "AllowedNode" },
    invalid: { name: "Forbidden \uD800" },
    AllowedKey: { name: "Allowed\uD800" },
    AllowedKEY: { name: "Allowed\uD800" },
    neighbor: { name: "AllowedKey-other" },
    allowedshadow: { name: "Forbidden\uD800" },
    shadow: { name: "AllowedShadow" },
  };
  const http = createServer((request, response) => {
    requests.push(request.url!);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/REST" ? { nodes } : []));
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  assert(address && typeof address !== "string");
  const config = createTestConfig({
    nodelBaseUrl: `http://127.0.0.1:${address.port}`,
    allowedNodePrefixes: ["Allowed"],
    writesEnabled: true,
    writeApprovalRequired: false,
    nodeLifecycleEnabled: true,
    deletesEnabled: true,
  });
  const client = new NodelClient(config);
  const mcp = new McpServer({ name: "rejected-identity", version: "1" });
  registerRecipeWriteTools(mcp, client, config);
  const sdk = new Client({ name: "rejected-identity-client", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await mcp.connect(st);
  await sdk.connect(ct);
  try {
    const resolved = await client.resolveNode("AllowedNode");
    assert.equal(resolved.restPathSegment, "AllowedNode");
    await client.getNodeActions(resolved);
    assert(requests.includes("/nodes/AllowedNode/REST/actions"));
    assert.equal((await client.resolveNode("valid")).name, "AllowedNode");
    requests.length = 0;
    for (const name of ["AllowedKey", "allowedkey", "AllowedKeyother", "AllowedShadow", "Allowed", "allowednode"]) {
      await assert.rejects(client.resolveNode(name), NodeResolutionInconclusiveError);
      await assert.rejects(client.resolveNodeForDeletion(name), NodeResolutionInconclusiveError);
      await assert.rejects(deleteNode(client, config, name, name, true), NodeResolutionInconclusiveError);
      for (const tool of ["propose_node_file_edit", "apply_node_file_edit"]) {
        const result = await sdk.callTool({
          name: `nodel.${tool}`,
          arguments: {
            node: name,
            path: "content/control.html",
            edits: [{ oldText: "original", newText: "edited" }],
            ...(tool === "apply_node_file_edit" ? { dryRun: true, expectedHash: "0".repeat(64) } : {}),
          },
        });
        assert.equal(result.isError, true);
        assert.match((result.content as Array<{ text: string }>)[0]!.text, /conclusively verified/u);
      }
    }
    assert(
      requests.every((path) => path === "/REST"),
      "no node, remote discovery or cache fallback is safe",
    );
    await assert.rejects(client.resolveNode("UnknownNode"), NodeResolutionInconclusiveError);
    await assert.rejects(client.resolveNodeForDeletion("UnknownNode"), NodeResolutionInconclusiveError);
    await assert.rejects(client.listLocalNodes(false), /listing is incomplete/u);
    await assert.rejects(client.listLocalNodes(true), /listing is incomplete/u);
    assert(requests.every((path) => !path.includes("/save") && !path.includes("/newNode")));
  } finally {
    await sdk.close();
    await mcp.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

void test("real client verifies deletion using local HTTP discovery and preserves inconclusive identity", async () => {
  const requests: string[] = [];
  let incomplete = false;
  const http = createServer((request, response) => {
    requests.push(request.url!);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify(request.url === "/REST" ? { nodes: incomplete ? { exact: { name: "Allowed\uD800" } } : {} } : []),
    );
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  assert(address && typeof address !== "string");
  const config = createTestConfig({
    nodelBaseUrl: `http://127.0.0.1:${address.port}`,
    allowedNodePrefixes: ["Allowed"],
    postWriteReadyTimeoutSeconds: 0,
  });
  const client = new NodelClient(config);
  try {
    const clean = await verifyDeletedNode(client, config, "AllowedGone");
    assert.equal(clean.ok, true);
    assert(requests.includes("/REST"), "verification must make the real local discovery request");
    assert(!requests.some((path) => path.includes("/nodes/")), "verification must not probe a neighbor");

    incomplete = true;
    requests.length = 0;
    const pending = await verifyDeletedNode(client, config, "Allowed\uD800");
    assert.equal(pending.ok, false);
    assert.match(pending.lastError ?? "", /incomplete|conclusive|surrogate/iu);
    assert.doesNotMatch(pending.lastError ?? "", /rememberNodeTypeError/iu);
    assert(requests.includes("/REST"), "inconclusive verification must make the real discovery request");
    assert(!requests.some((path) => path.includes("/nodes/")), "inconclusive discovery must not probe a neighbor");

    await assert.rejects(client.resolveNodeForDeletion("Allowed\uD800"), NodeResolutionInconclusiveError);
    incomplete = false;
    await assert.rejects(client.resolveNode("DefinitelyAbsent"), NodeResolutionNotFoundError);
  } finally {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});
