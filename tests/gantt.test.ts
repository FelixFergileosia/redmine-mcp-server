import test from "node:test";
import assert from "node:assert/strict";
import { GanttService } from "../src/gantt/service.js";
import { ganttDataSchema, ganttDetailSchema } from "../src/schemas/gantt.js";

const issue = (id: number, changes: Record<string, unknown> = {}) => ({
  id, subject: `Task ${id}`, project: { id: 11, name: "Collector" },
  author: { id: 12, name: "Felix" }, assigned_to: { id: 12, name: "Felix" },
  status: { id: 2, name: "Done", is_closed: true },
  start_date: "2026-09-07", due_date: "2026-09-07",
  created_on: "2026-08-01T00:00:00Z", updated_on: "2026-09-07T00:00:00Z", ...changes,
});
const input = { from: "2026-09-07", to: "2026-09-11" };

function fixture(rows: ReturnType<typeof issue>[], options: {
  pageSize?: number; failOffset?: number; failProject?: number;
  repeat?: boolean; ignoredFilter?: boolean;
} = {}) {
  let caller = "alice-key-hash";
  let now = Date.parse("2026-10-09T00:00:00Z");
  let revoked = false;
  const hidden = new Set<number>();
  const calls: URL[] = [];
  const fetcher = async (path: string) => {
    const url = new URL(path, "http://redmine.test"); calls.push(url);
    if (revoked) return Response.json({}, { status: 401 });
    if (url.pathname === "/users/current.json")
      return Response.json({ user: { id: 12, name: "Felix", api_key: "must-never-appear" } });
    if (/^\/projects\//.test(url.pathname)) {
      const id = Number(url.pathname.split("/")[2].split(".")[0]);
      return id === options.failProject ? Response.json({}, { status: 403 })
        : Response.json({ project: { id, name: `Project ${id}` } });
    }
    if (url.pathname === "/issues.json") {
      assert.equal(url.searchParams.get("status_id"), "*");
      const ids = url.searchParams.get("issue_id");
      if (ids) return Response.json({ issues: rows.filter(row => ids.split(",").includes(String(row.id)) && !hidden.has(row.id)) });
      const offset = Number(url.searchParams.get("offset"));
      if (offset === options.failOffset) return Response.json({ error: "SECRET upstream body" }, { status: 503 });
      const filter = url.searchParams.has("author_id") ? "author" : "assigned_to";
      const filtered = rows.filter(row => options.ignoredFilter || (row[filter] as { id: number })?.id === 12);
      return Response.json({
        issues: filtered.slice(options.repeat ? 0 : offset, (options.repeat ? 0 : offset) + (options.pageSize ?? 100)),
        total_count: filtered.length, offset,
      });
    }
    if (/^\/issues\//.test(url.pathname)) {
      const id = Number(url.pathname.split("/")[2].split(".")[0]);
      return Response.json({ issue: {
        ...rows.find(row => row.id === id), description: "Detailed work", relations: [{ issue_to_id: 99 }],
        journals: [{ notes: "Review note" }],
      } });
    }
    throw new Error(`Unexpected path ${path}`);
  };
  return {
    service: new GanttService(fetcher, () => caller, () => now), calls, hidden,
    setCaller: (value: string) => { caller = value; },
    advance: (ms: number) => { now += ms; }, revoke: () => { revoked = true; },
  };
}

test("coverage unions projects, includes closed issues and does not use creation dates as schedule", async () => {
  const f = fixture([
    issue(1, { start_date: "2026-09-07", due_date: "2026-09-08" }),
    issue(2, { project: { id: 6, name: "MIS" }, start_date: "2026-09-09", due_date: "2026-09-11" }),
    issue(3, { start_date: "2026-11-01", due_date: "2026-11-02", created_on: "2026-09-07T17:30:00Z" }),
  ]);
  const scan = await f.service.scan(input);
  assert.equal(scan.complete, true);
  assert.deepEqual(scan.gap_dates, []);
  assert.equal(scan.covered_dates.length, 5);
  assert.equal(scan.daily[1].created_issue_count, 1);
  assert.deepEqual(scan.daily[2].project_ids, [6]);
  assert.equal(scan.daily[0].created_issue_count, 0);
  assert.equal(JSON.stringify(scan).includes("must-never-appear"), false);
  assert.equal(JSON.stringify(scan).includes("Task 1"), false);
});

test("working calendar excludes holidays/weekends and supports Saturday", async () => {
  const f = fixture([]);
  const scan = await f.service.scan({ ...input, to: "2026-09-13", excluded_dates: ["2026-09-09"] });
  assert.deepEqual(scan.gap_dates, ["2026-09-07", "2026-09-08", "2026-09-10", "2026-09-11"]);
  const saturday = await f.service.scan({ from: "2026-09-12", to: "2026-09-13", working_days: ["SAT"] });
  assert.deepEqual(saturday.gap_dates, ["2026-09-12"]);
});

test("missing/invalid/reversed schedules are uncertain without inferring single-day durations", async () => {
  const f = fixture([issue(1, { start_date: "2026-09-09", due_date: null })]);
  const scan = await f.service.scan(input);
  assert.deepEqual(scan.gap_dates, ["2026-09-07", "2026-09-08"]);
  assert.deepEqual(scan.uncertain_dates, ["2026-09-09", "2026-09-10", "2026-09-11"]);
  for (const dates of [
    { start_date: null, due_date: null },
    { start_date: "2026-02-30", due_date: "2026-09-08" },
    { start_date: "2026-09-11", due_date: "2026-09-07" },
  ]) {
    const result = await fixture([issue(1, dates)]).service.scan(input);
    assert.equal(result.gap_dates.length, 0);
    assert.equal(result.uncertain_dates.length, 5);
  }
});

test("confirmed coverage takes precedence over uncertain schedules", async () => {
  const scan = await fixture([issue(1), issue(2, { start_date: null, due_date: null })]).service.scan(input);
  assert.deepEqual(scan.covered_dates, ["2026-09-07"]);
  assert.equal(scan.uncertain_dates.length, 4);
});

test("pagination uses returned row count and author-or-assignee deduplicates", async () => {
  const f = fixture([
    issue(1), issue(2, { author: { id: 99, name: "Other" } }),
    issue(3, { assigned_to: { id: 99, name: "Other" } }),
  ], { pageSize: 1 });
  const scan = await f.service.scan({ ...input, user_scope: "author_or_assignee" });
  assert.equal(scan.issue_count, 3);
  assert.equal(scan.pages_read, 4);
  assert.equal(scan.complete, true);
});

test("large scans fetch every page rather than assuming the first 100 issues is complete", async () => {
  const f = fixture(Array.from({ length: 101 }, (_, i) => issue(i + 1)));
  const scan = await f.service.scan(input);
  assert.equal(scan.issue_count, 101);
  assert.equal(scan.pages_read, 2);
});

test("limits, failed pages, repeated pages and ignored user filters cannot report definite gaps", async () => {
  const failures = [
    fixture([issue(1), issue(2)], { pageSize: 1, failOffset: 1 }),
    fixture([issue(1), issue(2)], { pageSize: 1, repeat: true }),
    fixture([issue(1, { author: { id: 99, name: "Other" } })], { ignoredFilter: true }),
  ];
  for (const f of failures) {
    const scan = await f.service.scan(input);
    assert.equal(scan.complete, false);
    assert.equal(scan.gap_dates.length, 0);
    assert.equal(JSON.stringify(scan).includes("SECRET"), false);
  }
  const limited = await fixture([issue(1), issue(2)], { pageSize: 1 }).service.scan({ ...input, max_pages: 1 });
  assert.equal(limited.complete, false);
  assert.equal(limited.errors[0].code, "SCAN_LIMIT_REACHED");
});

test("explicit projects exclude unrelated issues, including implicit subprojects", async () => {
  const f = fixture([issue(1), issue(2, { project: { id: 6, name: "MIS" } })]);
  const scan = await f.service.scan({ ...input, project_ids: [11] });
  assert.equal(scan.issue_count, 1);
  assert.deepEqual(scan.projects_scanned.map(project => project.id), [11]);
  const denied = await fixture([], { failProject: 6 }).service.scan({ ...input, project_ids: [11, 6] });
  assert.equal(denied.complete, false);
  assert.equal(denied.gap_dates.length, 0);
  assert.equal(denied.errors[0].scope, "project:6");
});

test("detail uses cached schedule and paginates without rescanning user history", async () => {
  const f = fixture([issue(1), issue(2), issue(3, { start_date: null, due_date: null })]);
  const scan = await f.service.scan(input);
  f.calls.length = 0;
  const detail = await f.service.detail({ scan_id: scan.scan_id, dates: ["2026-09-08"], limit: 1 });
  assert.equal(detail.data_source, "cached_snapshot");
  assert.equal(detail.total_matching_issues, 3);
  assert.equal(detail.next_offset, 1);
  assert.equal(detail.issues[0].selection_reason, "nearby_schedule");
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].searchParams.has("author_id"), false);
  const second = await f.service.detail({ scan_id: scan.scan_id, dates: ["2026-09-08"], offset: 2 });
  assert.equal(second.issues[0].selection_reason, "uncertain_schedule");
});

test("descriptions, relations and journals are fetched only when requested", async () => {
  const f = fixture([issue(1)]);
  const scan = await f.service.scan(input);
  const args = { scan_id: scan.scan_id, dates: ["2026-09-07"] };
  const compact = await f.service.detail(args);
  assert.equal(compact.issues[0].description, undefined);
  const detailed = await f.service.detail({ ...args, include_description: true, include_relations: true, include_journals: true });
  assert.equal(detailed.issues[0].description, "Detailed work");
  assert.deepEqual(detailed.issues[0].journals, [{ notes: "Review note" }]);
  assert.equal(f.calls.at(-1)?.searchParams.get("include"), "relations,journals");
});

test("cache is isolated by caller and expires after ten minutes", async () => {
  const f = fixture([issue(1)]);
  const scan = await f.service.scan(input);
  const args = { scan_id: scan.scan_id, dates: ["2026-09-07"] };
  f.setCaller("bob-key-hash");
  await assert.rejects(f.service.detail(args), /unavailable or expired/);
  f.setCaller("alice-key-hash");
  f.advance(10 * 60 * 1000);
  await assert.rejects(f.service.detail(args), /unavailable or expired/);
});

test("detail rechecks revoked credentials and private issue visibility", async () => {
  const f = fixture([issue(1)]);
  const scan = await f.service.scan(input);
  f.hidden.add(1);
  const detail = await f.service.detail({ scan_id: scan.scan_id, dates: ["2026-09-07"] });
  assert.equal(detail.issues.length, 0);
  assert.equal(detail.complete, false);
  f.revoke();
  await assert.rejects(f.service.detail({ scan_id: scan.scan_id, dates: ["2026-09-07"] }), /HTTP_401/);
});

test("bounded cache evicts old snapshots", async () => {
  const f = fixture([]);
  const first = await f.service.scan(input);
  for (let i = 0; i < 20; i++) await f.service.scan(input);
  await assert.rejects(f.service.detail({ scan_id: first.scan_id, dates: ["2026-09-07"] }), /unavailable or expired/);
});

test("invalid dates, reversed/oversized ranges and invalid timezone are rejected", async () => {
  assert.throws(() => ganttDataSchema.parse({ ...input, from: "2026-02-30" }));
  assert.throws(() => ganttDataSchema.parse({ ...input, timezone: "Atlantis/Nowhere" }));
  assert.throws(() => ganttDetailSchema.parse({ scan_id: "bad", dates: ["2026-09-07"] }));
  const f = fixture([]);
  await assert.rejects(f.service.scan({ from: "2026-09-11", to: "2026-09-07" }), /1 to 366/);
  await assert.rejects(f.service.scan({ from: "2025-01-01", to: "2026-09-07" }), /1 to 366/);
  const scan = await f.service.scan(input);
  await assert.rejects(f.service.detail({ scan_id: scan.scan_id, dates: ["2026-10-01"] }), /inside the scan range/);
});
