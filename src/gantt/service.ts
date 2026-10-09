import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ganttDataSchema, ganttDetailSchema, isDate, type GanttDataArgs } from "../schemas/gantt.js";
import {
  errorCode, issueSchema, ReadError, RedmineClient, ref,
  type Fetcher, type Issue, type PageBudget, type ScanError,
} from "./redmine-client.js";

type Project = z.infer<typeof ref>;
export const DAY_MS = 86_400_000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_LIMIT = 20;
const MAX_ISSUES = 10_000;
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

export const range = (from: string, to: string): string[] => {
  const count = (Date.parse(to) - Date.parse(from)) / DAY_MS + 1;
  if (count < 1 || count > 366) throw new Error("Date range must contain 1 to 366 days");
  return Array.from({ length: count }, (_, i) =>
    new Date(Date.parse(from) + i * DAY_MS).toISOString().slice(0, 10));
};

export const scheduleProblem = (issue: Issue): string | null => {
  if (!issue.start_date || !issue.due_date) return "missing_schedule_dates";
  if (!isDate(issue.start_date) || !isDate(issue.due_date)) return "invalid_schedule_dates";
  return issue.start_date > issue.due_date ? "reversed_schedule_dates" : null;
};

const possiblyCovers = (issue: Issue, date: string): boolean => {
  if (scheduleProblem(issue) !== "missing_schedule_dates") return true;
  if (issue.start_date && !isDate(issue.start_date)) return true;
  if (issue.due_date && !isDate(issue.due_date)) return true;
  return (!issue.start_date || issue.start_date <= date) && (!issue.due_date || issue.due_date >= date);
};

const localCreationDate = (value: string | undefined, timezone: string): string | null => {
  // Schedule fields are calendar dates; only created_on is converted from a timestamp.
  if (!value || !/(Z|[+-]\d\d:\d\d)$/.test(value)) return null;
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(time);
  const get = (type: string) => parts.find(part => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
};

export const analyzeCoverage = (issues: Issue[], args: GanttDataArgs, complete: boolean) => {
  const dates = range(args.from, args.to);
  const excluded = new Set(args.excluded_dates);
  const unknown = issues.filter(issue => scheduleProblem(issue));
  const scheduled = issues.filter(issue => !scheduleProblem(issue));
  const created = new Map<string, number>();
  let invalidCreationCount = 0;
  for (const issue of issues) {
    const date = localCreationDate(issue.created_on, args.timezone);
    if (date) created.set(date, (created.get(date) ?? 0) + 1);
    else invalidCreationCount++;
  }
  const daily = dates.map(date => {
    const working = !excluded.has(date) && args.working_days.includes(
      WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()] as GanttDataArgs["working_days"][number]);
    const covering = scheduled.filter(issue => issue.start_date! <= date && issue.due_date! >= date);
    const uncertain = unknown.filter(issue => possiblyCovers(issue, date));
    const state = !working ? "excluded" : covering.length ? "covered"
      : !complete || uncertain.length ? "uncertain" : "gap";
    return {
      date, state, issue_count: covering.length,
      project_ids: [...new Set(covering.map(issue => issue.project.id))].sort((a, b) => a - b),
      created_issue_count: created.get(date) ?? 0, uncertain_issue_count: uncertain.length,
    };
  });
  return {
    daily,
    covered_dates: daily.filter(day => day.state === "covered").map(day => day.date),
    gap_dates: daily.filter(day => day.state === "gap").map(day => day.date),
    uncertain_dates: daily.filter(day => day.state === "uncertain").map(day => day.date),
    uncovered_dates: daily.filter(day => day.state === "gap" || day.state === "uncertain").map(day => day.date),
    unscheduled_issue_count: unknown.length,
    invalid_creation_timestamp_count: invalidCreationCount,
  };
};

interface Snapshot {
  owner: string;
  expiresAt: number;
  scannedAt: string;
  args: GanttDataArgs;
  userId: number;
  issues: Issue[];
  projects: Project[];
  errors: ScanError[];
  complete: boolean;
  coverage: ReturnType<typeof analyzeCoverage>;
}

export class GanttService {
  private readonly scans = new Map<string, Snapshot>();
  private readonly client: RedmineClient;
  constructor(
    fetcher: Fetcher,
    private readonly owner: () => string,
    private readonly now: () => number = Date.now,
  ) {
    this.client = new RedmineClient(fetcher);
  }

  private prune(): void {
    for (const [id, scan] of this.scans) {
      if (scan.expiresAt <= this.now()) this.scans.delete(id);
    }
  }

  async scan(input: unknown) {
    const args = ganttDataSchema.parse(input);
    range(args.from, args.to);
    const owner = this.owner();
    const currentUser = await this.client.currentUser();
    const userId = args.user_id === "me" ? currentUser : args.user_id;
    const errors: ScanError[] = [];
    const projects = new Map<number, Project>();
    const selected = args.project_ids === "all_accessible" ? null : new Set(args.project_ids);
    if (selected) {
      for (const id of selected) {
        try {
          const result = z.object({ project: ref }).parse(await this.client.read(`/projects/${id}.json`));
          if (result.project.id !== id) throw new ReadError("INVALID_PROJECT_RESPONSE");
          projects.set(id, result.project);
        } catch (error) {
          errors.push({ scope: `project:${id}`, code: errorCode(error) });
        }
      }
    }
    const issues = new Map<number, Issue>();
    const filters = args.user_scope === "author_or_assignee" ? ["author_id", "assigned_to_id"]
      : [args.user_scope === "author" ? "author_id" : "assigned_to_id"];
    const budget: PageBudget = { maxPages: args.max_pages, maxRows: MAX_ISSUES, pagesRead: 0, rowsRead: 0 };
    for (const filter of filters) {
      // Read every visible issue in the user scope. Filtering by created_on would miss backfilled schedules.
      const code = await this.client.readIssuePages(
        { [filter]: String(userId), status_id: "*", sort: "id:asc" }, budget, issue => {
          if ((filter === "author_id" ? issue.author.id : issue.assigned_to?.id) !== userId)
            throw new ReadError("USER_FILTER_NOT_APPLIED");
          if (!selected || projects.has(issue.project.id)) {
            issues.set(issue.id, issue);
            projects.set(issue.project.id, issue.project);
          }
        });
      if (code) errors.push({ scope: filter, code });
    }
    const snapshotIssues = [...issues.values()].sort((a, b) => a.id - b.id);
    const complete = errors.length === 0;
    const coverage = analyzeCoverage(snapshotIssues, args, complete);
    const scanId = randomUUID();
    const scannedAt = new Date(this.now()).toISOString();
    const expiresAt = this.now() + CACHE_TTL_MS;
    this.prune();
    while (this.scans.size >= CACHE_LIMIT) this.scans.delete(this.scans.keys().next().value!);
    this.scans.set(scanId, {
      owner, expiresAt, scannedAt, args, userId, issues: snapshotIssues,
      projects: [...projects.values()], errors, complete, coverage,
    });
    return {
      scan_id: scanId, scanned_at: scannedAt, expires_at: new Date(expiresAt).toISOString(),
      date_source: "issue_fields", user_id: userId, user_scope: args.user_scope,
      project_scope: args.project_ids, from: args.from, to: args.to, timezone: args.timezone,
      working_days: args.working_days, excluded_dates: args.excluded_dates,
      complete, errors, pages_read: budget.pagesRead, issue_count: snapshotIssues.length,
      projects_scanned: [...projects.values()].sort((a, b) => a.id - b.id).map(project => ({
        ...project, issue_count: snapshotIssues.filter(issue => issue.project.id === project.id).length,
      })),
      ...coverage,
      notes: [
        "Coverage is the union of inclusive start_date/due_date intervals across the selected projects.",
        "Gaps are candidates for missing records, not proof of forgotten work. No dates are inferred for unscheduled issues.",
        "Issue creation counts are separate from scheduled coverage. Closed issues are included.",
        "All-accessible scope means issues visible to this API key; projects without matching issues are not enumerated.",
        "This snapshot is not a plugin-rendered Gantt, an atomic database snapshot, or evidence of actual hours worked.",
      ],
    };
  }

  async detail(input: unknown) {
    const args = ganttDetailSchema.parse(input);
    this.prune();
    const scan = this.scans.get(args.scan_id);
    if (!scan || scan.owner !== this.owner()) throw new Error("Scan unavailable or expired; run getGanttData again");
    const dates = [...new Set(args.dates)].sort();
    if (dates.some(date => date < scan.args.from || date > scan.args.to))
      throw new Error("Detail dates must be inside the scan range");
    // HTTP has a new MCP instance per request. Validate the caller and project access before returning cached data.
    await this.client.currentUser();
    const candidates = scan.issues.filter(issue => {
      const problem = scheduleProblem(issue);
      if (problem) return args.include_unscheduled && dates.some(date => possiblyCovers(issue, date));
      if (dates.some(date => issue.start_date! <= date && issue.due_date! >= date)) return true;
      return args.include_nearby_issues && dates.some(date =>
        (issue.due_date! < date && Date.parse(date) - Date.parse(issue.due_date!) <= 7 * DAY_MS)
        || (issue.start_date! > date && Date.parse(issue.start_date!) - Date.parse(date) <= 7 * DAY_MS));
    });
    const page = candidates.slice(args.offset, args.offset + args.limit);
    const accessErrors: ScanError[] = [];
    const visible = await this.client.issuesById(page.map(issue => issue.id));
    const details: Array<Record<string, unknown>> = [];
    for (const issue of page) {
      const liveSummary = visible.get(issue.id);
      if (!liveSummary || liveSummary.project.id !== issue.project.id) {
        accessErrors.push({ scope: `issue:${issue.id}`, code: "ISSUE_NOT_VISIBLE_OR_MOVED" });
        continue;
      }
      const matching = dates.filter(date => !scheduleProblem(issue)
        && issue.start_date! <= date && issue.due_date! >= date);
      const detail: Record<string, unknown> = {
        ...issue, live_updated_on: liveSummary.updated_on,
        changed_since_scan: liveSummary.updated_on !== issue.updated_on,
        schedule_problem: scheduleProblem(issue), covering_dates: matching,
        selection_reason: scheduleProblem(issue) ? "uncertain_schedule" : matching.length ? "covers_date" : "nearby_schedule",
      };
      if (args.include_description || args.include_relations || args.include_journals) {
        const include = [args.include_relations && "relations", args.include_journals && "journals"].filter(Boolean).join(",");
        try {
          const live = z.object({ issue: issueSchema.extend({
            description: z.string().optional(), relations: z.array(z.unknown()).optional(), journals: z.array(z.unknown()).optional(),
          }) }).parse(await this.client.read(`/issues/${issue.id}.json${include ? `?include=${include}` : ""}`)).issue;
          if (live.id !== issue.id || live.project.id !== issue.project.id) throw new ReadError("ISSUE_CHANGED_PROJECT");
          detail.live_updated_on = live.updated_on;
          detail.changed_since_scan = live.updated_on !== issue.updated_on;
          if (args.include_description) detail.description = live.description;
          if (args.include_relations) detail.relations = live.relations ?? [];
          if (args.include_journals) detail.journals = live.journals ?? [];
        } catch (error) {
          accessErrors.push({ scope: `issue:${issue.id}`, code: errorCode(error) });
          // Do not return cached issue data after a live permission denial or a move.
          continue;
        }
      }
      details.push(detail);
    }
    return {
      scan_id: args.scan_id, scanned_at: scan.scannedAt, expires_at: new Date(scan.expiresAt).toISOString(),
      data_source: "cached_snapshot", date_source: "issue_fields", complete: scan.complete && !accessErrors.length,
      errors: [...scan.errors, ...accessErrors],
      days: scan.coverage.daily.filter(day => dates.includes(day.date)).map(day => ({
        ...day, explanation: day.state === "covered" ? "At least one scheduled issue covers this day across the selected projects."
          : day.state === "excluded" ? "Outside the configured working calendar."
          : day.state === "uncertain" ? "No confirmed coverage; incomplete schedules or scan errors prevent a definite gap."
          : "No scheduled issue covers this working day in the complete scan.",
      })),
      issues: details, total_matching_issues: candidates.length, offset: args.offset,
      next_offset: args.offset + page.length < candidates.length ? args.offset + page.length : null,
      nearby_window_days: 7,
      notes: ["Schedule fields come from the cached scan; optional descriptions/relations/journals are live and may have changed.",
        "Run getGanttData again after editing issues or changing the calendar."],
    };
  }
}
