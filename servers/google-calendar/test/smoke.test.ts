import { describe, expect, it } from "vitest";

import {
  GoogleCalendarServer,
  createServer,
  serverCard,
  type GoogleCalendarClient,
  type GoogleCalendarConfig,
} from "../src/index.js";

const config: GoogleCalendarConfig = {
  accessToken: "test-token",
  baseUrl: "https://calendar.example.test",
  defaultCalendarId: "primary",
  defaultTimeZone: "UTC",
};

const fakeClient: GoogleCalendarClient = {
  async listCalendars() {
    return {
      calendars: [
        {
          id: "primary",
          summary: "Primary Calendar",
          description: "Team schedule",
          timeZone: "UTC",
          primary: true,
          accessRole: "owner",
          backgroundColor: "#4285f4",
          selected: true,
          hidden: false,
        },
      ],
    };
  },
  async listEvents(input) {
    return {
      calendarId: input.calendarId,
      timeMin: input.timeMin ?? null,
      timeMax: input.timeMax ?? null,
      nextPageToken: null,
      events: [
        {
          id: "evt_123",
          status: "confirmed",
          summary: "Quarterly planning",
          description: "Review roadmap priorities",
          location: "Zoom",
          htmlLink: "https://calendar.example.test/events/evt_123",
          created: "2026-03-10T12:00:00Z",
          updated: "2026-03-10T12:05:00Z",
          start: {
            date: null,
            dateTime: "2026-03-12T09:00:00Z",
            timeZone: "UTC",
          },
          end: {
            date: null,
            dateTime: "2026-03-12T10:00:00Z",
            timeZone: "UTC",
          },
          attendees: [
            {
              email: "teammate@example.com",
              displayName: "Teammate",
              responseStatus: "accepted",
              optional: false,
            },
          ],
          organizerEmail: "owner@example.com",
          conferenceLink: "https://meet.example.test/room",
        },
      ],
    };
  },
  async createEvent(input) {
    return {
      calendarId: input.calendarId,
      event: {
        id: "evt_created",
        status: "confirmed",
        summary: input.summary,
        description: input.description ?? null,
        location: input.location ?? null,
        htmlLink: "https://calendar.example.test/events/evt_created",
        created: "2026-03-10T13:00:00Z",
        updated: "2026-03-10T13:00:00Z",
        start: {
          date: null,
          dateTime: input.startDateTime,
          timeZone: input.timeZone,
        },
        end: {
          date: null,
          dateTime: input.endDateTime,
          timeZone: input.timeZone,
        },
        attendees: input.attendeeEmails.map((email) => ({
          email,
          displayName: null,
          responseStatus: "needsAction",
          optional: false,
        })),
        organizerEmail: "owner@example.com",
        conferenceLink: null,
      },
    };
  },
};

describe("google-calendar smoke test", () => {
  it("registers the expected tools, resources, and prompts", async () => {
    const server = createServer({
      config,
      client: fakeClient,
    });

    expect(server).toBeInstanceOf(GoogleCalendarServer);
    expect(server.getToolNames()).toEqual(["create-event", "list-calendars", "list-events"]);
    expect(server.getResourceNames()).toEqual(["calendar-overview"]);
    expect(server.getPromptNames()).toEqual(["meeting-brief"]);
    expect(serverCard.tools).toEqual(["list-calendars", "list-events", "create-event"]);

    const calendars = await server.invokeTool<{ calendars: Array<{ id: string }> }>("list-calendars", {});
    expect(calendars.calendars[0]?.id).toBe("primary");

    const events = await server.invokeTool<{ events: Array<{ id: string }>; calendarId: string }>("list-events", {
      maxResults: 5,
    });
    expect(events.calendarId).toBe("primary");
    expect(events.events[0]?.id).toBe("evt_123");

    const created = await server.invokeTool<{ event: { summary: string; attendees: Array<{ email: string | null }> } }>(
      "create-event",
      {
        summary: "Quarterly planning",
        startDateTime: "2026-03-12T09:00:00Z",
        endDateTime: "2026-03-12T10:00:00Z",
        attendeeEmails: ["teammate@example.com"],
      },
    );

    expect(created.event.summary).toBe("Quarterly planning");
    expect(created.event.attendees[0]?.email).toBe("teammate@example.com");

    await server.close();
  });
});
