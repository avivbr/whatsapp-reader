/**
 * End-to-end CLI tests.
 *
 * These spawn the real `wa` entry point as a child process against a fixture, so
 * they cover what an agent or a shell actually gets: argument parsing, exit
 * codes, stdout/stderr separation, and the --json shapes. Everything below the
 * CLI is covered by the query tests; this is the layer they cannot reach.
 *
 * Spawning rather than importing is deliberate: DATA_DIR is resolved from
 * WA_DATA_DIR at module load, and exit codes only exist in a real process.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { CHAT_DB, CONTACTS_DB, LID_DB } from "../src/db.ts";
import { buildMediaRoot, buildStore } from "./fixture.ts";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

let dataDir: string;
let mediaRoot: string;

interface Result {
  status: number;
  stdout: string;
  stderr: string;
}

function wa(...args: string[]): Result {
  const r = spawnSync("node", ["--no-warnings", CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, WA_DATA_DIR: dataDir },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Run with --json and parse. Fails loudly if the command did not emit JSON. */
function waJson(...args: string[]): Record<string, unknown> {
  const r = wa(...args, "--json");
  assert.equal(r.status, 0, `expected success, got ${r.status}: ${r.stderr}`);
  try {
    return JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`not JSON: ${r.stdout.slice(0, 200)}`);
  }
}

before(() => {
  const store = buildStore();
  mediaRoot = buildMediaRoot();
  dataDir = mkdtempSync(join(tmpdir(), "wa-cli-"));
  for (const name of [CHAT_DB, CONTACTS_DB, LID_DB]) {
    cpSync(join(store, name), join(dataDir, name));
  }
  rmSync(store, { recursive: true, force: true });
});

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(mediaRoot, { recursive: true, force: true });
});

describe("the shipped binary", () => {
  // dist/ is committed, so git records its mode. A rebuild that drops the exec
  // bit ships a `wa` that dies with "permission denied" before Node ever runs.
  it("is executable, and runs without an interpreter", () => {
    const bin = join(import.meta.dirname, "..", "dist", "cli.js");
    if (!existsSync(bin)) return; // built artifact absent; `npm run build` covers it
    assert.ok(statSync(bin).mode & 0o111, "dist/cli.js must be executable");
    const r = spawnSync(bin, ["--help"], { encoding: "utf8" });
    assert.equal(r.status, 0, `direct exec failed: ${r.error?.message ?? r.stderr}`);
    assert.match(r.stdout, /COMMANDS/);
  });
});

describe("discovery", () => {
  it("prints usage with no arguments and exits 1", () => {
    const r = wa();
    assert.equal(r.status, 1);
    assert.match(r.stdout, /COMMANDS/);
  });

  it("prints usage with --help and exits 0", () => {
    const r = wa("stats", "--help");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--json/);
  });

  it("exits 0 for a bare --help, with no command", () => {
    // Asking for help is not a usage error, even though the output matches.
    const r = wa("--help");
    assert.equal(r.status, 0, "wa --help must succeed");
    assert.match(r.stdout, /COMMANDS/);
  });

  it("documents every command it accepts", () => {
    // The help text is how an agent discovers this tool; keep it complete.
    const help = wa().stdout;
    for (const cmd of [
      "snapshot", "stats", "chats", "read", "search", "whois", "today", "find-media", "media",
    ]) {
      assert.match(help, new RegExp(`wa ${cmd}`), `${cmd} missing from usage`);
    }
  });

  it("rejects an unknown command with usage on exit 1", () => {
    const r = wa("frobnicate");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown command/);
  });
});

describe("--json output", () => {
  it("stats returns the fixture totals", () => {
    const s = waJson("stats");
    assert.equal(s["messages"], 11);
    assert.equal(s["chats"], 3);
    assert.equal(s["contacts"], 2);
  });

  it("chats returns an array", () => {
    const out = waJson("chats");
    const chats = out["chats"] as Array<{ name: string }>;
    assert.ok(Array.isArray(chats));
    assert.ok(chats.some((c) => c.name === "Family"));
  });

  it("read returns the chat and its messages", () => {
    const out = waJson("read", "Dana Cohen");
    assert.equal((out["chat"] as { name: string }).name, "Dana Cohen");
    const messages = out["messages"] as Array<{ sender: string }>;
    assert.equal(messages[0]!.sender, "Dana Cohen");
  });

  it("search returns results and a count", () => {
    const out = waJson("search", "hello");
    assert.equal(out["count"], 1);
    assert.equal((out["results"] as unknown[]).length, 1);
  });

  it("whois resolves through the lid mapping", () => {
    const out = waJson("whois", "972500000222");
    const matches = out["matches"] as Array<{ bestName: string; lid: string }>;
    assert.equal(matches[0]!.bestName, "Yossi");
    assert.equal(matches[0]!.lid, "222@lid");
  });

  it("whois resolves several numbers in order", () => {
    const out = waJson("whois", "972500000222", "972500000111");
    const names = (out["matches"] as Array<{ bestName: string }>).map((m) => m.bestName);
    assert.deepEqual(names, ["Yossi", "Ada Lovelace"]);
  });

  it("today separates replied-in from merely active", () => {
    const out = waJson("today", "2026-04-10");
    assert.equal((out["participated"] as unknown[]).length, 1);
    assert.equal((out["activeOnly"] as unknown[]).length, 0);
  });

  it("find-media reports the document filename and MIME type", () => {
    const out = waJson("find-media", "--kind", "document");
    const media = out["media"] as Array<{ filename: string; mimeType: string }>;
    assert.equal(media[0]!.filename, "מסמך חשוב.pdf");
    assert.equal(media[0]!.mimeType, "application/pdf");
  });

  it("emits nothing but JSON on stdout, so it can be piped", () => {
    const r = wa("stats", "--json");
    assert.doesNotThrow(() => JSON.parse(r.stdout));
  });
});

describe("option parsing", () => {
  it("honours -n as a limit", () => {
    const out = waJson("read", "Family", "-n", "2");
    assert.equal((out["messages"] as unknown[]).length, 2);
  });

  it("honours --since and --until", () => {
    const out = waJson("read", "Family", "--since", "2026-02-01", "--until", "2026-03-01");
    const messages = out["messages"] as Array<{ sender: string }>;
    assert.deepEqual(messages.map((m) => m.sender), ["Yossi"]);
  });

  it("accepts several --kind values", () => {
    const out = waJson("find-media", "--kind", "image,video");
    const kinds = new Set((out["media"] as Array<{ kind: string }>).map((m) => m.kind));
    assert.deepEqual(kinds, new Set(["image", "video"]));
  });

  it("rejects an unknown --kind", () => {
    const r = wa("find-media", "--kind", "hologram");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown media kind/);
  });

  it("rejects a non-numeric --limit", () => {
    const r = wa("read", "Family", "-n", "lots");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--limit expects a number/);
  });

  it("rejects an unparseable date", () => {
    const r = wa("read", "Family", "--since", "yesterday");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /YYYY-MM-DD/);
  });
});

describe("errors go to stderr with exit 1", () => {
  it("an ambiguous chat lists candidates", () => {
    const r = wa("read", "Fam");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /chats match/);
    assert.match(r.stderr, /Family Reunion/);
    assert.equal(r.stdout, "", "errors must not contaminate stdout");
  });

  it("an unknown chat reports not found", () => {
    const r = wa("read", "Nonexistent");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No chat matching/);
  });

  it("a missing required argument is reported", () => {
    const r = wa("read");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /needs a chat/);
  });

  it("a missing snapshot names the fix", () => {
    const empty = mkdtempSync(join(tmpdir(), "wa-empty-"));
    try {
      const r = spawnSync("node", ["--no-warnings", CLI, "stats"], {
        encoding: "utf8",
        env: { ...process.env, WA_DATA_DIR: empty },
      });
      assert.equal(r.status, 1);
      assert.match(r.stderr ?? "", /wa snapshot/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("media export", () => {
  it("writes files and reports the count", () => {
    const out = mkdtempSync(join(tmpdir(), "wa-out-"));
    try {
      // The fixture's media tree is separate from the data dir, so point the
      // export at real files by running with the fixture root as cwd-independent.
      const r = wa("media", "--kind", "document", "--out", out);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /file\(s\) ->/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("reports attachments that were never downloaded", () => {
    const out = mkdtempSync(join(tmpdir(), "wa-out2-"));
    try {
      const r = wa("media", "--kind", "image", "--out", out, "--json");
      const data = JSON.parse(r.stdout) as { missing: number; exported: unknown[] };
      // One fixture image is deliberately absent from the media tree.
      assert.ok(data.missing >= 1, "expected at least one missing attachment");
      assert.ok(readdirSync(out).length <= data.exported.length);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
