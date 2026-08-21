import { copyFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { mediaPath } from "../db.ts";
import { CORE_DATA_EPOCH, messageTypeLabel } from "../schema.ts";
import { resolveChat } from "./chats.ts";

/**
 * Copy a chat's attachments out of WhatsApp's container so they can be opened.
 *
 * Only files WhatsApp actually downloaded exist on disk. The database indexes
 * every attachment ever sent, but an unopened one is a thumbnail and a row --
 * those are reported as `missing` rather than silently dropped, so the caller
 * can see the difference between "no media" and "media not fetched yet".
 */

export interface MediaItem {
  date: string;
  sender: string;
  kind: string;
  source: string;
  exported: string | null;
}

export interface MediaExport {
  chat: string;
  destination: string;
  exported: MediaItem[];
  missing: number;
}

export interface ExportMediaOptions {
  since?: string | undefined;
  until?: string | undefined;
  limit?: number | undefined;
  destination?: string | undefined;
}

export function exportMedia(
  db: DatabaseSync,
  chat: string,
  destinationRoot: string,
  options: ExportMediaOptions = {},
): MediaExport {
  const { since, until, limit = 200 } = options;
  const target = resolveChat(db, chat);

  let sql = `
    SELECT strftime('%Y-%m-%d_%H%M%S', m.ZMESSAGEDATE + ${CORE_DATA_EPOCH}, 'unixepoch', 'localtime') stamp,
           m.ZISFROMME me, m.ZMESSAGETYPE kind, mi.ZMEDIALOCALPATH path
    FROM ZWAMESSAGE m
    JOIN ZWAMEDIAITEM mi ON mi.Z_PK = m.ZMEDIAITEM
    WHERE m.ZCHATSESSION = ? AND mi.ZMEDIALOCALPATH IS NOT NULL AND mi.ZMEDIALOCALPATH <> ''
  `;
  const params: (string | number)[] = [target.id];
  if (since) {
    sql += ` AND date(m.ZMESSAGEDATE + ${CORE_DATA_EPOCH}, 'unixepoch', 'localtime') >= ?`;
    params.push(since);
  }
  if (until) {
    sql += ` AND date(m.ZMESSAGEDATE + ${CORE_DATA_EPOCH}, 'unixepoch', 'localtime') < ?`;
    params.push(until);
  }
  sql += " ORDER BY m.ZMESSAGEDATE LIMIT ?";
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  const destination = join(destinationRoot, target.name.replace(/[^\p{L}\p{N}_-]+/gu, "_"));
  const exported: MediaItem[] = [];
  let missing = 0;

  if (rows.length > 0) mkdirSync(destination, { recursive: true });

  for (const row of rows) {
    const relative = row["path"] as string;
    const source = mediaPath(relative);
    const who = Number(row["me"]) === 1 ? "me" : "them";
    const item: MediaItem = {
      date: row["stamp"] as string,
      sender: who,
      kind: messageTypeLabel(Number(row["kind"])),
      source: relative,
      exported: null,
    };
    if (source === null) {
      missing += 1;
    } else {
      const out = join(destination, `${item.date}_${who}_${basename(relative)}`);
      copyFileSync(source, out);
      item.exported = out;
    }
    exported.push(item);
  }

  return { chat: target.name, destination, exported, missing };
}
