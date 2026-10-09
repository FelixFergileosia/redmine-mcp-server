import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const repository = fileURLToPath(new URL("../", import.meta.url));
const target = fileURLToPath(new URL("../src/__generated__/", import.meta.url));
if (resolve(target) !== resolve(repository, "src", "__generated__")) {
  throw new Error("Unexpected generated-code directory");
}
await rm(target, { recursive: true, force: true });
