import { createHash } from "node:crypto";
import { customFetch } from "../api/custom-fetch.js";
import { getRedmineApiKey } from "../api/request-context.js";
import { GanttService } from "./service.js";

const service = new GanttService(customFetch, () =>
  createHash("sha256").update(getRedmineApiKey()).digest("hex"));

const result = async (operation: () => Promise<unknown>) => {
  try {
    return { content: [{ type: "text" as const, text: JSON.stringify(await operation()) }] };
  } catch (error) {
    // Validation and explicit service errors are safe; upstream exceptions are sanitized by the service.
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify({ error: error instanceof Error ? error.message : "Gantt operation failed" }) }],
    };
  }
};

export const getGanttDataHandler = (args: unknown) => result(() => service.scan(args));
export const getGanttDataDetailHandler = (args: unknown) => result(() => service.detail(args));
