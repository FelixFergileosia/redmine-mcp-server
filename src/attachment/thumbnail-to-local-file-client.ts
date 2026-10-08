/**
 * HTTP client for thumbnail download from Redmine
 */
import fs from "fs";
import os from "os";
import path from "path";
import { getDownloadThumbnailUrl } from "../__generated__/http-client";
import { downloadBinary } from "../api/custom-fetch";
import { DownloadLocalFileResponse } from "../types/attachment";

export async function downloadThumbnailToLocalFromRedmine(
  attachmentId: number,
  outputDir?: string
): Promise<DownloadLocalFileResponse> {
  // Download the thumbnail using the generated URL function
  const fileBuffer = await downloadBinary(
    getDownloadThumbnailUrl(attachmentId),
    "thumbnail"
  );

  // Determine output directory and file path
  const actualOutputDir = outputDir || os.tmpdir();

  // Ensure output directory exists
  if (!fs.existsSync(actualOutputDir)) {
    fs.mkdirSync(actualOutputDir, { recursive: true });
  }

  // Create unique filename for thumbnail
  const timestamp = Date.now();
  const uniqueFilename = `redmine_thumbnail_${attachmentId}_${timestamp}.png`;
  const outputPath = path.join(actualOutputDir, uniqueFilename);

  // Write thumbnail to disk
  fs.writeFileSync(outputPath, fileBuffer);

  return {
    filePath: outputPath,
    filename: uniqueFilename,
  };
}