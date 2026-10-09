import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const listen = async server => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
};
const close = server => new Promise(resolve => server.close(resolve));

test("Gantt tools work over stateless HTTP and stdio, respect filtering, and isolate concurrent callers", { timeout: 30_000 }, async t => {
  const backendCalls = [];
  const backend = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const caller = req.headers["x-redmine-api-key"] === "bob-test-key" ? 13 : 12;
    backendCalls.push({ path: url.pathname, caller, params: url.searchParams });
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/users/current.json") {
      res.end(JSON.stringify({ user: { id: caller, name: `User ${caller}`, api_key: "never-return-this" } }));
    } else if (url.pathname === "/issues.json") {
      const selected = url.searchParams.get("issue_id");
      const row = {
        id: caller, subject: `User ${caller} task`, project: { id: 11, name: "Collector" },
        author: { id: caller, name: `User ${caller}` }, status: { id: 2, name: "Done", is_closed: true },
        start_date: "2026-09-07", due_date: "2026-09-07", created_on: "2026-08-01T00:00:00Z",
      };
      const issues = !selected || selected.split(",").includes(String(caller)) ? [row] : [];
      res.end(JSON.stringify({ issues, total_count: issues.length, offset: 0, limit: 100 }));
    } else {
      res.statusCode = 404; res.end("{}");
    }
  });
  const backendPort = await listen(backend);
  t.after(() => close(backend));
  const reservation = http.createServer();
  const port = await listen(reservation);
  await close(reservation);
  const env = {
    ...process.env,
    REDMINE_URL: `http://127.0.0.1:${backendPort}`,
    REDMINE_MCP_TRANSPORT: "http", REDMINE_MCP_HTTP_HOST: "127.0.0.1",
    REDMINE_MCP_HTTP_PORT: String(port), REDMINE_MCP_READ_ONLY: "true",
    REDMINE_MCP_TOOLS_ALLOW_PATTERN: "^getGanttData", REDMINE_MCP_TOOLS_DENY_PATTERN: "",
    REDMINE_MCP_HTTP_ALLOWED_HOSTS: "", REDMINE_MCP_HTTP_ALLOWED_ORIGINS: "",
  };
  const child = spawn(process.execPath, ["dist/server.mjs"], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, "exit"); child.kill(); await exited;
    }
  });
  let logs = "";
  child.stderr.on("data", data => { logs += data; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP did not start: ${logs}`)), 10_000);
    child.stderr.on("data", () => {
      if (logs.includes("MCP server running on")) { clearTimeout(timer); resolve(); }
    });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`MCP exited ${code}: ${logs}`)); });
  });
  let sequence = 0;
  const rpc = async (method, params = {}, key = "alice-test-key") => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST", headers: {
        "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        "X-Redmine-API-Key": key, "MCP-Protocol-Version": "2025-03-26",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
    });
    assert.equal(response.status, 200);
    const message = await response.json();
    assert.equal(message.error, undefined);
    return message.result;
  };
  const call = async (name, args, key) => {
    const result = await rpc("tools/call", { name, arguments: args }, key);
    return { ...JSON.parse(result.content[0].text), isError: result.isError ?? false };
  };
  await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "gantt-tests", version: "1" } });
  const tools = (await rpc("tools/list")).tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), ["getGanttData", "getGanttDataDetail"]);
  assert.ok(tools.every(tool => tool.annotations.readOnlyHint));
  const args = { from: "2026-09-07", to: "2026-09-08" };
  const [alice, bob] = await Promise.all([
    call("getGanttData", args, "alice-test-key"), call("getGanttData", args, "bob-test-key"),
  ]);
  assert.equal(alice.user_id, 12);
  assert.equal(bob.user_id, 13);
  assert.deepEqual(alice.gap_dates, ["2026-09-08"]);
  assert.equal(JSON.stringify(alice).includes("never-return-this"), false);
  const detailArgs = { scan_id: alice.scan_id, dates: ["2026-09-08"] };
  const denied = await call("getGanttDataDetail", detailArgs, "bob-test-key");
  assert.equal(denied.isError, true);
  const detail = await call("getGanttDataDetail", detailArgs, "alice-test-key");
  assert.equal(detail.isError, false);
  assert.equal(detail.issues[0].id, 12);
  assert.equal(detail.data_source, "cached_snapshot");
  assert.equal(backendCalls.filter(call => call.path === "/issues.json" && call.params.has("author_id")).length, 2);
  assert.ok(backendCalls.some(call => call.caller === 12 && call.params.get("author_id") === "12"));
  assert.ok(backendCalls.some(call => call.caller === 13 && call.params.get("author_id") === "13"));

  const client = new Client({ name: "stdio-gantt-tests", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ["dist/server.mjs"], stderr: "pipe",
    env: { ...env, REDMINE_MCP_TRANSPORT: "stdio", REDMINE_API_KEY: "alice-test-key", REDMINE_MCP_TOOLS_DENY_PATTERN: "Detail$" },
  });
  t.after(() => client.close());
  await client.connect(transport);
  const stdioTools = await client.listTools();
  assert.deepEqual(stdioTools.tools.map(tool => tool.name), ["getGanttData"]);
  const stdioResult = await client.callTool({ name: "getGanttData", arguments: args });
  assert.equal(stdioResult.isError, undefined);
  assert.equal(JSON.parse(stdioResult.content[0].text).user_id, 12);
});
