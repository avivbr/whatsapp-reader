# whatsapp-reader

Read your WhatsApp history from the local **WhatsApp for Mac** database — offline,
read-only, and without ever speaking to WhatsApp.

A single CLI, `wa`. Every command takes `--json`, which is what makes it usable
by an agent as well as by hand.

## Why this approach

The usual way to wire WhatsApp into an AI assistant is a `whatsmeow`/Baileys
bridge that pairs as an unofficial linked device. That works, and it is also how
accounts get [warned and banned](https://github.com/tulir/whatsmeow/issues/810) —
including for purely passive, low-volume use. The detection is server-side, so no
library can patch it.

WhatsApp for Mac is Meta's own first-party client; it already keeps a full local
SQLite store. We snapshot that file and query it offline. There is no unofficial
client anywhere in the path, so the ban question does not apply.

The corollary: this is a **reader**. It cannot send, and adding sending would
reintroduce exactly the risk it was built to avoid.

## Requirements

- macOS with [WhatsApp for Mac](https://www.whatsapp.com/download) installed and
  linked to your account
- **Node 24+** — relies on `node:sqlite` and on Node's built-in TypeScript type
  stripping

## Install

Either way you need a clone or a release tarball — see the note below on why
`npm i -g github:...` is not offered.

**From a release tarball** (one command, nothing left on disk):

```bash
curl -LO https://github.com/avivbr/whatsapp-reader/releases/latest/download/whatsapp-reader.tgz
npm install -g ./whatsapp-reader.tgz
```

**From a clone** (also what you want for development):

```bash
git clone https://github.com/avivbr/whatsapp-reader.git
cd whatsapp-reader
npm install
npm link          # puts `wa` on PATH
```

> **Why not `npm install -g github:avivbr/whatsapp-reader`?**
> It reports success and installs nothing. npm 11.6.2 links a *globally*
> installed git dependency to a directory under `~/.npm/_cacache/tmp/`, then
> cleans that directory up — leaving `wa` as a dangling symlink. Installing the
> same git URL *locally* (without `-g`) works fine, which is what makes the
> failure so quiet. Use one of the two commands above instead.

## Using it from an AI agent

The CLI is the interface — there is no server to run. Point your agent at it and
it will use `wa` like any other command.

- **Claude Code** reads `CLAUDE.md` from the project directory.
- **Codex** reads `AGENTS.md`. Copy this repo's `AGENTS.md` to `~/.codex/AGENTS.md`
  to make `wa` available from any directory, rewording it in the first person.

Queries work under a read-only sandbox: every connection keeps SQLite's scratch
space in memory, so no write access is needed to run a `GROUP BY`. `wa snapshot`
is the exception — it writes outside the workspace and has to be run by you, not
by the agent. Refresh it before asking about recent messages.

**Zero runtime dependencies.** Nothing to compile, no native modules.

Tests run against `src/` directly — Node 24 executes the TypeScript without a
build. An *installed* copy has to ship JavaScript, though, because Node refuses to
strip types under `node_modules`, so `dist/` is a committed artifact rather than
something built on install. Run `npm run build` after changing `src/`; `npm run
check` fails if `dist/` has drifted.

There is deliberately no `prepare` script. Its presence is what triggered the npm
bug described under Install, and with `dist/` committed there is nothing for it to
do.

The build uses Node's own `stripTypeScriptTypes` rather than `tsc`, so it needs
nothing installed — npm does not reliably give `prepare` access to
devDependencies, and a `tsc`-based build fails a git install with
`tsc: command not found`. `tsc` remains the typechecker.

An installed copy is ~80 kB: `dist/`, a README, and a licence.

The snapshot lives in `~/Library/Application Support/whatsapp-reader`, not beside
the code. Override with `WA_DATA_DIR` to put it on an external disk.

## Use

```bash
wa snapshot                          # copy the live DB into ./data (run to refresh)
wa stats                             # totals, date range, breakdown by year and type
wa chats                             # chats, most recently active first
wa chats --kind group -n 10
wa read "Family" -n 50               # read one chat
wa read 42 --since 2026-01-01        # by chat id, date-filtered
wa read "Work" --media               # only messages carrying media
wa search "invoice"                  # full-text search everywhere
wa search "dinner" --chat "Family" --from "Dana" --since 2026-06-01
wa whois 972500000111 972500000222   # phone numbers -> names
wa today                             # who you exchanged messages with today
wa today 2026-08-14
wa media "Family" --out ./exports --since 2026-08-01
```

Chats are addressed by name, unique substring, or numeric id. An ambiguous
substring lists the candidates rather than guessing.

Run without installing globally with `node --no-warnings src/cli.ts <command>`.

## Use from Claude Code

There is no server. `wa` is a plain CLI the model runs like any other command,
and `CLAUDE.md` in this repo tells a session it exists, that `--json` is the
shape to ask for, and which limitations will otherwise waste its time.

This started as an MCP server and was deliberately simplified. The server bought
about 100ms per call by keeping a process warm, plus schema discovery and
client-interop. None of that was load-bearing here: the tool holds no state
between calls, uses no sampling, subscriptions, progress or cancellation, and
only ever had one client. What is left does the same work with one fewer moving
part and no dependencies at all.

If you want it back, `git show v0.2.0:src/server.ts` — the query layer it sat on
has not changed.

## How it works

WhatsApp for Mac stores everything in a Core Data SQLite database:

```
~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/
├── ChatStorage.sqlite     messages, chats, media index
├── ContactsV2.sqlite      address book
├── LID.sqlite             phone number <-> @lid identifier
└── Message/Media/         downloaded photos, video, voice notes, documents
```

`wa snapshot` copies those alongside their write-ahead logs, checkpoints the WAL
into the main file, and marks the copy read-only.

**Reading the live store is not an option, not merely inadvisable.** It runs in
WAL mode, and a read-only SQLite connection to a WAL database still needs to
create the `-shm` shared-memory index. Against WhatsApp's container that fails
with `SQLITE_READONLY_CANTINIT` unless you pass `immutable=1` and accept torn
reads while WhatsApp is writing. The `-shm` is also the one file that must never
be *copied*: a stale one blocks WAL recovery, which presents as a database whose
tables all read as empty.

### Times are local

Timestamps are Core Data seconds from 2001-01-01. Both display and filtering
convert to local time. Rendering as UTC silently drops everything sent after
21:00 local when you ask about "today" from UTC+3.

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

Two columns look right and are not: `ZWAGROUPMEMBER.ZCONTACTNAME` is the empty
string on every row — so a plain `COALESCE` latches onto it and every sender
renders blank — and `ZWAMESSAGE.ZPUSHNAME` holds base64 protobuf rather than a
name. Both are skipped deliberately, and two tests assert on it.

People in your groups but not your address book resolve to a push name or a bare
identifier; there is no local source for a name you never saved.

## Development

```bash
npm test           # node:test, fixture-driven
npm run typecheck  # tsc --noEmit
```

The fixture builds a synthetic store that reproduces both schema traps on
purpose. `test/offline.test.ts` enforces the offline guarantee: no
network-capable imports, no WhatsApp endpoints in any source file, and the real
query path exercised with `fetch` disabled.

`docs/architecture.html` covers the design in more depth, with diagrams.

## Limitations

- **History starts when you linked the Mac app.** Companion devices sync forward
  from pairing with limited backfill; anything older lives only on your phone.
- **Media is lazily downloaded, and the horizon is later than you expect.** The
  database indexes every attachment ever sent, but only files WhatsApp actually
  fetched exist on disk — in practice, only from the date the Mac app was
  linked. `find-media` marks the rest `onDisk: false` rather than hiding them.
- **Search does not see inside images, or captions.** Message text only. Finding
  "the screenshot of X" means exporting candidates and looking at them.
- **Read-only, by design.** No sending, ever.

## Privacy

`data/` and every `*.sqlite` are gitignored. The snapshot is your complete
message history in plaintext — keep the repo private and the disk encrypted.

The Python implementation this replaced is tagged `python-final`.
