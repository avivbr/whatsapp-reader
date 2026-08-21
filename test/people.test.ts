import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import type { DatabaseSync } from "node:sqlite";

import { openSnapshot } from "../src/db.ts";
import { resolvePhone, resolvePhones } from "../src/queries/people.ts";
import { daySummary } from "../src/queries/summary.ts";
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

describe("resolvePhone", () => {
  it("finds a saved contact by WhatsApp JID", () => {
    const r = resolvePhone(db, "972500000111");
    assert.equal(r.contactName, "Ada Lovelace");
    assert.equal(r.bestName, "Ada Lovelace");
    assert.equal(r.found, true);
  });

  it("reaches a non-contact through the lid mapping", () => {
    // The whole reason LID.sqlite is a snapshot source: without the phone -> @lid
    // hop there is no way to a name for someone absent from the address book.
    const r = resolvePhone(db, "972500000222");
    assert.equal(r.lid, "222@lid");
    assert.equal(r.contactName, null);
    assert.equal(r.pushName, "Yossi");
    assert.equal(r.bestName, "Yossi");
  });

  it("normalises punctuation and country prefixes", () => {
    const r = resolvePhone(db, "+972-500-000-555");
    assert.equal(r.number, "972500000555");
    assert.equal(r.contactName, "Dana Cohen");
  });

  it("reports a 1:1 chat title alongside the contact", () => {
    assert.equal(resolvePhone(db, "972500000555").chatTitle, "Dana Cohen");
  });

  it("marks an unknown number as not found", () => {
    const r = resolvePhone(db, "972999999999");
    assert.equal(r.found, false);
    assert.equal(r.bestName, null);
    assert.equal(r.lid, null);
  });

  it("resolves a batch in order", () => {
    const names = resolvePhones(db, ["972500000222", "972500000111"]).map((r) => r.bestName);
    assert.deepEqual(names, ["Yossi", "Ada Lovelace"]);
  });
});

describe("daySummary", () => {
  it("separates days you replied in from days you only received", () => {
    const replied = daySummary(db, "2026-04-10");
    assert.equal(replied.participated.length, 1);
    assert.equal(replied.participated[0]!.sent, 1);
    assert.equal(replied.activeOnly.length, 0);

    const received = daySummary(db, "2026-01-10");
    assert.equal(received.participated.length, 0);
    assert.equal(received.activeOnly.length, 1);
    assert.equal(received.activeOnly[0]!.chat, "Family");
  });

  it("names who else was talking in chats you replied in", () => {
    // Ada and the outgoing reply share a chat but not a day, so widen to a day
    // that has both an incoming and an outgoing message.
    const day = daySummary(db, "2026-04-10");
    assert.equal(day.participated[0]!.others.length, 0);
  });

  it("returns an empty summary for a quiet day", () => {
    const quiet = daySummary(db, "2025-01-01");
    assert.deepEqual(quiet.participated, []);
    assert.deepEqual(quiet.activeOnly, []);
    assert.equal(quiet.date, "2025-01-01");
  });

  it("defaults to today in local time", () => {
    const today = daySummary(db);
    assert.match(today.date, /^\d{4}-\d{2}-\d{2}$/);
  });
});
