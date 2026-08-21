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

/** Find exactly one chat by name, id, or unique substring. */
export function resolveChat(db: DatabaseSync, term: string): Chat {
  const all = listChats(db, { limit: 10_000 });

  if (/^\d+$/.test(term)) {
    const byId = all.find((c) => c.id === Number(term));
    if (byId) return byId;
  }

  const lowered = term.toLowerCase();
  const candidates = all.filter((c) => c.name.toLowerCase().includes(lowered));
  if (candidates.length === 0) {
    throw new ChatNotFoundError(`No chat matching ${JSON.stringify(term)}`);
  }
  if (candidates.length === 1) return candidates[0]!;

  const exact = candidates.filter((c) => c.name.toLowerCase() === lowered);
  if (exact.length === 1) return exact[0]!;

  throw new AmbiguousChatError(term, candidates.map((c) => c.name));
}
