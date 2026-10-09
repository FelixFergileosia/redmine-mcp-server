import { z } from "zod";
import { readLimitedBody } from "../api/binary.js";

export const ref = z.object({ id: z.number().int().positive(), name: z.string().optional() });
export const relationSchema = z.object({
  id: z.number().int().positive(), issue_id: z.number().int().positive(),
  issue_to_id: z.number().int().positive(), relation_type: z.string(), delay: z.number().nullable().optional(),
});
export const issueSchema = z.object({
  id: z.number().int().positive(), subject: z.string(), project: ref, author: ref,
  assigned_to: ref.optional(), status: ref.extend({ is_closed: z.boolean().optional() }),
  tracker: ref.optional(), parent: z.object({ id: z.number().int().positive() }).optional(),
  fixed_version: ref.optional(), done_ratio: z.number().optional(),
  start_date: z.string().nullable().optional(), due_date: z.string().nullable().optional(),
  created_on: z.string().optional(), updated_on: z.string().optional(),
  relations: z.array(relationSchema).optional(),
});
export type Issue = z.infer<typeof issueSchema>;
export type Relation = z.infer<typeof relationSchema>;
export type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;
export type ScanError = { scope: string; code: string };

export class ReadError extends Error {
  constructor(readonly code: string) { super(code); }
}

export const errorCode = (error: unknown): string =>
  error instanceof ReadError ? error.code : "INVALID_RESPONSE";

/** Shared page/row budget, so several issue streams can draw from one limit. */
export interface PageBudget { maxPages: number; maxRows: number; pagesRead: number; rowsRead: number }

export type WriteResult =
  | { ok: true; data: unknown }
  | { ok: false; code: string; messages: string[] };

export type BinaryStatus = "available" | "requires_browser_session" | "not_supported" | "unavailable";
export type BinaryResult =
  | { status: "available"; content_type: string; content?: Buffer }
  | { status: Exclude<BinaryStatus, "available">; code: string };

const validationMessages = z.object({ errors: z.array(z.string()) });

/**
 * Redmine access shared by the Gantt tools. Responses are validated and errors are reduced
 * to codes, so backend bodies, URLs, exception messages and credentials are never returned.
 */
export class RedmineClient {
  constructor(private readonly fetcher: Fetcher, private readonly maxBinaryBytes = 0) {}

  async read(path: string): Promise<unknown> {
    try {
      const response = await this.fetcher(path);
      if (!response.ok) throw new ReadError(`HTTP_${response.status}`);
      return await response.json();
    } catch (error) {
      throw error instanceof ReadError ? error : new ReadError("READ_FAILED");
    }
  }

  async currentUser(): Promise<number> {
    return z.object({ user: ref }).parse(await this.read("/users/current.json")).user.id;
  }

  /** Read visible issues by ID (any status) in one request. */
  async issuesById(ids: number[], include?: string): Promise<Map<number, Issue>> {
    const visible = new Map<number, Issue>();
    if (!ids.length) return visible;
    if (ids.length > 100) throw new Error("At most 100 issues can be read at once");
    const query = new URLSearchParams({ issue_id: ids.join(","), status_id: "*", limit: "100" });
    if (include) query.set("include", include);
    const response = z.object({ issues: z.array(issueSchema).max(100) })
      .parse(await this.read(`/issues.json?${query}`));
    for (const issue of response.issues) visible.set(issue.id, issue);
    return visible;
  }

  /**
   * Read every page of an issue query, checking pagination consistency.
   * `visit` may throw a ReadError to reject a page. Returns an error code, or null when complete.
   */
  async readIssuePages(params: Record<string, string>, budget: PageBudget, visit: (issue: Issue) => void): Promise<string | null> {
    let offset = 0;
    let expectedTotal: number | undefined;
    const seen = new Set<number>();
    while (true) {
      if (budget.pagesRead >= budget.maxPages || budget.rowsRead >= budget.maxRows) return "SCAN_LIMIT_REACHED";
      const query = new URLSearchParams({ ...params, limit: "100", offset: String(offset) });
      try {
        budget.pagesRead++;
        const page = z.object({
          issues: z.array(issueSchema).max(100), total_count: z.number().int().nonnegative(),
          offset: z.number().int().nonnegative(),
        }).parse(await this.read(`/issues.json?${query}`));
        if (page.offset !== offset) throw new ReadError("INVALID_PAGINATION");
        if (offset + page.issues.length > page.total_count) throw new ReadError("INVALID_PAGINATION");
        if (expectedTotal !== undefined && expectedTotal !== page.total_count)
          throw new ReadError("RESULT_CHANGED_DURING_SCAN");
        expectedTotal = page.total_count;
        if (!page.issues.length && offset < page.total_count) throw new ReadError("INCOMPLETE_PAGE");
        for (const issue of page.issues) {
          if (seen.has(issue.id)) throw new ReadError("REPEATED_ISSUE_PAGE");
          seen.add(issue.id);
          visit(issue);
        }
        budget.rowsRead += page.issues.length;
        offset += page.issues.length;
        if (offset >= page.total_count) return null;
      } catch (error) {
        return errorCode(error);
      }
    }
  }

  /** Send a JSON write. Redmine validation messages (HTTP 422) are returned; other bodies are not. */
  async write(method: "POST" | "PUT", path: string, body: unknown): Promise<WriteResult> {
    try {
      const response = await this.fetcher(path, {
        method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const text = await response.text();
      if (response.ok) return { ok: true, data: text ? JSON.parse(text) : null };
      let messages: string[] = [];
      if (response.status === 422) {
        try { messages = validationMessages.parse(JSON.parse(text)).errors.slice(0, 10).map(m => m.slice(0, 300)); }
        catch { /* not a Redmine validation body */ }
      }
      return { ok: false, code: `HTTP_${response.status}`, messages };
    } catch {
      return { ok: false, code: "WRITE_FAILED", messages: [] };
    }
  }

  /**
   * Fetch a non-API resource (such as a Gantt export) without following redirects.
   * With `probe`, only headers are requested. Redmine accepts API keys for JSON/XML only,
   * so most HTML-session exports report `requires_browser_session`.
   */
  async binary(path: string, expectedType: string, probe = false): Promise<BinaryResult> {
    try {
      const response = await this.fetcher(path, { method: probe ? "HEAD" : "GET", redirect: "manual" });
      const type = response.headers.get("content-type") ?? "";
      const location = response.headers.get("location") ?? "";
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        return /\/login\b/.test(location)
          ? { status: "requires_browser_session", code: "REDIRECT_TO_LOGIN" }
          : { status: "unavailable", code: `HTTP_${response.status}` };
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        return { status: "requires_browser_session", code: `HTTP_${response.status}` };
      }
      if (response.status === 406) {
        await response.body?.cancel();
        return { status: "not_supported", code: "HTTP_406" };
      }
      if (!response.ok || !type.startsWith(expectedType)) {
        await response.body?.cancel();
        return { status: "unavailable", code: response.ok ? "UNEXPECTED_CONTENT_TYPE" : `HTTP_${response.status}` };
      }
      return probe
        ? { status: "available", content_type: type }
        : { status: "available", content_type: type, content: await readLimitedBody(response, this.maxBinaryBytes, "Gantt export") };
    } catch (error) {
      // readLimitedBody's size error is safe to surface; anything else is reduced to a code.
      if (error instanceof Error && error.message.includes("exceeds limit")) throw error;
      return { status: "unavailable", code: "READ_FAILED" };
    }
  }
}
