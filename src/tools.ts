/**
 * MCP tool definitions.
 *
 * Every tool here reads a local SQLite snapshot. Nothing contacts WhatsApp, and
 * there is deliberately no tool that sends a message.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";

import { DATA_DIR, openSnapshot, snapshot, snapshotAgeSeconds } from "./db.ts";
import { listChats } from "./queries/chats.ts";
import { exportMedia, findMedia } from "./queries/media.ts";
import { readChat, searchMessages } from "./queries/messages.ts";
import { resolvePhones } from "./queries/people.ts";
import { stats } from "./queries/stats.ts";
import { daySummary } from "./queries/summary.ts";
import { AmbiguousChatError, ChatNotFoundError } from "./queries/types.ts";

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/** Warn the model when the snapshot has drifted behind the live store. */
function freshness(): Record<string, unknown> {
  const age = snapshotAgeSeconds();
  if (age === null) return {};
  const hours = Math.round((age / 3600) * 10) / 10;
  return hours > 6
    ? { snapshotAgeHours: hours, hint: "Snapshot is stale; call refresh_snapshot." }
    : { snapshotAgeHours: hours };
}

/** Run a query against a fresh read-only handle, always closing it. */
function withDb<T>(fn: (db: ReturnType<typeof openSnapshot>) => T): T {
  const db = openSnapshot();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

/** Chat lookups fail in two recoverable ways; report them as data, not errors. */
function guardChat<T>(fn: () => T): T | { error: string; candidates?: string[] } {
  try {
    return fn();
  } catch (err) {
    if (err instanceof AmbiguousChatError) {
      return { error: err.message, candidates: err.matches };
    }
    if (err instanceof ChatNotFoundError) return { error: err.message };
    throw err;
  }
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    "stats",
    {
      description:
        "Summarise the WhatsApp archive: totals, date range, breakdown by year and message type.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () => json(withDb((db) => ({ ...stats(db), ...freshness() }))),
  );

  server.registerTool(
    "list_chats",
    {
      description: "List chats, most recently active first.",
      inputSchema: z.object({
        query: z.string().optional().describe("filter by name substring"),
        kind: z.enum(["direct", "group", "broadcast", "status"]).optional(),
        limit: z.number().int().min(1).max(500).default(30),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, kind, limit }) =>
      json(withDb((db) => ({ chats: listChats(db, { query, kind, limit }), ...freshness() }))),
  );

  server.registerTool(
    "read_chat",
    {
      description:
        "Read messages from one chat, oldest first. Accepts a chat name, unique substring, or numeric id.",
      inputSchema: z.object({
        chat: z.string(),
        limit: z.number().int().min(1).max(500).default(50),
        since: DATE.optional(),
        until: DATE.optional().describe("exclusive"),
        mediaOnly: z.boolean().default(false),
      }),
      annotations: READ_ONLY,
    },
    async ({ chat, limit, since, until, mediaOnly }) =>
      json(
        withDb((db) =>
          guardChat(() => ({
            ...readChat(db, chat, { limit, since, until, mediaOnly }),
            ...freshness(),
          })),
        ),
      ),
  );

  server.registerTool(
    "search_messages",
    {
      description: "Search message text across all chats, most recent first.",
      inputSchema: z.object({
        term: z.string(),
        chat: z.string().optional(),
        sender: z.string().optional(),
        since: DATE.optional(),
        until: DATE.optional(),
        limit: z.number().int().min(1).max(500).default(50),
      }),
      annotations: READ_ONLY,
    },
    async ({ term, chat, sender, since, until, limit }) =>
      json(
        withDb((db) =>
          guardChat(() => ({
            results: searchMessages(db, term, { chat, sender, since, until, limit }),
            ...freshness(),
          })),
        ),
      ),
  );

  server.registerTool(
    "resolve_phone",
    {
      description:
        "Resolve phone numbers to the names WhatsApp knows them by: address book, self-set push name, or 1:1 chat title.",
      inputSchema: z.object({
        numbers: z.array(z.string()).min(1).max(500),
      }),
      annotations: READ_ONLY,
    },
    async ({ numbers }) =>
      json(withDb((db) => ({ matches: resolvePhones(db, numbers), ...freshness() }))),
  );

  server.registerTool(
    "day_summary",
    {
      description:
        "Who you exchanged messages with on one day, separating chats you replied in from chats that were merely active. Day boundaries are local.",
      inputSchema: z.object({
        date: DATE.optional().describe("defaults to today, local time"),
      }),
      annotations: READ_ONLY,
    },
    async ({ date }) => json(withDb((db) => ({ ...daySummary(db, date), ...freshness() }))),
  );

  const MEDIA_KINDS = z
    .array(z.enum(["image", "video", "voice", "document", "sticker"]))
    .optional()
    .describe("restrict to these attachment kinds");

  server.registerTool(
    "find_media",
    {
      description:
        "List attachments without copying them: kind, MIME type, size, caption, sender, and whether the file is on disk. Documents also carry their original filename.",
      inputSchema: z.object({
        kinds: MEDIA_KINDS,
        chat: z.string().optional(),
        sender: z.string().optional(),
        since: DATE.optional(),
        until: DATE.optional(),
        onDiskOnly: z.boolean().default(false).describe("skip attachments never downloaded"),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      annotations: READ_ONLY,
    },
    async ({ kinds, chat, sender, since, until, onDiskOnly, limit }) =>
      json(
        withDb((db) =>
          guardChat(() => ({
            media: findMedia(db, { kinds, chat, sender, since, until, onDiskOnly, limit }),
            ...freshness(),
          })),
        ),
      ),
  );

  server.registerTool(
    "export_media",
    {
      description:
        "Copy downloaded attachments to a directory so they can be opened. Documents keep their original filename. Attachments never downloaded are reported as missing.",
      inputSchema: z.object({
        destination: z.string().optional().describe("defaults to a temp directory"),
        chat: z.string().optional().describe("all chats when omitted"),
        kinds: MEDIA_KINDS,
        sender: z.string().optional(),
        since: DATE.optional(),
        until: DATE.optional(),
        limit: z.number().int().min(1).max(1000).default(200),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ destination, chat, kinds, sender, since, until, limit }) =>
      json(
        withDb((db) =>
          guardChat(() =>
            exportMedia(db, destination ?? join(tmpdir(), "whatsapp-export"), {
              chat,
              kinds,
              sender,
              since,
              until,
              limit,
            }),
          ),
        ),
      ),
  );

  server.registerTool(
    "refresh_snapshot",
    {
      description:
        "Re-copy the live WhatsApp database so subsequent reads see current messages.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      snapshot(DATA_DIR);
      const summary = withDb((db) => stats(db));
      return json({ messages: summary.messages, newest: summary.last });
    },
  );
}
