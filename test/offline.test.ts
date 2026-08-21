/**
 * The reader must never talk to WhatsApp.
 *
 * The whole premise of this project is that it reads a local file instead of
 * pairing an unofficial client, so "offline" is a correctness property, not a
 * style preference. These tests fail if that stops being true.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const SRC = join(import.meta.dirname, "..", "src");

/** Modules that can open a connection. */
const NETWORK_MODULES = [
  "node:http", "node:https", "node:net", "node:tls", "node:dgram", "node:dns",
  "http", "https", "net", "tls", "dns",
  "undici", "axios", "node-fetch", "ws", "socket.io-client",
];

const ENDPOINTS = ["graph.facebook", "mmg.whatsapp", "web.whatsapp", "wa.me", "whatsmeow", "baileys"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const FILES = sourceFiles(SRC);

describe("offline guarantees", () => {
  it("finds source files to check", () => {
    assert.ok(FILES.length >= 10, `only found ${FILES.length} source files`);
  });

  for (const file of FILES) {
    const name = file.slice(SRC.length + 1);
    const text = readFileSync(file, "utf8");

    it(`${name} imports no network module`, () => {
      // Match the specifier in `from "x"` / `import("x")` / `require("x")`.
      const specifiers = [...text.matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)].map(
        (m) => m[1]!,
      );
      const offenders = specifiers.filter((s) => NETWORK_MODULES.includes(s));
      assert.deepEqual(offenders, [], `${name} imports ${offenders.join(", ")}`);
    });

    it(`${name} references no WhatsApp endpoint`, () => {
      const lowered = text.toLowerCase();
      for (const needle of ENDPOINTS) {
        // The comment explaining why we don't fetch media is allowed to say so.
        const hits = lowered.split(needle).length - 1;
        assert.equal(hits, 0, `${name} references ${needle}`);
      }
    });
  }

  it("runs the real query path with fetch and net disabled", async () => {
    const refuse = () => {
      throw new Error("attempted network access");
    };
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = refuse;
    try {
      const { openSnapshot } = await import("../src/db.ts");
      const { buildStore } = await import("./fixture.ts");
      const { stats } = await import("../src/queries/stats.ts");
      const { readChat, searchMessages } = await import("../src/queries/messages.ts");
      const { resolvePhone } = await import("../src/queries/people.ts");

      const dir = buildStore();
      const db = openSnapshot(dir);
      try {
        assert.equal(stats(db).messages, 7);
        assert.ok(readChat(db, "Family").messages.length > 0);
        assert.equal(searchMessages(db, "hello").length, 1);
        assert.equal(resolvePhone(db, "972500000111").bestName, "Ada Lovelace");
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      (globalThis as { fetch: unknown }).fetch = originalFetch;
    }
  });
});
