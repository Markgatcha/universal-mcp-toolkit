import { pathToFileURL } from "node:url";

import {
  ExternalServiceError,
  HttpServiceClient,
  ToolkitServer,
  createServerCard,
  defineTool,
  loadEnv,
  parseRuntimeOptions,
  runToolkitServer,
  type ToolkitServerMetadata,
} from "@universal-mcp-toolkit/core";
import { z } from "zod";

const TOOL_NAMES = ["currently-playing", "search-tracks", "list-playlists"] as const;
const RESOURCE_NAMES = ["listener-profile"] as const;
const PROMPT_NAMES = ["playlist-curator"] as const;

export const metadata: ToolkitServerMetadata = {
  id: "spotify",
  title: "Spotify MCP Server",
  description: "Playback, search, playlist, and listener-context tools for Spotify.",
  version: "0.1.0",
  packageName: "@universal-mcp-toolkit/server-spotify",
  homepage: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit#readme",
  repositoryUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit",
  envVarNames: ["SPOTIFY_ACCESS_TOKEN"],
  transports: ["stdio", "sse"],
  toolNames: TOOL_NAMES,
  resourceNames: RESOURCE_NAMES,
  promptNames: PROMPT_NAMES,
};

export const serverCard = createServerCard(metadata);

const nonEmptyString = z.string().trim().min(1);

const spotifyEnvShape = {
  SPOTIFY_ACCESS_TOKEN: nonEmptyString,
  SPOTIFY_API_BASE_URL: z.string().url().default("https://api.spotify.com/v1"),
} satisfies z.ZodRawShape;

type SpotifyEnv = z.infer<z.ZodObject<typeof spotifyEnvShape>>;

export interface SpotifyConfig {
  accessToken: string;
  baseUrl: string;
}

const spotifyTrackShape = {
  id: z.string(),
  name: z.string(),
  albumName: z.string().nullable(),
  albumReleaseDate: z.string().nullable(),
  artistNames: z.array(z.string()),
  durationMs: z.number().int().nonnegative(),
  explicit: z.boolean(),
  popularity: z.number().int().min(0).max(100).nullable(),
  spotifyUrl: z.string().nullable(),
  uri: z.string().nullable(),
  previewUrl: z.string().nullable(),
} satisfies z.ZodRawShape;

const spotifyTrackSchema = z.object(spotifyTrackShape);
export type SpotifyTrack = z.infer<typeof spotifyTrackSchema>;

const spotifyPlaylistShape = {
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  collaborative: z.boolean(),
  public: z.boolean().nullable(),
  ownerDisplayName: z.string().nullable(),
  ownerId: z.string().nullable(),
  trackCount: z.number().int().nonnegative(),
  spotifyUrl: z.string().nullable(),
  snapshotId: z.string().nullable(),
} satisfies z.ZodRawShape;

const spotifyPlaylistSchema = z.object(spotifyPlaylistShape);
export type SpotifyPlaylist = z.infer<typeof spotifyPlaylistSchema>;

const spotifyProfileShape = {
  id: z.string(),
  displayName: z.string().nullable(),
  email: z.string().nullable(),
  country: z.string().nullable(),
  product: z.string().nullable(),
  followerCount: z.number().int().nonnegative(),
  imageUrls: z.array(z.string()),
  spotifyUrl: z.string().nullable(),
} satisfies z.ZodRawShape;

const spotifyProfileSchema = z.object(spotifyProfileShape);
export type SpotifyProfile = z.infer<typeof spotifyProfileSchema>;

const spotifyDeviceShape = {
  id: z.string().nullable(),
  name: z.string(),
  type: z.string(),
  isActive: z.boolean(),
  volumePercent: z.number().int().min(0).max(100).nullable(),
} satisfies z.ZodRawShape;

const spotifyDeviceSchema = z.object(spotifyDeviceShape);
export type SpotifyDevice = z.infer<typeof spotifyDeviceSchema>;

const currentlyPlayingOutputShape = {
  active: z.boolean(),
  isPlaying: z.boolean(),
  progressMs: z.number().int().nonnegative().nullable(),
  device: z.object(spotifyDeviceShape).nullable(),
  track: z.object(spotifyTrackShape).nullable(),
} satisfies z.ZodRawShape;

const currentlyPlayingOutputSchema = z.object(currentlyPlayingOutputShape);
export type SpotifyCurrentlyPlayingOutput = z.infer<typeof currentlyPlayingOutputSchema>;

const searchTracksOutputShape = {
  query: z.string(),
  limit: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  tracks: z.array(z.object(spotifyTrackShape)),
} satisfies z.ZodRawShape;

const searchTracksOutputSchema = z.object(searchTracksOutputShape);
export type SpotifySearchTracksOutput = z.infer<typeof searchTracksOutputSchema>;

const listPlaylistsOutputShape = {
  limit: z.number().int().positive(),
  nextUrl: z.string().nullable(),
  playlists: z.array(z.object(spotifyPlaylistShape)),
} satisfies z.ZodRawShape;

const listPlaylistsOutputSchema = z.object(listPlaylistsOutputShape);
export type SpotifyListPlaylistsOutput = z.infer<typeof listPlaylistsOutputSchema>;

export interface SpotifyClient {
  getCurrentPlayback(): Promise<SpotifyCurrentlyPlayingOutput>;
  searchTracks(input: { query: string; limit: number; market?: string }): Promise<SpotifySearchTracksOutput>;
  listPlaylists(limit: number): Promise<SpotifyListPlaylistsOutput>;
  getProfile(): Promise<SpotifyProfile>;
}

const rawExternalUrlsSchema = z
  .object({
    spotify: z.string().nullable().optional(),
  })
  .passthrough();

const rawArtistSchema = z
  .object({
    id: z.string().optional(),
    name: z.string(),
  })
  .passthrough();

type RawArtist = z.infer<typeof rawArtistSchema>;

const rawAlbumSchema = z
  .object({
    name: z.string().optional(),
    release_date: z.string().nullable().optional(),
  })
  .passthrough();

const rawTrackSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    duration_ms: z.number().int().nonnegative(),
    explicit: z.boolean().optional(),
    popularity: z.number().int().optional(),
    preview_url: z.string().nullable().optional(),
    uri: z.string().nullable().optional(),
    external_urls: rawExternalUrlsSchema.optional(),
    artists: z.array(rawArtistSchema).optional(),
    album: rawAlbumSchema.optional(),
  })
  .passthrough();

type RawTrack = z.infer<typeof rawTrackSchema>;

const rawPlaylistSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable().optional(),
    collaborative: z.boolean().optional(),
    public: z.boolean().nullable().optional(),
    owner: z
      .object({
        display_name: z.string().nullable().optional(),
        id: z.string().optional(),
      })
      .passthrough()
      .optional(),
    tracks: z
      .object({
        total: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
    external_urls: rawExternalUrlsSchema.optional(),
    snapshot_id: z.string().nullable().optional(),
  })
  .passthrough();

type RawPlaylist = z.infer<typeof rawPlaylistSchema>;

const rawProfileSchema = z
  .object({
    id: z.string(),
    display_name: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    product: z.string().nullable().optional(),
    followers: z
      .object({
        total: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
    images: z
      .array(
        z
          .object({
            url: z.string(),
          })
          .passthrough(),
      )
      .optional(),
    external_urls: rawExternalUrlsSchema.optional(),
  })
  .passthrough();

const rawSearchTracksResponseSchema = z
  .object({
    tracks: z
      .object({
        total: z.number().int().nonnegative().optional(),
        items: z.array(rawTrackSchema).optional().default([]),
      })
      .passthrough(),
  })
  .passthrough();

const rawListPlaylistsResponseSchema = z
  .object({
    next: z.string().nullable().optional(),
    items: z.array(rawPlaylistSchema).optional().default([]),
  })
  .passthrough();

const rawDeviceSchema = z
  .object({
    id: z.string().nullable().optional(),
    name: z.string(),
    type: z.string(),
    is_active: z.boolean().optional(),
    volume_percent: z.number().int().nullable().optional(),
  })
  .passthrough();

type RawDevice = z.infer<typeof rawDeviceSchema>;

const rawCurrentPlaybackSchema = z
  .object({
    is_playing: z.boolean().optional(),
    progress_ms: z.number().int().nullable().optional(),
    device: rawDeviceSchema.optional(),
    item: z.unknown().nullable().optional(),
  })
  .passthrough();

function toSpotifyConfig(env: SpotifyEnv): SpotifyConfig {
  return {
    accessToken: env.SPOTIFY_ACCESS_TOKEN,
    baseUrl: env.SPOTIFY_API_BASE_URL,
  };
}

function loadSpotifyConfig(source: NodeJS.ProcessEnv = process.env): SpotifyConfig {
  return toSpotifyConfig(loadEnv(spotifyEnvShape, source));
}

function mapTrack(raw: RawTrack): SpotifyTrack {
  return {
    id: raw.id,
    name: raw.name,
    albumName: raw.album?.name ?? null,
    albumReleaseDate: raw.album?.release_date ?? null,
    artistNames: (raw.artists ?? []).map((artist: RawArtist) => artist.name),
    durationMs: raw.duration_ms,
    explicit: raw.explicit ?? false,
    popularity: raw.popularity ?? null,
    spotifyUrl: raw.external_urls?.spotify ?? null,
    uri: raw.uri ?? null,
    previewUrl: raw.preview_url ?? null,
  };
}

function mapPlaylist(raw: RawPlaylist): SpotifyPlaylist {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description ?? null,
    collaborative: raw.collaborative ?? false,
    public: raw.public ?? null,
    ownerDisplayName: raw.owner?.display_name ?? null,
    ownerId: raw.owner?.id ?? null,
    trackCount: raw.tracks?.total ?? 0,
    spotifyUrl: raw.external_urls?.spotify ?? null,
    snapshotId: raw.snapshot_id ?? null,
  };
}

function mapProfile(raw: z.infer<typeof rawProfileSchema>): SpotifyProfile {
  return {
    id: raw.id,
    displayName: raw.display_name ?? null,
    email: raw.email ?? null,
    country: raw.country ?? null,
    product: raw.product ?? null,
    followerCount: raw.followers?.total ?? 0,
    imageUrls: (raw.images ?? []).map((image: { url: string }) => image.url),
    spotifyUrl: raw.external_urls?.spotify ?? null,
  };
}

function mapDevice(raw: RawDevice): SpotifyDevice {
  return {
    id: raw.id ?? null,
    name: raw.name,
    type: raw.type,
    isActive: raw.is_active ?? false,
    volumePercent: raw.volume_percent ?? null,
  };
}

function maybeMapTrack(value: unknown): SpotifyTrack | null {
  const parsed = rawTrackSchema.safeParse(value);
  return parsed.success ? mapTrack(parsed.data) : null;
}

function renderCurrentPlayback(output: SpotifyCurrentlyPlayingOutput): string {
  if (!output.active || !output.track) {
    return "Nothing is currently playing.";
  }

  return `Now playing: ${output.track.name} — ${output.track.artistNames.join(", ")}${output.isPlaying ? "" : " [paused]"}`;
}

function renderSearchTracks(output: SpotifySearchTracksOutput): string {
  if (output.tracks.length === 0) {
    return `No tracks found for '${output.query}'.`;
  }

  return output.tracks.map((track: SpotifyTrack) => `- ${track.name} — ${track.artistNames.join(", ")}`).join("\n");
}

function renderPlaylists(output: SpotifyListPlaylistsOutput): string {
  if (output.playlists.length === 0) {
    return "No playlists found.";
  }

  return output.playlists.map((playlist: SpotifyPlaylist) => `- ${playlist.name} (${playlist.trackCount} tracks)`).join("\n");
}

class SpotifyHttpClient extends HttpServiceClient implements SpotifyClient {
  public constructor(config: SpotifyConfig, logger: ToolkitServer["logger"]) {
    super({
      serviceName: "spotify",
      baseUrl: config.baseUrl,
      logger,
      defaultHeaders: () => ({
        authorization: `Bearer ${config.accessToken}`,
        accept: "application/json",
      }),
    });
  }

  public async getCurrentPlayback(): Promise<SpotifyCurrentlyPlayingOutput> {
    const response = await this.fetch("/me/player/currently-playing", {
      query: {
        additional_types: "track",
      },
    });

    if (response.status === 204) {
      return {
        active: false,
        isPlaying: false,
        progressMs: null,
        device: null,
        track: null,
      };
    }

    const payload = (await response.json()) as unknown;
    const parsed = rawCurrentPlaybackSchema.safeParse(payload);

    if (!parsed.success) {
      throw new ExternalServiceError("Spotify returned an invalid currently-playing payload.", {
        details: parsed.error.flatten(),
      });
    }

    return {
      active: true,
      isPlaying: parsed.data.is_playing ?? false,
      progressMs: parsed.data.progress_ms ?? null,
      device: parsed.data.device ? mapDevice(parsed.data.device) : null,
      track: maybeMapTrack(parsed.data.item),
    };
  }

  public async searchTracks(input: { query: string; limit: number; market?: string }): Promise<SpotifySearchTracksOutput> {
    const response = await this.getJson<z.infer<typeof rawSearchTracksResponseSchema>>("/search", rawSearchTracksResponseSchema, {
      query: {
        q: input.query,
        type: "track",
        limit: input.limit,
        market: input.market,
      },
    });

    return {
      query: input.query,
      limit: input.limit,
      total: response.tracks.total ?? 0,
      tracks: response.tracks.items.map(mapTrack),
    };
  }

  public async listPlaylists(limit: number): Promise<SpotifyListPlaylistsOutput> {
    const response = await this.getJson<z.infer<typeof rawListPlaylistsResponseSchema>>("/me/playlists", rawListPlaylistsResponseSchema, {
      query: {
        limit,
      },
    });

    return {
      limit,
      nextUrl: response.next ?? null,
      playlists: response.items.map(mapPlaylist),
    };
  }

  public async getProfile(): Promise<SpotifyProfile> {
    const response = await this.getJson<z.infer<typeof rawProfileSchema>>("/me", rawProfileSchema);
    return mapProfile(response);
  }
}

export interface SpotifyServerOptions {
  config?: SpotifyConfig;
  client?: SpotifyClient;
  env?: NodeJS.ProcessEnv;
}

export class SpotifyServer extends ToolkitServer {
  private readonly client: SpotifyClient;

  public constructor(options: { config: SpotifyConfig; client?: SpotifyClient }) {
    super(metadata);

    this.client = options.client ?? new SpotifyHttpClient(options.config, this.logger);

    this.registerTool(
      defineTool({
        name: "currently-playing",
        title: "Currently playing",
        description: "Return the current Spotify playback state and active track, if any.",
        annotations: {
          readOnlyHint: true,
        },
        inputSchema: {
          includeDevice: z.boolean().default(true),
        },
        outputSchema: currentlyPlayingOutputShape,
        handler: async ({ includeDevice }) => {
          const playback = await this.client.getCurrentPlayback();
          return includeDevice ? playback : { ...playback, device: null };
        },
        renderText: renderCurrentPlayback,
      }),
    );

    this.registerTool(
      defineTool({
        name: "search-tracks",
        title: "Search tracks",
        description: "Search Spotify tracks by query string.",
        annotations: {
          readOnlyHint: true,
        },
        inputSchema: {
          query: nonEmptyString,
          limit: z.number().int().positive().max(50).default(10),
          market: z.string().trim().length(2).optional(),
        },
        outputSchema: searchTracksOutputShape,
        handler: async ({ query, limit, market }) => {
          const request = {
            query,
            limit,
            ...(market ? { market } : {}),
          };

          return this.client.searchTracks(request);
        },
        renderText: renderSearchTracks,
      }),
    );

    this.registerTool(
      defineTool({
        name: "list-playlists",
        title: "List playlists",
        description: "List the authenticated Spotify user's playlists.",
        annotations: {
          readOnlyHint: true,
        },
        inputSchema: {
          limit: z.number().int().positive().max(50).default(10),
        },
        outputSchema: listPlaylistsOutputShape,
        handler: async ({ limit }) => this.client.listPlaylists(limit),
        renderText: renderPlaylists,
      }),
    );

    this.registerStaticResource(
      "listener-profile",
      "spotify://listener-profile",
      {
        title: "Listener Profile",
        description: "A JSON snapshot of the authenticated Spotify listener profile.",
        mimeType: "application/json",
      },
      async (uri) =>
        this.createJsonResource(uri.toString(), {
          generatedAt: new Date().toISOString(),
          profile: await this.client.getProfile(),
        }),
    );

    this.registerPrompt(
      "playlist-curator",
      {
        title: "Playlist Curator",
        description: "Generate a playlist-curation prompt grounded in the user's Spotify profile and listening context.",
        argsSchema: {
          theme: nonEmptyString,
          playlistLength: z.number().int().positive().max(50).default(12),
          seedQuery: nonEmptyString.optional(),
        },
      },
      async ({ theme, playlistLength, seedQuery }) => {
        const promptInput = {
          theme,
          playlistLength,
          ...(seedQuery ? { seedQuery } : {}),
        };

        return this.createTextPrompt(await this.buildPlaylistCuratorPrompt(promptInput));
      },
    );
  }

  private async buildPlaylistCuratorPrompt(input: {
    theme: string;
    playlistLength: number;
    seedQuery?: string;
  }): Promise<string> {
    const [profile, playlists, searchResults] = await Promise.all([
      this.client.getProfile(),
      this.client.listPlaylists(8),
      this.client.searchTracks({
        query: input.seedQuery ?? input.theme,
        limit: 10,
      }),
    ]);

    const playlistNames =
      playlists.playlists.length === 0
        ? ["- No existing playlists were returned."]
        : playlists.playlists.map((playlist: SpotifyPlaylist) => `- ${playlist.name} (${playlist.trackCount} tracks)`);

    const candidateTracks =
      searchResults.tracks.length === 0
        ? ["- No seed tracks were returned."]
        : searchResults.tracks.map((track: SpotifyTrack) => `- ${track.name} — ${track.artistNames.join(", ")}`);

    return [
      "Create a Spotify playlist concept for this listener.",
      `Listener: ${profile.displayName ?? profile.id}`,
      `Country: ${profile.country ?? "unknown"}`,
      `Product tier: ${profile.product ?? "unknown"}`,
      `Theme: ${input.theme}`,
      `Target track count: ${input.playlistLength}`,
      "",
      "Existing playlists:",
      ...playlistNames,
      "",
      "Candidate seed tracks:",
      ...candidateTracks,
      "",
      "Please provide:",
      "1. A playlist title and one-paragraph concept.",
      "2. A sequenced track list of approximately the requested length.",
      "3. Brief rationale for the opening, midpoint, and closing tracks.",
    ].join("\n");
  }
}

export function createServer(options: SpotifyServerOptions = {}): SpotifyServer {
  const config = options.config ?? loadSpotifyConfig(options.env);

  return options.client
    ? new SpotifyServer({
        config,
        client: options.client,
      })
    : new SpotifyServer({
        config,
      });
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const runtimeOptions = parseRuntimeOptions(argv);
  await runToolkitServer(
    {
      createServer: () => createServer(),
      serverCard,
    },
    runtimeOptions,
  );
}

function isMainModule(moduleUrl: string): boolean {
  const entryPoint = process.argv[1];
  return typeof entryPoint === "string" && pathToFileURL(entryPoint).href === moduleUrl;
}

if (isMainModule(import.meta.url)) {
  void main();
}
