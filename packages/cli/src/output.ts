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
