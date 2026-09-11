                                                

import { SENDER_JOINS, SENDER_SQL, messageTypeLabel, toCoreData, tsSql } from "../schema.js";
import { resolveChat } from "./chats.js";
                                                

                  
                             
                             
 

/** Append date bounds to a WHERE clause. `until` is exclusive. */
function applyWindow(sql        , params                     , w        )         {
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

function toMessage(row                         , chat        )          {
  return {
    date: row["date"]          ,
    chat,
    sender: row["sender"]          ,
    kind: messageTypeLabel(Number(row["kind"])),
    text: (row["text"]                 ) ?? null,
    media: (row["media"]                 ) ?? null,
    starred: Boolean(row["starred"]),
  };
}

                                                 
                             
                                  
 

export function readChat(
  db              ,
  chat        ,
  options                  = {},
)                                      {
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
  const params                      = [target.id];
  sql = applyWindow(sql, params, { since, until });
  if (mediaOnly) sql += " AND mi.Z_PK IS NOT NULL";
  // Order newest-first so LIMIT keeps the most recent, then present oldest-first.
  sql += " ORDER BY m.ZMESSAGEDATE DESC LIMIT ?";
  params.push(limit);

  const rows = db.prepare(sql).all(...params)                                  ;
  return { chat: target, messages: rows.reverse().map((r) => toMessage(r, target.name)) };
}

                                               
                            
                              
                             
 

export function searchMessages(
  db              ,
  term        ,
  options                = {},
)            {
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
  const params                      = [`%${term}%`];

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

  const rows = db.prepare(sql).all(...params)                                  ;
  return rows.map((r) => toMessage(r, (r["chat"]                 ) ?? "(unnamed)"));
}
