"""A synthetic store matching the real Core Data schema closely enough to test against.

Deliberately reproduces the two traps in the real database: ZWAGROUPMEMBER.ZCONTACTNAME
is the empty string rather than NULL, and ZWAMESSAGE.ZPUSHNAME holds base64 protobuf
rather than a display name.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import pytest

from whatsapp_reader import db
from whatsapp_reader.schema import CORE_DATA_EPOCH


def cd(date: str) -> float:
    """YYYY-MM-DD -> Core Data timestamp."""
    return (
        datetime.fromisoformat(date).replace(tzinfo=timezone.utc).timestamp()
        - CORE_DATA_EPOCH
    )


CHAT_SCHEMA = """
CREATE TABLE ZWACHATSESSION (
    Z_PK INTEGER PRIMARY KEY, ZPARTNERNAME TEXT, ZSESSIONTYPE INTEGER,
    ZCONTACTJID TEXT
);
CREATE TABLE ZWAMESSAGE (
    Z_PK INTEGER PRIMARY KEY, ZISFROMME INTEGER DEFAULT 0, ZCHATSESSION INTEGER,
    ZGROUPMEMBER INTEGER, ZMEDIAITEM INTEGER, ZMESSAGEDATE REAL, ZFROMJID TEXT,
    ZTEXT TEXT, ZMESSAGETYPE INTEGER DEFAULT 0, ZSTARRED INTEGER DEFAULT 0,
    ZPUSHNAME TEXT
);
CREATE TABLE ZWAGROUPMEMBER (
    Z_PK INTEGER PRIMARY KEY, ZMEMBERJID TEXT, ZCONTACTNAME TEXT DEFAULT ''
);
CREATE TABLE ZWAPROFILEPUSHNAME (ZJID TEXT, ZPUSHNAME TEXT);
CREATE TABLE ZWAMEDIAITEM (Z_PK INTEGER PRIMARY KEY, ZMEDIALOCALPATH TEXT);
"""

CONTACTS_SCHEMA = """
CREATE TABLE ZWAADDRESSBOOKCONTACT (
    Z_PK INTEGER PRIMARY KEY, ZFULLNAME TEXT, ZLID TEXT, ZWHATSAPPID TEXT
);
"""


@pytest.fixture
def store(tmp_path: Path) -> Path:
    chat = sqlite3.connect(tmp_path / db.CHAT_DB)
    chat.executescript(CHAT_SCHEMA)

    chat.executemany(
        "INSERT INTO ZWACHATSESSION (Z_PK, ZPARTNERNAME, ZSESSIONTYPE) VALUES (?,?,?)",
        [(1, "Family", 1), (2, "Dana Cohen", 0), (3, "Family Reunion", 1)],
    )
    chat.executemany(
        "INSERT INTO ZWAGROUPMEMBER (Z_PK, ZMEMBERJID) VALUES (?,?)",
        [(10, "111@lid"), (11, "222@lid"), (12, "333@lid")],
    )
    chat.executemany(
        "INSERT INTO ZWAPROFILEPUSHNAME (ZJID, ZPUSHNAME) VALUES (?,?)",
        [("222@lid", "Yossi"), ("999@s.whatsapp.net", "Direct Pushname")],
    )
    chat.execute(
        "INSERT INTO ZWAMEDIAITEM (Z_PK, ZMEDIALOCALPATH) VALUES (1, 'Media/1/a/pic.jpg')"
    )

    junk = "CIGF/dMGIABIAZABAPABAtgC"  # what ZPUSHNAME actually contains
    chat.executemany(
        """INSERT INTO ZWAMESSAGE
           (Z_PK, ZISFROMME, ZCHATSESSION, ZGROUPMEMBER, ZMEDIAITEM,
            ZMESSAGEDATE, ZFROMJID, ZTEXT, ZMESSAGETYPE, ZPUSHNAME)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        [
            # group message from a saved contact, resolved via @lid
            (1, 0, 1, 10, None, cd("2026-01-10"), "grp@g.us", "hello from Ada", 0, junk),
            # group message from a non-contact with only a push name
            (2, 0, 1, 11, None, cd("2026-02-10"), "grp@g.us", "hi from Yossi", 0, junk),
            # group message from someone with no name anywhere
            (3, 0, 1, 12, None, cd("2026-03-10"), "grp@g.us", "who am i", 0, junk),
            # outgoing
            (4, 1, 1, None, None, cd("2026-04-10"), None, "my reply", 0, None),
            # direct message resolved via ZWHATSAPPID
            (5, 0, 2, None, None, cd("2026-05-10"), "555@s.whatsapp.net", "dinner?", 0, junk),
            # image with media path
            (6, 0, 1, 10, 1, cd("2026-06-10"), "grp@g.us", None, 1, junk),
            # a second chat whose name shares a prefix with the first
            (7, 0, 3, 10, None, cd("2026-07-10"), "grp2@g.us", "reunion planning", 0, junk),
        ],
    )
    chat.commit()
    chat.close()

    contacts = sqlite3.connect(tmp_path / db.CONTACTS_DB)
    contacts.executescript(CONTACTS_SCHEMA)
    contacts.executemany(
        "INSERT INTO ZWAADDRESSBOOKCONTACT (ZFULLNAME, ZLID, ZWHATSAPPID) VALUES (?,?,?)",
        [
            ("Ada Lovelace", "111@lid", "111@s.whatsapp.net"),
            ("Dana Cohen", "444@lid", "555@s.whatsapp.net"),
        ],
    )
    contacts.commit()
    contacts.close()

    return tmp_path


@pytest.fixture
def conn(store: Path):
    connection = db.connect(store)
    yield connection
    connection.close()
