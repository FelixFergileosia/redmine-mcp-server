# Cross-project schedule coverage

`getGanttData` finds working days without scheduled issue coverage for a user.
`getGanttDataDetail` explains selected dates using the scan's cached snapshot.
Both tools are read-only and work over stdio and shared stateless HTTP. They
respect the server's tool allow/deny patterns.

## Scan

```json
{
  "project_ids": "all_accessible",
  "user_id": "me",
  "user_scope": "author",
  "from": "2026-09-01",
  "to": "2026-09-30",
  "timezone": "Asia/Jakarta",
  "working_days": ["MON", "TUE", "WED", "THU", "FRI"],
  "excluded_dates": ["2026-09-04"]
}
```

The excluded date is illustrative; provide your own holidays and leave dates.
No holiday calendar is inferred from issue subjects. Include `SAT` when Saturday
is a working day.

`user_scope` defaults to `author`, for issues you created. Use `assignee` for work
assigned to you, or `author_or_assignee` for their union. `user_id` defaults to the
authenticated user and can also be a numeric Redmine user ID. Access always uses
the caller's API key, including scans of another user's issues.

`project_ids` accepts `all_accessible` or up to 50 numeric IDs. All-accessible
means every matching issue visible to the caller, including closed issues. It
does not enumerate empty projects or prove that inaccessible/private projects
have no work. Explicit IDs are checked for access; implicit subprojects are not
included unless explicitly selected. Issues are read in one user-filtered stream
per scope, rather than once per project or per day. Author-or-assignee uses two
streams and deduplicates by issue ID. Project selection is applied locally.

The result includes `scan_id`, `scanned_at`, `expires_at`, `projects_scanned`,
`issue_count`, `pages_read`, `complete`, `errors`, and daily coverage:

| Field | Meaning |
|---|---|
| `covered_dates` | At least one issue has a valid inclusive start/due interval covering the working day, across any selected project. |
| `gap_dates` | No issue covers the working day, the scan completed, and incomplete schedules cannot potentially cover it. These are candidates for missing records. |
| `uncertain_dates` | No confirmed coverage, but incomplete/invalid schedules or scan failures prevent a definite gap. |
| `uncovered_dates` | Union of gap and uncertain working days. Use this to find days requiring review. |
| `unscheduled_issue_count` | Issues with missing, invalid, or reversed start/due dates. |
| `daily[].created_issue_count` | Issues created that day, independently of scheduled coverage. Creation timestamps use the requested timezone. |

Schedule dates are calendar dates and are not shifted by timezone. An issue
created last month can cover this month. A working day with no newly created
issues can still be covered by an earlier multi-day issue. Closed/Done issues
participate in coverage. No duration is inferred from a single date, estimated
hours, status, parent dates, or creation timestamp.

A missing start date may potentially cover days up to its due date; a missing
due date may potentially cover days from its start date onward. Both missing,
invalid, or reversed dates make all otherwise-uncovered days uncertain. Confirmed
coverage takes precedence over uncertainty. Parent/child intervals are used only
as stored; plugin-specific date calculations are not reproduced.

Scans accept up to 366 days, a default total budget of 100 issue pages
(`max_pages`, configurable from 1 to 200), and at most 10,000 fetched rows.
Pagination follows returned row counts. Failed reads, malformed/repeated pages,
changed totals, ignored user filters, and budget exhaustion set `complete=false`;
uncovered days become uncertain rather than confirmed gaps. Creation counts are
partial when the scan is incomplete. A scan reads current records and is not an
atomic database snapshot or a reconstruction of historical edits.

## Detail

Use the actual `scan_id` returned above:

```json
{
  "scan_id": "<scan_id from getGanttData>",
  "dates": ["2026-09-08", "2026-09-09"],
  "include_nearby_issues": true,
  "include_unscheduled": true,
  "offset": 0,
  "limit": 50
}
```

Detail accepts 1 to 31 dates inside the scan range. It returns daily explanations
and covering issues, potentially relevant incomplete schedules, and scheduled
issues ending/starting within seven calendar days of the requested dates.
`include_nearby_issues` and `include_unscheduled` default to true. Issue results
are sorted by ID and paginated with `offset`, `limit` (1 to 100), and
`next_offset`. Follow `next_offset` to inspect all matches.

By default, the server validates current credentials and batch-checks the
visibility of only the selected issue page. It does not rescan user history.
Hidden/deleted/moved issues are omitted and reported as access errors. Cached
schedule fields remain the basis of the explanation, and `changed_since_scan`
compares each visible issue's update timestamp with the snapshot.

Set `include_description`, `include_relations`, or `include_journals` to true
only when needed. They fetch live data for the selected issue page, so those
fields can be newer than the cached schedule. Re-run the scan after edits or
calendar changes. Snapshots expire after ten minutes, may be evicted once 20
scans are retained, and are lost on restart. Each snapshot is bound to a hash of
the caller's API key; another key cannot retrieve it. Keys are never returned.
For multiple replicas, route both tools to the same process; no shared external
cache is introduced.

These tools analyze stored issue fields, not the plugin-rendered Gantt. A gap is
not proof that work was forgotten, and interval coverage does not prove that
hours were worked. Both tools leave issues, dates, relations and time entries
unchanged.

## Apply a schedule

`applySchedule` sets start/due dates and adds dependencies on several issues in
one call. `dry_run` defaults to `true`, so the first call only reports the plan:

```json
{
  "changes": [
    { "issue_id": 101, "due_date": "2026-09-08" },
    { "issue_id": 102, "start_date": "2026-09-09", "due_date": "2026-09-14" },
    { "issue_id": 103, "start_date": null }
  ],
  "dependencies": [
    { "issue_id": 101, "issue_to_id": 102, "relation_type": "precedes", "delay": 0 }
  ],
  "notes": "Rescheduled after sprint planning",
  "dry_run": true
}
```

Omit a date field to keep it, or pass `null` to clear it. Dependencies accept
`precedes`, `follows`, `blocks` and `blocked`; `delay` is only valid for
precedes/follows. At most 50 changes, 50 dependencies and 100 distinct issues
per call. `notes` becomes a journal entry on each issue whose dates change.

Each item gets a status: `planned`, `unchanged`, `invalid` (with a code such as
`REVERSED_DATES` or `ISSUE_NOT_VISIBLE`) or `already_exists` (the relation
exists in either direction). The plan also returns warnings:

| Warning | Meaning |
|---|---|
| `FOLLOWER_STARTS_BEFORE_PREDECESSOR_ENDS` | A following issue would start on or before its predecessor's due date plus delay. Redmine will reject that date, or move the follower when the relation is created. Uses calendar days; Redmine also skips its non-working days. |
| `PARENT_DATES_MAY_BE_DERIVED` | The issue has subtasks. With Redmine's default settings its dates come from the subtasks and the write is ignored. |

Warnings cover the requested issues plus the direct predecessors and followers
of changed issues.

With `dry_run: false`, dates are written first and dependencies second, one
request at a time. Writes are not atomic: a failure does not roll back earlier
writes. Each item becomes `applied` or `failed`; failures carry `HTTP_<status>`
and, for HTTP 422, Redmine's own validation messages. Everything is then read
back:

- `verified` is `false` when Redmine stored something other than requested (for
  example a parent whose dates are derived). `stored` shows the actual dates.
- `rescheduled_by_redmine` lists loaded issues whose dates Redmine changed on its
  own, such as followers moved by a new or tightened `precedes` relation. Issues
  further down a chain are not read back.

The tool is a write tool: it is hidden in read-only mode.

## Gantt implementation and export

`getGanttPluginCapabilities` reports which Gantt implementation this server can
recognize and what actually works with the caller's API key:

```json
{ "project_id": 1 }
```

Redmine's REST API does not list installed plugins or their versions, so an
implementation is recognized only through an adapter in `src/gantt/export.ts`.
The built-in adapter is `redmine_core` (Redmine's own Gantt). Plugins without an
adapter are not identified, and `version` is `null` because Redmine does not
expose it. Each export is probed with a header-only request:

| Status | Meaning |
|---|---|
| `available` | Redmine returned the file. |
| `requires_browser_session` | Redmine redirected to the login page or answered 401/403. |
| `not_supported` | Redmine answered 406, e.g. PNG without ImageMagick on the Redmine server. |
| `unavailable` | Any other answer; see `code`. |

Redmine accepts API keys for JSON/XML only. Its PDF/PNG Gantt routes therefore
run as the anonymous user (`rendered_as: "anonymous"`): on instances that
require login they are `requires_browser_session`, and where they are
`available` they show only publicly visible issues. Redmine core has no
baselines, and its working calendar is an admin setting the API does not
expose, so both are reported as unsupported.

`exportGantt` keeps the two kinds of output apart through `source`:

| `format` | `source` | Produced by |
|---|---|---|
| `pdf`, `png` | `redmine_plugin` | Redmine's own export, returned as `content_base64`. Covers whole months from `from`, up to 24 months. |
| `csv`, `mermaid` | `mcp_generated` | This server, from issue start/due dates. Not the plugin-rendered chart. |

```json
{ "format": "mermaid", "from": "2026-09-01", "to": "2026-09-30", "project_id": 1 }
```

MCP-generated charts include issues whose start and due dates overlap the range
(closed issues too unless `include_closed` is false), or exactly the issues in
`issue_ids`. They read up to `max_pages` pages and 500 issues; `complete` is
false when that limit or a read error cut the list short. CSV includes duration,
progress, parent and dependencies, and prefixes cells that start with `=`, `+`,
`-` or `@` so spreadsheets do not evaluate them. Mermaid draws one bar per
scheduled issue grouped by project; closed issues are `done`, issues with
progress are `active`, and dependencies are listed as comments. Plugin-specific
calculations (working-day calendars, baselines, derived dates) are not
reproduced. `REDMINE_MCP_MAX_DOWNLOAD_BYTES` limits Redmine's PDF/PNG exports.

## Development verification

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
```

Tests use local fixtures: schedule plans and writes against an in-memory
Redmine that rejects invalid dates, derives parent dates and reschedules
followers; export probing and CSV/Mermaid output; cross-project coverage, calendars, timezone conversion,
incomplete schedules, pagination, partial scans, ownership, expired/evicted
snapshots, permission changes, opt-in details, concurrent HTTP callers and stdio
registration. The HTTP tests bind to loopback and do not access live Redmine.
