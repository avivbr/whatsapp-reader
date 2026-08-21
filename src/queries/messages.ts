import type { DatabaseSync } from "node:sqlite";

import { SENDER_JOINS, SENDER_SQL, messageTypeLabel, toCoreData, tsSql } from "../schema.ts";
import { resolveChat } from "./chats.ts";
import type { Chat, Message } from "./types.ts";

interface Window {
  since?: string | undefined;
  until?: string | undefined;
}

/** Append date bounds to a WHERE clause. `until` is exclusive. */
function applyWindow(sql: string, params: (string | number)[], w: Window): string {
  if (w.since) {
    sql += " AND m.ZMESSAGEDATE >= ?";
    params.push(toCoreData(w.since));
  }
  if (w.until) {
    sql += " AND m.ZMESSAGEDATE < ?";
    params.push(toCoreData(w.until));
  }
  return sql;
}

function toMessage(row: Record<string, unknown>, chat: string): Message {
  return {
    date: row["date"] as string,
    chat,
    sender: row["sender"] as string,
    kind: messageTypeLabel(Number(row["kind"])),
    text: (row["text"] as string | null) ?? null,
    media: (row["media"] as string | null) ?? null,
    starred: Boolean(row["starred"]),
  };
}

export interface ReadChatOptions extends Window {
  limit?: number | undefined;
  mediaOnly?: boolean | undefined;
}

export function readChat(
  db: DatabaseSync,
  chat: string,
  options: ReadChatOptions = {},
): { chat: Chat; messages: Message[] } {
  const { limit = 50, mediaOnly = false, since, until } = options;
  const target = resolveChat(db, chat);

  let sql = `
    SELECT ${tsSql("m.ZMESSAGEDATE")} date,
           ${SENDER_SQL} sender,
           m.ZMESSAGETYPE kind, m.ZTEXT text, m.ZSTARRED starred,
           mi.ZMEDIALOCALPATH media
    FROM ZWAMESSAGE m
    ${SENDER_JOINS}
    LEFT JOIN ZWAMEDIAITEM mi ON mi.Z_PK = m.ZMEDIAITEM
    WHERE m.ZCHATSESSION = ?
  `;
  const params: (string | number)[] = [target.id];
  sql = applyWindow(sql, params, { since, until });
  if (mediaOnly) sql += " AND mi.Z_PK IS NOT NULL";
  // Order newest-first so LIMIT keeps the most recent, then present oldest-first.
  sql += " ORDER BY m.ZMESSAGEDATE DESC LIMIT ?";
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return { chat: target, messages: rows.reverse().map((r) => toMessage(r, target.name)) };
}

export interface SearchOptions extends Window {
  chat?: string | undefined;
  sender?: string | undefined;
  limit?: number | undefined;
}

export function searchMessages(
  db: DatabaseSync,
  term: string,
  options: SearchOptions = {},
): Message[] {
  const { chat, sender, limit = 50, since, until } = options;

  let sql = `
    SELECT ${tsSql("m.ZMESSAGEDATE")} date,
           cs.ZPARTNERNAME chat,
           ${SENDER_SQL} sender,
           m.ZMESSAGETYPE kind, m.ZTEXT text, m.ZSTARRED starred,
           mi.ZMEDIALOCALPATH media
    FROM ZWAMESSAGE m
    JOIN ZWACHATSESSION cs ON cs.Z_PK = m.ZCHATSESSION
    ${SENDER_JOINS}
    LEFT JOIN ZWAMEDIAITEM mi ON mi.Z_PK = m.ZMEDIAITEM
    WHERE m.ZTEXT LIKE ?
  `;
  const params: (string | number)[] = [`%${term}%`];

  if (chat) {
    sql += " AND m.ZCHATSESSION = ?";
    params.push(resolveChat(db, chat).id);
  }
  sql = applyWindow(sql, params, { since, until });
  if (sender) {
    sql += ` AND ${SENDER_SQL} LIKE ?`;
    params.push(`%${sender}%`);
  }
  sql += " ORDER BY m.ZMESSAGEDATE DESC LIMIT ?";
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map((r) => toMessage(r, (r["chat"] as string | null) ?? "(unnamed)"));
}
