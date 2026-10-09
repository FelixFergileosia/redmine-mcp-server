/**
 * Read a binary response body, enforcing a maximum size (0 = unlimited).
 * Kept free of config imports so services can be unit-tested without env vars.
 */
export const readLimitedBody = async (
  res: Response,
  maxBytes: number,
  label: string
): Promise<Buffer> => {
  const exceedsLimit = (size: number) => maxBytes > 0 && size > maxBytes;
  const limitError = (size: number) =>
    new Error(
      `Failed to download ${label}: size ${size} bytes exceeds limit of ${maxBytes} bytes`
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
