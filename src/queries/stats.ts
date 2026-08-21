import type { DatabaseSync } from "node:sqlite";

import { CORE_DATA_EPOCH, messageTypeLabel, tsSql } from "../schema.ts";

export interface Stats {
  messages: number;
  chats: number;
  contacts: number;
  first: string | null;
  last: string | null;
  fromMe: number;
  byYear: Record<string, number>;
  byType: Record<string, number>;
}

export function stats(db: DatabaseSync): Stats {
  const totals = db
    .prepare(
      `SELECT COUNT(*) messages, SUM(ZISFROMME) fromMe,
              ${tsSql("MIN(NULLIF(ZMESSAGEDATE, 0))")} first,
              ${tsSql("MAX(ZMESSAGEDATE)")} last
       FROM ZWAMESSAGE`,
    )
    .get() as Record<string, unknown>;

  const byYear: Record<string, number> = {};
  for (const row of db
    .prepare(
      `SELECT strftime('%Y', ZMESSAGEDATE + ${CORE_DATA_EPOCH}, 'unixepoch', 'localtime') y,
              COUNT(*) n
       FROM ZWAMESSAGE WHERE ZMESSAGEDATE > 0 GROUP BY y ORDER BY y`,
    )
    .all() as Array<Record<string, unknown>>) {
    byYear[row["y"] as string] = Number(row["n"]);
  }

  const byType: Record<string, number> = {};
  for (const row of db
    .prepare(
      "SELECT ZMESSAGETYPE k, COUNT(*) n FROM ZWAMESSAGE GROUP BY k ORDER BY n DESC",
    )
    .all() as Array<Record<string, unknown>>) {
    byType[messageTypeLabel(Number(row["k"]))] = Number(row["n"]);
  }

  const chats = db.prepare("SELECT COUNT(*) n FROM ZWACHATSESSION").get() as { n: number };
  const contacts = db
    .prepare("SELECT COUNT(*) n FROM contacts.ZWAADDRESSBOOKCONTACT")
    .get() as { n: number };

  return {
    messages: Number(totals["messages"]),
    chats: Number(chats.n),
    contacts: Number(contacts.n),
    first: (totals["first"] as string | null) ?? null,
    last: (totals["last"] as string | null) ?? null,
    fromMe: Number(totals["fromMe"] ?? 0),
    byYear,
    byType,
  };
}
