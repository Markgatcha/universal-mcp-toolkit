import { describe, expect, it } from "vitest";

import {
  SpotifyServer,
  createServer,
  serverCard,
  type SpotifyClient,
  type SpotifyConfig,
} from "../src/index.js";

const config: SpotifyConfig = {
  accessToken: "spotify-token",
  baseUrl: "https://spotify.example.test",
};

const fakeClient: SpotifyClient = {
  async getCurrentPlayback() {
    return {
      active: true,
      isPlaying: true,
      progressMs: 120000,
      device: {
        id: "device_1",
        name: "Desktop Player",
        type: "Computer",
        isActive: true,
        volumePercent: 40,
      },
      track: {
        id: "track_1",
        name: "Night Drive",
        albumName: "After Hours",
        albumReleaseDate: "2026-02-01",
        artistNames: ["The Examples"],
        durationMs: 210000,
        explicit: false,
        popularity: 72,
        spotifyUrl: "https://spotify.example.test/track/track_1",
        uri: "spotify:track:track_1",
        previewUrl: null,
      },
    };
  },
  async searchTracks(input) {
    return {
      query: input.query,
      limit: input.limit,
      total: 1,
      tracks: [
        {
          id: "track_1",
          name: "Night Drive",
          albumName: "After Hours",
          albumReleaseDate: "2026-02-01",
          artistNames: ["The Examples"],
          durationMs: 210000,
          explicit: false,
          popularity: 72,
          spotifyUrl: "https://spotify.example.test/track/track_1",
          uri: "spotify:track:track_1",
          previewUrl: null,
        },
      ],
    };
  },
  async listPlaylists(limit) {
    return {
      limit,
      nextUrl: null,
      playlists: [
        {
          id: "playlist_1",
          name: "Late Night Coding",
          description: "Focus music",
          collaborative: false,
          public: true,
          ownerDisplayName: "Listener",
          ownerId: "user_1",
          trackCount: 35,
          spotifyUrl: "https://spotify.example.test/playlist/playlist_1",
          snapshotId: "snap_1",
        },
      ],
    };
  },
  async getProfile() {
    return {
      id: "user_1",
      displayName: "Listener",
      email: "listener@example.com",
      country: "US",
      product: "premium",
      followerCount: 120,
      imageUrls: ["https://spotify.example.test/avatar.jpg"],
      spotifyUrl: "https://spotify.example.test/user/user_1",
    };
  },
};

describe("spotify smoke test", () => {
  it("registers discovery metadata and exposes working tools", async () => {
    const server = createServer({
      config,
      client: fakeClient,
    });

    expect(server).toBeInstanceOf(SpotifyServer);
    expect(server.getToolNames()).toEqual(["currently-playing", "list-playlists", "search-tracks"]);
    expect(server.getResourceNames()).toEqual(["listener-profile"]);
    expect(server.getPromptNames()).toEqual(["playlist-curator"]);
    expect(serverCard.tools).toEqual(["currently-playing", "search-tracks", "list-playlists"]);

    const playback = await server.invokeTool<{ track: { name: string } | null }>("currently-playing", {});
    expect(playback.track?.name).toBe("Night Drive");

    const search = await server.invokeTool<{ tracks: Array<{ id: string }> }>("search-tracks", {
      query: "Night Drive",
      limit: 5,
    });
    expect(search.tracks[0]?.id).toBe("track_1");

    const playlists = await server.invokeTool<{ playlists: Array<{ name: string }> }>("list-playlists", {
      limit: 5,
    });
    expect(playlists.playlists[0]?.name).toBe("Late Night Coding");

    await server.close();
  });
});
