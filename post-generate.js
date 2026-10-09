import fs from 'fs';

const HTTP_CLIENT_FILE = 'src/__generated__/http-client.ts';
const GENERATED_SERVER_FILE = 'src/__generated__/server.ts';
const CUSTOM_FETCH_IMPORT = 'import { customFetch as fetch } from "../api/custom-fetch";';

function addCustomFetchImport() {
  if (!fs.existsSync(HTTP_CLIENT_FILE)) {
    console.log(`File ${HTTP_CLIENT_FILE} not found`);
    return;
  }

  const content = fs.readFileSync(HTTP_CLIENT_FILE, 'utf8');
  const lines = content.split('\n');
  
  // Check if import already exists
  if (lines.some(line => line.includes('import { customFetch as fetch }'))) {
    console.log('customFetch import already exists');
    return;
  }
  
  // Find the line with http-schemas import
  const importIndex = lines.findIndex(line => line.includes('} from \'./http-schemas\';'));
  
  if (importIndex === -1) {
    console.log('Could not find http-schemas import line');
    return;
  }
  
  // Insert the customFetch import after the http-schemas import
  lines.splice(importIndex + 1, 0, CUSTOM_FETCH_IMPORT);
  
  fs.writeFileSync(HTTP_CLIENT_FILE, lines.join('\n'));
  console.log('Added customFetch import to http-client.ts');
}

function removeGeneratedServer() {
  if (fs.existsSync(GENERATED_SERVER_FILE)) {
    fs.unlinkSync(GENERATED_SERVER_FILE);
    console.log('Removed generated server.ts file');
  }
}

function removeUnusedBinaryBodyImport() {
  // Orval 7.10's MCP generator imports a binary body alias that its schema
  // generator never emits; the upload handler already uses Blob directly.
  const path = 'src/__generated__/handlers.ts';
  const content = fs.readFileSync(path, 'utf8');
  if ((content.match(/\bUploadAttachmentFileBody\b/g) ?? []).length === 1) {
    fs.writeFileSync(path, content.replace(/^\s*UploadAttachmentFileBody,\r?\n/m, ''));
  }
}

addCustomFetchImport();
removeUnusedBinaryBodyImport();
removeGeneratedServer();
