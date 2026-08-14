"""Constants and SQL fragments describing the WhatsApp for Mac Core Data schema.

The store is Core Data, so tables are Z-prefixed and timestamps are seconds since
2001-01-01 rather than the Unix epoch.
"""

# Core Data reference date (2001-01-01) as a Unix timestamp.
CORE_DATA_EPOCH = 978_307_200

# Message type codes, determined empirically from a real store rather than from
# documentation. Codes absent here are rare and rendered as "type:<n>"; the tail
# is long and guessing at it would put wrong labels on real messages.
MESSAGE_TYPES = {
    0: "text",
    1: "image",
    2: "video",
    3: "voice",
    4: "contact",
    5: "location",
    7: "link",
    8: "document",
    15: "sticker",
}


def message_type_label(code: int) -> str:
    return MESSAGE_TYPES.get(code, f"type:{code}")


# Sender resolution. WhatsApp scatters the display name across several places and
# no single one covers every message:
#
#   * outgoing messages carry no sender at all -> "Me"
#   * group messages set ZFROMJID to the *group*, so the sender must come from
#     ZWAGROUPMEMBER.ZMEMBERJID, which is a @lid (privacy) identifier
#   * a @lid maps to the address book via ZWAADDRESSBOOKCONTACT.ZLID
#   * direct messages set ZFROMJID to the contact's @s.whatsapp.net JID
#   * non-contacts may still have a self-set push name in ZWAPROFILEPUSHNAME,
#     keyed by either identifier
#
# ZWAGROUPMEMBER.ZCONTACTNAME looks like the obvious source but is the empty
# string on every row, and ZWAMESSAGE.ZPUSHNAME holds base64 protobuf, not a name.
# Both are deliberately skipped.
SENDER_SQL = """
    CASE WHEN m.ZISFROMME = 1 THEN 'Me' ELSE COALESCE(
        NULLIF(cg.ZFULLNAME, ''),
        NULLIF(cd.ZFULLNAME, ''),
        NULLIF(ppl.ZPUSHNAME, ''),
        NULLIF(ppd.ZPUSHNAME, ''),
        NULLIF(gm.ZMEMBERJID, ''),
        NULLIF(m.ZFROMJID, ''),
        '(unknown)'
    ) END
"""

SENDER_JOINS = """
    LEFT JOIN ZWAGROUPMEMBER gm ON gm.Z_PK = m.ZGROUPMEMBER
    LEFT JOIN contacts.ZWAADDRESSBOOKCONTACT cg ON cg.ZLID = gm.ZMEMBERJID
    LEFT JOIN contacts.ZWAADDRESSBOOKCONTACT cd ON cd.ZWHATSAPPID = m.ZFROMJID
    LEFT JOIN ZWAPROFILEPUSHNAME ppl ON ppl.ZJID = gm.ZMEMBERJID
    LEFT JOIN ZWAPROFILEPUSHNAME ppd ON ppd.ZJID = m.ZFROMJID
"""

# Convert a Core Data timestamp column to an ISO-ish UTC string.
def ts_sql(column: str) -> str:
    return f"datetime({column} + {CORE_DATA_EPOCH}, 'unixepoch')"


# ZWACHATSESSION.ZSESSIONTYPE
SESSION_KINDS = {0: "direct", 1: "group", 2: "broadcast", 3: "status", 4: "other"}


def session_kind_label(code: int) -> str:
    return SESSION_KINDS.get(code, f"kind:{code}")
