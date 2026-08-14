"""Snapshotting and read-only access to the WhatsApp for Mac store.

Nothing here touches the network or the WhatsApp protocol. The live container is
only ever read from, and every query runs against a snapshot so WhatsApp itself
can keep writing while we work.
"""

from __future__ import annotations

import os
import shutil
import sqlite3
from pathlib import Path

CONTAINER = (
    Path.home()
    / "Library"
    / "Group Containers"
    / "group.net.whatsapp.WhatsApp.shared"
)

# Media paths stored in the database are relative to this directory.
MEDIA_ROOT = CONTAINER / "Message"

DATA_DIR = Path(__file__).resolve().parents[2] / "data"

CHAT_DB = "ChatStorage.sqlite"
CONTACTS_DB = "ContactsV2.sqlite"
# Maps phone numbers to the @lid privacy identifiers used in group messages,
# which is the only way to reach a name for someone not in the address book.
LID_DB = "LID.sqlite"

SNAPSHOT_DBS = (CHAT_DB, CONTACTS_DB, LID_DB)


class SnapshotMissing(RuntimeError):
    pass


def snapshot(dest: Path | None = None) -> Path:
    """Copy the live databases into `dest`, folding each write-ahead log in.

    Returns the destination directory. Safe to run while WhatsApp is open: the
    WAL and shared-memory sidecars are copied alongside the main file, then
    checkpointed into it so the snapshot is internally consistent.
    """
    dest = dest or DATA_DIR
    dest.mkdir(parents=True, exist_ok=True)

    if not (CONTAINER / CHAT_DB).exists():
        raise SnapshotMissing(
            f"{CHAT_DB} not found in {CONTAINER}. "
            "Is WhatsApp for Mac installed and linked to your account?"
        )

    for name in SNAPSHOT_DBS:
        stem = Path(name).stem
        # Copy the database and its write-ahead log, but never the -shm: it is a
        # rebuildable index into the WAL, and a stale one can block recovery.
        for suffix in ("", "-wal"):
            src = CONTAINER / f"{stem}.sqlite{suffix}"
            if src.exists():
                target = dest / f"{stem}.sqlite{suffix}"
                # Snapshots are chmod'd read-only; clear that before overwriting.
                if target.exists():
                    target.chmod(0o600)
                shutil.copy2(src, target)
        (dest / f"{stem}.sqlite-shm").unlink(missing_ok=True)

        copied = dest / f"{stem}.sqlite"
        if not copied.exists():
            continue
        with sqlite3.connect(copied) as conn:
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            conn.execute("PRAGMA journal_mode=DELETE")
        for suffix in ("-wal", "-shm"):
            (dest / f"{stem}.sqlite{suffix}").unlink(missing_ok=True)
        copied.chmod(0o400)

    return dest


def connect(data_dir: Path | None = None) -> sqlite3.Connection:
    """Open the snapshot read-only with the contacts database attached as `contacts`."""
    data_dir = data_dir or DATA_DIR
    chat = data_dir / CHAT_DB
    if not chat.exists():
        raise SnapshotMissing(
            f"No snapshot at {chat}. Run `wa snapshot` first."
        )

    conn = sqlite3.connect(f"file:{chat}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row

    contacts = data_dir / CONTACTS_DB
    if contacts.exists():
        conn.execute("ATTACH DATABASE ? AS contacts", (f"file:{contacts}?mode=ro",))
    else:
        # Keep the sender-resolution joins valid even without an address book.
        conn.execute("ATTACH DATABASE ':memory:' AS contacts")
        conn.execute(
            "CREATE TABLE contacts.ZWAADDRESSBOOKCONTACT "
            "(ZFULLNAME TEXT, ZLID TEXT, ZWHATSAPPID TEXT)"
        )

    lid = data_dir / LID_DB
    if lid.exists():
        conn.execute("ATTACH DATABASE ? AS lid", (f"file:{lid}?mode=ro",))
    else:
        conn.execute("ATTACH DATABASE ':memory:' AS lid")
        conn.execute(
            "CREATE TABLE lid.ZWAZACCOUNT (ZPHONENUMBER TEXT, ZIDENTIFIER TEXT)"
        )
    return conn


def snapshot_age_seconds(data_dir: Path | None = None) -> float | None:
    """Seconds since the snapshot was taken, or None if there isn't one."""
    data_dir = data_dir or DATA_DIR
    chat = data_dir / CHAT_DB
    if not chat.exists():
        return None
    import time

    return time.time() - os.path.getmtime(chat)


def media_path(relative: str) -> Path | None:
    """Resolve a ZMEDIALOCALPATH to an absolute path, if the file was downloaded."""
    if not relative:
        return None
    candidate = MEDIA_ROOT / relative
    return candidate if candidate.exists() else None
