import type { DatabaseSync } from "node:sqlite";

import { CORE_DATA_EPOCH, SENDER_JOINS, SENDER_SQL, sessionKindLabel } from "../schema.ts";

/**
 * Who you exchanged messages with on a given day.
 *
 * Day boundaries are local, which is the whole point: comparing UTC-rendered
 * dates against a local "today" drops everything sent after 21:00 in UTC+3.
 */

export interface DayChat {
  chat: string;
  kind: string;
  messages: number;
  sent: number;
  firstAt: string;
  lastAt: string;
  others: Array<{ name: string; messages: number }>;
}

export interface DaySummary {
  date: string;
  participated: DayChat[];
  activeOnly: DayChat[];
}

/** SQL predicate matching one local calendar day. */
const SAME_LOCAL_DAY = `date(m.ZMESSAGEDATE + ${CORE_DATA_EPOCH}, 'unixepoch', 'localtime') = ?`;

export function daySummary(db: DatabaseSync, date?: string): DaySummary {
  const day =
    date ??
    (db.prepare("SELECT date('now','localtime') d").get() as { d: string }).d;

  const rows = db
    .prepare(
      `SELECT cs.Z_PK id, cs.ZPARTNERNAME chat, cs.ZSESSIONTYPE kind,
              COUNT(*) messages, SUM(m.ZISFROMME) sent,
              time(MIN(m.ZMESSAGEDATE) + ${CORE_DATA_EPOCH}, 'unixepoch', 'localtime') firstAt,
              time(MAX(m.ZMESSAGEDATE) + ${CORE_DATA_EPOCH}, 'unixepoch', 'localtime') lastAt
       FROM ZWAMESSAGE m
       JOIN ZWACHATSESSION cs ON cs.Z_PK = m.ZCHATSESSION
       WHERE ${SAME_LOCAL_DAY} AND cs.ZSESSIONTYPE IN (0, 1)
       GROUP BY cs.Z_PK
       ORDER BY MAX(m.ZMESSAGEDATE) DESC`,
    )
    .all(day) as Array<Record<string, unknown>>;

  const others = db.prepare(
    `SELECT ${SENDER_SQL} name, COUNT(*) n
     FROM ZWAMESSAGE m
     ${SENDER_JOINS}
     WHERE m.ZCHATSESSION = ? AND m.ZISFROMME = 0 AND ${SAME_LOCAL_DAY}
     GROUP BY name ORDER BY n DESC LIMIT 12`,
  );

  const participated: DayChat[] = [];
  const activeOnly: DayChat[] = [];

  for (const row of rows) {
    const sent = Number(row["sent"] ?? 0);
    const entry: DayChat = {
      chat: (row["chat"] as string | null) ?? "(unnamed)",
      kind: sessionKindLabel(Number(row["kind"])),
      messages: Number(row["messages"]),
      sent,
      firstAt: row["firstAt"] as string,
      lastAt: row["lastAt"] as string,
      others: [],
    };
    if (sent > 0) {
      entry.others = (others.all(Number(row["id"]), day) as Array<Record<string, unknown>>).map(
        (o) => ({ name: o["name"] as string, messages: Number(o["n"]) }),
      );
      participated.push(entry);
    } else {
      activeOnly.push(entry);
    }
  }

  return { date: day, participated, activeOnly };
}
