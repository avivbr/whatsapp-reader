/**
 * A synthetic store matching the real Core Data schema closely enough to test against.
 *
 * Deliberately reproduces the two traps in the real database:
 * ZWAGROUPMEMBER.ZCONTACTNAME is the empty string rather than NULL, and
 * ZWAMESSAGE.ZPUSHNAME holds base64 protobuf rather than a display name. A
 * fixture without them would let the blank-sender bug back in unnoticed.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { CHAT_DB, CONTACTS_DB, LID_DB } from "../src/db.ts";
import { CORE_DATA_EPOCH } from "../src/schema.ts";

/** YYYY-MM-DD -> Core Data timestamp, at local midnight to match the reader. */
export function cd(date: string): number {
  return new Date(`${date}T00:00:00`).getTime() / 1000 - CORE_DATA_EPOCH;
}

/** What ZWAMESSAGE.ZPUSHNAME actually contains: protobuf, not a name. */
const JUNK = "CIGF/dMGIABIAZABAPABAtgC";

export function buildStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "wa-fixture-"));

  const chat = new DatabaseSync(join(dir, CHAT_DB));
  chat.exec(`
    CREATE TABLE ZWACHATSESSION (
      Z_PK INTEGER PRIMARY KEY, ZPARTNERNAME TEXT, ZSESSIONTYPE INTEGER,
      ZCONTACTJID TEXT
    );
    CREATE TABLE ZWAMESSAGE (
      Z_PK INTEGER PRIMARY KEY, ZISFROMME INTEGER DEFAULT 0, ZCHATSESSION INTEGER,
      ZGROUPMEMBER INTEGER, ZMEDIAITEM INTEGER, ZMESSAGEDATE REAL, ZFROMJID TEXT,
      ZTEXT TEXT, ZMESSAGETYPE INTEGER DEFAULT 0, ZSTARRED INTEGER DEFAULT 0,
      ZPUSHNAME TEXT
    );
    CREATE TABLE ZWAGROUPMEMBER (
      Z_PK INTEGER PRIMARY KEY, ZMEMBERJID TEXT, ZCONTACTNAME TEXT DEFAULT ''
    );
    CREATE TABLE ZWAPROFILEPUSHNAME (ZJID TEXT, ZPUSHNAME TEXT);
    CREATE TABLE ZWAMEDIAITEM (Z_PK INTEGER PRIMARY KEY, ZMEDIALOCALPATH TEXT);
  `);

  const session = chat.prepare(
    "INSERT INTO ZWACHATSESSION (Z_PK, ZPARTNERNAME, ZSESSIONTYPE, ZCONTACTJID) VALUES (?,?,?,?)",
  );
  session.run(1, "Family", 1, "grp@g.us");
  session.run(2, "Dana Cohen", 0, "555@s.whatsapp.net");
  session.run(3, "Family Reunion", 1, "grp2@g.us");

  const member = chat.prepare("INSERT INTO ZWAGROUPMEMBER (Z_PK, ZMEMBERJID) VALUES (?,?)");
  for (const [pk, jid] of [[10, "111@lid"], [11, "222@lid"], [12, "333@lid"]] as const) {
    member.run(pk, jid);
  }

  const push = chat.prepare("INSERT INTO ZWAPROFILEPUSHNAME (ZJID, ZPUSHNAME) VALUES (?,?)");
  push.run("222@lid", "Yossi");
  push.run("999@s.whatsapp.net", "Direct Pushname");

  chat
    .prepare("INSERT INTO ZWAMEDIAITEM (Z_PK, ZMEDIALOCALPATH) VALUES (?,?)")
    .run(1, "Media/1/a/pic.jpg");

  const msg = chat.prepare(`
    INSERT INTO ZWAMESSAGE
      (Z_PK, ZISFROMME, ZCHATSESSION, ZGROUPMEMBER, ZMEDIAITEM,
       ZMESSAGEDATE, ZFROMJID, ZTEXT, ZMESSAGETYPE, ZPUSHNAME)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `);
  // group message from a saved contact, resolved via @lid
  msg.run(1, 0, 1, 10, null, cd("2026-01-10"), "grp@g.us", "hello from Ada", 0, JUNK);
  // group message from a non-contact who has only a push name
  msg.run(2, 0, 1, 11, null, cd("2026-02-10"), "grp@g.us", "hi from Yossi", 0, JUNK);
  // group message from someone with no name anywhere
  msg.run(3, 0, 1, 12, null, cd("2026-03-10"), "grp@g.us", "who am i", 0, JUNK);
  // outgoing
  msg.run(4, 1, 1, null, null, cd("2026-04-10"), null, "my reply", 0, null);
  // direct message resolved via ZWHATSAPPID
  msg.run(5, 0, 2, null, null, cd("2026-05-10"), "555@s.whatsapp.net", "dinner?", 0, JUNK);
  // image carrying a media path, no text
  msg.run(6, 0, 1, 10, 1, cd("2026-06-10"), "grp@g.us", null, 1, JUNK);
  // a second chat whose name shares a prefix with the first
  msg.run(7, 0, 3, 10, null, cd("2026-07-10"), "grp2@g.us", "reunion planning", 0, JUNK);
  chat.close();

  const contacts = new DatabaseSync(join(dir, CONTACTS_DB));
  contacts.exec(`
    CREATE TABLE ZWAADDRESSBOOKCONTACT (
      Z_PK INTEGER PRIMARY KEY, ZFULLNAME TEXT, ZLID TEXT,
      ZWHATSAPPID TEXT, ZPHONENUMBER TEXT
    );
  `);
  const contact = contacts.prepare(
    "INSERT INTO ZWAADDRESSBOOKCONTACT (ZFULLNAME, ZLID, ZWHATSAPPID, ZPHONENUMBER) VALUES (?,?,?,?)",
  );
  contact.run("Ada Lovelace", "111@lid", "111@s.whatsapp.net", "+972500000111");
  contact.run("Dana Cohen", "444@lid", "555@s.whatsapp.net", "+972500000555");
  contacts.close();

  const lid = new DatabaseSync(join(dir, LID_DB));
  lid.exec("CREATE TABLE ZWAZACCOUNT (ZPHONENUMBER TEXT, ZIDENTIFIER TEXT);");
  const account = lid.prepare("INSERT INTO ZWAZACCOUNT (ZPHONENUMBER, ZIDENTIFIER) VALUES (?,?)");
  account.run("972500000111", "111@lid");
  account.run("972500000222", "222@lid");
  account.run("972500000555", "555@lid");
  lid.close();

  return dir;
}
