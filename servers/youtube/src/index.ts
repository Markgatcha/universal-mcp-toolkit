import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ExternalServiceError,
  ToolkitServer,
  createServerCard,
  defineTool,
  loadEnv,
  normalizeError,
  parseRuntimeOptions,
  runToolkitServer,
  type ToolkitServerMetadata,
} from "@universal-mcp-toolkit/core";
import { z } from "zod";

const YOUTUBE_API_BASE_URL = "https://www.googleapis.com/youtube/v3";

const SEARCH_VIDEOS_TOOL_NAME = "youtube_search_videos";
const GET_VIDEO_TOOL_NAME = "youtube_get_video";
const GET_CHANNEL_TOOL_NAME = "youtube_get_channel";
const LIST_CHANNEL_VIDEOS_TOOL_NAME = "youtube_list_channel_videos";
const GET_COMMENTS_TOOL_NAME = "youtube_get_comments";

export const metadata = {
  id: "youtube",
  title: "YouTube MCP Server",
  description: "Search videos, fetch video/channel details, and read comments via the YouTube Data API v3.",
  version: "0.1.0",
  packageName: "@universal-mcp-toolkit/server-youtube",
  homepage: "https://github.com/Markgatcha/universal-mcp-toolkit#readme",
  repositoryUrl: "https://github.com/Markgatcha/universal-mcp-toolkit.git",
  documentationUrl: "https://github.com/Markgatcha/universal-mcp-toolkit#readme",
  envVarNames: ["YOUTUBE_API_KEY"] as const,
  transports: ["stdio", "sse"] as const,
  toolNames: [
    SEARCH_VIDEOS_TOOL_NAME,
    GET_VIDEO_TOOL_NAME,
    GET_CHANNEL_TOOL_NAME,
    LIST_CHANNEL_VIDEOS_TOOL_NAME,
    GET_COMMENTS_TOOL_NAME,
  ] as const,
  resourceNames: [] as const,
  promptNames: [] as const,
} satisfies ToolkitServerMetadata;

export const serverCard = createServerCard(metadata);

function toNullableString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractErrorDetails(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return error;
}

// --- Zod schemas (raw YouTube Data API v3 responses) ---

const thumbnailMapSchema = z
  .object({
    default: z.object({ url: z.string() }).optional(),
    medium: z.object({ url: z.string() }).optional(),
    high: z.object({ url: z.string() }).optional(),
  })
  .passthrough();

const searchIdSchema = z.object({
  kind: z.string().optional(),
  videoId: z.string().nullable().optional(),
  channelId: z.string().nullable().optional(),
});

const searchItemSchema = z.object({
  id: searchIdSchema,
  snippet: z
    .object({
      title: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      channelId: z.string().nullable().optional(),
      channelTitle: z.string().nullable().optional(),
      publishedAt: z.string().nullable().optional(),
      thumbnails: thumbnailMapSchema.optional(),
    })
    .passthrough()
    .optional(),
});

const searchResponseSchema = z.object({
  items: z.array(searchItemSchema).optional(),
  nextPageToken: z.string().optional(),
});

const videoStatisticsSchema = z
  .object({
    viewCount: z.string().nullable().optional(),
    likeCount: z.string().nullable().optional(),
    commentCount: z.string().nullable().optional(),
  })
  .passthrough();

const videoContentDetailsSchema = z
  .object({
    duration: z.string().nullable().optional(),
    definition: z.string().nullable().optional(),
  })
  .passthrough();

const videoItemSchema = z.object({
  id: z.string().min(1),
  snippet: z
    .object({
      title: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      channelId: z.string().nullable().optional(),
      channelTitle: z.string().nullable().optional(),
      publishedAt: z.string().nullable().optional(),
      tags: z.array(z.string()).nullable().optional(),
    })
    .passthrough()
    .optional(),
  statistics: videoStatisticsSchema.optional(),
  contentDetails: videoContentDetailsSchema.optional(),
});

const videoListResponseSchema = z.object({
  items: z.array(videoItemSchema).optional(),
});

const channelStatisticsSchema = z
  .object({
    viewCount: z.string().nullable().optional(),
    subscriberCount: z.string().nullable().optional(),
    hiddenSubscriberCount: z.boolean().optional(),
    videoCount: z.string().nullable().optional(),
  })
  .passthrough();

const channelItemSchema = z.object({
  id: z.string().min(1),
  snippet: z
    .object({
      title: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
    })
    .passthrough()
    .optional(),
  statistics: channelStatisticsSchema.optional(),
});

const channelListResponseSchema = z.object({
  items: z.array(channelItemSchema).optional(),
});

const playlistItemListSchema = z.object({
  snippet: z
    .object({
      resourceId: z.object({ videoId: z.string().nullable().optional() }).passthrough(),
      title: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      channelTitle: z.string().nullable().optional(),
      publishedAt: z.string().nullable().optional(),
      thumbnails: thumbnailMapSchema.optional(),
    })
    .passthrough()
    .optional(),
});

const playlistItemListResponseSchema = z.object({
  items: z.array(playlistItemListSchema).optional(),
  nextPageToken: z.string().optional(),
});

const commentSnippetSchema = z
  .object({
    textDisplay: z.string().nullable().optional(),
    textOriginal: z.string().nullable().optional(),
    authorDisplayName: z.string().nullable().optional(),
    likeCount: z.number().int().optional(),
    publishedAt: z.string().nullable().optional(),
  })
  .passthrough();

const commentItemSchema = z.object({
  id: z.string().min(1),
  snippet: commentSnippetSchema.optional(),
});

const commentThreadItemSchema = z.object({
  id: z.string().optional(),
  snippet: z
    .object({
      topLevelComment: commentItemSchema.optional(),
    })
    .passthrough()
    .optional(),
});

const commentThreadListResponseSchema = z.object({
  items: z.array(commentThreadItemSchema).optional(),
});

// --- Tool shapes ---

const videoSummarySchema = z.object({
  videoId: z.string().min(1).describe("YouTube video ID."),
  title: z.string().describe("Video title."),
  channelTitle: z.string().describe("Name of the publishing channel."),
  publishedAt: z.string().nullable().describe("ISO 8601 publication timestamp."),
  description: z.string().describe("Short video description (may be truncated)."),
  thumbnailUrl: z.string().nullable().describe("URL of a representative thumbnail."),
});

const searchVideosInputShape = {
  query: z.string().trim().min(1).describe("Search query text."),
  maxResults: z.coerce.number().int().min(1).max(25).default(10).describe("Maximum videos to return (1-25)."),
  order: z.enum(["relevance", "date", "viewCount"]).optional().describe("Result ordering."),
};

const searchVideosOutputShape = {
  query: z.string().describe("The search query that was executed."),
  videos: z.array(videoSummarySchema).max(50).describe("Matching video summaries."),
  returnedCount: z.number().int().nonnegative().describe("Number of videos returned."),
};

const getVideoInputShape = {
  videoId: z.string().trim().min(1).describe("The YouTube video ID to retrieve."),
};

const videoDetailsSchema = z.object({
  videoId: z.string().min(1).describe("YouTube video ID."),
  title: z.string().describe("Video title."),
  description: z.string().describe("Full video description."),
  channelTitle: z.string().describe("Name of the publishing channel."),
  publishedAt: z.string().nullable().describe("ISO 8601 publication timestamp."),
  duration: z.string().nullable().describe("ISO 8601 duration (e.g. PT1M30S)."),
  viewCount: z.number().int().nullable().describe("Total view count, if visible."),
  likeCount: z.number().int().nullable().describe("Total like count, if visible."),
  tags: z.array(z.string()).max(50).describe("Video tags."),
});

const getVideoOutputShape = {
  video: videoDetailsSchema.describe("The full video details."),
};

const getChannelInputShape = {
  channelId: z.string().trim().min(1).describe("Channel ID or handle (prefix handles with @, e.g. @Google)."),
};

const channelDetailsSchema = z.object({
  channelId: z.string().min(1).describe("YouTube channel ID."),
  title: z.string().describe("Channel display name."),
  description: z.string().describe("Channel description."),
  subscriberCount: z.number().int().nullable().describe("Subscriber count (null if hidden)."),
  videoCount: z.number().int().nullable().describe("Public video count."),
  viewCount: z.number().int().nullable().describe("Total channel view count."),
});

const getChannelOutputShape = {
  channel: channelDetailsSchema.describe("The channel details."),
};

const listChannelVideosInputShape = {
  channelId: z.string().trim().min(1).describe("The YouTube channel ID to list videos for."),
  maxResults: z.coerce.number().int().min(1).max(25).default(10).describe("Maximum videos to return (1-25)."),
};

const listChannelVideosOutputShape = {
  channelId: z.string().min(1).describe("The channel that was queried."),
  videos: z.array(videoSummarySchema).max(50).describe("Recent video summaries for the channel."),
  returnedCount: z.number().int().nonnegative().describe("Number of videos returned."),
};

const getCommentsInputShape = {
  videoId: z.string().trim().min(1).describe("The video ID to read comments from."),
  maxResults: z.coerce.number().int().min(1).max(20).default(10).describe("Maximum comments to return (1-20)."),
};

const commentSummarySchema = z.object({
  commentId: z.string().min(1).describe("Comment identifier."),
  authorName: z.string().describe("Display name of the commenter."),
  text: z.string().describe("Comment text (display form)."),
  likeCount: z.number().int().describe("Number of likes on the comment."),
  publishedAt: z.string().nullable().describe("ISO 8601 comment timestamp."),
});

const getCommentsOutputShape = {
  videoId: z.string().min(1).describe("The video the comments belong to."),
  comments: z.array(commentSummarySchema).max(50).describe("Top-level comment summaries."),
  returnedCount: z.number().int().nonnegative().describe("Number of comments returned."),
};

// --- Client interface ---

export interface YoutubeVideoSummary {
  videoId: string;
  title: string;
  channelTitle: string;
  publishedAt: string | null;
  description: string;
  thumbnailUrl: string | null;
}

export interface YoutubeVideoDetails {
  videoId: string;
  title: string;
  description: string;
  channelTitle: string;
  publishedAt: string | null;
  duration: string | null;
  viewCount: number | null;
  likeCount: number | null;
  tags: string[];
}

export interface YoutubeChannelDetails {
  channelId: string;
  title: string;
  description: string;
  subscriberCount: number | null;
  videoCount: number | null;
  viewCount: number | null;
}

export interface YoutubeCommentSummary {
  commentId: string;
  authorName: string;
  text: string;
  likeCount: number;
  publishedAt: string | null;
}

export interface YoutubeClient {
  searchVideos(query: string, maxResults: number, order?: "relevance" | "date" | "viewCount"): Promise<YoutubeVideoSummary[]>;
  getVideo(videoId: string): Promise<YoutubeVideoDetails>;
  getChannel(channelIdOrHandle: string): Promise<YoutubeChannelDetails>;
  listChannelVideos(channelId: string, maxResults: number): Promise<YoutubeVideoSummary[]>;
  getComments(videoId: string, maxResults: number): Promise<YoutubeCommentSummary[]>;
}

// --- Concrete client ---

class RestYoutubeClient implements YoutubeClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiKey: string;
  private initialized = false;

  public constructor(apiKey: string, baseUrl: string, fetchImpl: typeof fetch = fetch) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    // No startup network call needed: the API key is validated lazily on first use.
    this.initialized = true;
  }

  public async searchVideos(query: string, maxResults: number, order?: "relevance" | "date" | "viewCount"): Promise<YoutubeVideoSummary[]> {
    await this.ensureInitialized();
    const params = new URLSearchParams({
      part: "snippet",
      type: "video",
      q: query,
      maxResults: String(maxResults),
      key: this.apiKey,
    });
    if (order) {
      params.set("order", order);
    }
    const payload = await this.request("GET", `/search?${params.toString()}`);
    const parsed = searchResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("YouTube returned an unexpected search response.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    const items = parsed.data.items ?? [];
    return items.map(mapSearchItem).filter((v): v is YoutubeVideoSummary => v !== null);
  }

  public async getVideo(videoId: string): Promise<YoutubeVideoDetails> {
    await this.ensureInitialized();
    const params = new URLSearchParams({
      part: "snippet,statistics,contentDetails",
      id: videoId,
      key: this.apiKey,
    });
    const payload = await this.request("GET", `/videos?${params.toString()}`);
    const parsed = videoListResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("YouTube returned an unexpected video response.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    const item = parsed.data.items?.[0];
    if (!item) {
      throw new ExternalServiceError(`YouTube video '${videoId}' was not found.`, {
        statusCode: 404,
        details: { videoId },
      });
    }
    return mapVideoItem(item);
  }

  public async getChannel(channelIdOrHandle: string): Promise<YoutubeChannelDetails> {
    await this.ensureInitialized();
    const params = new URLSearchParams({
      part: "snippet,statistics",
      key: this.apiKey,
    });
    if (channelIdOrHandle.startsWith("@")) {
      params.set("forHandle", channelIdOrHandle);
    } else {
      params.set("id", channelIdOrHandle);
    }
    const payload = await this.request("GET", `/channels?${params.toString()}`);
    const parsed = channelListResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("YouTube returned an unexpected channel response.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    const item = parsed.data.items?.[0];
    if (!item) {
      throw new ExternalServiceError(`YouTube channel '${channelIdOrHandle}' was not found.`, {
        statusCode: 404,
        details: { channelIdOrHandle },
      });
    }
    return mapChannelItem(item);
  }

  public async listChannelVideos(channelId: string, maxResults: number): Promise<YoutubeVideoSummary[]> {
    await this.ensureInitialized();
    // Resolve the channel's uploads playlist, then list its items. The channel
    // response keeps contentDetails via passthrough, so read it from the raw payload.
    const channelParams = new URLSearchParams({
      part: "contentDetails",
      id: channelId,
      key: this.apiKey,
    });
    const channelPayload = await this.request("GET", `/channels?${channelParams.toString()}`);
    const uploadsId = extractUploadsPlaylistId(channelPayload);
    if (!uploadsId) {
      throw new ExternalServiceError(`Could not resolve an uploads playlist for channel '${channelId}'.`, {
        statusCode: 404,
        details: { channelId },
      });
    }

    const playlistParams = new URLSearchParams({
      part: "snippet",
      playlistId: uploadsId,
      maxResults: String(maxResults),
      key: this.apiKey,
    });
    const payload = await this.request("GET", `/playlistItems?${playlistParams.toString()}`);
    const parsed = playlistItemListResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("YouTube returned an unexpected playlist item response.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    const items = parsed.data.items ?? [];
    return items.map(mapPlaylistItem).filter((v): v is YoutubeVideoSummary => v !== null);
  }

  public async getComments(videoId: string, maxResults: number): Promise<YoutubeCommentSummary[]> {
    await this.ensureInitialized();
    const params = new URLSearchParams({
      part: "snippet",
      videoId,
      maxResults: String(maxResults),
      order: "relevance",
      textFormat: "plainText",
      key: this.apiKey,
    });
    const payload = await this.request("GET", `/commentThreads?${params.toString()}`);
    const parsed = commentThreadListResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("YouTube returned an unexpected comment response.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    const items = parsed.data.items ?? [];
    return items.map(mapCommentThread).filter((c): c is YoutubeCommentSummary => c !== null);
  }

  private async request(method: "GET" | "POST", path: string, body?: object): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Connection": "keep-alive",
      "Keep-Alive": "timeout=30, max=100",
    };

    const requestInit: RequestInit = { method, headers };

    if (body) {
      headers["Content-Type"] = "application/json";
      requestInit.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, requestInit);
    } catch (error) {
      throw new ExternalServiceError(`Unable to reach YouTube API at '${path}'.`, {
        statusCode: 502,
        details: { path, cause: extractErrorDetails(error) },
      });
    }

    const rawText = await response.text();
    let payload: unknown;
    try {
      payload = rawText.length > 0 ? (JSON.parse(rawText) as unknown) : {};
    } catch {
      throw new ExternalServiceError(`YouTube API at '${path}' returned malformed JSON.`, {
        statusCode: 502,
        details: { path, rawText: rawText.slice(0, 1000) },
        exposeToClient: false,
      });
    }

    if (!response.ok) {
      const details = { path, statusCode: response.status, body: payload };
      if (response.status === 401 || response.status === 403) {
        throw new ExternalServiceError("YouTube authentication failed. Verify YOUTUBE_API_KEY and that the API is enabled.", {
          statusCode: response.status === 401 ? 401 : 403,
          details,
        });
      }
      if (response.status === 404) {
        throw new ExternalServiceError(`YouTube resource at '${path}' was not found.`, {
          statusCode: 404,
          details,
        });
      }
      if (response.status === 429) {
        throw new ExternalServiceError(`YouTube rate limited request to '${path}'. Check your API quota.`, {
          statusCode: 429,
          details,
        });
      }
      throw new ExternalServiceError(`YouTube API request to '${path}' failed with status ${response.status}.`, {
        statusCode: response.status >= 400 ? response.status : 502,
        details,
      });
    }

    return payload;
  }
}

// --- Mapping helpers ---

function pickThumbnail(thumbnails: unknown): string | null {
  if (!thumbnails || typeof thumbnails !== "object") {
    return null;
  }
  const map = thumbnails as Record<string, { url?: string }>;
  const candidate = map.high ?? map.medium ?? map.default;
  return candidate?.url ? toNullableString(candidate.url) : null;
}

function mapSearchItem(item: z.infer<typeof searchItemSchema>): YoutubeVideoSummary | null {
  const videoId = item.id.videoId;
  if (!videoId) {
    return null;
  }
  const snippet = item.snippet;
  return {
    videoId,
    title: snippet?.title ?? "",
    channelTitle: snippet?.channelTitle ?? "",
    publishedAt: toNullableString(snippet?.publishedAt),
    description: snippet?.description ?? "",
    thumbnailUrl: pickThumbnail(snippet?.thumbnails),
  };
}

function mapVideoItem(item: z.infer<typeof videoItemSchema>): YoutubeVideoDetails {
  const snippet = item.snippet;
  const stats = item.statistics;
  return {
    videoId: item.id,
    title: snippet?.title ?? "",
    description: snippet?.description ?? "",
    channelTitle: snippet?.channelTitle ?? "",
    publishedAt: toNullableString(snippet?.publishedAt),
    duration: toNullableString(item.contentDetails?.duration),
    viewCount: parseCount(stats?.viewCount),
    likeCount: parseCount(stats?.likeCount),
    tags: snippet?.tags ?? [],
  };
}

function mapChannelItem(item: z.infer<typeof channelItemSchema>): YoutubeChannelDetails {
  const stats = item.statistics;
  return {
    channelId: item.id,
    title: item.snippet?.title ?? "",
    description: item.snippet?.description ?? "",
    subscriberCount: stats?.hiddenSubscriberCount ? null : parseCount(stats?.subscriberCount),
    videoCount: parseCount(stats?.videoCount),
    viewCount: parseCount(stats?.viewCount),
  };
}

function mapPlaylistItem(item: z.infer<typeof playlistItemListSchema>): YoutubeVideoSummary | null {
  const snippet = item.snippet;
  const videoId = snippet?.resourceId.videoId;
  if (!videoId) {
    return null;
  }
  return {
    videoId,
    title: snippet?.title ?? "",
    channelTitle: snippet?.channelTitle ?? "",
    publishedAt: toNullableString(snippet?.publishedAt),
    description: snippet?.description ?? "",
    thumbnailUrl: pickThumbnail(snippet?.thumbnails),
  };
}

function mapCommentThread(item: z.infer<typeof commentThreadItemSchema>): YoutubeCommentSummary | null {
  const comment = item.snippet?.topLevelComment;
  if (!comment) {
    return null;
  }
  const snippet = comment.snippet;
  return {
    commentId: comment.id,
    authorName: snippet?.authorDisplayName ?? "",
    text: snippet?.textDisplay ?? snippet?.textOriginal ?? "",
    likeCount: snippet?.likeCount ?? 0,
    publishedAt: toNullableString(snippet?.publishedAt),
  };
}

function parseCount(value: string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractUploadsPlaylistId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const root = payload as { items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }> };
  const items = root.items;
  if (!items || items.length === 0) {
    return null;
  }
  const uploads = items[0]?.contentDetails?.relatedPlaylists?.uploads;
  return uploads ? toNullableString(uploads) : null;
}

// --- Render helpers ---

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function renderVideoSummaries(videos: YoutubeVideoSummary[], noun: string): string {
  if (videos.length === 0) {
    return `No ${noun} found.`;
  }
  const shown = videos.slice(0, 5);
  const lines = shown.map((v) => {
    const parts: string[] = [truncate(v.title, 80)];
    if (v.channelTitle) {
      parts.push(v.channelTitle);
    }
    if (v.publishedAt) {
      parts.push(v.publishedAt.slice(0, 10));
    }
    parts.push(`https://youtu.be/${v.videoId}`);
    return `- ${parts.join(" | ")}`;
  });
  const omitted = videos.length - shown.length;
  if (omitted > 0) {
    lines.push(`(+${omitted} more, use maxResults to adjust)`);
  }
  return [`✓ ${videos.length} ${noun}`, ...lines].join("\n");
}

function renderVideoDetails(video: YoutubeVideoDetails): string {
  const lines: string[] = [`✓ ${video.title}`];
  if (video.channelTitle) {
    lines.push(`Channel: ${video.channelTitle}`);
  }
  if (video.publishedAt) {
    lines.push(`Published: ${video.publishedAt.slice(0, 10)}`);
  }
  if (video.duration) {
    lines.push(`Duration: ${video.duration}`);
  }
  if (video.viewCount !== null) {
    lines.push(`Views: ${video.viewCount.toLocaleString()}`);
  }
  if (video.likeCount !== null) {
    lines.push(`Likes: ${video.likeCount.toLocaleString()}`);
  }
  if (video.description) {
    lines.push("");
    lines.push(truncate(video.description, 500));
  }
  return lines.join("\n");
}

function renderChannelDetails(channel: YoutubeChannelDetails): string {
  const lines: string[] = [`✓ ${channel.title}`];
  if (channel.subscriberCount !== null) {
    lines.push(`Subscribers: ${channel.subscriberCount.toLocaleString()}`);
  }
  if (channel.videoCount !== null) {
    lines.push(`Videos: ${channel.videoCount.toLocaleString()}`);
  }
  if (channel.viewCount !== null) {
    lines.push(`Views: ${channel.viewCount.toLocaleString()}`);
  }
  if (channel.description) {
    lines.push("");
    lines.push(truncate(channel.description, 500));
  }
  return lines.join("\n");
}

function renderComments(comments: YoutubeCommentSummary[]): string {
  if (comments.length === 0) {
    return "No comments found.";
  }
  const shown = comments.slice(0, 5);
  const lines = shown.map((c) => {
    const parts: string[] = [c.authorName];
    if (c.publishedAt) {
      parts.push(c.publishedAt.slice(0, 10));
    }
    if (c.likeCount > 0) {
      parts.push(`♥${c.likeCount}`);
    }
    parts.push(truncate(c.text, 160));
    return `- ${parts.join(" | ")}`;
  });
  const omitted = comments.length - shown.length;
  if (omitted > 0) {
    lines.push(`(+${omitted} more, use maxResults to adjust)`);
  }
  return [`✓ ${comments.length} comments`, ...lines].join("\n");
}

// --- Server ---

export interface YoutubeServerOptions {
  client: YoutubeClient;
}

export class YoutubeServer extends ToolkitServer {
  private readonly client: YoutubeClient;

  public constructor(options: YoutubeServerOptions) {
    super(metadata);
    this.client = options.client;

    this.registerTool(
      defineTool({
        name: SEARCH_VIDEOS_TOOL_NAME,
        title: "Search YouTube videos",
        description: "Search YouTube videos by query, with optional ordering.",
        annotations: {
          idempotentHint: true,
          openWorldHint: true,
          readOnlyHint: true,
        },
        inputSchema: searchVideosInputShape,
        outputSchema: searchVideosOutputShape,
        handler: async (input, context) => {
          await context.log("info", `Searching YouTube videos for '${input.query}'.`);
          try {
            const videos = await this.client.searchVideos(input.query, input.maxResults, input.order);
            return { query: input.query, videos, returnedCount: videos.length };
          } catch (error) {
            throw this.mapOperationError(SEARCH_VIDEOS_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderVideoSummaries(output.videos, "videos"),
      }),
    );

    this.registerTool(
      defineTool({
        name: GET_VIDEO_TOOL_NAME,
        title: "Get YouTube video",
        description: "Fetch full details (statistics, duration, tags) for a YouTube video by ID.",
        annotations: {
          idempotentHint: true,
          openWorldHint: true,
          readOnlyHint: true,
        },
        inputSchema: getVideoInputShape,
        outputSchema: getVideoOutputShape,
        handler: async (input, context) => {
          await context.log("info", `Fetching YouTube video ${input.videoId}.`);
          try {
            const video = await this.client.getVideo(input.videoId);
            return { video };
          } catch (error) {
            throw this.mapOperationError(GET_VIDEO_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderVideoDetails(output.video),
      }),
    );

    this.registerTool(
      defineTool({
        name: GET_CHANNEL_TOOL_NAME,
        title: "Get YouTube channel",
        description: "Fetch YouTube channel details by channel ID or @handle.",
        annotations: {
          idempotentHint: true,
          openWorldHint: true,
          readOnlyHint: true,
        },
        inputSchema: getChannelInputShape,
        outputSchema: getChannelOutputShape,
        handler: async (input, context) => {
          await context.log("info", `Fetching YouTube channel ${input.channelId}.`);
          try {
            const channel = await this.client.getChannel(input.channelId);
            return { channel };
          } catch (error) {
            throw this.mapOperationError(GET_CHANNEL_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderChannelDetails(output.channel),
      }),
    );

    this.registerTool(
      defineTool({
        name: LIST_CHANNEL_VIDEOS_TOOL_NAME,
        title: "List YouTube channel videos",
        description: "List recent videos uploaded by a YouTube channel.",
        annotations: {
          idempotentHint: true,
          openWorldHint: true,
          readOnlyHint: true,
        },
        inputSchema: listChannelVideosInputShape,
        outputSchema: listChannelVideosOutputShape,
        handler: async (input, context) => {
          await context.log("info", `Listing videos for YouTube channel ${input.channelId}.`);
          try {
            const videos = await this.client.listChannelVideos(input.channelId, input.maxResults);
            return { channelId: input.channelId, videos, returnedCount: videos.length };
          } catch (error) {
            throw this.mapOperationError(LIST_CHANNEL_VIDEOS_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderVideoSummaries(output.videos, "videos"),
      }),
    );

    this.registerTool(
      defineTool({
        name: GET_COMMENTS_TOOL_NAME,
        title: "Get YouTube comments",
        description: "Fetch top-level comments for a YouTube video.",
        annotations: {
          idempotentHint: true,
          openWorldHint: true,
          readOnlyHint: true,
        },
        inputSchema: getCommentsInputShape,
        outputSchema: getCommentsOutputShape,
        handler: async (input, context) => {
          await context.log("info", `Fetching comments for YouTube video ${input.videoId}.`);
          try {
            const comments = await this.client.getComments(input.videoId, input.maxResults);
            return { videoId: input.videoId, comments, returnedCount: comments.length };
          } catch (error) {
            throw this.mapOperationError(GET_COMMENTS_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderComments(output.comments),
      }),
    );
  }

  private mapOperationError(operation: string, error: unknown): ExternalServiceError {
    if (error instanceof ExternalServiceError) {
      return error;
    }
    return new ExternalServiceError(`YouTube operation '${operation}' failed unexpectedly.`, {
      details: { operation, cause: extractErrorDetails(error) },
      exposeToClient: true,
    });
  }
}

export interface CreateYoutubeServerOptions {
  client?: YoutubeClient;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

const envShape = {
  YOUTUBE_API_KEY: z.string().trim().min(1, "YOUTUBE_API_KEY is required."),
  YOUTUBE_API_BASE_URL: z.string().trim().url().default(YOUTUBE_API_BASE_URL),
};

export function createServer(options: CreateYoutubeServerOptions = {}): YoutubeServer {
  const env = loadEnv(envShape, options.env);
  const client =
    options.client ??
    new RestYoutubeClient(env.YOUTUBE_API_KEY, env.YOUTUBE_API_BASE_URL, options.fetchImpl);
  return new YoutubeServer({ client });
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  await runToolkitServer(
    {
      createServer,
      serverCard,
    },
    parseRuntimeOptions(argv),
  );
}

const isDirectExecution =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  void main().catch((error) => {
    const normalized = normalizeError(error);
    process.stderr.write(`${normalized.toClientMessage()}\n`);
    process.exitCode = 1;
  });
}
