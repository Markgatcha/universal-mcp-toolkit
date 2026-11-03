import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { isMainModule } from "../src/main-module.js";

describe("isMainModule", () => {
  const temporaryDirectories: string[] = [];

  function makeTemporaryDirectory(): string {
    const directory = mkdtempSync(path.join(tmpdir(), "umt-main-module-"));
    temporaryDirectories.push(directory);
    return directory;
  }

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("matches a module executed by its real path", () => {
    const directory = makeTemporaryDirectory();
    const entry = path.join(directory, "index.mjs");
    writeFileSync(entry, "");

    expect(isMainModule(pathToFileURL(entry).href, entry)).toBe(true);
  });

  it("matches a module executed through a package-manager bin symlink", () => {
    const root = makeTemporaryDirectory();
    const packageDirectory = path.join(root, "server-hackernews");
    mkdirSync(packageDirectory);
    const entry = path.join(packageDirectory, "dist", "index.mjs");
    mkdirSync(path.dirname(entry));
    writeFileSync(entry, "");

    // npm/pnpm expose `bin` entries as symlinks on macOS/Linux. A junction is
    // the Windows equivalent that can be created without administrator rights.
    const binDirectory = path.join(root, "node_modules", ".bin");
    mkdirSync(path.dirname(binDirectory), { recursive: true });
    symlinkSync(packageDirectory, binDirectory, process.platform === "win32" ? "junction" : "dir");

    const linkedEntry = path.join(binDirectory, "dist", "index.mjs");
    expect(isMainModule(pathToFileURL(entry).href, linkedEntry)).toBe(true);
  });

  it("does not match a different module", () => {
    const directory = makeTemporaryDirectory();
    const entry = path.join(directory, "index.mjs");
    const other = path.join(directory, "other.mjs");
    writeFileSync(entry, "");
    writeFileSync(other, "");

    expect(isMainModule(pathToFileURL(entry).href, other)).toBe(false);
  });

  it("returns false when there is no entry point", () => {
    const directory = makeTemporaryDirectory();
    const entry = path.join(directory, "index.mjs");
    writeFileSync(entry, "");

    expect(isMainModule(pathToFileURL(entry).href, undefined)).toBe(false);
  });

  it("returns false when the entry point does not exist", () => {
    const directory = makeTemporaryDirectory();
    const entry = path.join(directory, "index.mjs");
    writeFileSync(entry, "");

    expect(isMainModule(pathToFileURL(entry).href, path.join(directory, "missing.mjs"))).toBe(false);
  });
});
