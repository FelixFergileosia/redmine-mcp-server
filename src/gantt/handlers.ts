import { createHash } from "node:crypto";
import { redmineFetch } from "../api/custom-fetch.js";
import { getRedmineApiKey } from "../api/request-context.js";
import { config } from "../config.js";
import { GanttExportService } from "./export.js";
import { ScheduleService } from "./schedule.js";
import { GanttService } from "./service.js";

const service = new GanttService(redmineFetch, () =>
  createHash("sha256").update(getRedmineApiKey()).digest("hex"));
const schedule = new ScheduleService(redmineFetch);
const exporter = new GanttExportService(redmineFetch, config.maxDownloadBytes);

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
export const applyScheduleHandler = (args: unknown) => result(() => schedule.apply(args));
export const getGanttPluginCapabilitiesHandler = (args: unknown) => result(() => exporter.capabilities(args));
export const exportGanttHandler = (args: unknown) => result(() => exporter.export(args));
