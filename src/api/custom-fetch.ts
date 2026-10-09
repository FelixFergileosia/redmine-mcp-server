import { config } from "../config.js";
import { readLimitedBody } from "./binary.js";
import { getRedmineApiKey } from "./request-context.js";

/**
 * Authenticated request to Redmine that returns the raw response,
 * whatever its status or content type.
 */
export const redmineFetch = async (url: string, options?: RequestInit) => {
  const headers: HeadersInit = {
    "X-Redmine-API-Key": getRedmineApiKey(),
    ...options?.headers,
  };

  // Normalize both URLs to handle subpath deployments properly
  const normalizedBase = config.redmineUrl.replace(/\/$/, ''); // Remove trailing slash
  const normalizedPath = url.startsWith('/') ? url : '/' + url; // Ensure leading slash
  const fullUrl = normalizedBase + normalizedPath;

  console.error(`Fetching URL: ${fullUrl}`);

  const res = await fetch(fullUrl, {
    ...options,
    headers,
    signal:
      options?.signal ??
      (config.requestTimeoutMs > 0
        ? AbortSignal.timeout(config.requestTimeoutMs)
        : undefined),
  });

  console.error(`Response status: ${res.status}`);
  return res;
};

export const customFetch = async (url: string, options?: RequestInit) => {
  const res = await redmineFetch(url, options);

  // Check if response is HTML instead of JSON
  if (!res.ok) {
    const contentType = res.headers.get('content-type');
    if (contentType?.includes('text/html')) {
      const text = await res.text();
      throw new Error(
        `Expected JSON but received HTML (HTTP ${res.status}). ` +
        `URL: ${res.url || url}. ` +
        `Response body: ${text.substring(0, 200)}...`
      );
    }
  }

  return res;
};

/**
 * Download binary content (attachment or thumbnail) from Redmine,
 * enforcing the configured maximum download size.
 */
export const downloadBinary = async (
  url: string,
  label: string
): Promise<Buffer> => {
  const res = await customFetch(url);

  if (!res.ok) {
    throw new Error(
      `Failed to download ${label}: ${res.status} ${res.statusText}`
    );
  }

  return readLimitedBody(res, config.maxDownloadBytes, label);
};
