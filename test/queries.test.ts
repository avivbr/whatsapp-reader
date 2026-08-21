import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import type { DatabaseSync } from "node:sqlite";

import { openSnapshot } from "../src/db.ts";
import { listChats, resolveChat } from "../src/queries/chats.ts";
import { readChat, searchMessages } from "../src/queries/messages.ts";
import { stats } from "../src/queries/stats.ts";
import { AmbiguousChatError, ChatNotFoundError } from "../src/queries/types.ts";
import { buildStore } from "./fixture.ts";

let dir: string;
let db: DatabaseSync;

before(() => {
  dir = buildStore();
  db = openSnapshot(dir);
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const senders = (chat: string, opts = {}) => readChat(db, chat, opts).messages.map((m) => m.sender);

describe("sender resolution", () => {
  // The fallback chain is the fiddliest part of the reader; cover every branch.

  it("resolves a group member from the address book via @lid", () => {
    assert.deepEqual(senders("Family", { until: "2026-02-01" }), ["Ada Lovelace"]);
  });

  it("falls back to a push name for a non-contact", () => {
    assert.deepEqual(senders("Family", { since: "2026-02-01", until: "2026-03-01" }), ["Yossi"]);
  });

  it("falls back to the raw identifier when no name exists anywhere", () => {
    assert.deepEqual(senders("Family", { since: "2026-03-01", until: "2026-04-01" }), ["333@lid"]);
  });

  it("labels outgoing messages as Me", () => {
    assert.deepEqual(senders("Family", { since: "2026-04-01", until: "2026-05-01" }), ["Me"]);
  });

  it("resolves a direct message via ZWHATSAPPID", () => {
    assert.deepEqual(senders("Dana Cohen"), ["Dana Cohen"]);
  });

  it("does not let the empty ZCONTACTNAME shadow later sources", () => {
    // ZWAGROUPMEMBER.ZCONTACTNAME is '' on every real row, so a naive COALESCE
    // returns blank senders. Guard against that regressing.
    for (const m of readChat(db, "Family").messages) {
      assert.ok(m.sender.trim().length > 0, `blank sender at ${m.date}`);
    }
  });

  it("never leaks the base64 ZPUSHNAME into output", () => {
    for (const m of readChat(db, "Family").messages) {
      assert.ok(!m.sender.includes("IABIAZABAPABAtgC"), `protobuf leaked: ${m.sender}`);
    }
  });
});

describe("readChat", () => {
  it("returns oldest first", () => {
    const dates = readChat(db, "Family").messages.map((m) => m.date);
    assert.deepEqual(dates, [...dates].sort());
  });

  it("keeps the most recent when limited", () => {
    const messages = readChat(db, "Family", { limit: 2 }).messages;
    assert.equal(messages.length, 2);
    assert.ok(messages.at(-1)!.date.startsWith("2026-06-14"));
  });

  it("filters to messages carrying media", () => {
    const messages = readChat(db, "Family", { mediaOnly: true }).messages;
    assert.deepEqual(
      messages.map((m) => m.kind),
      ["image", "document", "video", "voice", "image"],
    );
    assert.equal(messages[0]!.media, "Media/1/a/pic.jpg");
  });

  it("treats until as exclusive", () => {
    assert.deepEqual(readChat(db, "Family", { until: "2026-01-10" }).messages, []);
  });

  it("rejects an unparseable date", () => {
    assert.throws(() => readChat(db, "Family", { since: "last tuesday" }), /YYYY-MM-DD/);
  });
});

describe("chat resolution", () => {
  it("prefers an exact name over a substring", () => {
    assert.equal(resolveChat(db, "Family").name, "Family");
  });

  it("lists candidates when a substring is ambiguous", () => {
    assert.throws(
      () => resolveChat(db, "Fam"),
      (err: unknown) => {
        assert.ok(err instanceof AmbiguousChatError);
        assert.deepEqual(new Set(err.matches), new Set(["Family", "Family Reunion"]));
        return true;
      },
    );
  });

  it("raises on an unknown chat", () => {
    assert.throws(() => resolveChat(db, "Nonexistent"), ChatNotFoundError);
  });

  it("resolves by numeric id", () => {
    assert.equal(resolveChat(db, "2").name, "Dana Cohen");
  });

  it("filters by kind", () => {
    assert.deepEqual(
      listChats(db, { kind: "direct" }).map((c) => c.name),
      ["Dana Cohen"],
    );
  });
});

describe("searchMessages", () => {
  it("finds across chats", () => {
    assert.equal(searchMessages(db, "hello").length, 1);
  });

  it("scopes to one chat", () => {
    assert.deepEqual(searchMessages(db, "dinner", { chat: "Family" }), []);
    assert.equal(searchMessages(db, "dinner", { chat: "Dana Cohen" }).length, 1);
  });

  it("filters by sender", () => {
    const found = searchMessages(db, "", { sender: "Ada" });
    assert.deepEqual(new Set(found.map((m) => m.sender)), new Set(["Ada Lovelace"]));
  });

  it("honours a date window", () => {
    assert.notEqual(searchMessages(db, "", { since: "2026-05-01" }).length, 0);
    assert.equal(searchMessages(db, "", { since: "2027-01-01" }).length, 0);
  });

  it("skips messages without text", () => {
    // An empty term matches every text row but never a bare attachment.
    assert.ok(searchMessages(db, "").every((m) => m.text));
  });
});

describe("stats", () => {
  it("totals", () => {
    const s = stats(db);
    assert.equal(s.messages, 11);
    assert.equal(s.fromMe, 2);
    assert.equal(s.chats, 3);
    assert.equal(s.contacts, 2);
  });

  it("labels types", () => {
    const s = stats(db);
    assert.equal(s.byType["text"], 6);
    assert.equal(s.byType["image"], 2);
    assert.equal(s.byType["document"], 1);
    assert.equal(s.byType["video"], 1);
    assert.equal(s.byType["voice"], 1);
  });
});
