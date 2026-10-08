/**
 * HTTP client for Base64 thumbnail download from Redmine
 */
import { getDownloadThumbnailUrl } from "../__generated__/http-client";
import { downloadBinary } from "../api/custom-fetch";
import { DownloadThumbnailBase64ContentResponse } from "../types/attachment";

export async function downloadThumbnailAsBase64FromRedmine(
  attachmentId: number
): Promise<DownloadThumbnailBase64ContentResponse> {
  // Download the thumbnail using the generated URL function
  const fileBuffer = await downloadBinary(
    getDownloadThumbnailUrl(attachmentId),
    "thumbnail"
  );

  // Convert to Base64
  const base64Content = fileBuffer.toString("base64");

  return {
    content: base64Content,
    attachmentId: attachmentId,
  };
}