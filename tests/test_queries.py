import pytest

from whatsapp_reader import queries


def senders(messages):
    return [m.sender for m in messages]


class TestSenderResolution:
    """The fallback chain is the fiddliest part of the reader; cover every branch."""

    def test_group_member_resolved_from_address_book_via_lid(self, conn):
        _, messages = queries.read_chat(conn, "Family", until="2026-02-01")
        assert senders(messages) == ["Ada Lovelace"]

    def test_non_contact_falls_back_to_push_name(self, conn):
        _, messages = queries.read_chat(conn, "Family", since="2026-02-01", until="2026-03-01")
        assert senders(messages) == ["Yossi"]

    def test_unknown_sender_falls_back_to_identifier(self, conn):
        _, messages = queries.read_chat(conn, "Family", since="2026-03-01", until="2026-04-01")
        assert senders(messages) == ["333@lid"]

    def test_outgoing_is_me(self, conn):
        _, messages = queries.read_chat(conn, "Family", since="2026-04-01", until="2026-05-01")
        assert senders(messages) == ["Me"]

    def test_direct_message_resolved_via_whatsapp_id(self, conn):
        _, messages = queries.read_chat(conn, "Dana Cohen")
        assert senders(messages) == ["Dana Cohen"]

    def test_empty_contact_name_does_not_shadow_later_sources(self, conn):
        """ZWAGROUPMEMBER.ZCONTACTNAME is '' on every real row, so a naive
        COALESCE returns blank senders. Guard against that regressing."""
        _, messages = queries.read_chat(conn, "Family")
        assert all(m.sender.strip() for m in messages)

    def test_base64_push_name_never_leaks_into_output(self, conn):
        _, messages = queries.read_chat(conn, "Family")
        assert not any("IABIAZABAPABAtgC" in m.sender for m in messages)


class TestReadChat:
    def test_returns_oldest_first(self, conn):
        _, messages = queries.read_chat(conn, "Family")
        assert [m.date for m in messages] == sorted(m.date for m in messages)

    def test_limit_keeps_the_most_recent(self, conn):
        _, messages = queries.read_chat(conn, "Family", limit=2)
        assert len(messages) == 2
        assert messages[-1].date.startswith("2026-06-10")

    def test_media_only_filter(self, conn):
        _, messages = queries.read_chat(conn, "Family", media_only=True)
        assert len(messages) == 1
        assert messages[0].media == "Media/1/a/pic.jpg"
        assert messages[0].kind == "image"

    def test_until_is_exclusive(self, conn):
        _, messages = queries.read_chat(conn, "Family", until="2026-01-10")
        assert messages == []

    def test_rejects_unparseable_date(self, conn):
        with pytest.raises(ValueError, match="YYYY-MM-DD"):
            queries.read_chat(conn, "Family", since="last tuesday")


class TestChatResolution:
    def test_exact_name_wins_over_substring(self, conn):
        chat = queries.resolve_chat(conn, "Family")
        assert chat.name == "Family"

    def test_ambiguous_substring_lists_candidates(self, conn):
        with pytest.raises(queries.AmbiguousChat) as exc:
            queries.resolve_chat(conn, "Fam")
        assert set(exc.value.matches) == {"Family", "Family Reunion"}

    def test_unknown_chat_raises(self, conn):
        with pytest.raises(queries.ChatNotFound):
            queries.resolve_chat(conn, "Nonexistent")

    def test_resolves_by_numeric_id(self, conn):
        assert queries.resolve_chat(conn, "2").name == "Dana Cohen"


class TestSearch:
    def test_finds_across_chats(self, conn):
        assert len(queries.search(conn, "hello")) == 1

    def test_scoped_to_chat(self, conn):
        assert queries.search(conn, "dinner", chat="Family") == []
        assert len(queries.search(conn, "dinner", chat="Dana Cohen")) == 1

    def test_filtered_by_sender(self, conn):
        results = queries.search(conn, "", sender="Ada")
        assert {m.sender for m in results} == {"Ada Lovelace"}

    def test_date_window(self, conn):
        assert queries.search(conn, "", since="2026-05-01") != []
        assert queries.search(conn, "", since="2027-01-01") == []

    def test_skips_messages_without_text(self, conn):
        """An empty term matches every text row but never a bare attachment."""
        assert all(m.text for m in queries.search(conn, ""))


class TestStats:
    def test_totals(self, conn):
        s = queries.stats(conn)
        assert s.messages == 7
        assert s.from_me == 1
        assert s.chats == 3
        assert s.contacts == 2

    def test_type_labels(self, conn):
        s = queries.stats(conn)
        assert s.by_type["text"] == 6
        assert s.by_type["image"] == 1
