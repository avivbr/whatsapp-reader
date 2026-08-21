/**
 * Constants and SQL fragments describing the WhatsApp for Mac Core Data schema.
 *
 * The store is Core Data, so tables are Z-prefixed and timestamps are seconds
 * since 2001-01-01 rather than the Unix epoch.
 */

/** Core Data reference date (2001-01-01) as a Unix timestamp. */
export const CORE_DATA_EPOCH = 978_307_200;

/**
 * Message type codes, determined empirically from a real store rather than from
 * documentation. Codes absent here are rare and rendered as "type:<n>"; the tail
 * is long and guessing at it would put wrong labels on real messages.
 */
const MESSAGE_TYPES = new Map<number, string>([
  [0, "text"],
  [1, "image"],
  [2, "video"],
  [3, "voice"],
  [4, "contact"],
  [5, "location"],
  [7, "link"],
  [8, "document"],
  [15, "sticker"],
]);

export function messageTypeLabel(code: number): string {
  return MESSAGE_TYPES.get(code) ?? `type:${code}`;
}

/** ZWACHATSESSION.ZSESSIONTYPE */
const SESSION_KINDS = new Map<number, string>([
  [0, "direct"],
  [1, "group"],
  [2, "broadcast"],
  [3, "status"],
  [4, "other"],
]);

export function sessionKindLabel(code: number): string {
  return SESSION_KINDS.get(code) ?? `kind:${code}`;
}

export type SessionKind = "direct" | "group" | "broadcast" | "status" | "other";

/**
 * Sender resolution. WhatsApp scatters the display name across several places
 * and no single one covers every message:
 *
 *   - outgoing messages carry no sender at all -> "Me"
 *   - group messages set ZFROMJID to the *group*, so the sender must come from
 *     ZWAGROUPMEMBER.ZMEMBERJID, which is a @lid (privacy) identifier
 *   - a @lid maps to the address book via ZWAADDRESSBOOKCONTACT.ZLID
 *   - direct messages set ZFROMJID to the contact's @s.whatsapp.net JID
 *   - non-contacts may still have a self-set push name in ZWAPROFILEPUSHNAME,
 *     keyed by either identifier
 *
 * Two columns look like the obvious source and are traps:
 * ZWAGROUPMEMBER.ZCONTACTNAME is the empty string on every row, so a plain
 * COALESCE latches onto it and every sender renders blank -- NULLIF is
 * load-bearing. ZWAMESSAGE.ZPUSHNAME holds base64 protobuf, not a name. Both
 * are skipped deliberately; do not "simplify" this by reaching for either.
 */
export const SENDER_SQL = `
    CASE WHEN m.ZISFROMME = 1 THEN 'Me' ELSE COALESCE(
        NULLIF(cg.ZFULLNAME, ''),
        NULLIF(cd.ZFULLNAME, ''),
        NULLIF(ppl.ZPUSHNAME, ''),
        NULLIF(ppd.ZPUSHNAME, ''),
        NULLIF(gm.ZMEMBERJID, ''),
        NULLIF(m.ZFROMJID, ''),
        '(unknown)'
    ) END
`;

export const SENDER_JOINS = `
    LEFT JOIN ZWAGROUPMEMBER gm ON gm.Z_PK = m.ZGROUPMEMBER
    LEFT JOIN contacts.ZWAADDRESSBOOKCONTACT cg ON cg.ZLID = gm.ZMEMBERJID
    LEFT JOIN contacts.ZWAADDRESSBOOKCONTACT cd ON cd.ZWHATSAPPID = m.ZFROMJID
    LEFT JOIN ZWAPROFILEPUSHNAME ppl ON ppl.ZJID = gm.ZMEMBERJID
    LEFT JOIN ZWAPROFILEPUSHNAME ppd ON ppd.ZJID = m.ZFROMJID
`;

/**
 * Render a Core Data timestamp column as a local-time string.
 *
 * Local, not UTC, and deliberately so: asking "who did I message today" from
 * UTC+3 against UTC-rendered timestamps silently drops every message sent after
 * 21:00 local. Display and filtering both use local time so the two agree.
 */
export function tsSql(column: string): string {
  return `datetime(${column} + ${CORE_DATA_EPOCH}, 'unixepoch', 'localtime')`;
}

/**
 * Parse a YYYY-MM-DD (or full ISO) string into a Core Data timestamp.
 *
 * A bare date is read as local midnight, matching tsSql above -- a person asking
 * for messages "since 2026-08-01" means their own midnight, not UTC's.
 */
export function toCoreData(value: string): number {
  const text = value.trim();
  const isBareDate = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const parsed = new Date(isBareDate ? `${text}T00:00:00` : text);
  if (Number.isNaN(parsed.getTime())) {
    throw new RangeError(`Could not parse date ${JSON.stringify(value)}; use YYYY-MM-DD`);
  }
  return parsed.getTime() / 1000 - CORE_DATA_EPOCH;
}
