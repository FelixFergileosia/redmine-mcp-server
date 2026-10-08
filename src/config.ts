/**
 * Configuration management for Redmine MCP Server
 */

export type TransportMode = "stdio" | "http";

export interface HttpConfig {
  host: string;
  port: number;
  /** Host header values accepted by the HTTP endpoint (DNS rebinding protection) */
  allowedHosts: string[];
  /** Origin header values accepted by the HTTP endpoint (DNS rebinding protection) */
  allowedOrigins: string[];
}

export interface ServerConfig {
  transport: TransportMode;
  readOnlyMode: boolean;
  redmineUrl: string;
  /**
   * Shared API key used in stdio mode. In http mode every request supplies
   * its own key, so this is undefined.
   */
  redmineApiKey: string | undefined;
  toolsAllowPattern: RegExp | null;
  toolsDenyPattern: RegExp | null;
  /** Timeout for each request to Redmine, in milliseconds (0 = no timeout) */
  requestTimeoutMs: number;
  /** Maximum attachment/thumbnail download size in bytes (0 = unlimited) */
  maxDownloadBytes: number;
  http: HttpConfig;
}

const compilePattern = (
  value: string | undefined,
  varName: string,
): RegExp | null => {
  if (!value) return null;
  try {
    return new RegExp(value);
  } catch (e) {
    throw new Error(
      `Invalid regex in ${varName}: "${value}" - ${(e as Error).message}`,
    );
  }
};

const requireEnv = (varName: string): string => {
  const value = process.env[varName];
  if (!value) {
    throw new Error(`${varName} environment variable is not set`);
  }
  return value;
};

const parseNonNegativeInt = (varName: string, defaultValue: number): number => {
  const value = process.env[varName];
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `Invalid value in ${varName}: "${value}" - must be a non-negative integer`,
    );
  }
  return parsed;
};

const parseList = (varName: string): string[] =>
  (process.env[varName] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const parseTransport = (): TransportMode => {
  const value = process.env.REDMINE_MCP_TRANSPORT ?? "stdio";
  if (value !== "stdio" && value !== "http") {
    throw new Error(
      `Invalid value in REDMINE_MCP_TRANSPORT: "${value}" - must be "stdio" or "http"`,
    );
  }
  return value;
};

/**
 * Load configuration from environment variables
 */
const loadConfig = (): ServerConfig => {
  const transport = parseTransport();

  return {
    transport,
    readOnlyMode: process.env.REDMINE_MCP_READ_ONLY === "true",
    redmineUrl: requireEnv("REDMINE_URL"),
    redmineApiKey:
      transport === "stdio" ? requireEnv("REDMINE_API_KEY") : undefined,
    toolsAllowPattern: compilePattern(
      process.env.REDMINE_MCP_TOOLS_ALLOW_PATTERN,
      "REDMINE_MCP_TOOLS_ALLOW_PATTERN",
    ),
    toolsDenyPattern: compilePattern(
      process.env.REDMINE_MCP_TOOLS_DENY_PATTERN,
      "REDMINE_MCP_TOOLS_DENY_PATTERN",
    ),
    requestTimeoutMs: parseNonNegativeInt(
      "REDMINE_MCP_REQUEST_TIMEOUT_MS",
      30000,
    ),
    maxDownloadBytes: parseNonNegativeInt("REDMINE_MCP_MAX_DOWNLOAD_BYTES", 0),
    http: {
      host: process.env.REDMINE_MCP_HTTP_HOST ?? "0.0.0.0",
      port: parseNonNegativeInt("REDMINE_MCP_HTTP_PORT", 3000),
      allowedHosts: parseList("REDMINE_MCP_HTTP_ALLOWED_HOSTS"),
      allowedOrigins: parseList("REDMINE_MCP_HTTP_ALLOWED_ORIGINS"),
    },
  };
};

/**
 * Get current configuration
 */
export const config = loadConfig();
