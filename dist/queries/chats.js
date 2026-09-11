                                                

import { sessionKindLabel, tsSql } from "../schema.js";
import { AmbiguousChatError, ChatNotFoundError,           } from "./types.js";

                                   
                             
                            
                             
 

export function listChats(db              , options                   = {})         {
  const { query, kind, limit = 50 } = options;

  let sql = `
    SELECT cs.Z_PK id, cs.ZPARTNERNAME name, cs.ZSESSIONTYPE kind,
           COUNT(m.Z_PK) messages, ${tsSql("MAX(m.ZMESSAGEDATE)")} last
    FROM ZWACHATSESSION cs
    JOIN ZWAMESSAGE m ON m.ZCHATSESSION = cs.Z_PK
    WHERE 1=1
  `;
  const params                      = [];
  if (query) {
    sql += " AND cs.ZPARTNERNAME LIKE ?";
    params.push(`%${query}%`);
  }
  // Over-fetch when filtering by kind, since the filter is applied after grouping.
  sql += " GROUP BY cs.Z_PK ORDER BY MAX(m.ZMESSAGEDATE) DESC LIMIT ?";
  params.push(kind ? limit * 8 : limit);

  const rows = db.prepare(sql).all(...params)                                  ;
  const chats         = rows.map((r) => ({
    id: Number(r["id"]),
    name: (r["name"]                 ) ?? "(unnamed)",
    kind: sessionKindLabel(Number(r["kind"])),
    messages: Number(r["messages"]),
    last: (r["last"]                 ) ?? null,
  }));

  return kind ? chats.filter((c) => c.kind === kind).slice(0, limit) : chats;
}

/** Counts for a single chat, which the ZCHATSESSION index makes cheap. */
function chatById(db              , id        , name        , kind        )       {
  const row = db
    .prepare(
      `SELECT COUNT(*) messages, ${tsSql("MAX(ZMESSAGEDATE)")} last
       FROM ZWAMESSAGE WHERE ZCHATSESSION = ?`,
    )
    .get(id)                           ;
  return {
    id,
    name: name || "(unnamed)",
    kind: sessionKindLabel(kind),
    messages: Number(row["messages"]),
    last: (row["last"]                 ) ?? null,
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
export function resolveChat(db              , term        )       {
                                                                                 

  if (/^\d+$/.test(term)) {
    const byId = db
      .prepare("SELECT Z_PK, ZPARTNERNAME, ZSESSIONTYPE FROM ZWACHATSESSION WHERE Z_PK = ?")
      .get(Number(term))                   ;
    if (byId) return chatById(db, byId.Z_PK, byId.ZPARTNERNAME ?? "", byId.ZSESSIONTYPE);
  }

  const candidates = db
    .prepare(
      "SELECT Z_PK, ZPARTNERNAME, ZSESSIONTYPE FROM ZWACHATSESSION " +
        "WHERE ZPARTNERNAME LIKE ? AND EXISTS " +
        "(SELECT 1 FROM ZWAMESSAGE WHERE ZCHATSESSION = ZWACHATSESSION.Z_PK)",
    )
    .all(`%${term}%`)         ;

  if (candidates.length === 0) {
    throw new ChatNotFoundError(`No chat matching ${JSON.stringify(term)}`);
  }
  const pick = (row     ) => chatById(db, row.Z_PK, row.ZPARTNERNAME ?? "", row.ZSESSIONTYPE);
  if (candidates.length === 1) return pick(candidates[0] );

  const lowered = term.toLowerCase();
  const exact = candidates.filter((c) => (c.ZPARTNERNAME ?? "").toLowerCase() === lowered);
  if (exact.length === 1) return pick(exact[0] );

  throw new AmbiguousChatError(
    term,
    candidates.map((c) => c.ZPARTNERNAME ?? "(unnamed)"),
  );
}
