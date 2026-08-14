"""Command line interface: `wa snapshot | chats | read | search | stats`."""

from __future__ import annotations

import argparse
import sys

from . import db, queries


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="wa",
        description="Read your WhatsApp history from the local Mac database. "
        "Offline and read-only; never contacts WhatsApp.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("snapshot", help="refresh the local snapshot from WhatsApp for Mac")

    p_chats = sub.add_parser("chats", help="list chats, most recently active first")
    p_chats.add_argument("query", nargs="?", help="filter by name substring")
    p_chats.add_argument("--kind", choices=["direct", "group", "broadcast", "status"])
    p_chats.add_argument("-n", "--limit", type=int, default=30)

    p_read = sub.add_parser("read", help="read messages from one chat")
    p_read.add_argument("chat", help="chat name, substring, or id")
    p_read.add_argument("-n", "--limit", type=int, default=40)
    p_read.add_argument("--since", help="YYYY-MM-DD")
    p_read.add_argument("--until", help="YYYY-MM-DD")
    p_read.add_argument("--media", action="store_true", help="only messages with media")

    p_search = sub.add_parser("search", help="full-text search across all chats")
    p_search.add_argument("term")
    p_search.add_argument("--chat", help="restrict to one chat")
    p_search.add_argument("--from", dest="sender", help="restrict to one sender")
    p_search.add_argument("--since", help="YYYY-MM-DD")
    p_search.add_argument("--until", help="YYYY-MM-DD")
    p_search.add_argument("-n", "--limit", type=int, default=40)

    sub.add_parser("stats", help="summarise the snapshot")

    args = parser.parse_args(argv)

    if args.command == "snapshot":
        dest = db.snapshot()
        with db.connect() as conn:
            summary = queries.stats(conn)
        print(f"snapshot -> {dest}")
        print(f"{summary.messages:,} messages across {summary.chats:,} chats")
        print(f"newest: {summary.last}")
        return 0

    try:
        conn = db.connect()
    except db.SnapshotMissing as exc:
        print(exc, file=sys.stderr)
        return 1

    _warn_if_stale()

    try:
        return _dispatch(args, conn)
    except (queries.ChatNotFound, queries.AmbiguousChat, ValueError) as exc:
        print(exc, file=sys.stderr)
        return 1


def _dispatch(args: argparse.Namespace, conn) -> int:
    if args.command == "chats":
        chats = queries.list_chats(
            conn, query=args.query, kind=args.kind, limit=args.limit
        )
        width = max((len(c.name) for c in chats), default=10)
        for chat in chats:
            print(
                f"{chat.name:<{width}}  {chat.kind:<9} {chat.messages:>7,}  {chat.last}"
            )
        return 0

    if args.command == "read":
        chat, messages = queries.read_chat(
            conn,
            args.chat,
            limit=args.limit,
            since=args.since,
            until=args.until,
            media_only=args.media,
        )
        print(f"# {chat.name}  ({chat.kind}, {chat.messages:,} messages)\n")
        _print_messages(messages, show_chat=False)
        return 0

    if args.command == "search":
        results = queries.search(
            conn,
            args.term,
            chat=args.chat,
            sender=args.sender,
            since=args.since,
            until=args.until,
            limit=args.limit,
        )
        if not results:
            print("no matches")
            return 0
        _print_messages(results, show_chat=True)
        print(f"\n{len(results)} match(es)")
        return 0

    if args.command == "stats":
        s = queries.stats(conn)
        print(f"messages : {s.messages:,}  ({s.from_me:,} from me)")
        print(f"chats    : {s.chats:,}")
        print(f"contacts : {s.contacts:,}")
        print(f"range    : {s.first}  ->  {s.last}")
        print("\nby year:")
        for year, count in s.by_year.items():
            print(f"  {year}  {count:>7,}")
        print("\nby type:")
        for kind, count in list(s.by_type.items())[:10]:
            print(f"  {kind:<10} {count:>7,}")
        return 0

    return 1


def _print_messages(messages, *, show_chat: bool) -> None:
    for msg in messages:
        prefix = f"[{msg.date}]"
        if show_chat:
            prefix += f" {msg.chat} |"
        body = msg.text or ""
        if msg.kind != "text":
            marker = f"<{msg.kind}>"
            if msg.media:
                marker = f"<{msg.kind}: {msg.media.rsplit('/', 1)[-1]}>"
            body = f"{marker} {body}".strip()
        star = " *" if msg.starred else ""
        print(f"{prefix} {msg.sender}{star}: {body}")


def _warn_if_stale(threshold_hours: int = 6) -> None:
    age = db.snapshot_age_seconds()
    if age is not None and age > threshold_hours * 3600:
        hours = age / 3600
        print(
            f"note: snapshot is {hours:.0f}h old; run `wa snapshot` to refresh",
            file=sys.stderr,
        )


if __name__ == "__main__":
    raise SystemExit(main())
