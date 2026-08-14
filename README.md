# whatsapp-reader

Read your WhatsApp history from the local **WhatsApp for Mac** database — offline,
read-only, and without ever speaking to WhatsApp.

Ships a CLI (`wa`) and an MCP server so Claude Code can query your chats as typed
tools.

## Why this approach

The usual way to wire WhatsApp into an AI assistant is a `whatsmeow`/Baileys
bridge that pairs as an unofficial linked device. That works, but it is an
unofficial client, and accounts using one have been [warned and
banned](https://github.com/tulir/whatsmeow/issues/810) — including for purely
passive, low-volume use.

This project avoids that entirely. WhatsApp for Mac is Meta's own first-party
client; it already keeps a full local SQLite store. We snapshot that file and
query it offline. There is no unofficial client anywhere in the path, so the ban
question does not apply.

The corollary: this is a **reader**. It cannot send, and adding sending would
reintroduce exactly the risk it was built to avoid.

## Requirements

- macOS with [WhatsApp for Mac](https://www.whatsapp.com/download) installed and
  linked to your account
- Python 3.11+

## Install

```bash
uv venv --python 3.12
uv pip install -e .
```

## Use

```bash
wa snapshot                      # copy the live DB into ./data (run to refresh)
wa stats                         # totals, date range, breakdown by year and type
wa chats                         # chats, most recently active first
wa chats --kind group -n 10
wa read "Family" -n 50           # read one chat
wa read 42 --since 2026-01-01    # by chat id, date-filtered
wa read "Work" --media           # only messages carrying media
wa search "invoice"              # full-text search everywhere
wa search "dinner" --chat "Family" --from "Dana" --since 2026-06-01
```

Chats are addressed by name, unique substring, or numeric id. An ambiguous
substring lists the candidates rather than guessing.

## MCP server

Register with Claude Code so any session can query your history:

```bash
uv pip install -e '.[mcp]'
claude mcp add whatsapp -- <repo>/.venv/bin/python -m whatsapp_reader.mcp_server
```

Tools exposed: `list_chats`, `read_chat`, `search_messages`, `stats`. All
read-only.

## How it works

`WhatsApp for Mac` stores everything in a Core Data SQLite database:

```
~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/
├── ChatStorage.sqlite     messages, chats, media index
├── ContactsV2.sqlite      address book
└── Message/Media/         downloaded photos, video, voice notes, documents
```

`wa snapshot` copies those alongside their write-ahead logs, checkpoints the WAL
into the main file, and marks the copy read-only. Queries then run against the
snapshot, so WhatsApp can keep writing while you work and the live store is never
locked or modified.

### Sender names

No single column holds the sender's display name, so the reader falls back
through several sources:

1. `ZISFROMME` — outgoing messages carry no sender at all
2. group messages set `ZFROMJID` to the *group*; the real sender comes from
   `ZWAGROUPMEMBER.ZMEMBERJID`, a `@lid` privacy identifier
3. `@lid` → address book via `ZWAADDRESSBOOKCONTACT.ZLID`
4. direct messages → address book via `ZWHATSAPPID`
5. non-contacts may still have a self-set push name in `ZWAPROFILEPUSHNAME`
6. otherwise the raw identifier

Two columns look right but are not: `ZWAGROUPMEMBER.ZCONTACTNAME` is the empty
string on every row, and `ZWAMESSAGE.ZPUSHNAME` holds base64 protobuf rather than
a name. Both are skipped deliberately.

People who are in your groups but not your address book resolve to a push name or
a bare identifier — there is no local source for a name you never saved.

## Limitations

- **History starts when you linked the Mac app.** Companion devices sync forward
  from pairing with limited backfill; anything older lives only on your phone.
- **Media is lazily downloaded.** The database indexes every attachment ever sent,
  but only files WhatsApp actually fetched exist on disk. The rest have
  thumbnails. Opening the chat in WhatsApp downloads them natively.
- **Read-only, by design.** No sending, ever.

## Privacy

`data/` and every `*.sqlite` are gitignored. The snapshot is your complete
message history in plaintext — keep the repo private and the disk encrypted.
