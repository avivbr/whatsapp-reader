                                                

import { CORE_DATA_EPOCH, messageTypeLabel, tsSql } from "../schema.js";

                        
                   
                
                   
                       
                      
                 
                                 
                                 
 

export function stats(db              )        {
  const totals = db
    .prepare(
      `SELECT COUNT(*) messages, SUM(ZISFROMME) fromMe,
              ${tsSql("MIN(NULLIF(ZMESSAGEDATE, 0))")} first,
              ${tsSql("MAX(ZMESSAGEDATE)")} last
       FROM ZWAMESSAGE`,
    )
    .get()                           ;

  const byYear                         = {};
  for (const row of db
    .prepare(
      `SELECT strftime('%Y', ZMESSAGEDATE + ${CORE_DATA_EPOCH}, 'unixepoch', 'localtime') y,
              COUNT(*) n
       FROM ZWAMESSAGE WHERE ZMESSAGEDATE > 0 GROUP BY y ORDER BY y`,
    )
    .all()                                  ) {
    byYear[row["y"]          ] = Number(row["n"]);
  }

  const byType                         = {};
  for (const row of db
    .prepare(
      "SELECT ZMESSAGETYPE k, COUNT(*) n FROM ZWAMESSAGE GROUP BY k ORDER BY n DESC",
    )
    .all()                                  ) {
    byType[messageTypeLabel(Number(row["k"]))] = Number(row["n"]);
  }

  const chats = db.prepare("SELECT COUNT(*) n FROM ZWACHATSESSION").get()                 ;
  const contacts = db
    .prepare("SELECT COUNT(*) n FROM contacts.ZWAADDRESSBOOKCONTACT")
    .get()                 ;

  return {
    messages: Number(totals["messages"]),
    chats: Number(chats.n),
    contacts: Number(contacts.n),
    first: (totals["first"]                 ) ?? null,
    last: (totals["last"]                 ) ?? null,
    fromMe: Number(totals["fromMe"] ?? 0),
    byYear,
    byType,
  };
}
