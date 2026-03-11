import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createServer, metadata, serverCard } from "../src/index.js";

describe("filesystem smoke", () => {
  it("enforces allowlisted roots while reading and writing files", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "umt-filesystem-"));
    const server = await createServer({
      env: {
        FILESYSTEM_ROOTS: workspace,
        FILESYSTEM_MAX_READ_BYTES: "4096",
        FILESYSTEM_MAX_WRITE_BYTES: "4096",
      },
    });

    try {
      expect(serverCard.tools).toEqual(metadata.toolNames);
      expect(server.getToolNames()).toEqual([...metadata.toolNames].sort());
      expect(server.getResourceNames()).toEqual([...metadata.resourceNames].sort());
      expect(server.getPromptNames()).toEqual([...metadata.promptNames].sort());

      const writeResult = await server.invokeTool<{ created: boolean; bytesWritten: number }>("write_file", {
        path: "notes\\todo.txt",
        content: "remember to test",
        encoding: "utf8",
        overwrite: false,
        createDirectories: true,
      });
      expect(writeResult.created).toBe(true);
      expect(writeResult.bytesWritten).toBeGreaterThan(0);

      const readResult = await server.invokeTool<{ content: string }>("read_file", {
        path: "notes\\todo.txt",
        encoding: "utf8",
      });
      expect(readResult.content).toBe("remember to test");

      const files = await server.invokeTool<{ entries: ReadonlyArray<{ path: string }> }>("list_files", {
        path: ".",
        recursive: true,
        maxEntries: 10,
      });
      expect(files.entries.some((entry) => entry.path === "notes\\todo.txt")).toBe(true);

      await expect(
        server.invokeTool("read_file", {
          path: "..\\outside.txt",
          encoding: "utf8",
        }),
      ).rejects.toThrow(/allowlisted/i);
    } finally {
      await server.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
