/**
 * A synthetic store matching the real Core Data schema closely enough to test against.
 *
 * Deliberately reproduces the two traps in the real database:
 * ZWAGROUPMEMBER.ZCONTACTNAME is the empty string rather than NULL, and
 * ZWAMESSAGE.ZPUSHNAME holds base64 protobuf rather than a display name. A
 * fixture without them would let the blank-sender bug back in unnoticed.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    CREATE TABLE ZWAMEDIAITEM (
      Z_PK INTEGER PRIMARY KEY, ZMEDIALOCALPATH TEXT, ZAUTHORNAME TEXT,
      ZVCARDSTRING TEXT, ZFILESIZE INTEGER, ZTITLE TEXT
    );
  `);

  const session = chat.prepare(
    "INSERT INTO ZWACHATSESSION (Z_PK, ZPARTNERNAME, ZSESSIONTYPE, ZCONTACTJID) VALUES (?,?,?,?)",
  );
  session.run(1, "Family", 1, "grp@g.us");
  session.run(2, "Dana Cohen", 0, "972500000555@s.whatsapp.net");
  session.run(3, "Family Reunion", 1, "grp2@g.us");

  const member = chat.prepare("INSERT INTO ZWAGROUPMEMBER (Z_PK, ZMEMBERJID) VALUES (?,?)");
  for (const [pk, jid] of [[10, "111@lid"], [11, "222@lid"], [12, "333@lid"]] as const) {
    member.run(pk, jid);
  }

  const push = chat.prepare("INSERT INTO ZWAPROFILEPUSHNAME (ZJID, ZPUSHNAME) VALUES (?,?)");
  push.run("222@lid", "Yossi");
  push.run("972500000999@s.whatsapp.net", "Direct Pushname");

  // ZAUTHORNAME is the original filename (documents only), ZVCARDSTRING the MIME
  // type, ZTITLE the sender's caption. All three are misleadingly named.
  const media = chat.prepare(
    `INSERT INTO ZWAMEDIAITEM
       (Z_PK, ZMEDIALOCALPATH, ZAUTHORNAME, ZVCARDSTRING, ZFILESIZE, ZTITLE)
     VALUES (?,?,?,?,?,?)`,
  );
  media.run(1, "Media/1/a/pic.jpg", null, "image/jpeg", 2048, "at the beach");
  media.run(2, "Media/1/b/doc.pdf", "מסמך חשוב.pdf", "application/pdf", 51200, null);
  media.run(3, "Media/1/c/clip.mp4", null, "video/mp4", 1048576, null);
  media.run(4, "Media/1/d/note.opus", null, "audio/ogg; codecs=opus", 8192, null);
  // Indexed but never downloaded: the row exists, the file does not.
  media.run(5, "Media/1/e/never.jpg", null, "image/jpeg", 4096, null);

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
  msg.run(5, 0, 2, null, null, cd("2026-05-10"), "972500000555@s.whatsapp.net", "dinner?", 0, JUNK);
  // image carrying a media path, no text
  msg.run(6, 0, 1, 10, 1, cd("2026-06-10"), "grp@g.us", null, 1, JUNK);
  // a second chat whose name shares a prefix with the first
  msg.run(7, 0, 3, 10, null, cd("2026-07-10"), "grp2@g.us", "reunion planning", 0, JUNK);
  // a document, a video, a voice note, and an attachment that was never fetched
  msg.run(8, 0, 1, 10, 2, cd("2026-06-11"), "grp@g.us", null, 8, JUNK);
  msg.run(9, 1, 1, null, 3, cd("2026-06-12"), null, null, 2, null);
  msg.run(10, 0, 1, 11, 4, cd("2026-06-13"), "grp@g.us", null, 3, JUNK);
  msg.run(11, 0, 1, 12, 5, cd("2026-06-14"), "grp@g.us", null, 1, JUNK);
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
  contact.run("Ada Lovelace", "111@lid", "972500000111@s.whatsapp.net", "+972500000111");
  contact.run("Dana Cohen", "444@lid", "972500000555@s.whatsapp.net", "+972500000555");
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

/**
 * Build a media tree matching the fixture's ZMEDIALOCALPATH values.
 *
 * Deliberately omits Media/1/e/never.jpg so the "indexed but not downloaded"
 * path is exercised rather than assumed.
 */
export function buildMediaRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "wa-media-"));
  for (const [path, bytes] of [
    ["Media/1/a/pic.jpg", "jpeg-bytes"],
    ["Media/1/b/doc.pdf", "%PDF-1.4 fake"],
    ["Media/1/c/clip.mp4", "mp4-bytes"],
    ["Media/1/d/note.opus", "opus-bytes"],
  ] as const) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, bytes);
  }
  return root;
}
