/**
 * Per-request context for the HTTP transport.
 *
 * In http mode each developer sends their own Redmine API key with the
 * request. The key is stored here for the duration of that request so the
 * shared fetch layer can use it without threading it through every handler.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "../config.js";

interface RequestContext {
  redmineApiKey: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const runWithRedmineApiKey = <T>(redmineApiKey: string, fn: () => T): T =>
  storage.run({ redmineApiKey }, fn);

/**
 * Resolve the API key for the current call: the per-request key in http mode,
 * otherwise the key from the environment (stdio mode).
 */
export const getRedmineApiKey = (): string => {
  const apiKey = storage.getStore()?.redmineApiKey ?? config.redmineApiKey;
  if (!apiKey) {
    throw new Error("No Redmine API key available for this request");
  }
  return apiKey;
};
