import { pathToFileURL } from "node:url";

import {
  HttpServiceClient,
  ToolkitServer,
  ValidationError,
  createServerCard,
  defineTool,
  loadEnv,
  parseRuntimeOptions,
  runToolkitServer,
  type ToolkitServerMetadata,
} from "@universal-mcp-toolkit/core";
import { z } from "zod";

const TOOL_NAMES = ["list-calendars", "list-events", "create-event"] as const;
const RESOURCE_NAMES = ["calendar-overview"] as const;
const PROMPT_NAMES = ["meeting-brief"] as const;

export const metadata: ToolkitServerMetadata = {
  id: "google-calendar",
  title: "Google Calendar MCP Server",
  description: "Calendar discovery, event planning, and meeting preparation tools for Google Calendar.",
  version: "0.1.0",
  packageName: "@universal-mcp-toolkit/server-google-calendar",
  homepage: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit#readme",
  repositoryUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit",
  envVarNames: ["GOOGLE_CALENDAR_ACCESS_TOKEN"],
  transports: ["stdio", "sse"],
  toolNames: TOOL_NAMES,
  resourceNames: RESOURCE_NAMES,
  promptNames: PROMPT_NAMES,
};

export const serverCard = createServerCard(metadata);

const nonEmptyString = z.string().trim().min(1);

const googleCalendarEnvShape = {
  GOOGLE_CALENDAR_ACCESS_TOKEN: nonEmptyString,
  GOOGLE_CALENDAR_BASE_URL: z.string().url().default("https://www.googleapis.com/calendar/v3"),
  GOOGLE_CALENDAR_DEFAULT_CALENDAR_ID: nonEmptyString.default("primary"),
  GOOGLE_CALENDAR_DEFAULT_TIME_ZONE: nonEmptyString.default("UTC"),
} satisfies z.ZodRawShape;

type GoogleCalendarEnv = z.infer<z.ZodObject<typeof googleCalendarEnvShape>>;

export interface GoogleCalendarConfig {
  accessToken: string;
  baseUrl: string;
  defaultCalendarId: string;
  defaultTimeZone: string;
}

const calendarSummaryShape = {
  id: z.string(),
  summary: z.string(),
  description: z.string().nullable(),
  timeZone: z.string().nullable(),
  primary: z.boolean(),
  accessRole: z.string().nullable(),
  backgroundColor: z.string().nullable(),
  selected: z.boolean(),
  hidden: z.boolean(),
} satisfies z.ZodRawShape;

const calendarSummarySchema = z.object(calendarSummaryShape);
export type GoogleCalendarSummary = z.infer<typeof calendarSummarySchema>;

const calendarEventTimeShape = {
  date: z.string().nullable(),
  dateTime: z.string().nullable(),
  timeZone: z.string().nullable(),
} satisfies z.ZodRawShape;

const calendarEventTimeSchema = z.object(calendarEventTimeShape);
export type GoogleCalendarEventTime = z.infer<typeof calendarEventTimeSchema>;

const calendarEventAttendeeShape = {
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  responseStatus: z.string().nullable(),
  optional: z.boolean(),
} satisfies z.ZodRawShape;

const calendarEventAttendeeSchema = z.object(calendarEventAttendeeShape);
export type GoogleCalendarEventAttendee = z.infer<typeof calendarEventAttendeeSchema>;

const calendarEventShape = {
  id: z.string(),
  status: z.string(),
  summary: z.string().nullable(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  htmlLink: z.string().nullable(),
  created: z.string().nullable(),
  updated: z.string().nullable(),
  start: z.object(calendarEventTimeShape),
  end: z.object(calendarEventTimeShape),
  attendees: z.array(z.object(calendarEventAttendeeShape)),
  organizerEmail: z.string().nullable(),
  conferenceLink: z.string().nullable(),
} satisfies z.ZodRawShape;

const calendarEventSchema = z.object(calendarEventShape);
export type GoogleCalendarEvent = z.infer<typeof calendarEventSchema>;

const listCalendarsOutputShape = {
  calendars: z.array(z.object(calendarSummaryShape)),
} satisfies z.ZodRawShape;

const listCalendarsOutputSchema = z.object(listCalendarsOutputShape);
export type GoogleCalendarListCalendarsOutput = z.infer<typeof listCalendarsOutputSchema>;

const listEventsOutputShape = {
  calendarId: z.string(),
  timeMin: z.string().nullable(),
  timeMax: z.string().nullable(),
  nextPageToken: z.string().nullable(),
  events: z.array(z.object(calendarEventShape)),
} satisfies z.ZodRawShape;

const listEventsOutputSchema = z.object(listEventsOutputShape);
export type GoogleCalendarListEventsOutput = z.infer<typeof listEventsOutputSchema>;

const createEventOutputShape = {
  calendarId: z.string(),
  event: z.object(calendarEventShape),
} satisfies z.ZodRawShape;

const createEventOutputSchema = z.object(createEventOutputShape);
export type GoogleCalendarCreateEventOutput = z.infer<typeof createEventOutputSchema>;

export interface GoogleCalendarClient {
  listCalendars(): Promise<GoogleCalendarListCalendarsOutput>;
  listEvents(input: {
    calendarId: string;
    timeMin?: string;
    timeMax?: string;
    query?: string;
    maxResults: number;
    pageToken?: string;
    orderBy: "startTime" | "updated";
  }): Promise<GoogleCalendarListEventsOutput>;
  createEvent(input: {
    calendarId: string;
    summary: string;
    description?: string;
    location?: string;
    startDateTime: string;
    endDateTime: string;
    timeZone: string;
    attendeeEmails: readonly string[];
  }): Promise<GoogleCalendarCreateEventOutput>;
}

const rawCalendarSchema = z
  .object({
    id: z.string(),
    summary: z.string().optional(),
    description: z.string().nullable().optional(),
    timeZone: z.string().nullable().optional(),
    primary: z.boolean().optional(),
    accessRole: z.string().optional(),
    backgroundColor: z.string().optional(),
    selected: z.boolean().optional(),
    hidden: z.boolean().optional(),
  })
  .passthrough();

type RawCalendar = z.infer<typeof rawCalendarSchema>;

const rawCalendarListResponseSchema = z
  .object({
    items: z.array(rawCalendarSchema).optional().default([]),
  })
  .passthrough();

const rawEventTimeSchema = z
  .object({
    date: z.string().nullable().optional(),
    dateTime: z.string().nullable().optional(),
    timeZone: z.string().nullable().optional(),
  })
  .passthrough();

type RawEventTime = z.infer<typeof rawEventTimeSchema>;

const rawAttendeeSchema = z
  .object({
    email: z.string().nullable().optional(),
    displayName: z.string().nullable().optional(),
    responseStatus: z.string().nullable().optional(),
    optional: z.boolean().optional(),
  })
  .passthrough();

type RawAttendee = z.infer<typeof rawAttendeeSchema>;

const rawConferenceEntrySchema = z
  .object({
    uri: z.string().nullable().optional(),
    entryPointType: z.string().nullable().optional(),
  })
  .passthrough();

type RawConferenceEntry = z.infer<typeof rawConferenceEntrySchema>;

const rawEventSchema = z
  .object({
    id: z.string(),
    status: z.string().optional(),
    summary: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    htmlLink: z.string().nullable().optional(),
    created: z.string().nullable().optional(),
    updated: z.string().nullable().optional(),
    start: rawEventTimeSchema,
    end: rawEventTimeSchema,
    attendees: z.array(rawAttendeeSchema).optional(),
    organizer: z
      .object({
        email: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    conferenceData: z
      .object({
        entryPoints: z.array(rawConferenceEntrySchema).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

type RawEvent = z.infer<typeof rawEventSchema>;

const rawEventsResponseSchema = z
  .object({
    items: z.array(rawEventSchema).optional().default([]),
    nextPageToken: z.string().optional(),
  })
  .passthrough();

function toGoogleCalendarConfig(env: GoogleCalendarEnv): GoogleCalendarConfig {
  return {
    accessToken: env.GOOGLE_CALENDAR_ACCESS_TOKEN,
    baseUrl: env.GOOGLE_CALENDAR_BASE_URL,
    defaultCalendarId: env.GOOGLE_CALENDAR_DEFAULT_CALENDAR_ID,
    defaultTimeZone: env.GOOGLE_CALENDAR_DEFAULT_TIME_ZONE,
  };
}

function loadGoogleCalendarConfig(source: NodeJS.ProcessEnv = process.env): GoogleCalendarConfig {
  return toGoogleCalendarConfig(loadEnv(googleCalendarEnvShape, source));
}

function mapCalendar(raw: RawCalendar): GoogleCalendarSummary {
  return {
    id: raw.id,
    summary: raw.summary?.trim() ? raw.summary : raw.id,
    description: raw.description ?? null,
    timeZone: raw.timeZone ?? null,
    primary: raw.primary ?? false,
    accessRole: raw.accessRole ?? null,
    backgroundColor: raw.backgroundColor ?? null,
    selected: raw.selected ?? false,
    hidden: raw.hidden ?? false,
  };
}

function mapEventTime(raw: RawEventTime): GoogleCalendarEventTime {
  return {
    date: raw.date ?? null,
    dateTime: raw.dateTime ?? null,
    timeZone: raw.timeZone ?? null,
  };
}

function mapAttendee(raw: RawAttendee): GoogleCalendarEventAttendee {
  return {
    email: raw.email ?? null,
    displayName: raw.displayName ?? null,
    responseStatus: raw.responseStatus ?? null,
    optional: raw.optional ?? false,
  };
}

function extractConferenceLink(entries: readonly RawConferenceEntry[] | undefined): string | null {
  if (!entries || entries.length === 0) {
    return null;
  }

  for (const entry of entries) {
    if (entry.entryPointType === "video" && entry.uri) {
      return entry.uri;
    }
  }

  return entries[0]?.uri ?? null;
}

function mapEvent(raw: RawEvent): GoogleCalendarEvent {
  return {
    id: raw.id,
    status: raw.status ?? "confirmed",
    summary: raw.summary ?? null,
    description: raw.description ?? null,
    location: raw.location ?? null,
    htmlLink: raw.htmlLink ?? null,
    created: raw.created ?? null,
    updated: raw.updated ?? null,
    start: mapEventTime(raw.start),
    end: mapEventTime(raw.end),
    attendees: raw.attendees?.map(mapAttendee) ?? [],
    organizerEmail: raw.organizer?.email ?? null,
    conferenceLink: extractConferenceLink(raw.conferenceData?.entryPoints),
  };
}

function formatEventBoundary(time: GoogleCalendarEventTime): string {
  if (time.dateTime) {
    return time.dateTime;
  }

  if (time.date) {
    return time.date;
  }

  return "unspecified";
}

function renderCalendars(output: GoogleCalendarListCalendarsOutput): string {
  if (output.calendars.length === 0) {
    return "No calendars found.";
  }

  return output.calendars
    .map((calendar: GoogleCalendarSummary) => `- ${calendar.summary} (${calendar.id})${calendar.primary ? " [primary]" : ""}`)
    .join("\n");
}

function renderEvents(output: GoogleCalendarListEventsOutput): string {
  if (output.events.length === 0) {
    return `No events found for calendar '${output.calendarId}'.`;
  }

  return output.events
    .map((event: GoogleCalendarEvent) => `- ${event.summary ?? "(untitled)"} | ${formatEventBoundary(event.start)} -> ${formatEventBoundary(event.end)}`)
    .join("\n");
}

function renderCreatedEvent(output: GoogleCalendarCreateEventOutput): string {
  return `Created '${output.event.summary ?? output.event.id}' on ${output.calendarId} (${formatEventBoundary(output.event.start)} -> ${formatEventBoundary(output.event.end)}).`;
}

class GoogleCalendarHttpClient extends HttpServiceClient implements GoogleCalendarClient {
  public constructor(private readonly config: GoogleCalendarConfig, logger: ToolkitServer["logger"]) {
    super({
      serviceName: "google-calendar",
      baseUrl: config.baseUrl,
      logger,
      defaultHeaders: () => ({
        authorization: `Bearer ${config.accessToken}`,
        accept: "application/json",
      }),
    });
  }

  public async listCalendars(): Promise<GoogleCalendarListCalendarsOutput> {
    const response = await this.getJson<z.infer<typeof rawCalendarListResponseSchema>>(
      "/users/me/calendarList",
      rawCalendarListResponseSchema,
    );

    return {
      calendars: response.items.map(mapCalendar),
    };
  }

  public async listEvents(input: {
    calendarId: string;
    timeMin?: string;
    timeMax?: string;
    query?: string;
    maxResults: number;
    pageToken?: string;
    orderBy: "startTime" | "updated";
  }): Promise<GoogleCalendarListEventsOutput> {
    const response = await this.getJson<z.infer<typeof rawEventsResponseSchema>>(
      `/calendars/${encodeURIComponent(input.calendarId)}/events`,
      rawEventsResponseSchema,
      {
        query: {
          maxResults: input.maxResults,
          timeMin: input.timeMin,
          timeMax: input.timeMax,
          q: input.query,
          pageToken: input.pageToken,
          orderBy: input.orderBy,
          singleEvents: input.orderBy === "startTime",
        },
      },
    );

    return {
      calendarId: input.calendarId,
      timeMin: input.timeMin ?? null,
      timeMax: input.timeMax ?? null,
      nextPageToken: response.nextPageToken ?? null,
      events: response.items.map(mapEvent),
    };
  }

  public async createEvent(input: {
    calendarId: string;
    summary: string;
    description?: string;
    location?: string;
    startDateTime: string;
    endDateTime: string;
    timeZone: string;
    attendeeEmails: readonly string[];
  }): Promise<GoogleCalendarCreateEventOutput> {
    const response = await this.postJson<z.infer<typeof rawEventSchema>>(
      `/calendars/${encodeURIComponent(input.calendarId)}/events`,
      rawEventSchema,
      {
        body: {
          summary: input.summary,
          description: input.description,
          location: input.location,
          start: {
            dateTime: input.startDateTime,
            timeZone: input.timeZone,
          },
          end: {
            dateTime: input.endDateTime,
            timeZone: input.timeZone,
          },
          attendees:
            input.attendeeEmails.length > 0
              ? input.attendeeEmails.map((email) => ({
                  email,
                }))
              : undefined,
        },
      },
    );

    return {
      calendarId: input.calendarId,
      event: mapEvent(response),
    };
  }
}

export interface GoogleCalendarServerOptions {
  config?: GoogleCalendarConfig;
  client?: GoogleCalendarClient;
  env?: NodeJS.ProcessEnv;
}

export class GoogleCalendarServer extends ToolkitServer {
  private readonly client: GoogleCalendarClient;
  private readonly config: GoogleCalendarConfig;

  public constructor(options: { config: GoogleCalendarConfig; client?: GoogleCalendarClient }) {
    super(metadata);

    this.config = options.config;
    this.client = options.client ?? new GoogleCalendarHttpClient(options.config, this.logger);

    this.registerTool(
      defineTool({
        name: "list-calendars",
        title: "List calendars",
        description: "List accessible Google Calendars, including primary and shared calendars.",
        annotations: {
          readOnlyHint: true,
        },
        inputSchema: {
          includeHidden: z.boolean().default(false),
        },
        outputSchema: listCalendarsOutputShape,
        handler: async ({ includeHidden }) => {
          const calendars = await this.client.listCalendars();

          return includeHidden
            ? calendars
            : {
                calendars: calendars.calendars.filter((calendar: GoogleCalendarSummary) => !calendar.hidden),
              };
        },
        renderText: renderCalendars,
      }),
    );

    this.registerTool(
      defineTool({
        name: "list-events",
        title: "List events",
        description: "List events from a Google Calendar within an optional time window.",
        annotations: {
          readOnlyHint: true,
        },
        inputSchema: {
          calendarId: nonEmptyString.optional(),
          timeMin: z.string().datetime().optional(),
          timeMax: z.string().datetime().optional(),
          query: nonEmptyString.optional(),
          maxResults: z.number().int().positive().max(100).default(10),
          pageToken: nonEmptyString.optional(),
          orderBy: z.enum(["startTime", "updated"]).default("startTime"),
        },
        outputSchema: listEventsOutputShape,
        handler: async ({ calendarId, timeMin, timeMax, query, maxResults, pageToken, orderBy }) => {
          const request = {
            calendarId: calendarId ?? this.config.defaultCalendarId,
            maxResults,
            orderBy,
            ...(timeMin ? { timeMin } : {}),
            ...(timeMax ? { timeMax } : {}),
            ...(query ? { query } : {}),
            ...(pageToken ? { pageToken } : {}),
          };

          return this.client.listEvents(request);
        },
        renderText: renderEvents,
      }),
    );

    this.registerTool(
      defineTool({
        name: "create-event",
        title: "Create event",
        description: "Create a Google Calendar event with attendees, notes, and timing.",
        inputSchema: {
          calendarId: nonEmptyString.optional(),
          summary: nonEmptyString,
          description: z.string().trim().optional(),
          location: z.string().trim().optional(),
          startDateTime: z.string().datetime(),
          endDateTime: z.string().datetime(),
          timeZone: nonEmptyString.optional(),
          attendeeEmails: z.array(z.string().email()).max(50).default([]),
        },
        outputSchema: createEventOutputShape,
        handler: async ({ calendarId, summary, description, location, startDateTime, endDateTime, timeZone, attendeeEmails }, context) => {
          const start = Date.parse(startDateTime);
          const end = Date.parse(endDateTime);

          if (end <= start) {
            throw new ValidationError("endDateTime must be later than startDateTime.");
          }

          await context.log("info", `Creating Google Calendar event '${summary}'.`);

          const request = {
            calendarId: calendarId ?? this.config.defaultCalendarId,
            summary,
            startDateTime,
            endDateTime,
            timeZone: timeZone ?? this.config.defaultTimeZone,
            attendeeEmails,
            ...(description ? { description } : {}),
            ...(location ? { location } : {}),
          };

          return this.client.createEvent(request);
        },
        renderText: renderCreatedEvent,
      }),
    );

    this.registerStaticResource(
      "calendar-overview",
      "google-calendar://overview",
      {
        title: "Calendar Overview",
        description: "A JSON summary of available calendars and default scheduling preferences.",
        mimeType: "application/json",
      },
      async (uri) => this.createJsonResource(uri.toString(), await this.buildCalendarOverview()),
    );

    this.registerPrompt(
      "meeting-brief",
      {
        title: "Meeting Brief",
        description: "Generate a concise prep brief for an upcoming block of calendar events.",
        argsSchema: {
          calendarId: nonEmptyString.optional(),
          timeMin: z.string().datetime(),
          timeMax: z.string().datetime(),
          focus: nonEmptyString.optional(),
        },
      },
      async ({ calendarId, timeMin, timeMax, focus }) => {
        const promptInput = {
          calendarId: calendarId ?? this.config.defaultCalendarId,
          timeMin,
          timeMax,
          ...(focus ? { focus } : {}),
        };

        return this.createTextPrompt(
          await this.buildMeetingBrief(promptInput),
        );
      },
    );
  }

  private async buildCalendarOverview(): Promise<{
    generatedAt: string;
    defaultCalendarId: string;
    defaultTimeZone: string;
    calendars: GoogleCalendarSummary[];
  }> {
    const calendars = await this.client.listCalendars();

    return {
      generatedAt: new Date().toISOString(),
      defaultCalendarId: this.config.defaultCalendarId,
      defaultTimeZone: this.config.defaultTimeZone,
      calendars: calendars.calendars,
    };
  }

  private async buildMeetingBrief(input: {
    calendarId: string;
    timeMin: string;
    timeMax: string;
    focus?: string;
  }): Promise<string> {
    const events = await this.client.listEvents({
      calendarId: input.calendarId,
      timeMin: input.timeMin,
      timeMax: input.timeMax,
      maxResults: 25,
      orderBy: "startTime",
    });

    const eventLines =
      events.events.length === 0
        ? ["- No meetings are scheduled in this time window."]
        : events.events.map((event: GoogleCalendarEvent) => {
            const attendees =
              event.attendees.length > 0
                ? ` | Attendees: ${event.attendees.map((attendee: GoogleCalendarEventAttendee) => attendee.email ?? attendee.displayName ?? "unknown").join(", ")}`
                : "";
            const location = event.location ? ` | Location: ${event.location}` : "";

            return `- ${event.summary ?? "(untitled)"} | ${formatEventBoundary(event.start)} -> ${formatEventBoundary(event.end)}${location}${attendees}`;
          });

    const focusLine = input.focus
      ? `Focus the brief on: ${input.focus}.`
      : "Focus the brief on preparation needs, chronology, and open questions.";

    return [
      "You are preparing a meeting brief from Google Calendar data.",
      `Calendar: ${input.calendarId}`,
      `Window: ${input.timeMin} to ${input.timeMax}`,
      focusLine,
      "",
      "Scheduled events:",
      ...eventLines,
      "",
      "Produce:",
      "1. A short executive summary.",
      "2. A chronological agenda with meeting-by-meeting preparation notes.",
      "3. Risks, overlaps, or missing context that should be resolved before the meetings start.",
    ].join("\n");
  }
}

export function createServer(options: GoogleCalendarServerOptions = {}): GoogleCalendarServer {
  const config = options.config ?? loadGoogleCalendarConfig(options.env);

  return options.client
    ? new GoogleCalendarServer({
        config,
        client: options.client,
      })
    : new GoogleCalendarServer({
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
