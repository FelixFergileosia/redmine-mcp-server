/**
 * HTTP client for Base64 content download from Redmine
 */
import { getDownloadAttachmentFileUrl } from "../__generated__/http-client";
import { downloadBinary } from "../api/custom-fetch";
import { DownloadBase64ContentResponse } from "../types/attachment";

export async function downloadFileAsBase64FromRedmine(
  attachmentId: number,
  filename: string
): Promise<DownloadBase64ContentResponse> {
  // Download the actual file using the generated URL function
  const fileBuffer = await downloadBinary(
    getDownloadAttachmentFileUrl(attachmentId, filename),
    "file"
  );

  // Convert to Base64
  const base64Content = fileBuffer.toString("base64");

  return {
    content: base64Content,
    filename: filename,
  };
}