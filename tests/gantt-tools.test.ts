import test from "node:test";
import assert from "node:assert/strict";
import { GanttExportService } from "../src/gantt/export.js";
import { ScheduleService } from "../src/gantt/schedule.js";

type Row = {
  id: number; subject: string; project: { id: number; name: string }; author: { id: number };
  status: { id: number; name: string; is_closed: boolean }; start_date: string | null; due_date: string | null;
  done_ratio?: number; parent?: { id: number }; updated_on: string;
};
type StoredRelation = { id: number; issue_id: number; issue_to_id: number; relation_type: string; delay: number | null };

const row = (id: number, start: string | null, due: string | null, changes: Partial<Row> = {}): Row => ({
  id, subject: `Task ${id}`, project: { id: 1, name: "Collector" }, author: { id: 12 },
  status: { id: 1, name: "New", is_closed: false }, start_date: start, due_date: due,
  updated_on: "2026-10-01T00:00:00Z", ...changes,
});

const addDays = (date: string, days: number) => new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);

/** In-memory Redmine that imitates the behaviors applySchedule must report. */
function redmine(rows: Row[], options: { relations?: StoredRelation[]; hidden?: number[]; pdf?: "ok" | "login" } = {}) {
  const issues = new Map(rows.map(issue => [issue.id, structuredClone(issue)]));
  const relations = [...(options.relations ?? [])];
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  const hidden = new Set(options.hidden ?? []);
  const withRelations = (issue: Row, include: string | null) => include?.includes("relations")
    ? { ...issue, relations: relations.filter(r => r.issue_id === issue.id || r.issue_to_id === issue.id) } : issue;
  // Redmine moves followers whose start is not after the predecessor's due date plus delay.
  const reschedule = (precedingId: number) => {
    for (const relation of relations.filter(r => r.relation_type === "precedes" && r.issue_id === precedingId)) {
      const preceding = issues.get(precedingId)!; const following = issues.get(relation.issue_to_id)!;
      if (!preceding.due_date || !following.start_date) continue;
      const earliest = addDays(preceding.due_date, (relation.delay ?? 0) + 1);
      if (following.start_date < earliest) {
        const length = following.due_date ? (Date.parse(following.due_date) - Date.parse(following.start_date)) / 86_400_000 : 0;
        following.start_date = earliest;
        if (following.due_date) following.due_date = addDays(earliest, length);
        reschedule(following.id);
      }
    }
  };
  const fetcher = async (path: string, init: RequestInit = {}) => {
    const url = new URL(path, "http://redmine.test");
    const method = init.method ?? "GET";
    if (method === "PUT" || method === "POST") writes.push({ method, path: url.pathname, body: JSON.parse(String(init.body)) });
    if (url.pathname === "/users/current.json") return Response.json({ user: { id: 12, name: "Felix" } });
    if (url.pathname === "/issues.json") {
      const ids = url.searchParams.get("issue_id")?.split(",").map(Number);
      let list = [...issues.values()].filter(issue => !hidden.has(issue.id) && (!ids || ids.includes(issue.id)));
      const from = url.searchParams.get("due_date")?.slice(2); const to = url.searchParams.get("start_date")?.slice(2);
      if (from && to) list = list.filter(issue => issue.start_date && issue.due_date && issue.start_date <= to && issue.due_date >= from);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      return Response.json({
        issues: list.slice(offset, offset + 100).map(issue => withRelations(issue, url.searchParams.get("include"))),
        total_count: list.length, offset,
      });
    }
    const issueMatch = url.pathname.match(/^\/issues\/(\d+)\.json$/);
    if (issueMatch && method === "GET") {
      const issue = issues.get(Number(issueMatch[1]));
      if (!issue || hidden.has(issue.id)) return new Response(null, { status: 404 });
      return Response.json({ issue: { ...issue, children: [...issues.values()].filter(child => child.parent?.id === issue.id).map(child => ({ id: child.id })) } });
    }
    if (issueMatch && method === "PUT") {
      const issue = issues.get(Number(issueMatch[1]));
      if (!issue || hidden.has(issue.id)) return new Response(null, { status: 404 });
      const changes = (JSON.parse(String(init.body)) as { issue: Partial<Row> }).issue;
      const next = { ...issue, ...changes };
      if (next.start_date && next.due_date && next.start_date > next.due_date)
        return Response.json({ errors: ["Due date must be greater than start date"] }, { status: 422 });
      for (const relation of relations.filter(r => r.relation_type === "precedes" && r.issue_to_id === issue.id)) {
        const due = issues.get(relation.issue_id)!.due_date;
        if (due && next.start_date && next.start_date < addDays(due, (relation.delay ?? 0) + 1))
          return Response.json({ errors: ["Start date cannot be earlier than the preceding issue allows"] }, { status: 422 });
      }
      const isParent = [...issues.values()].some(child => child.parent?.id === issue.id);
      if (!isParent) Object.assign(issue, changes); // parent dates are derived from subtasks
      reschedule(issue.id);
      return new Response(null, { status: 204 });
    }
    const relationMatch = url.pathname.match(/^\/issues\/(\d+)\/relations\.json$/);
    if (relationMatch && method === "POST") {
      const body = (JSON.parse(String(init.body)) as { relation: { issue_to_id: number; relation_type: string; delay?: number } }).relation;
      let from = Number(relationMatch[1]); let to = body.issue_to_id; let type = body.relation_type;
      if (type === "follows") [from, to, type] = [to, from, "precedes"];
      if (type === "blocked") [from, to, type] = [to, from, "blocks"];
      const relation = { id: 100 + relations.length, issue_id: from, issue_to_id: to, relation_type: type, delay: body.delay ?? null };
      relations.push(relation);
      if (type === "precedes") reschedule(from);
      return Response.json({ relation }, { status: 201 });
    }
    if (url.pathname.startsWith("/projects/") && url.pathname.endsWith(".json"))
      return Response.json({ project: { id: 1, name: "Collector", enabled_modules: [{ name: "issue_tracking" }, { name: "gantt" }] } });
    if (/\/issues\/gantt\.pdf$/.test(url.pathname)) {
      if (options.pdf !== "ok") return new Response(null, { status: 302, headers: { Location: "http://redmine.test/login?back_url=x" } });
      return new Response(method === "HEAD" ? null : "%PDF-1.4 fake", { headers: { "Content-Type": "application/pdf" } });
    }
    if (/\/issues\/gantt\.png$/.test(url.pathname)) return new Response(null, { status: 406 });
    throw new Error(`Unexpected ${method} ${path}`);
  };
  return { fetcher, issues, relations, writes };
}

test("dry run plans changes, flags invalid and existing items, warns about precedence, and writes nothing", async () => {
  const r = redmine([row(1, "2026-09-01", "2026-09-05"), row(2, "2026-09-03", "2026-09-04"), row(3, null, null)],
    { relations: [{ id: 50, issue_id: 1, issue_to_id: 3, relation_type: "precedes", delay: null }] });
  const result = await new ScheduleService(r.fetcher).apply({
    changes: [
      { issue_id: 1, due_date: "2026-09-06" },
      { issue_id: 2, start_date: "2026-09-10", due_date: "2026-09-09" },
      { issue_id: 3, start_date: null },
      { issue_id: 99, due_date: "2026-09-09" },
    ],
    dependencies: [
      { issue_id: 1, issue_to_id: 2, relation_type: "precedes" },
      { issue_id: 3, issue_to_id: 1, relation_type: "follows" },
    ],
  });
  assert.equal(result.dry_run, true);
  assert.equal(r.writes.length, 0);
  assert.deepEqual(result.changes.map(c => [c.issue_id, c.status, c.code]), [
    [1, "planned", undefined], [2, "invalid", "REVERSED_DATES"], [3, "unchanged", undefined], [99, "invalid", "ISSUE_NOT_VISIBLE"],
  ]);
  assert.deepEqual(result.dependencies.map(d => d.status), ["planned", "already_exists"]);
  assert.deepEqual(result.warnings, [{
    code: "FOLLOWER_STARTS_BEFORE_PREDECESSOR_ENDS", preceding_issue_id: 1, following_issue_id: 2,
    following_start_date: "2026-09-03", earliest_start_date: "2026-09-07",
  }]);
  assert.equal(result.summary.planned, 2);
});

test("apply writes changed fields only, reports per-issue failures and verifies by reading back", async () => {
  const r = redmine([row(1, "2026-09-01", "2026-09-05"), row(2, "2026-09-08", "2026-09-09"),
    row(3, "2026-09-01", "2026-09-30"), row(4, "2026-09-02", "2026-09-03", { parent: { id: 3 } }),
    row(5, "2026-09-01", "2026-09-10"), row(6, "2026-09-11", "2026-09-12")],
  { relations: [{ id: 80, issue_id: 5, issue_to_id: 6, relation_type: "precedes", delay: null }] });
  const result = await new ScheduleService(r.fetcher).apply({
    dry_run: false, notes: "Rescheduled by planning",
    changes: [
      { issue_id: 1, due_date: "2026-09-10" },
      { issue_id: 3, start_date: "2026-09-15" },
      { issue_id: 6, start_date: "2026-09-05" },
    ],
    dependencies: [{ issue_id: 1, issue_to_id: 2, relation_type: "precedes", delay: 1 }],
  });
  assert.deepEqual(r.writes[0], { method: "PUT", path: "/issues/1.json", body: { issue: { due_date: "2026-09-10", notes: "Rescheduled by planning" } } });
  const byId = new Map(result.changes.map(c => [c.issue_id, c]));
  assert.equal(byId.get(1)!.status, "applied");
  assert.equal(byId.get(1)!.verified, true);
  // Issue 6 would start before its predecessor ends: the plan warns and Redmine rejects it.
  assert.ok(result.warnings.some(w => w.code === "FOLLOWER_STARTS_BEFORE_PREDECESSOR_ENDS" && w.following_issue_id === 6));
  assert.equal(byId.get(6)!.status, "failed");
  assert.equal(byId.get(6)!.code, "HTTP_422");
  assert.deepEqual(byId.get(6)!.messages, ["Start date cannot be earlier than the preceding issue allows"]);
  assert.equal(r.issues.get(6)!.start_date, "2026-09-11");
  // Issue 3 is a parent: Redmine keeps derived dates, so the write "succeeds" but is not verified.
  assert.equal(byId.get(3)!.status, "applied");
  assert.equal(byId.get(3)!.verified, false);
  assert.deepEqual(byId.get(3)!.stored, { start_date: "2026-09-01", due_date: "2026-09-30" });
  assert.equal(result.dependencies[0].status, "applied");
  assert.equal(result.dependencies[0].verified, true);
  assert.equal(result.dependencies[0].relation_id, 101);
  // Creating "1 precedes 2 (+1d)" made Redmine move issue 2.
  assert.ok(result.rescheduled_by_redmine!.some(item => item.issue_id === 2
    && item.after.start_date === "2026-09-12" && item.after.due_date === "2026-09-13"));
  assert.ok(result.warnings.some(w => w.code === "PARENT_DATES_MAY_BE_DERIVED" && w.issue_id === 3));
  // An ignored write is reported through verified=false, not as a Redmine reschedule.
  assert.equal(result.rescheduled_by_redmine!.some(item => item.issue_id === 3), false);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.summary.not_verified, 1);
});

test("apply reports followers that Redmine reschedules even when not named in the request", async () => {
  const r = redmine([row(1, "2026-09-01", "2026-09-05"), row(2, "2026-09-06", "2026-09-07")],
    { relations: [{ id: 60, issue_id: 1, issue_to_id: 2, relation_type: "precedes", delay: null }] });
  const result = await new ScheduleService(r.fetcher).apply({ dry_run: false, changes: [{ issue_id: 1, due_date: "2026-09-08" }] });
  assert.equal(result.changes[0].verified, true);
  assert.deepEqual(result.rescheduled_by_redmine, [{
    issue_id: 2, before: { start_date: "2026-09-06", due_date: "2026-09-07" }, after: { start_date: "2026-09-09", due_date: "2026-09-10" },
  }]);
});

test("applySchedule rejects empty, duplicate and self-referencing input", async () => {
  const service = new ScheduleService(redmine([]).fetcher);
  await assert.rejects(service.apply({}), /at least one change/);
  await assert.rejects(service.apply({ changes: [{ issue_id: 1, due_date: "2026-09-01" }, { issue_id: 1, start_date: "2026-09-01" }] }), /only once/);
  await assert.rejects(service.apply({ dependencies: [{ issue_id: 1, issue_to_id: 1 }] }), /itself/);
  await assert.rejects(service.apply({ dependencies: [{ issue_id: 1, issue_to_id: 2, relation_type: "blocks", delay: 2 }] }), /delay/);
  await assert.rejects(service.apply({ changes: [{ issue_id: 1 }] }), /start_date and\/or due_date/);
});

test("capabilities report core adapter exports as probed, without claiming plugin detection", async () => {
  const r = redmine([]);
  const result = await new GanttExportService(r.fetcher).capabilities({ project_id: 1 });
  assert.equal(result.identified[0].id, "redmine_core");
  assert.equal(result.identified[0].version, null);
  assert.equal(result.identified[0].exports.pdf.status, "requires_browser_session");
  assert.equal(result.identified[0].exports.pdf.rendered_as, "anonymous");
  assert.equal(result.identified[0].exports.png.status, "not_supported");
  assert.equal(result.identified[0].features.baseline.supported, false);
  assert.equal(result.project?.gantt_module_enabled, true);
  assert.match(result.identification.limitation, /does not list installed plugins/);
  assert.deepEqual(result.mcp_generated_exports.map(e => e.format), ["csv", "mermaid"]);
});

test("plugin export returns Redmine's file when available and explains when it is not", async () => {
  const ok = await new GanttExportService(redmine([], { pdf: "ok" }).fetcher)
    .export({ format: "pdf", from: "2026-09-01", to: "2026-10-31", project_id: 1 });
  assert.equal(ok.source, "redmine_plugin");
  assert.equal((ok as { rendered_as: string }).rendered_as, "anonymous");
  assert.equal(Buffer.from((ok as { content_base64: string }).content_base64, "base64").toString(), "%PDF-1.4 fake");
  await assert.rejects(new GanttExportService(redmine([]).fetcher).export({ format: "pdf", from: "2026-09-01", to: "2026-09-30" }),
    /requires_browser_session.*csv or mermaid/);
  await assert.rejects(new GanttExportService(redmine([], { pdf: "ok" }).fetcher, 5)
    .export({ format: "pdf", from: "2026-09-01", to: "2026-09-30" }), /exceeds limit/);
  await assert.rejects(new GanttExportService(redmine([]).fetcher).export({ format: "png", source: "mcp", from: "2026-09-01", to: "2026-09-30" }), /csv and mermaid only/);
  await assert.rejects(new GanttExportService(redmine([]).fetcher).export({ format: "pdf", from: "2026-01-01", to: "2028-01-01" }), /366 days/);
});

test("MCP-generated csv and mermaid are labelled, escaped, and include dependencies", async () => {
  const r = redmine([
    row(1, "2026-09-01", "2026-09-03", { subject: "=SUM(A1), \"quoted\"", status: { id: 5, name: "Closed", is_closed: true } }),
    row(2, "2026-09-04", "2026-09-05", { subject: "Deploy: prod; #1", done_ratio: 50, project: { id: 2, name: "Ops" } }),
    row(3, "2026-11-01", "2026-11-02"),
  ], { relations: [{ id: 70, issue_id: 1, issue_to_id: 2, relation_type: "precedes", delay: 2 }] });
  const service = new GanttExportService(r.fetcher);
  const csv = await service.export({ format: "csv", from: "2026-09-01", to: "2026-09-30" }) as { source: string; content: string; issue_count: number };
  assert.equal(csv.source, "mcp_generated");
  assert.equal(csv.issue_count, 2);
  const lines = csv.content.trim().split("\r\n");
  assert.equal(lines[1], "1,Collector,,\"'=SUM(A1), \"\"quoted\"\"\",Closed,true,,2026-09-01,2026-09-03,3,,,precedes #2 (+2d)");
  assert.ok(lines[2].endsWith(",follows #1 (+2d)"));
  const mermaid = await service.export({ format: "mermaid", from: "2026-09-01", to: "2026-09-30" }) as { content: string };
  assert.match(mermaid.content, /^gantt\n/);
  assert.match(mermaid.content, /section Collector\n {4}=SUM\(A1\), "quoted" \(1\) :done, i1, 2026-09-01, 3d/);
  assert.match(mermaid.content, /section Ops\n {4}Deploy prod 1 \(2\) :active, i2, 2026-09-04, 2d/);
  assert.match(mermaid.content, /%% #1 precedes #2 \(\+2d\)/);
  const selected = await service.export({ format: "mermaid", from: "2026-09-01", to: "2026-09-30", issue_ids: [3, 404] }) as { content: string; complete: boolean; errors: unknown[] };
  assert.match(selected.content, /i3, 2026-11-01, 2d/);
  assert.equal(selected.complete, false);
  assert.deepEqual(selected.errors, [{ scope: "issue:404", code: "ISSUE_NOT_VISIBLE" }]);
});
