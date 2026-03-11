import { describe, expect, it } from "vitest";

import {
  GoogleDriveServer,
  createServer,
  serverCard,
  type GoogleDriveClient,
  type GoogleDriveConfig,
} from "../src/index.js";

const config: GoogleDriveConfig = {
  accessToken: "drive-token",
  baseUrl: "https://drive.example.test",
};

const fakeClient: GoogleDriveClient = {
  async searchFiles(input) {
    return {
      query: input.query ?? null,
      pageSize: input.pageSize,
      nextPageToken: null,
      files: [
        {
          id: "file_123",
          name: "Quarterly Notes",
          mimeType: "application/vnd.google-apps.document",
          description: "Planning notes",
          createdTime: "2026-03-10T10:00:00Z",
          modifiedTime: "2026-03-11T11:00:00Z",
          sizeBytes: null,
          webViewLink: "https://drive.example.test/file_123",
          iconLink: "https://drive.example.test/icon.png",
          ownerNames: ["Owner"],
          ownerEmails: ["owner@example.com"],
          parents: ["folder_1"],
          driveId: null,
        },
      ],
    };
  },
  async getFileMetadata(fileId) {
    return {
      file: {
        id: fileId,
        name: "Quarterly Notes",
        mimeType: "application/vnd.google-apps.document",
        description: "Planning notes",
        createdTime: "2026-03-10T10:00:00Z",
        modifiedTime: "2026-03-11T11:00:00Z",
        sizeBytes: null,
        webViewLink: "https://drive.example.test/file_123",
        iconLink: "https://drive.example.test/icon.png",
        ownerNames: ["Owner"],
        ownerEmails: ["owner@example.com"],
        parents: ["folder_1"],
        driveId: null,
      },
    };
  },
  async exportFile(input) {
    return {
      fileId: input.fileId,
      fileName: "Quarterly Notes",
      mimeType: input.mimeType,
      contentType: "text",
      byteLength: 42,
      textContent: "Agenda:\n- Launch prep\n- Staffing review",
      base64Content: null,
    };
  },
  async getOverview() {
    return {
      generatedAt: "2026-03-11T11:30:00Z",
      user: {
        displayName: "Owner",
        email: "owner@example.com",
        permissionId: "perm_123",
      },
      storageQuota: {
        limitBytes: "1000000",
        usageBytes: "500000",
        trashBytes: "1000",
      },
      importFormats: {
        "text/plain": ["application/vnd.google-apps.document"],
      },
      exportFormats: {
        "application/vnd.google-apps.document": ["text/plain", "application/pdf"],
      },
    };
  },
};

describe("google-drive smoke test", () => {
  it("registers expected tools and invokes them with fake clients", async () => {
    const server = createServer({
      config,
      client: fakeClient,
    });

    expect(server).toBeInstanceOf(GoogleDriveServer);
    expect(server.getToolNames()).toEqual(["export-file", "get-file-metadata", "search-files"]);
    expect(server.getResourceNames()).toEqual(["drive-overview"]);
    expect(server.getPromptNames()).toEqual(["summarize-doc"]);
    expect(serverCard.tools).toEqual(["search-files", "get-file-metadata", "export-file"]);

    const searchResult = await server.invokeTool<{ files: Array<{ id: string }> }>("search-files", {
      query: "Quarterly",
      pageSize: 5,
    });
    expect(searchResult.files[0]?.id).toBe("file_123");

    const metadataResult = await server.invokeTool<{ file: { id: string; name: string } }>("get-file-metadata", {
      fileId: "file_123",
    });
    expect(metadataResult.file.name).toBe("Quarterly Notes");

    const exportResult = await server.invokeTool<{ textContent: string | null; mimeType: string }>("export-file", {
      fileId: "file_123",
      mimeType: "text/plain",
    });
    expect(exportResult.mimeType).toBe("text/plain");
    expect(exportResult.textContent).toContain("Launch prep");

    await server.close();
  });
});
