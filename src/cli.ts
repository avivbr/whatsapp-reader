#!/usr/bin/env node
/**
 * Command line interface — the only interface.
 *
 * Every command returns structured data and then renders it, so `--json` and the
 * human rendering are the same result formatted two ways rather than two code
 * paths that can disagree. `--json` is what makes this usable by an agent: it
 * gets objects to reason over instead of text to re-parse.
 */

import "./quiet.ts";

import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DATA_DIR, SnapshotMissingError, openSnapshot, snapshot, snapshotAgeSeconds } from "./db.ts";
import { listChats } from "./queries/chats.ts";
import { type MediaKind, exportMedia, findMedia } from "./queries/media.ts";
import { readChat, searchMessages } from "./queries/messages.ts";
import { resolvePhones } from "./queries/people.ts";
import { stats } from "./queries/stats.ts";
import { daySummary } from "./queries/summary.ts";
import { AmbiguousChatError, ChatNotFoundError, type Message } from "./queries/types.ts";

export const USAGE = `wa — read your WhatsApp history from the local Mac database.
Offline and read-only. Never contacts WhatsApp; cannot send.

COMMANDS
  wa snapshot                       refresh the local snapshot from WhatsApp for Mac
  wa stats                          totals, date range, breakdown by year and type
  wa chats [query]                  chats, most recently active first
  wa read <chat>                    messages from one chat, oldest first
  wa search <term>                  search message text across all chats
  wa whois <number>...              resolve phone numbers to names
  wa today [date]                   who you exchanged messages with that day
  wa find-media                     list attachments without copying them
  wa media [chat]                   copy attachments to a directory

OPTIONS
  --json                  emit structured JSON instead of text (use this from scripts)
  -n, --limit N           maximum results
  --since YYYY-MM-DD      on or after this date (local time)
  --until YYYY-MM-DD      before this date, exclusive (local time)
  --chat NAME             restrict to one chat
  --from NAME             restrict to one sender
  --kind K[,K]            image, video, voice, document, sticker
  --media                 read: only messages with attachments
                          find-media: only attachments present on disk
  --out DIR               media: destination directory
  -h, --help              this text

NOTES
  Chats are addressed by name, unique substring, or numeric id. An ambiguous
  substring exits 1 and lists the candidates rather than guessing.

  Message text goes back further than media. Attachments exist only from the
  date the Mac app was linked; earlier ones are indexed but were never
  downloaded, and are reported rather than silently omitted.
`;

const MEDIA_KINDS = ["image", "video", "voice", "document", "sticker"] as const;

/** Parse a comma-separated --kind value, rejecting anything unrecognised. */
function parseKinds(value: string | undefined): MediaKind[] | undefined {
  if (!value) return undefined;
  return value.split(",").map((raw) => {
    const kind = raw.trim().toLowerCase();
    if (!(MEDIA_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`unknown media kind "${kind}"; expected one of ${MEDIA_KINDS.join(", ")}`);
    }
    return kind as MediaKind;
  });
}

const OPTIONS = {
  json: { type: "boolean" },
  limit: { type: "string", short: "n" },
  kind: { type: "string" },
  since: { type: "string" },
  until: { type: "string" },
  chat: { type: "string" },
  from: { type: "string" },
  out: { type: "string" },
  media: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

/** A command's result: the data, plus how to render it for a human. */
interface Outcome {
  data: Record<string, unknown>;
  render: () => void;
}

function renderMessages(messages: Message[], showChat: boolean): void {
  for (const m of messages) {
    let body = m.text ?? "";
    if (m.kind !== "text") {
      const marker = m.media ? `<${m.kind}: ${m.media.split("/").pop()}>` : `<${m.kind}>`;
      body = `${marker} ${body}`.trim();
    }
    const where = showChat ? ` ${m.chat} |` : "";
    console.log(`[${m.date}]${where} ${m.sender}${m.starred ? " *" : ""}: ${body}`);
  }
}

function warnIfStale(): void {
  const age = snapshotAgeSeconds();
  if (age !== null && age > 6 * 3600) {
    console.error(`note: snapshot is ${Math.round(age / 3600)}h old; run \`wa snapshot\` to refresh`);
  }
}

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
  });
  const [command, ...rest] = positionals;
  // Asking for help succeeds. Invoking with nothing at all is a usage error,
  // even though both print the same text.
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (!command) {
    console.log(USAGE);
    return 1;
  }
  const limit = values.limit ? Number(values.limit) : undefined;
  if (values.limit !== undefined && !Number.isFinite(limit)) {
    throw new Error(`--limit expects a number, got ${JSON.stringify(values.limit)}`);
  }

  // snapshot writes before it can read, so it runs outside the shared handle.
  if (command === "snapshot") {
    snapshot(DATA_DIR);
    const db = openSnapshot();
    const summary = stats(db);
    db.close();
    const data = {
      dataDir: DATA_DIR,
      messages: summary.messages,
      chats: summary.chats,
      newest: summary.last,
    };
    if (values.json) console.log(JSON.stringify(data, null, 2));
    else {
      console.log(`snapshot -> ${DATA_DIR}`);
      console.log(
        `${summary.messages.toLocaleString()} messages across ${summary.chats.toLocaleString()} chats`,
      );
      console.log(`newest: ${summary.last}`);
    }
    return 0;
  }

  const db = openSnapshot();
  if (!values.json) warnIfStale();
  try {
    const outcome = dispatch(command, rest, values, limit, db);
    if (outcome === null) {
      console.error(`unknown command: ${command}\n`);
      console.log(USAGE);
      return 1;
    }
    if (values.json) console.log(JSON.stringify(outcome.data, null, 2));
    else outcome.render();
    return 0;
  } finally {
    db.close();
  }
}

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>["values"];

function dispatch(
  command: string,
  rest: string[],
  values: Values,
  limit: number | undefined,
  db: ReturnType<typeof openSnapshot>,
): Outcome | null {
  switch (command) {
    case "stats": {
      const s = stats(db);
      return {
        data: s as unknown as Record<string, unknown>,
        render: () => {
          console.log(
            `messages : ${s.messages.toLocaleString()}  (${s.fromMe.toLocaleString()} from me)`,
          );
          console.log(`chats    : ${s.chats.toLocaleString()}`);
          console.log(`contacts : ${s.contacts.toLocaleString()}`);
          console.log(`range    : ${s.first}  ->  ${s.last}`);
          console.log("\nby year:");
          for (const [year, n] of Object.entries(s.byYear)) {
            console.log(`  ${year}  ${n.toLocaleString().padStart(8)}`);
          }
          console.log("\nby type:");
          for (const [kind, n] of Object.entries(s.byType).slice(0, 10)) {
            console.log(`  ${kind.padEnd(10)} ${n.toLocaleString().padStart(8)}`);
          }
        },
      };
    }

    case "chats": {
      const chats = listChats(db, {
        query: rest[0],
        kind: values.kind,
        limit: limit ?? 30,
      });
      return {
        data: { chats },
        render: () => {
          const width = Math.max(10, ...chats.map((c) => c.name.length));
          for (const c of chats) {
            console.log(
              `${c.name.padEnd(width)}  ${c.kind.padEnd(9)} ${c.messages.toLocaleString().padStart(8)}  ${c.last}`,
            );
          }
        },
      };
    }

    case "read": {
      if (!rest[0]) throw new Error("read needs a chat");
      const { chat, messages } = readChat(db, rest[0], {
        limit: limit ?? 40,
        since: values.since,
        until: values.until,
        mediaOnly: values.media,
      });
      return {
        data: { chat, messages },
        render: () => {
          console.log(`# ${chat.name}  (${chat.kind}, ${chat.messages.toLocaleString()} messages)\n`);
          renderMessages(messages, false);
        },
      };
    }

    case "search": {
      if (rest[0] === undefined) throw new Error("search needs a term");
      const results = searchMessages(db, rest[0], {
        chat: values.chat,
        sender: values.from,
        since: values.since,
        until: values.until,
        limit: limit ?? 40,
      });
      return {
        data: { results, count: results.length },
        render: () => {
          if (results.length === 0) {
            console.log("no matches");
            return;
          }
          renderMessages(results, true);
          console.log(`\n${results.length} match(es)`);
        },
      };
    }

    case "whois": {
      if (rest.length === 0) throw new Error("whois needs at least one number");
      const matches = resolvePhones(db, rest);
      return {
        data: { matches },
        render: () => {
          for (const m of matches) {
            const via = m.contactName
              ? "contact"
              : m.pushName
                ? "pushname"
                : m.chatTitle
                  ? "chat"
                  : "-";
            console.log(
              `${m.number.padEnd(15)} ${(m.bestName ?? "(not found)").padEnd(38)} ${via}`,
            );
          }
        },
      };
    }

    case "today": {
      const s = daySummary(db, rest[0]);
      return {
        data: s as unknown as Record<string, unknown>,
        render: () => {
          console.log(`# ${s.date}\n`);
          console.log(`you replied in ${s.participated.length} chat(s):`);
          for (const c of s.participated) {
            console.log(
              `  ${c.chat}  (${c.kind}, sent ${c.sent}/${c.messages}, ${c.firstAt}-${c.lastAt})`,
            );
            if (c.others.length > 0) {
              console.log(`      ${c.others.map((o) => `${o.name} (${o.messages})`).join(", ")}`);
            }
          }
          console.log(`\n${s.activeOnly.length} chat(s) active without a reply from you:`);
          for (const c of s.activeOnly) console.log(`  ${c.chat}  (${c.messages})`);
        },
      };
    }

    case "find-media": {
      const media = findMedia(db, {
        chat: values.chat,
        kinds: parseKinds(values.kind),
        sender: values.from,
        since: values.since,
        until: values.until,
        onDiskOnly: values.media,
        limit: limit ?? 40,
      });
      return {
        data: { media, count: media.length },
        render: () => {
          for (const f of media) {
            const size = f.sizeBytes ? `${Math.round(f.sizeBytes / 1024)}KB` : "-";
            const label = f.filename ?? f.caption ?? f.source.split("/").pop() ?? "";
            console.log(
              `[${f.date}] ${f.onDisk ? " " : "!"} ${f.kind.padEnd(9)} ${size.padStart(7)}  ` +
                `${f.chat.slice(0, 22).padEnd(22)} ${f.sender.slice(0, 20).padEnd(20)} ${label.slice(0, 44)}`,
            );
          }
          console.log(`\n${media.length} item(s); ! = indexed but not downloaded`);
        },
      };
    }

    case "media": {
      const result = exportMedia(db, values.out ?? join(tmpdir(), "whatsapp-export"), {
        chat: rest[0],
        kinds: parseKinds(values.kind),
        sender: values.from,
        since: values.since,
        until: values.until,
        limit: limit ?? 200,
      });
      return {
        data: result as unknown as Record<string, unknown>,
        render: () => {
          console.log(`${result.written} file(s) -> ${result.destination}`);
          if (result.missing > 0) {
            console.log(`${result.missing} indexed but never downloaded`);
          }
        },
      };
    }

    default:
      return null;
  }
}

/** Recoverable failures print a message and exit 1; anything else is a real crash. */
const EXPECTED = [
  AmbiguousChatError,
  ChatNotFoundError,
  SnapshotMissingError,
  RangeError,
] as const;

export function main(argv: string[]): number {
  try {
    return run(argv);
  } catch (err) {
    if (EXPECTED.some((E) => err instanceof E) || err instanceof Error) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
    throw err;
  }
}

// Only run when invoked directly, so tests can import `run` without side effects.
// argv[1] is the symlink path when invoked as `wa`, so both sides are resolved.
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(import.meta.filename);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = main(process.argv.slice(2));
}
