/**
 * HTTP client for file download from Redmine
 */
import fs from "fs";
import os from "os";
import path from "path";
import { getDownloadAttachmentFileUrl } from "../__generated__/http-client";
import { downloadBinary } from "../api/custom-fetch";
import { DownloadLocalFileResponse } from "../types/attachment";

export async function downloadFileToLocalFromRedmine(
  attachmentId: number,
  filename: string,
  outputDir?: string
): Promise<DownloadLocalFileResponse> {
  // Download the actual file using the generated URL function
  const fileBuffer = await downloadBinary(
    getDownloadAttachmentFileUrl(attachmentId, filename),
    "file"
  );

  // Determine output directory and file path
  const actualOutputDir = outputDir || os.tmpdir();

  // Ensure output directory exists
  if (!fs.existsSync(actualOutputDir)) {
    fs.mkdirSync(actualOutputDir, { recursive: true });
  }

  // Create unique filename to avoid conflicts
  const timestamp = Date.now();
  const ext = path.extname(filename);
  const uniqueFilename = `redmine_attachment_${attachmentId}_${timestamp}${ext}`;
  const outputPath = path.join(actualOutputDir, uniqueFilename);

  // Write file to disk
  fs.writeFileSync(outputPath, fileBuffer);

  return {
    filePath: outputPath,
    filename: filename,
  };
}
