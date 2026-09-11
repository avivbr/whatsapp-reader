                                                

import { CORE_DATA_EPOCH, SENDER_JOINS, SENDER_SQL, sessionKindLabel } from "../schema.js";

/**
 * Who you exchanged messages with on a given day.
 *
 * Day boundaries are local, which is the whole point: comparing UTC-rendered
 * dates against a local "today" drops everything sent after 21:00 in UTC+3.
 */

                          
               
               
                   
               
                  
                 
                                                    
 

                             
               
                          
                        
 

/** SQL predicate matching one local calendar day. */
const SAME_LOCAL_DAY = `date(m.ZMESSAGEDATE + ${CORE_DATA_EPOCH}, 'unixepoch', 'localtime') = ?`;

export function daySummary(db              , date         )             {
  const day =
    date ??
    (db.prepare("SELECT date('now','localtime') d").get()                 ).d;

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
    .all(day)                                  ;

  const others = db.prepare(
    `SELECT ${SENDER_SQL} name, COUNT(*) n
     FROM ZWAMESSAGE m
     ${SENDER_JOINS}
     WHERE m.ZCHATSESSION = ? AND m.ZISFROMME = 0 AND ${SAME_LOCAL_DAY}
     GROUP BY name ORDER BY n DESC LIMIT 12`,
  );

  const participated            = [];
  const activeOnly            = [];

  for (const row of rows) {
    const sent = Number(row["sent"] ?? 0);
    const entry          = {
      chat: (row["chat"]                 ) ?? "(unnamed)",
      kind: sessionKindLabel(Number(row["kind"])),
      messages: Number(row["messages"]),
      sent,
      firstAt: row["firstAt"]          ,
      lastAt: row["lastAt"]          ,
      others: [],
    };
    if (sent > 0) {
      entry.others = (others.all(Number(row["id"]), day)                                  ).map(
        (o) => ({ name: o["name"]          , messages: Number(o["n"]) }),
      );
      participated.push(entry);
    } else {
      activeOnly.push(entry);
    }
  }

  return { date: day, participated, activeOnly };
}
