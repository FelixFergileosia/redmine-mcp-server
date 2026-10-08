import { config } from "../config.js";
import { getRedmineApiKey } from "./request-context.js";

export const customFetch = async (url: string, options?: RequestInit) => {
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

  // Check if response is HTML instead of JSON
  if (!res.ok) {
    const contentType = res.headers.get('content-type');
    if (contentType?.includes('text/html')) {
      const text = await res.text();
      throw new Error(
        `Expected JSON but received HTML (HTTP ${res.status}). ` +
        `URL: ${fullUrl}. ` +
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

  const exceedsLimit = (size: number) =>
    config.maxDownloadBytes > 0 && size > config.maxDownloadBytes;
  const limitError = (size: number) =>
    new Error(
      `Failed to download ${label}: size ${size} bytes exceeds limit of ${config.maxDownloadBytes} bytes`
    );

  // Reject early when the server announces the size, then verify the actual body
  const announcedSize = Number(res.headers.get("content-length") ?? 0);
  if (exceedsLimit(announcedSize)) {
    await res.body?.cancel();
    throw limitError(announcedSize);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (exceedsLimit(buffer.length)) {
    throw limitError(buffer.length);
  }

  return buffer;
};
