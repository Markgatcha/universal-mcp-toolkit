export type ConfigTarget = "claude-desktop" | "cursor" | "json";

export type InvocationMode = "npx" | "workspace";

export interface ServerRegistryEntry {
  id: string;
  title: string;
  category: string;
  description: string;
  packageName: string;
  envVarNames: readonly string[];
  transports: readonly ("stdio" | "sse")[];
}

export const SERVER_REGISTRY: readonly ServerRegistryEntry[] = [
  {
    id: "github",
    title: "GitHub",
    category: "Collaboration",
    description: "Repository search, pull requests, workflows, and issue triage.",
    packageName: "@universal-mcp-toolkit/server-github",
    envVarNames: ["GITHUB_TOKEN"],
    transports: ["stdio", "sse"],
  },
  {
    id: "notion",
    title: "Notion",
    category: "Collaboration",
    description: "Search pages and databases, read docs, and publish structured notes.",
    packageName: "@universal-mcp-toolkit/server-notion",
    envVarNames: ["NOTION_TOKEN"],
    transports: ["stdio", "sse"],
  },
  {
    id: "slack",
    title: "Slack",
    category: "Collaboration",
    description: "Look up channels, fetch threads, and post workspace updates.",
    packageName: "@universal-mcp-toolkit/server-slack",
    envVarNames: ["SLACK_BOT_TOKEN"],
    transports: ["stdio", "sse"],
  },
  {
    id: "linear",
    title: "Linear",
    category: "Collaboration",
    description: "Search issues, inspect workflow state, and create new work items.",
    packageName: "@universal-mcp-toolkit/server-linear",
    envVarNames: ["LINEAR_API_KEY"],
    transports: ["stdio", "sse"],
  },
  {
    id: "jira",
    title: "Jira",
    category: "Collaboration",
    description: "Search issues, inspect tickets, and drive incident triage.",
    packageName: "@universal-mcp-toolkit/server-jira",
    envVarNames: ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"],
    transports: ["stdio", "sse"],
  },
  {
    id: "google-calendar",
    title: "Google Calendar",
    category: "Productivity",
    description: "List calendars, inspect events, and schedule meetings.",
    packageName: "@universal-mcp-toolkit/server-google-calendar",
    envVarNames: ["GOOGLE_CALENDAR_ACCESS_TOKEN"],
    transports: ["stdio", "sse"],
  },
  {
    id: "google-drive",
    title: "Google Drive",
    category: "Productivity",
    description: "Search Drive, inspect document metadata, and export files.",
    packageName: "@universal-mcp-toolkit/server-google-drive",
    envVarNames: ["GOOGLE_DRIVE_ACCESS_TOKEN"],
    transports: ["stdio", "sse"],
  },
  {
    id: "spotify",
    title: "Spotify",
    category: "Media & Commerce",
    description: "Search tracks, inspect playback, and curate playlists.",
    packageName: "@universal-mcp-toolkit/server-spotify",
    envVarNames: ["SPOTIFY_ACCESS_TOKEN"],
    transports: ["stdio", "sse"],
  },
  {
    id: "stripe",
    title: "Stripe",
    category: "Media & Commerce",
    description: "Inspect billing state, customers, invoices, and subscriptions.",
    packageName: "@universal-mcp-toolkit/server-stripe",
    envVarNames: ["STRIPE_SECRET_KEY"],
    transports: ["stdio", "sse"],
  },
  {
    id: "postgresql",
    title: "PostgreSQL",
    category: "Data",
    description: "Inspect schemas and run guarded SQL queries.",
    packageName: "@universal-mcp-toolkit/server-postgresql",
    envVarNames: ["POSTGRESQL_URL"],
    transports: ["stdio", "sse"],
  },
  {
    id: "mongodb",
    title: "MongoDB",
    category: "Data",
    description: "Explore collections and run filtered document queries.",
    packageName: "@universal-mcp-toolkit/server-mongodb",
    envVarNames: ["MONGODB_URI"],
    transports: ["stdio", "sse"],
  },
  {
    id: "redis",
    title: "Redis",
    category: "Data",
    description: "Inspect keys, TTLs, and runtime cache diagnostics.",
    packageName: "@universal-mcp-toolkit/server-redis",
    envVarNames: ["REDIS_URL"],
    transports: ["stdio", "sse"],
  },
  {
    id: "supabase",
    title: "Supabase",
    category: "Data",
    description: "Query tables, storage, and operational project metadata.",
    packageName: "@universal-mcp-toolkit/server-supabase",
    envVarNames: ["SUPABASE_URL", "SUPABASE_KEY"],
    transports: ["stdio", "sse"],
  },
  {
    id: "vercel",
    title: "Vercel",
    category: "Platform",
    description: "Track projects, deployments, and environment settings.",
    packageName: "@universal-mcp-toolkit/server-vercel",
    envVarNames: ["VERCEL_TOKEN"],
    transports: ["stdio", "sse"],
  },
  {
    id: "cloudflare-workers",
    title: "Cloudflare Workers",
    category: "Platform",
    description: "Inspect workers, routes, and edge rollout state.",
    packageName: "@universal-mcp-toolkit/server-cloudflare-workers",
    envVarNames: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
    transports: ["stdio", "sse"],
  },
  {
    id: "docker",
    title: "Docker",
    category: "Platform",
    description: "Inspect containers, images, and daemon state.",
    packageName: "@universal-mcp-toolkit/server-docker",
    envVarNames: [],
    transports: ["stdio", "sse"],
  },
  {
    id: "npm-registry",
    title: "NPM Registry",
    category: "Platform",
    description: "Search packages, inspect versions, and review release metadata.",
    packageName: "@universal-mcp-toolkit/server-npm-registry",
    envVarNames: [],
    transports: ["stdio", "sse"],
  },
  {
    id: "hackernews",
    title: "Hacker News",
    category: "Research",
    description: "Search trends, fetch top stories, and inspect discussion threads.",
    packageName: "@universal-mcp-toolkit/server-hackernews",
    envVarNames: [],
    transports: ["stdio", "sse"],
  },
  {
    id: "arxiv",
    title: "arXiv",
    category: "Research",
    description: "Search papers and build compact literature digests.",
    packageName: "@universal-mcp-toolkit/server-arxiv",
    envVarNames: [],
    transports: ["stdio", "sse"],
  },
  {
    id: "filesystem",
    title: "FileSystem",
    category: "Local",
    description: "Read and write files safely inside explicitly allowed roots.",
    packageName: "@universal-mcp-toolkit/server-filesystem",
    envVarNames: ["FILESYSTEM_ROOTS"],
    transports: ["stdio", "sse"],
  },
];

export function getRegistryEntry(id: string): ServerRegistryEntry {
  const entry = SERVER_REGISTRY.find((candidate) => candidate.id === id);
  if (!entry) {
    throw new Error(`Unknown server '${id}'.`);
  }

  return entry;
}
