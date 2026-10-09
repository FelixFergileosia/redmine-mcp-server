import { z } from "zod";
import { applyScheduleSchema, type ApplyScheduleArgs } from "../schemas/gantt.js";
import { RedmineClient, type Fetcher, type Issue, type Relation } from "./redmine-client.js";
import { DAY_MS } from "./service.js";

type Dates = { start_date: string | null; due_date: string | null };
type Dependency = ApplyScheduleArgs["dependencies"][number];
type Status = "planned" | "unchanged" | "invalid" | "already_exists" | "applied" | "failed";
type Outcome = { status: Status; code?: string; messages?: string[]; verified?: boolean };
type ChangePlan = Outcome & { issue_id: number; subject?: string; before?: Dates; after?: Dates; stored?: Dates };
type DependencyPlan = Outcome & Dependency & { relation_id?: number };

const MAX_ISSUES = 100;
export const INVERSE: Record<string, string> = { precedes: "follows", follows: "precedes", blocks: "blocked", blocked: "blocks" };

const datesOf = (issue: Issue): Dates => ({ start_date: issue.start_date ?? null, due_date: issue.due_date ?? null });
const sameDates = (a: Dates, b: Dates) => a.start_date === b.start_date && a.due_date === b.due_date;
const addDays = (date: string, days: number) => new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);

/** True when `relation` already expresses `issueId <type> issueToId` in either direction. */
const expresses = (relation: Pick<Relation, "issue_id" | "issue_to_id" | "relation_type">,
  issueId: number, issueToId: number, type: string) =>
  (relation.issue_id === issueId && relation.issue_to_id === issueToId && relation.relation_type === type)
  || (relation.issue_id === issueToId && relation.issue_to_id === issueId && relation.relation_type === INVERSE[type]);

/** Normalize precedes/follows into [preceding, following, delay]. */
const precedence = (relation: { issue_id: number; issue_to_id: number; relation_type: string; delay?: number | null }) =>
  relation.relation_type === "precedes" ? [relation.issue_id, relation.issue_to_id, relation.delay ?? 0] as const
    : relation.relation_type === "follows" ? [relation.issue_to_id, relation.issue_id, relation.delay ?? 0] as const
      : null;

export class ScheduleService {
  private readonly client: RedmineClient;
  constructor(fetcher: Fetcher) {
    this.client = new RedmineClient(fetcher);
  }

  /**
   * Load requested issues with relations, plus the direct predecessors and followers of changed
   * issues: predecessors constrain the new dates, and Redmine may reschedule followers.
   */
  private async load(ids: number[], changedIds: Set<number>): Promise<Map<number, Issue>> {
    const issues = await this.client.issuesById(ids, "relations");
    const neighbors = [...issues.values()].flatMap(issue => changedIds.has(issue.id)
      ? (issue.relations ?? []).map(precedence).flatMap(p => p ? [p[0], p[1]] : []) : [])
      .filter(id => !issues.has(id));
    const extra = [...new Set(neighbors)].slice(0, MAX_ISSUES - ids.length);
    for (const [id, issue] of await this.client.issuesById(extra)) issues.set(id, issue);
    return issues;
  }

  /** Changed issues with subtasks; Redmine usually derives their dates from the subtasks. */
  private async parents(changedIds: number[], issues: Map<number, Issue>): Promise<Set<number>> {
    const parents = new Set<number>();
    for (const id of changedIds.filter(id => issues.has(id))) {
      try {
        const { issue } = z.object({ issue: z.object({ children: z.array(z.unknown()).optional() }) })
          .parse(await this.client.read(`/issues/${id}.json?include=children`));
        if (issue.children?.length) parents.add(id);
      } catch { /* unknown: the read-back still reports what Redmine stored */ }
    }
    return parents;
  }

  private plan(args: ApplyScheduleArgs, issues: Map<number, Issue>, parents: Set<number>) {
    const changes: ChangePlan[] = args.changes.map(change => {
      const issue = issues.get(change.issue_id);
      if (!issue) return { issue_id: change.issue_id, status: "invalid", code: "ISSUE_NOT_VISIBLE" };
      const before = datesOf(issue);
      const after: Dates = {
        start_date: change.start_date === undefined ? before.start_date : change.start_date,
        due_date: change.due_date === undefined ? before.due_date : change.due_date,
      };
      const base = { issue_id: issue.id, subject: issue.subject, before, after };
      if (after.start_date && after.due_date && after.start_date > after.due_date)
        return { ...base, status: "invalid", code: "REVERSED_DATES" };
      return { ...base, status: sameDates(before, after) ? "unchanged" : "planned" };
    });
    const dependencies: DependencyPlan[] = args.dependencies.map(dependency => {
      const issue = issues.get(dependency.issue_id);
      if (!issue || !issues.has(dependency.issue_to_id)) return { ...dependency, status: "invalid", code: "ISSUE_NOT_VISIBLE" };
      const exists = (issue.relations ?? []).some(relation =>
        expresses(relation, dependency.issue_id, dependency.issue_to_id, dependency.relation_type));
      return { ...dependency, status: exists ? "already_exists" : "planned" };
    });
    return { changes, dependencies, warnings: this.warnings(changes, dependencies, issues, parents) };
  }

  /** Flag schedules Redmine is likely to reject or move, judged from the planned dates. */
  private warnings(changes: ChangePlan[], dependencies: DependencyPlan[], issues: Map<number, Issue>, parents: Set<number>) {
    const planned = new Map([...issues.values()].map(issue => [issue.id, datesOf(issue)]));
    for (const change of changes) if (change.status === "planned") planned.set(change.issue_id, change.after!);
    const links = new Map<string, { issue_id: number; issue_to_id: number; relation_type: string; delay?: number | null }>();
    for (const issue of issues.values()) for (const relation of issue.relations ?? []) links.set(`r${relation.id}`, relation);
    dependencies.forEach((dependency, index) => {
      if (dependency.status === "planned") links.set(`d${index}`, dependency);
    });
    const warnings: Array<Record<string, unknown>> = [];
    for (const link of links.values()) {
      const order = precedence(link);
      if (!order) continue;
      const [preceding, following, delay] = order;
      const due = planned.get(preceding)?.due_date;
      const start = planned.get(following)?.start_date;
      if (!due || !start) continue;
      const earliest = addDays(due, delay + 1);
      if (start < earliest) warnings.push({
        code: "FOLLOWER_STARTS_BEFORE_PREDECESSOR_ENDS", preceding_issue_id: preceding,
        following_issue_id: following, following_start_date: start, earliest_start_date: earliest,
      });
    }
    for (const change of changes) {
      if (change.status === "planned" && parents.has(change.issue_id))
        warnings.push({ code: "PARENT_DATES_MAY_BE_DERIVED", issue_id: change.issue_id });
    }
    return warnings;
  }

  async apply(input: unknown) {
    const args = applyScheduleSchema.parse(input);
    if (!args.changes.length && !args.dependencies.length) throw new Error("Provide at least one change or dependency");
    const changedIds = args.changes.map(change => change.issue_id);
    if (new Set(changedIds).size !== changedIds.length) throw new Error("Each issue may appear only once in changes");
    const ids = [...new Set([...changedIds, ...args.dependencies.flatMap(d => [d.issue_id, d.issue_to_id])])];
    if (ids.length > MAX_ISSUES) throw new Error(`At most ${MAX_ISSUES} distinct issues per call`);

    const before = await this.load(ids, new Set(changedIds));
    const { changes, dependencies, warnings } = this.plan(args, before, await this.parents(changedIds, before));
    if (!args.dry_run) {
      // Dates first, then dependencies: creating a precedes relation lets Redmine reschedule the follower.
      for (const change of changes.filter(change => change.status === "planned")) {
        const fields = Object.fromEntries((["start_date", "due_date"] as const)
          .filter(field => change.before![field] !== change.after![field]).map(field => [field, change.after![field]]));
        Object.assign(change, this.outcome(await this.client.write("PUT", `/issues/${change.issue_id}.json`,
          { issue: { ...fields, ...(args.notes ? { notes: args.notes } : {}) } })));
      }
      for (const dependency of dependencies.filter(dependency => dependency.status === "planned")) {
        const { issue_id, issue_to_id, relation_type, delay } = dependency;
        const result = await this.client.write("POST", `/issues/${issue_id}/relations.json`,
          { relation: { issue_to_id, relation_type, ...(delay !== undefined ? { delay } : {}) } });
        Object.assign(dependency, this.outcome(result));
        if (result.ok) dependency.relation_id = (result.data as { relation?: { id?: number } })?.relation?.id;
      }
    }
    const after = args.dry_run ? null : await this.verify(changes, dependencies, before);
    const count = (status: Status) => [...changes, ...dependencies].filter(item => item.status === status).length;
    return {
      dry_run: args.dry_run,
      summary: {
        planned: count("planned"), applied: count("applied"), failed: count("failed"), unchanged: count("unchanged"),
        invalid: count("invalid"), already_exists: count("already_exists"),
        not_verified: [...changes, ...dependencies].filter(item => item.verified === false).length,
      },
      changes, dependencies, warnings,
      ...(after ? { rescheduled_by_redmine: after } : {}),
      notes: args.dry_run ? [
        "Dry run: nothing was written. Call again with dry_run=false to apply; the plan is rebuilt from current data.",
        "Warnings use calendar days; Redmine also skips its configured non-working days.",
      ] : [
        "Writes are applied one at a time and are not atomic; a failure does not roll back earlier writes.",
        "Results were read back from Redmine; verified=false means Redmine stored something other than requested.",
        "rescheduled_by_redmine lists loaded issues (including direct predecessors and followers) whose dates Redmine changed on its own.",
      ],
    };
  }

  private outcome(result: Awaited<ReturnType<RedmineClient["write"]>>): Outcome {
    return result.ok ? { status: "applied" }
      : { status: "failed", code: result.code, ...(result.messages.length ? { messages: result.messages } : {}) };
  }

  /** Read back every loaded issue, mark what was stored, and report side effects. */
  private async verify(changes: ChangePlan[], dependencies: DependencyPlan[], before: Map<number, Issue>) {
    let current: Map<number, Issue>;
    try {
      current = await this.client.issuesById([...before.keys()], "relations");
    } catch {
      for (const item of [...changes, ...dependencies]) if (item.status === "applied") item.code = "READ_BACK_FAILED";
      return [];
    }
    for (const change of changes.filter(change => change.status === "applied")) {
      const issue = current.get(change.issue_id);
      change.stored = issue ? datesOf(issue) : undefined;
      change.verified = !!change.stored && sameDates(change.stored, change.after!);
    }
    for (const dependency of dependencies.filter(dependency => dependency.status === "applied")) {
      dependency.verified = (current.get(dependency.issue_id)?.relations ?? []).some(relation =>
        expresses(relation, dependency.issue_id, dependency.issue_to_id, dependency.relation_type));
    }
    const requested = new Map(changes.filter(change => change.status === "applied").map(change => [change.issue_id, change.after!]));
    return [...before.values()].flatMap(issue => {
      const now = current.get(issue.id);
      if (!now) return [];
      // Moved by Redmine: changed from before, and not what was requested (ignored writes keep the old dates).
      const stored = datesOf(now);
      const expected = requested.get(issue.id) ?? datesOf(issue);
      return sameDates(stored, expected) || sameDates(stored, datesOf(issue)) ? []
        : [{ issue_id: issue.id, before: datesOf(issue), after: stored }];
    });
  }
}
