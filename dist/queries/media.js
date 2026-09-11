import { copyFileSync, mkdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
                                                

import { MEDIA_ROOT, mediaPath } from "../db.js";
import { CORE_DATA_EPOCH, SENDER_JOINS, SENDER_SQL, messageTypeLabel } from "../schema.js";
import { resolveChat } from "./chats.js";

/**
 * Finding and extracting attachments.
 *
 * Only files WhatsApp actually downloaded exist on disk. The database indexes
 * every attachment ever sent, but an unopened one is a thumbnail and a row --
 * so `onDisk` is reported per item rather than the absent ones being dropped.
 * Opening the chat in WhatsApp downloads them natively.
 *
 * Three ZWAMEDIAITEM columns are badly named and worth knowing:
 *   ZAUTHORNAME   the original filename -- documents only, but all of them
 *   ZVCARDSTRING  the MIME type, present for every kind
 *   ZTITLE        the caption the sender typed, not a filename
 */

                                                                             

/** ZWAMESSAGE.ZMESSAGETYPE codes for each attachment kind. */
const KIND_CODES                            = {
  image: 1,
  video: 2,
  voice: 3,
  document: 8,
  sticker: 15,
};

                              
               
               
                 
               
                                                                                 
                          
                          
                           
                                                        
                         
                 
                  
 

                                   
                                           
                            
                              
                             
                             
                                                                        
                                   
                             
                                 
 

const localDate = (col        ) =>
  `date(${col} + ${CORE_DATA_EPOCH}, 'unixepoch', 'localtime')`;

function buildQuery(options                  , db              ) {
  const { kinds, chat, sender, since, until } = options;

  let sql = `
    SELECT ${SENDER_SQL} sender,
           datetime(m.ZMESSAGEDATE + ${CORE_DATA_EPOCH}, 'unixepoch', 'localtime') date,
           strftime('%Y-%m-%d_%H%M%S', m.ZMESSAGEDATE + ${CORE_DATA_EPOCH}, 'unixepoch', 'localtime') stamp,
           cs.ZPARTNERNAME chat, m.ZISFROMME me, m.ZMESSAGETYPE kind,
           mi.ZMEDIALOCALPATH source, mi.ZAUTHORNAME filename,
           mi.ZVCARDSTRING mime, mi.ZFILESIZE size, mi.ZTITLE caption
    FROM ZWAMESSAGE m
    JOIN ZWAMEDIAITEM mi ON mi.Z_PK = m.ZMEDIAITEM
    JOIN ZWACHATSESSION cs ON cs.Z_PK = m.ZCHATSESSION
    ${SENDER_JOINS}
    WHERE mi.ZMEDIALOCALPATH IS NOT NULL AND mi.ZMEDIALOCALPATH <> ''
  `;
  const params                      = [];

  if (kinds && kinds.length > 0) {
    sql += ` AND m.ZMESSAGETYPE IN (${kinds.map(() => "?").join(",")})`;
    params.push(...kinds.map((k) => KIND_CODES[k]));
  }
  if (chat) {
    sql += " AND m.ZCHATSESSION = ?";
    params.push(resolveChat(db, chat).id);
  }
  if (since) {
    sql += ` AND ${localDate("m.ZMESSAGEDATE")} >= ?`;
    params.push(since);
  }
  if (until) {
    sql += ` AND ${localDate("m.ZMESSAGEDATE")} < ?`;
    params.push(until);
  }
  if (sender) {
    sql += ` AND ${SENDER_SQL} LIKE ?`;
    params.push(`%${sender}%`);
  }
  return { sql, params };
}

const text = (value         )                =>
  typeof value === "string" && value !== "" ? value : null;

function toRecord(row                         , mediaRoot        )              {
  const source = row["source"]          ;
  const size = Number(row["size"]);
  return {
    date: row["date"]          ,
    chat: text(row["chat"]) ?? "(unnamed)",
    sender: row["sender"]          ,
    kind: messageTypeLabel(Number(row["kind"])),
    filename: text(row["filename"]),
    mimeType: text(row["mime"]),
    sizeBytes: Number.isFinite(size) && size > 0 ? size : null,
    caption: text(row["caption"]),
    source,
    onDisk: mediaPath(source, mediaRoot) !== null,
  };
}

/** Search attachments across chats without copying anything. */
export function findMedia(db              , options                   = {})                {
  const { limit = 100, onDiskOnly = false, mediaRoot = MEDIA_ROOT } = options;
  const { sql, params } = buildQuery(options, db);
  const rows = db
    .prepare(`${sql} ORDER BY m.ZMESSAGEDATE DESC LIMIT ?`)
    .all(...params, onDiskOnly ? limit * 4 : limit)                                  ;

  const records = rows.map((r) => toRecord(r, mediaRoot));
  return (onDiskOnly ? records.filter((r) => r.onDisk) : records).slice(0, limit);
}

                                                   
                                                                           
                          
 

                              
                      
                           
                  
                  
 

                                                              
                                                                                   
                                       
 

/** Strip anything that would misbehave as a filename, keeping letters and digits. */
const safeName = (value        ) => value.replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 120);

export function exportMedia(
  db              ,
  destinationRoot        ,
  options                     = {},
)              {
  const { limit = 200, mediaRoot = MEDIA_ROOT, timestampNames = true } = options;
  const { sql, params } = buildQuery(options, db);
  const rows = db
    .prepare(`${sql} ORDER BY m.ZMESSAGEDATE LIMIT ?`)
    .all(...params, limit)                                  ;

  const exported                 = [];
  let written = 0;
  let missing = 0;
  if (rows.length > 0) mkdirSync(destinationRoot, { recursive: true });

  for (const row of rows) {
    const record = toRecord(row, mediaRoot);
    const source = mediaPath(record.source, mediaRoot);
    if (source === null) {
      missing += 1;
      exported.push({ ...record, exported: null });
      continue;
    }

    // Documents keep the name the sender gave them; everything else has only a
    // UUID on disk, so timestamp and direction are the useful identifiers.
    const who = Number(row["me"]) === 1 ? "me" : "them";
    let name        ;
    if (record.filename) {
      const stem = safeName(record.filename);
      // The stored file's extension is authoritative when the name lacks one.
      name = extname(stem) ? stem : stem + extname(record.source);
    } else {
      name = `${who}_${safeName(basename(record.source))}`;
    }
    const out = join(destinationRoot, timestampNames ? `${row["stamp"]          }_${name}` : name);

    copyFileSync(source, out);
    written += 1;
    exported.push({ ...record, exported: out });
  }

  return { destination: destinationRoot, exported, written, missing };
}
