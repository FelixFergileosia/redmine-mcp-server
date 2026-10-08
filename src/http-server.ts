/**
 * Stateless Streamable HTTP transport.
 *
 * Every POST to /mcp is handled by a fresh MCP server and transport, so no
 * session state is kept between requests and the server can be scaled or
 * restarted freely. Each request carries the caller's own Redmine API key.
 */
import http, { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { runWithRedmineApiKey } from "./api/request-context.js";
import { config } from "./config.js";

const MCP_PATH = "/mcp";
const HEALTH_PATH = "/healthz";

const sendJsonRpcError = (
  res: ServerResponse,
  status: number,
  message: string,
  headers: http.OutgoingHttpHeaders = {}
) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    })
  );
};

/**
 * Read the caller's Redmine API key from either
 * `X-Redmine-API-Key: <key>` or `Authorization: Bearer <key>`.
 */
const extractApiKey = (req: IncomingMessage): string | undefined => {
  const apiKeyHeader = req.headers["x-redmine-api-key"];
  if (typeof apiKeyHeader === "string" && apiKeyHeader.trim()) {
    return apiKeyHeader.trim();
  }
  const match = req.headers.authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1].trim() || undefined;
};

const handleMcpRequest = async (
  req: IncomingMessage,
  res: ServerResponse,
  createServer: () => McpServer
) => {
  const apiKey = extractApiKey(req);
  if (!apiKey) {
    sendJsonRpcError(
      res,
      401,
      "Missing Redmine API key: send it in the X-Redmine-API-Key header or as Authorization: Bearer <key>",
      { "WWW-Authenticate": "Bearer" }
    );
    return;
  }

  const { allowedHosts, allowedOrigins } = config.http;
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    allowedHosts,
    allowedOrigins,
    enableDnsRebindingProtection:
      allowedHosts.length > 0 || allowedOrigins.length > 0,
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await runWithRedmineApiKey(apiKey, () => transport.handleRequest(req, res));
};

/**
 * Start the HTTP server. `createServer` builds a fully registered MCP server
 * and is called once per request.
 */
export const startHttpServer = (createServer: () => McpServer) => {
  const httpServer = http.createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    try {
      if (path === HEALTH_PATH && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
      } else if (path !== MCP_PATH) {
        sendJsonRpcError(res, 404, "Not found");
      } else if (req.method !== "POST") {
        // Stateless mode: no server-initiated streams (GET) or sessions (DELETE)
        sendJsonRpcError(res, 405, "Method not allowed", { Allow: "POST" });
      } else {
        await handleMcpRequest(req, res, createServer);
      }
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, "Internal server error");
      }
    }
  });

  const { host, port } = config.http;
  httpServer.listen(port, host, () => {
    console.error(`MCP server running on http://${host}:${port}${MCP_PATH}`);
  });
  return httpServer;
};
