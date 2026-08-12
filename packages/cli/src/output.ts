import chalk from "chalk";
import Table from "cli-table3";

import type { ServerRegistryEntry } from "./registry.js";

export function renderServerTable(entries: readonly ServerRegistryEntry[]): string {
  const table = new Table({
    head: [chalk.cyan("ID"), chalk.cyan("Title"), chalk.cyan("Category"), chalk.cyan("Env"), chalk.cyan("Description")],
    colWidths: [24, 22, 18, 22, 54],
    wordWrap: true,
    style: {
      head: [],
      border: ["gray"],
    },
  });

  for (const entry of entries) {
    const experimentalBadge = entry.experimental ? chalk.yellow(" [EXPERIMENTAL]") : "";
    table.push([
      chalk.white(entry.id),
      `${chalk.bold(entry.title)}${experimentalBadge}`,
      chalk.magenta(entry.category),
      entry.envVarNames.length === 0 ? chalk.gray("none") : chalk.yellow(entry.envVarNames.join(", ")),
      entry.description,
    ]);
  }

  const hasExperimental = entries.some((e) => e.experimental);
  const footer = hasExperimental
    ? `\n${chalk.yellow("Items marked [EXPERIMENTAL] may change or be removed in future releases.")}`
    : "";

  return table.toString() + footer;
}

export function renderStatusLabel(ok: boolean): string {
  return ok ? chalk.green("OK") : chalk.red("Missing");
}

export function printSection(title: string): void {
  console.log(chalk.bold.blue(`\n${title}`));
}

// ---------------------------------------------------------------------------
// Tool listing renderer
// ---------------------------------------------------------------------------

/**
 * Render a table of all tools exposed by one or more servers.
 * Each row shows the server ID, tool name, and (if available) the tool's
 * human-readable title or description.  When a tool has no title the
 * description is shown inline; when neither is present a dash is rendered.
 */
export function renderToolTable(
  entries: readonly { serverId: string; toolName: string; title?: string; description?: string }[],
): string {
  const table = new Table({
    head: [chalk.cyan("Server"), chalk.cyan("Tool"), chalk.cyan("Title")],
    colWidths: [20, 35, 65],
    wordWrap: true,
    style: {
      head: [],
      border: ["gray"],
    },
  });

  for (const entry of entries) {
    table.push([
      chalk.white(entry.serverId),
      chalk.cyan(entry.toolName),
      entry.title || entry.description || chalk.gray("—"),
    ]);
  }

  return table.toString();
}
