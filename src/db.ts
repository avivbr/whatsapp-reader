/**
 * Snapshotting and read-only access to the WhatsApp for Mac store.
 *
 * Nothing here touches the network or the WhatsApp protocol. The live container
 * is only ever read from, and every query runs against a snapshot so WhatsApp
 * itself can keep writing while we work.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const CONTAINER = join(
  homedir(),
  "Library",
  "Group Containers",
  "group.net.whatsapp.WhatsApp.shared",
);

/** Media paths stored in the database are relative to this directory. */
export const MEDIA_ROOT = join(CONTAINER, "Message");

export const DATA_DIR = join(import.meta.dirname, "..", "data");

export const CHAT_DB = "ChatStorage.sqlite";
export const CONTACTS_DB = "ContactsV2.sqlite";
/**
 * Maps phone numbers to the @lid privacy identifiers used in group messages,
 * which is the only route to a name for someone not in the address book.
 */
export const LID_DB = "LID.sqlite";

export const SNAPSHOT_DBS = [CHAT_DB, CONTACTS_DB, LID_DB] as const;

export class SnapshotMissingError extends Error {}

/**
 * Copy the live databases into `dest`, folding each write-ahead log in.
 *
 * Safe to run while WhatsApp is open. Reading the live store directly is not an
 * option: it runs in WAL mode, and a read-only connection to a WAL database
 * still needs to create the -shm shared-memory index, which fails against
 * WhatsApp's container unless you pass immutable=1 and accept torn reads.
 */
export function snapshot(dest: string = DATA_DIR): string {
  if (!existsSync(join(CONTAINER, CHAT_DB))) {
    throw new SnapshotMissingError(
      `${CHAT_DB} not found in ${CONTAINER}. ` +
        "Is WhatsApp for Mac installed and linked to your account?",
    );
  }
  mkdirSync(dest, { recursive: true });

  for (const name of SNAPSHOT_DBS) {
    const stem = name.replace(/\.sqlite$/, "");

    // Copy the database and its write-ahead log, but never the -shm: it is a
    // rebuildable index into the WAL, and a stale one blocks recovery, which
    // presents as a database whose tables all read as empty.
    for (const suffix of ["", "-wal"]) {
      const src = join(CONTAINER, `${stem}.sqlite${suffix}`);
      if (!existsSync(src)) continue;
      const target = join(dest, `${stem}.sqlite${suffix}`);
      if (existsSync(target)) chmodSync(target, 0o600);
      copyFileSync(src, target);
    }
    rmSync(join(dest, `${stem}.sqlite-shm`), { force: true });

    const copied = join(dest, `${stem}.sqlite`);
    if (!existsSync(copied)) continue;

    const db = new DatabaseSync(copied);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec("PRAGMA journal_mode=DELETE");
    db.close();
    rmSync(join(dest, `${stem}.sqlite-wal`), { force: true });
    chmodSync(copied, 0o400);
  }
  return dest;
}

/** Open the snapshot read-only, with contacts and lid attached. */
export function openSnapshot(dataDir: string = DATA_DIR): DatabaseSync {
  const chat = join(dataDir, CHAT_DB);
  if (!existsSync(chat)) {
    throw new SnapshotMissingError(`No snapshot at ${chat}. Run \`wa snapshot\` first.`);
  }

  const db = new DatabaseSync(chat, { readOnly: true });

  // Attach as empty in-memory stands-ins when absent, so the sender-resolution
  // joins stay valid rather than failing the whole query.
  const contacts = join(dataDir, CONTACTS_DB);
  if (existsSync(contacts)) {
    db.exec(`ATTACH DATABASE 'file:${contacts}?mode=ro' AS contacts`);
  } else {
    db.exec("ATTACH DATABASE ':memory:' AS contacts");
    db.exec(
      "CREATE TABLE contacts.ZWAADDRESSBOOKCONTACT " +
        "(ZFULLNAME TEXT, ZLID TEXT, ZWHATSAPPID TEXT, ZPHONENUMBER TEXT)",
    );
  }

  const lid = join(dataDir, LID_DB);
  if (existsSync(lid)) {
    db.exec(`ATTACH DATABASE 'file:${lid}?mode=ro' AS lid`);
  } else {
    db.exec("ATTACH DATABASE ':memory:' AS lid");
    db.exec("CREATE TABLE lid.ZWAZACCOUNT (ZPHONENUMBER TEXT, ZIDENTIFIER TEXT)");
  }

  return db;
}

/** Seconds since the snapshot was taken, or null if there isn't one. */
export function snapshotAgeSeconds(dataDir: string = DATA_DIR): number | null {
  const chat = join(dataDir, CHAT_DB);
  if (!existsSync(chat)) return null;
  return (Date.now() - statSync(chat).mtimeMs) / 1000;
}

/** Resolve a ZMEDIALOCALPATH to an absolute path, if the file was downloaded. */
export function mediaPath(relative: string): string | null {
  if (!relative) return null;
  const candidate = join(MEDIA_ROOT, relative);
  return existsSync(candidate) ? candidate : null;
}
