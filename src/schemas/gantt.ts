import { z } from "zod";

export const isDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const date = z.string().refine(isDate, "Use a valid YYYY-MM-DD date");
const id = z.number().int().positive();
export const ganttDataSchema = z.object({
  project_ids: z.union([z.literal("all_accessible"), z.array(id).min(1).max(50)])
    .default("all_accessible"),
  user_id: z.union([z.literal("me"), id]).default("me"),
  user_scope: z.enum(["author", "assignee", "author_or_assignee"]).default("author"),
  from: date.describe("First schedule date, inclusive; maximum range is 366 days"),
  to: date.describe("Last schedule date, inclusive"),
  timezone: z.string().default("Asia/Jakarta")
    .refine(value => {
      try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; }
      catch { return false; }
    }, "Use an IANA timezone"),
  working_days: z.array(z.enum(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]))
    .min(1).max(7).default(["MON", "TUE", "WED", "THU", "FRI"]),
  excluded_dates: z.array(date).max(366).default([]),
  max_pages: z.number().int().min(1).max(200).default(100)
    .describe("Total issue page budget; reaching it reports an incomplete scan"),
});

export const ganttDetailSchema = z.object({
  scan_id: z.string().uuid().describe("Snapshot from getGanttData; expires after 10 minutes"),
  dates: z.array(date).min(1).max(31),
  include_nearby_issues: z.boolean().default(true),
  include_unscheduled: z.boolean().default(true),
  include_description: z.boolean().default(false),
  include_relations: z.boolean().default(false),
  include_journals: z.boolean().default(false),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(100).default(50),
});

export type GanttDataArgs = z.infer<typeof ganttDataSchema>;
export type GanttDetailArgs = z.infer<typeof ganttDetailSchema>;
