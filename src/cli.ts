#!/usr/bin/env node
/** Command line interface: wa snapshot | chats | read | search | whois | today | media | stats */

import { parseArgs } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DATA_DIR, SnapshotMissingError, openSnapshot, snapshot, snapshotAgeSeconds } from "./db.ts";
import { listChats } from "./queries/chats.ts";
import { exportMedia } from "./queries/media.ts";
import { readChat, searchMessages } from "./queries/messages.ts";
import { resolvePhones } from "./queries/people.ts";
import { stats } from "./queries/stats.ts";
import { daySummary } from "./queries/summary.ts";
import { AmbiguousChatError, ChatNotFoundError, type Message } from "./queries/types.ts";

const USAGE = `wa — read your WhatsApp history from the local Mac database.
Offline and read-only; never contacts WhatsApp.

  wa snapshot                      refresh the local snapshot
  wa stats                         totals, date range, breakdowns
  wa chats [query] [--kind K] [-n] chats, most recently active first
  wa read <chat> [-n] [--since D] [--until D] [--media]
  wa search <term> [--chat C] [--from S] [--since D] [--until D] [-n]
  wa whois <number>...             resolve phone numbers to names
  wa today [date]                  who you exchanged messages with
  wa media <chat> [--out DIR] [--since D] [--until D]
`;

const OPTIONS = {
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

function printMessages(messages: Message[], showChat: boolean): void {
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

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
  });
  const [command, ...rest] = positionals;
  if (!command || values.help) {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  const limit = values.limit ? Number(values.limit) : undefined;

  if (command === "snapshot") {
    snapshot(DATA_DIR);
    const db = openSnapshot();
    const s = stats(db);
    db.close();
    console.log(`snapshot -> ${DATA_DIR}`);
    console.log(`${s.messages.toLocaleString()} messages across ${s.chats.toLocaleString()} chats`);
    console.log(`newest: ${s.last}`);
    return 0;
  }

  const db = openSnapshot();
  warnIfStale();
  try {
    switch (command) {
      case "stats": {
        const s = stats(db);
        console.log(`messages : ${s.messages.toLocaleString()}  (${s.fromMe.toLocaleString()} from me)`);
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
        return 0;
      }
      case "chats": {
        const chats = listChats(db, { query: rest[0], kind: values.kind, limit: limit ?? 30 });
        const width = Math.max(10, ...chats.map((c) => c.name.length));
        for (const c of chats) {
          console.log(
            `${c.name.padEnd(width)}  ${c.kind.padEnd(9)} ${c.messages.toLocaleString().padStart(8)}  ${c.last}`,
          );
        }
        return 0;
      }
      case "read": {
        if (!rest[0]) throw new Error("read needs a chat");
        const { chat, messages } = readChat(db, rest[0], {
          limit: limit ?? 40,
          since: values.since,
          until: values.until,
          mediaOnly: values.media,
        });
        console.log(`# ${chat.name}  (${chat.kind}, ${chat.messages.toLocaleString()} messages)\n`);
        printMessages(messages, false);
        return 0;
      }
      case "search": {
        if (!rest[0]) throw new Error("search needs a term");
        const results = searchMessages(db, rest[0], {
          chat: values.chat,
          sender: values.from,
          since: values.since,
          until: values.until,
          limit: limit ?? 40,
        });
        if (results.length === 0) {
          console.log("no matches");
          return 0;
        }
        printMessages(results, true);
        console.log(`\n${results.length} match(es)`);
        return 0;
      }
      case "whois": {
        if (rest.length === 0) throw new Error("whois needs at least one number");
        for (const m of resolvePhones(db, rest)) {
          const via = m.contactName ? "contact" : m.pushName ? "pushname" : m.chatTitle ? "chat" : "-";
          console.log(`${m.number.padEnd(15)} ${(m.bestName ?? "(not found)").padEnd(38)} ${via}`);
        }
        return 0;
      }
      case "today": {
        const s = daySummary(db, rest[0]);
        console.log(`# ${s.date}\n`);
        console.log(`you replied in ${s.participated.length} chat(s):`);
        for (const c of s.participated) {
          console.log(`  ${c.chat}  (${c.kind}, sent ${c.sent}/${c.messages}, ${c.firstAt}-${c.lastAt})`);
          if (c.others.length > 0) {
            console.log(`      ${c.others.map((o) => `${o.name} (${o.messages})`).join(", ")}`);
          }
        }
        console.log(`\n${s.activeOnly.length} chat(s) active without a reply from you:`);
        for (const c of s.activeOnly) console.log(`  ${c.chat}  (${c.messages})`);
        return 0;
      }
      case "media": {
        if (!rest[0]) throw new Error("media needs a chat");
        const r = exportMedia(db, rest[0], values.out ?? join(tmpdir(), "whatsapp-export"), {
          since: values.since,
          until: values.until,
          limit: limit ?? 200,
        });
        const done = r.exported.filter((e) => e.exported).length;
        console.log(`${done} file(s) -> ${r.destination}`);
        if (r.missing > 0) console.log(`${r.missing} indexed but never downloaded`);
        return 0;
      }
      default:
        console.error(`unknown command: ${command}\n`);
        console.log(USAGE);
        return 1;
    }
  } finally {
    db.close();
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  if (
    err instanceof AmbiguousChatError ||
    err instanceof ChatNotFoundError ||
    err instanceof SnapshotMissingError ||
    err instanceof RangeError ||
    err instanceof Error
  ) {
    console.error(err.message);
    process.exitCode = 1;
  } else throw err;
}
