/**
 * Shared text rendering helpers for MCP tool output.
 *
 * These helpers provide consistent, human-readable formatting for common
 * tool result shapes (tables, lists, key-value pairs, errors). Servers
 * can use them in their `renderText` functions to produce output that
 * is easy for LLMs to parse and for humans to read.
 *
 * @example
 * ```ts
 * import { formatTable, formatKeyValue } from "@universal-mcp-toolkit/core";
 *
 * defineTool({
 *   name: "list_users",
 *   description: "List all users in the workspace.",
 *   inputSchema: { ... },
 *   outputSchema: { ... },
 *   handler: async ({ limit }) => { ... },
 *   renderText: (output) => {
 *     return formatTable(output.users, ["id", "name", "email"], {
 *       headers: ["ID", "Name", "Email"],
 *     });
 *   },
 * });
 * ```
 */

/**
 * Column definition for {@link formatTable}.
 */
export interface TableColumn {
  /** The object key to read from each row. */
  key: string;
  /** Optional header label. Defaults to the key. */
  header?: string;
  /** Optional width constraint. If omitted, auto-sizes to content. */
  width?: number;
}

/**
 * Options for {@link formatTable}.
 */
export interface TableOptions {
  /** Column definitions. If omitted, infers from the first row's keys. */
  columns?: TableColumn[];
  /** Optional header labels (deprecated: use `columns[].header` instead). */
  headers?: string[];
  /** Separator between columns. Defaults to " | ". */
  separator?: string;
  /** Whether to include a header row. Defaults to true. */
  includeHeader?: boolean;
}

/**
 * Format an array of objects as a fixed-width text table.
 *
 * @param rows - Array of objects to render.
 * @param options - Column definitions and formatting options.
 * @returns A multi-line string with aligned columns.
 *
 * @example
 * ```ts
 * formatTable(
 *   [{ name: "Alice", age: 30 }, { name: "Bob", age: 25 }],
 *   { columns: [{ key: "name", header: "Name" }, { key: "age", header: "Age" }] }
 * );
 * // => "Name  | Age\nAlice | 30\nBob   | 25"
 * ```
 */
export function formatTable(
  rows: readonly Record<string, unknown>[],
  options: TableOptions = {},
): string {
  if (rows.length === 0) {
    return "(no data)";
  }

  const separator = options.separator ?? " | ";

  // Determine columns
  let columns: TableColumn[];
  if (options.columns) {
    columns = options.columns;
  } else {
    const keys = Object.keys(rows[0]!);
    columns = keys.map((key) => ({ key }));
  }

  // Build header row
  const headers = columns.map((col, i) => {
    const header = col.header ?? options.headers?.[i] ?? col.key;
    return header;
  });

  // Compute column widths
  const widths = columns.map((col, i) => {
    const headerLen = headers[i]!.length;
    const values = rows.map((row) => String(row[col.key] ?? "").length);
    const maxContent = values.length > 0 ? Math.max(...values) : 0;
    const width = col.width ?? Math.max(headerLen, maxContent);
    return width;
  });

  // Render rows
  const lines: string[] = [];

  if (options.includeHeader !== false) {
    const headerLine = headers
      .map((h, i) => h.padEnd(widths[i]!))
      .join(separator);
    lines.push(headerLine);

    // Add separator line
    const separatorLine = widths
      .map((w) => "-".repeat(w))
      .join(separator);
    lines.push(separatorLine);
  }

  for (const row of rows) {
    const cells = columns.map((col, i) => {
      const val = row[col.key];
      if (val === null || val === undefined) {
        return "".padEnd(widths[i]!);
      }
      if (typeof val === "object") {
        return JSON.stringify(val).padEnd(widths[i]!);
      }
      return String(val).padEnd(widths[i]!);
    });
    lines.push(cells.join(separator));
  }

  return lines.join("\n");
}

/**
 * Format a list of objects as a bulleted text list.
 *
 * @param items - Array of objects to render.
 * @param labelKey - The key to use as the label for each item.
 * @param detailKeys - Optional keys to show as sub-bullets.
 * @returns A multi-line bulleted string.
 *
 * @example
 * ```ts
 * formatList(
 *   [{ name: "Alice", role: "admin" }, { name: "Bob", role: "user" }],
 *   "name",
 *   ["role"]
 * );
 * // => "• Alice\n  role: admin\n• Bob\n  role: user"
 * ```
 */
export function formatList(
  items: readonly Record<string, unknown>[],
  labelKey: string,
  detailKeys?: string[],
): string {
  if (items.length === 0) {
    return "(no items)";
  }

  const lines: string[] = [];
  for (const item of items) {
    const label = String(item[labelKey] ?? "(no label)");
    lines.push(`• ${label}`);
    if (detailKeys) {
      for (const key of detailKeys) {
        const val = item[key];
        if (val !== undefined && val !== null) {
          lines.push(`  ${key}: ${typeof val === "object" ? JSON.stringify(val) : String(val)}`);
        }
      }
    }
  }

  return lines.join("\n");
}

/**
 * Format a key-value object as a readable text block.
 *
 * @param obj - The object to format.
 * @param options - Formatting options.
 * @returns A multi-line string with "key: value" pairs.
 *
 * @example
 * ```ts
 * formatKeyValue({ status: "ok", count: 42, active: true });
 * // => "status: ok\ncount: 42\nactive: true"
 * ```
 */
export function formatKeyValue(
  obj: Record<string, unknown>,
  options: { indent?: string; separator?: string } = {},
): string {
  const indent = options.indent ?? "";
  const separator = options.separator ?? ": ";

  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      continue;
    }
    const strValue = typeof value === "object" ? JSON.stringify(value) : String(value);
    lines.push(`${indent}${key}${separator}${strValue}`);
  }

  return lines.join("\n");
}

/**
 * Format an error object as a readable text block.
 *
 * @param error - The error to format (can be an Error, string, or unknown).
 * @returns A formatted error string with name, message, and details.
 *
 * @example
 * ```ts
 * try {
 *   await riskyOperation();
 * } catch (error) {
 *   return formatError(error);
 * }
 * // => "Error: Something went wrong\n  code: ECONNREFUSED\n  details: Connection refused"
 * ```
 */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    let result = `${error.name}: ${error.message}`;
    const details: string[] = [];

    // Include common error properties
    if ("code" in error && typeof (error as { code: unknown }).code === "string") {
      details.push(`code: ${(error as { code: string }).code}`);
    }
    if ("statusCode" in error) {
      details.push(`statusCode: ${(error as { statusCode: unknown }).statusCode}`);
    }
    if ("details" in error && (error as { details: unknown }).details !== undefined) {
      const d = (error as { details: unknown }).details;
      details.push(`details: ${typeof d === "object" ? JSON.stringify(d) : String(d)}`);
    }

    if (details.length > 0) {
      result += `\n  ${details.join("\n  ")}`;
    }

    return result;
  }

  if (typeof error === "string") {
    return error;
  }

  return String(error);
}

/**
 * Format a success/failure summary line.
 *
 * @param label - The operation that was performed.
 * @param success - Whether the operation succeeded.
 * @param details - Optional additional details.
 * @returns A formatted status line.
 *
 * @example
 * ```ts
 * formatStatus("Created issue", true, "Issue #42 created");
 * // => "✓ Created issue: Issue #42 created"
 * ```
 */
export function formatStatus(label: string, success: boolean, details?: string): string {
  const icon = success ? "✓" : "✗";
  const status = success ? "OK" : "FAILED";
  if (details) {
    return `${icon} ${label} (${status}): ${details}`;
  }
  return `${icon} ${label} (${status})`;
}
