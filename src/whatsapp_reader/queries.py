"""Read-only queries over the WhatsApp snapshot."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timezone

from .schema import (
    CORE_DATA_EPOCH,
    SENDER_JOINS,
    SENDER_SQL,
    message_type_label,
    session_kind_label,
    ts_sql,
)


class ChatNotFound(LookupError):
    pass


class AmbiguousChat(LookupError):
    def __init__(self, term: str, matches: list[str]):
        self.matches = matches
        super().__init__(
            f"{len(matches)} chats match {term!r}: "
            + ", ".join(matches[:8])
            + ("…" if len(matches) > 8 else "")
        )


@dataclass
class Chat:
    id: int
    name: str
    kind: str
    messages: int
    last: str | None


@dataclass
class Message:
    date: str
    chat: str
    sender: str
    kind: str
    text: str | None
    media: str | None = None
    starred: bool = False


@dataclass
class Stats:
    messages: int
    chats: int
    contacts: int
    first: str | None
    last: str | None
    from_me: int
    by_year: dict[str, int] = field(default_factory=dict)
    by_type: dict[str, int] = field(default_factory=dict)


def _to_coredata(value: str | None) -> float | None:
    """Parse a YYYY-MM-DD (or full ISO) string into a Core Data timestamp."""
    if not value:
        return None
    text = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise ValueError(f"Could not parse date {value!r}; use YYYY-MM-DD") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp() - CORE_DATA_EPOCH


def list_chats(
    conn: sqlite3.Connection,
    *,
    query: str | None = None,
    kind: str | None = None,
    limit: int = 50,
) -> list[Chat]:
    sql = f"""
        SELECT cs.Z_PK id, cs.ZPARTNERNAME name, cs.ZSESSIONTYPE kind,
               COUNT(m.Z_PK) messages, {ts_sql('MAX(m.ZMESSAGEDATE)')} last
        FROM ZWACHATSESSION cs
        JOIN ZWAMESSAGE m ON m.ZCHATSESSION = cs.Z_PK
        WHERE 1=1
    """
    params: list[object] = []
    if query:
        sql += " AND cs.ZPARTNERNAME LIKE ?"
        params.append(f"%{query}%")
    sql += " GROUP BY cs.Z_PK ORDER BY MAX(m.ZMESSAGEDATE) DESC LIMIT ?"
    params.append(limit if not kind else limit * 8)

    rows = conn.execute(sql, params).fetchall()
    chats = [
        Chat(
            id=r["id"],
            name=r["name"] or "(unnamed)",
            kind=session_kind_label(r["kind"]),
            messages=r["messages"],
            last=r["last"],
        )
        for r in rows
    ]
    if kind:
        chats = [c for c in chats if c.kind == kind][:limit]
    return chats


def resolve_chat(conn: sqlite3.Connection, term: str) -> Chat:
    """Find exactly one chat by name, id, or unique substring."""
    if term.isdigit():
        matches = list_chats(conn, limit=10_000)
        for chat in matches:
            if chat.id == int(term):
                return chat

    candidates = list_chats(conn, query=term, limit=10_000)
    if not candidates:
        raise ChatNotFound(f"No chat matching {term!r}")
    if len(candidates) == 1:
        return candidates[0]

    exact = [c for c in candidates if c.name.lower() == term.lower()]
    if len(exact) == 1:
        return exact[0]
    raise AmbiguousChat(term, [c.name for c in candidates])


def read_chat(
    conn: sqlite3.Connection,
    chat: str,
    *,
    limit: int = 50,
    since: str | None = None,
    until: str | None = None,
    media_only: bool = False,
) -> tuple[Chat, list[Message]]:
    target = resolve_chat(conn, chat)

    sql = f"""
        SELECT {ts_sql('m.ZMESSAGEDATE')} date,
               {SENDER_SQL} sender,
               m.ZMESSAGETYPE kind, m.ZTEXT text, m.ZSTARRED starred,
               mi.ZMEDIALOCALPATH media
        FROM ZWAMESSAGE m
        {SENDER_JOINS}
        LEFT JOIN ZWAMEDIAITEM mi ON mi.Z_PK = m.ZMEDIAITEM
        WHERE m.ZCHATSESSION = ?
    """
    params: list[object] = [target.id]
    sql, params = _apply_time_filters(sql, params, since, until)
    if media_only:
        sql += " AND mi.Z_PK IS NOT NULL"
    sql += " ORDER BY m.ZMESSAGEDATE DESC LIMIT ?"
    params.append(limit)

    rows = conn.execute(sql, params).fetchall()
    # Query newest-first so LIMIT takes the most recent, then present oldest-first.
    messages = [_row_to_message(r, target.name) for r in reversed(rows)]
    return target, messages


def search(
    conn: sqlite3.Connection,
    term: str,
    *,
    chat: str | None = None,
    sender: str | None = None,
    limit: int = 50,
    since: str | None = None,
    until: str | None = None,
) -> list[Message]:
    sql = f"""
        SELECT {ts_sql('m.ZMESSAGEDATE')} date,
               cs.ZPARTNERNAME chat,
               {SENDER_SQL} sender,
               m.ZMESSAGETYPE kind, m.ZTEXT text, m.ZSTARRED starred,
               mi.ZMEDIALOCALPATH media
        FROM ZWAMESSAGE m
        JOIN ZWACHATSESSION cs ON cs.Z_PK = m.ZCHATSESSION
        {SENDER_JOINS}
        LEFT JOIN ZWAMEDIAITEM mi ON mi.Z_PK = m.ZMEDIAITEM
        WHERE m.ZTEXT LIKE ?
    """
    params: list[object] = [f"%{term}%"]

    if chat:
        params.append(resolve_chat(conn, chat).id)
        sql += " AND m.ZCHATSESSION = ?"
    sql, params = _apply_time_filters(sql, params, since, until)
    if sender:
        sql += f" AND {SENDER_SQL} LIKE ?"
        params.append(f"%{sender}%")

    sql += " ORDER BY m.ZMESSAGEDATE DESC LIMIT ?"
    params.append(limit)

    return [
        _row_to_message(r, r["chat"] or "(unnamed)")
        for r in conn.execute(sql, params).fetchall()
    ]


def stats(conn: sqlite3.Connection) -> Stats:
    row = conn.execute(
        f"""
        SELECT COUNT(*) messages,
               SUM(ZISFROMME) from_me,
               {ts_sql('MIN(NULLIF(ZMESSAGEDATE, 0))')} first,
               {ts_sql('MAX(ZMESSAGEDATE)')} last
        FROM ZWAMESSAGE
        """
    ).fetchone()

    by_year = {
        r["y"]: r["n"]
        for r in conn.execute(
            f"""
            SELECT strftime('%Y', ZMESSAGEDATE + {CORE_DATA_EPOCH}, 'unixepoch') y,
                   COUNT(*) n
            FROM ZWAMESSAGE WHERE ZMESSAGEDATE > 0 GROUP BY y ORDER BY y
            """
        )
    }
    by_type = {
        message_type_label(r["ZMESSAGETYPE"]): r["n"]
        for r in conn.execute(
            "SELECT ZMESSAGETYPE, COUNT(*) n FROM ZWAMESSAGE "
            "GROUP BY ZMESSAGETYPE ORDER BY n DESC"
        )
    }
    contacts = conn.execute(
        "SELECT COUNT(*) n FROM contacts.ZWAADDRESSBOOKCONTACT"
    ).fetchone()["n"]

    return Stats(
        messages=row["messages"],
        chats=conn.execute("SELECT COUNT(*) n FROM ZWACHATSESSION").fetchone()["n"],
        contacts=contacts,
        first=row["first"],
        last=row["last"],
        from_me=row["from_me"] or 0,
        by_year=by_year,
        by_type=by_type,
    )


def _apply_time_filters(
    sql: str, params: list[object], since: str | None, until: str | None
) -> tuple[str, list[object]]:
    if since:
        sql += " AND m.ZMESSAGEDATE >= ?"
        params.append(_to_coredata(since))
    if until:
        sql += " AND m.ZMESSAGEDATE < ?"
        params.append(_to_coredata(until))
    return sql, params


def _row_to_message(row: sqlite3.Row, chat: str) -> Message:
    return Message(
        date=row["date"],
        chat=chat,
        sender=row["sender"],
        kind=message_type_label(row["kind"]),
        text=row["text"],
        media=row["media"],
        starred=bool(row["starred"]),
    )
