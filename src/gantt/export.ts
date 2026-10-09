import { z } from "zod";
import { exportGanttSchema, ganttCapabilitiesSchema, type ExportGanttArgs } from "../schemas/gantt.js";
import {
  errorCode, RedmineClient, type BinaryResult, type Fetcher, type Issue, type PageBudget, type ScanError,
} from "./redmine-client.js";
import { INVERSE } from "./schedule.js";
import { DAY_MS, range, scheduleProblem } from "./service.js";

type PluginFormat = "pdf" | "png";
type Scope = { projectId?: number; from: string; months: number; includeClosed: boolean };
type Feature = { supported: boolean; reason: string };

/**
 * Knowledge about one Gantt implementation. Redmine's REST API does not list installed
 * plugins or versions, so an implementation can only be recognized by an adapter here.
 */
interface GanttAdapter {
  id: string;
  name: string;
  /** `renderedAs: "anonymous"` when the route ignores API keys and renders with anonymous permissions. */
  exports: Partial<Record<PluginFormat, { mime: string; renderedAs: "caller" | "anonymous"; path: (scope: Scope) => string }>>;
  features: Record<"working_calendar" | "baseline", Feature>;
}

const coreExportPath = (format: PluginFormat) => ({ projectId, from, months, includeClosed }: Scope) => {
  const query = new URLSearchParams({ year: from.slice(0, 4), month: String(Number(from.slice(5, 7))), months: String(months) });
  if (includeClosed) {
    query.set("set_filter", "1");
    query.append("f[]", "status_id");
    query.set("op[status_id]", "*");
  }
  return `${projectId ? `/projects/${projectId}` : ""}/issues/gantt.${format}?${query}`;
};

const ADAPTERS: GanttAdapter[] = [{
  id: "redmine_core",
  name: "Redmine core Gantt",
  exports: {
    // Redmine accepts API keys for JSON/XML only, so these routes always run as the anonymous user.
    pdf: { mime: "application/pdf", renderedAs: "anonymous", path: coreExportPath("pdf") },
    png: { mime: "image/png", renderedAs: "anonymous", path: coreExportPath("png") },
  },
  features: {
    working_calendar: { supported: false, reason: "Redmine stores non-working weekdays in admin settings, which the REST API does not expose; pass working_days/excluded_dates to getGanttData explicitly." },
    baseline: { supported: false, reason: "Redmine core has no schedule baselines." },
  },
}];
const MCP_FORMATS = ["csv", "mermaid"] as const;
const MAX_EXPORT_ISSUES = 500;
const IDENTIFICATION = {
  method: "adapter_route_probe",
  adapters_available: ADAPTERS.map(adapter => adapter.id),
  limitation: "Redmine's REST API does not list installed plugins or versions; Gantt plugins without an adapter in this server are not identified.",
};

const monthsBetween = (from: string, to: string) =>
  (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;

const csvCell = (value: unknown): string => {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; // keep spreadsheet apps from evaluating cells
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const mermaidText = (value: string) => value.replace(/[:;#%\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "-";

/** Dependencies of an issue, described from its own point of view (e.g. "precedes #12 (+2d)"). */
const dependenciesOf = (issue: Issue): string[] => [...new Set((issue.relations ?? []).map(relation => {
  const outgoing = relation.issue_id === issue.id;
  const type = outgoing ? relation.relation_type : INVERSE[relation.relation_type] ?? relation.relation_type;
  return `${type} #${outgoing ? relation.issue_to_id : relation.issue_id}${relation.delay ? ` (+${relation.delay}d)` : ""}`;
}))].sort();

const durationDays = (issue: Issue) => scheduleProblem(issue) ? null
  : (Date.parse(issue.due_date!) - Date.parse(issue.start_date!)) / DAY_MS + 1;

const toCsv = (issues: Issue[]) => [
  ["issue_id", "project", "tracker", "subject", "status", "closed", "assignee", "start_date", "due_date",
    "duration_days", "done_ratio", "parent_id", "dependencies"],
  ...issues.map(issue => [issue.id, issue.project.name, issue.tracker?.name, issue.subject, issue.status.name,
    issue.status.is_closed ?? "", issue.assigned_to?.name, issue.start_date, issue.due_date, durationDays(issue),
    issue.done_ratio, issue.parent?.id, dependenciesOf(issue).join("; ")]),
].map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";

const toMermaid = (issues: Issue[], args: ExportGanttArgs) => {
  const lines = ["gantt", `    title Redmine schedule ${args.from} to ${args.to}`, "    dateFormat YYYY-MM-DD", "    axisFormat %d %b"];
  let section: string | undefined;
  for (const issue of issues) {
    const days = durationDays(issue);
    if (days === null) {
      lines.push(`    %% #${issue.id} skipped: ${scheduleProblem(issue)}`);
      continue;
    }
    if (issue.project.name !== section) lines.push(`    section ${mermaidText(section = issue.project.name ?? `Project ${issue.project.id}`)}`);
    const tags = [issue.status.is_closed ? "done" : issue.done_ratio ? "active" : null, `i${issue.id}`].filter(Boolean);
    lines.push(`    ${mermaidText(issue.subject)} (${issue.id}) :${tags.join(", ")}, ${issue.start_date}, ${days}d`);
  }
  for (const issue of issues) for (const dependency of dependenciesOf(issue)) {
    if (/^(precedes|blocks) /.test(dependency)) lines.push(`    %% #${issue.id} ${dependency}`);
  }
  return lines.join("\n") + "\n";
};

export class GanttExportService {
  private readonly client: RedmineClient;
  constructor(fetcher: Fetcher, maxBinaryBytes = 0) {
    this.client = new RedmineClient(fetcher, maxBinaryBytes);
  }

  private async ganttModule(projectId: number): Promise<{ gantt_module_enabled: boolean | null; code?: string }> {
    try {
      const project = z.object({ project: z.object({ enabled_modules: z.array(z.object({ name: z.string() })).optional() }) })
        .parse(await this.client.read(`/projects/${projectId}.json?include=enabled_modules`)).project;
      return { gantt_module_enabled: project.enabled_modules ? project.enabled_modules.some(module => module.name === "gantt") : null };
    } catch (error) {
      return { gantt_module_enabled: null, code: errorCode(error) };
    }
  }

  async capabilities(input: unknown) {
    const args = ganttCapabilitiesSchema.parse(input);
    await this.client.currentUser();
    const today = new Date().toISOString().slice(0, 10);
    const scope: Scope = { projectId: args.project_id, from: today, months: 1, includeClosed: false };
    const adapters = await Promise.all(ADAPTERS.map(async adapter => {
      const exports: Record<string, BinaryResult & { source: string; rendered_as: string }> = {};
      for (const [format, route] of Object.entries(adapter.exports)) {
        exports[format] = { source: "redmine_plugin", rendered_as: route.renderedAs, ...await this.client.binary(route.path(scope), route.mime, true) };
      }
      return { id: adapter.id, name: adapter.name, version: null, exports, features: adapter.features };
    }));
    return {
      identified: adapters,
      identification: IDENTIFICATION,
      ...(args.project_id ? { project: { id: args.project_id, ...await this.ganttModule(args.project_id) } } : {}),
      mcp_generated_exports: MCP_FORMATS.map(format => ({ format, source: "mcp_generated" })),
      notes: [
        "Export status comes from a header-only probe of Redmine's own export routes.",
        "requires_browser_session: Redmine accepts API keys for JSON/XML only, so this export needs a logged-in browser.",
        "rendered_as=anonymous: when available, the export shows only what anonymous users may see, not the caller's issues.",
        "not_supported: Redmine answered 406, e.g. PNG export without ImageMagick on the Redmine server.",
        "csv and mermaid are generated by this MCP server from issue fields and are always available.",
      ],
    };
  }

  async export(input: unknown) {
    const args = exportGanttSchema.parse(input);
    range(args.from, args.to);
    const pluginFormat = args.format === "pdf" || args.format === "png";
    const source = args.source === "auto" ? (pluginFormat ? "plugin" : "mcp") : args.source;
    if (source === "mcp" && pluginFormat)
      throw new Error("This server generates csv and mermaid only; use source=plugin for pdf/png");
    if (source === "plugin" && !pluginFormat)
      throw new Error("No Gantt adapter offers csv/mermaid exports; use source=mcp");
    return source === "plugin" ? this.pluginExport(args, args.format as PluginFormat) : this.mcpExport(args);
  }

  private async pluginExport(args: ExportGanttArgs, format: PluginFormat) {
    if (args.issue_ids) throw new Error("issue_ids applies to MCP-generated charts only");
    const months = monthsBetween(args.from, args.to);
    if (months > 24) throw new Error("Redmine Gantt exports cover at most 24 months");
    const adapter = ADAPTERS.find(candidate => candidate.exports[format])!;
    const route = adapter.exports[format]!;
    const result = await this.client.binary(
      route.path({ projectId: args.project_id, from: args.from, months, includeClosed: args.include_closed }), route.mime);
    if (result.status !== "available")
      throw new Error(`Redmine ${format} export unavailable (${result.status}, ${result.code}); `
        + "use format csv or mermaid for an MCP-generated chart");
    return {
      source: "redmine_plugin", renderer: adapter.id, rendered_as: route.renderedAs, format, content_type: result.content_type,
      filename: `gantt-${args.from.slice(0, 7)}.${format}`, bytes: result.content!.length,
      content_base64: result.content!.toString("base64"),
      notes: [
        route.renderedAs === "anonymous"
          ? "Rendered by Redmine as the anonymous user (it ignores API keys here): only publicly visible issues appear."
          : "Rendered by Redmine with the caller's permissions.",
        "Redmine's Gantt covers whole months starting with the month of 'from'.",
      ],
    };
  }

  private async mcpExport(args: ExportGanttArgs) {
    const include = args.include_relations ? "relations" : undefined;
    const errors: ScanError[] = [];
    let issues: Issue[];
    if (args.issue_ids) {
      const found = await this.client.issuesById([...new Set(args.issue_ids)], include);
      for (const id of args.issue_ids) if (!found.has(id)) errors.push({ scope: `issue:${id}`, code: "ISSUE_NOT_VISIBLE" });
      issues = [...found.values()];
    } else {
      const collected = new Map<number, Issue>();
      const budget: PageBudget = { maxPages: args.max_pages, maxRows: MAX_EXPORT_ISSUES, pagesRead: 0, rowsRead: 0 };
      const params: Record<string, string> = {
        status_id: args.include_closed ? "*" : "open", sort: "id:asc",
        start_date: `<=${args.to}`, due_date: `>=${args.from}`,
        ...(args.project_id ? { project_id: String(args.project_id) } : {}), ...(include ? { include } : {}),
      };
      const code = await this.client.readIssuePages(params, budget, issue => collected.set(issue.id, issue));
      if (code) errors.push({ scope: "issues", code });
      issues = [...collected.values()];
    }
    issues.sort((a, b) => (a.project.name ?? "").localeCompare(b.project.name ?? "") || a.project.id - b.project.id
      || (a.start_date ?? "").localeCompare(b.start_date ?? "") || a.id - b.id);
    return {
      source: "mcp_generated", renderer: "redmine-mcp-server", format: args.format,
      content_type: args.format === "csv" ? "text/csv" : "text/vnd.mermaid",
      content: args.format === "csv" ? toCsv(issues) : toMermaid(issues, args),
      issue_count: issues.length, complete: errors.length === 0, errors,
      notes: [
        "Generated by this MCP server from issue start/due dates; this is not the Redmine- or plugin-rendered Gantt.",
        "Plugin-specific calculations (working-day calendars, baselines, derived dates) are not reproduced.",
        args.issue_ids ? "Issues were selected by ID; unscheduled ones are listed but not drawn."
          : "Issues without both a start and a due date are omitted.",
      ],
    };
  }
}
