import type { DatabaseSync } from "node:sqlite";

import { sessionKindLabel, tsSql } from "../schema.ts";
import { AmbiguousChatError, ChatNotFoundError, type Chat } from "./types.ts";

export interface ListChatsOptions {
  query?: string | undefined;
  kind?: string | undefined;
  limit?: number | undefined;
}

export function listChats(db: DatabaseSync, options: ListChatsOptions = {}): Chat[] {
  const { query, kind, limit = 50 } = options;

  let sql = `
    SELECT cs.Z_PK id, cs.ZPARTNERNAME name, cs.ZSESSIONTYPE kind,
           COUNT(m.Z_PK) messages, ${tsSql("MAX(m.ZMESSAGEDATE)")} last
    FROM ZWACHATSESSION cs
    JOIN ZWAMESSAGE m ON m.ZCHATSESSION = cs.Z_PK
    WHERE 1=1
  `;
  const params: (string | number)[] = [];
  if (query) {
    sql += " AND cs.ZPARTNERNAME LIKE ?";
    params.push(`%${query}%`);
  }
  // Over-fetch when filtering by kind, since the filter is applied after grouping.
  sql += " GROUP BY cs.Z_PK ORDER BY MAX(m.ZMESSAGEDATE) DESC LIMIT ?";
  params.push(kind ? limit * 8 : limit);

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  const chats: Chat[] = rows.map((r) => ({
    id: Number(r["id"]),
    name: (r["name"] as string | null) ?? "(unnamed)",
    kind: sessionKindLabel(Number(r["kind"])),
    messages: Number(r["messages"]),
    last: (r["last"] as string | null) ?? null,
  }));

  return kind ? chats.filter((c) => c.kind === kind).slice(0, limit) : chats;
}

/** Counts for a single chat, which the ZCHATSESSION index makes cheap. */
function chatById(db: DatabaseSync, id: number, name: string, kind: number): Chat {
  const row = db
    .prepare(
      `SELECT COUNT(*) messages, ${tsSql("MAX(ZMESSAGEDATE)")} last
       FROM ZWAMESSAGE WHERE ZCHATSESSION = ?`,
    )
    .get(id) as Record<string, unknown>;
  return {
    id,
    name: name || "(unnamed)",
    kind: sessionKindLabel(kind),
    messages: Number(row["messages"]),
    last: (row["last"] as string | null) ?? null,
  };
}

/**
 * Find exactly one chat by name, id, or unique substring.
 *
 * Resolves against ZWACHATSESSION alone rather than reusing listChats: matching
 * a name needs no message counts, and grouping all 166k messages to answer it
 * costs ~45ms against ~0.2ms for the lookup. Counts are then fetched for the one
 * chat that matched.
 */
export function resolveChat(db: DatabaseSync, term: string): Chat {
  type Row = { Z_PK: number; ZPARTNERNAME: string | null; ZSESSIONTYPE: number };

  if (/^\d+$/.test(term)) {
    const byId = db
      .prepare("SELECT Z_PK, ZPARTNERNAME, ZSESSIONTYPE FROM ZWACHATSESSION WHERE Z_PK = ?")
      .get(Number(term)) as Row | undefined;
    if (byId) return chatById(db, byId.Z_PK, byId.ZPARTNERNAME ?? "", byId.ZSESSIONTYPE);
  }

  const candidates = db
    .prepare(
      "SELECT Z_PK, ZPARTNERNAME, ZSESSIONTYPE FROM ZWACHATSESSION " +
        "WHERE ZPARTNERNAME LIKE ? AND EXISTS " +
        "(SELECT 1 FROM ZWAMESSAGE WHERE ZCHATSESSION = ZWACHATSESSION.Z_PK)",
    )
    .all(`%${term}%`) as Row[];

  if (candidates.length === 0) {
    throw new ChatNotFoundError(`No chat matching ${JSON.stringify(term)}`);
  }
  const pick = (row: Row) => chatById(db, row.Z_PK, row.ZPARTNERNAME ?? "", row.ZSESSIONTYPE);
  if (candidates.length === 1) return pick(candidates[0]!);

  const lowered = term.toLowerCase();
  const exact = candidates.filter((c) => (c.ZPARTNERNAME ?? "").toLowerCase() === lowered);
  if (exact.length === 1) return pick(exact[0]!);

  throw new AmbiguousChatError(
    term,
    candidates.map((c) => c.ZPARTNERNAME ?? "(unnamed)"),
  );
}
