"""The reader must never talk to WhatsApp.

The whole premise of this project is that it reads a local file instead of pairing
an unofficial client, so "offline" is a correctness property, not a style
preference. These tests fail if that ever stops being true.
"""

from __future__ import annotations

import ast
import socket
from pathlib import Path

import pytest

PACKAGE = Path(__file__).resolve().parents[1] / "src" / "whatsapp_reader"

# Modules that can open a connection. `mcp` is allowed only in mcp_server.py,
# where it serves the local stdio transport and never reaches WhatsApp.
NETWORK_MODULES = {
    "aiohttp",
    "asyncio.streams",
    "ftplib",
    "http",
    "httpx",
    "requests",
    "smtplib",
    "socket",
    "ssl",
    "telnetlib",
    "urllib",
    "websocket",
    "websockets",
    "xmlrpc",
}

SOURCE_FILES = sorted(PACKAGE.glob("*.py"))


def imported_modules(path: Path) -> set[str]:
    tree = ast.parse(path.read_text())
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            found.add(node.module)
    return found


@pytest.mark.parametrize("path", SOURCE_FILES, ids=lambda p: p.name)
def test_no_network_imports(path: Path) -> None:
    offenders = {
        module
        for module in imported_modules(path)
        if module.split(".")[0] in NETWORK_MODULES
    }
    assert not offenders, f"{path.name} imports network module(s): {sorted(offenders)}"


@pytest.mark.parametrize("path", SOURCE_FILES, ids=lambda p: p.name)
def test_no_whatsapp_endpoints(path: Path) -> None:
    """Guard against anyone reintroducing a fetch of media or messages."""
    text = path.read_text().lower()
    for needle in ("graph.facebook", "mmg.whatsapp", "web.whatsapp", "wa.me", "whatsmeow"):
        assert needle not in text, f"{path.name} references {needle}"


def test_queries_run_with_networking_disabled(store, monkeypatch) -> None:
    """Exercise the real query path with sockets hard-disabled."""

    def refuse(*args, **kwargs):
        raise AssertionError("attempted to open a socket")

    monkeypatch.setattr(socket, "socket", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)

    from whatsapp_reader import db, queries

    conn = db.connect(store)
    try:
        assert queries.stats(conn).messages == 7
        assert queries.list_chats(conn)
        assert queries.read_chat(conn, "Family")[1]
        assert queries.search(conn, "hello")
    finally:
        conn.close()
