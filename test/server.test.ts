/**
 * End-to-end MCP protocol tests.
 *
 * These spawn the real server as a child process and speak JSON-RPC 2.0 over
 * stdio, exactly as Claude Code does. Everything below the transport is covered
 * by the query tests; this is the layer they cannot reach -- framing, the
 * initialize handshake, zod validation, tool dispatch, and the shape of what
 * comes back over the wire.
 *
 * The server is pointed at a fixture via WA_DATA_DIR, so no real snapshot is
 * touched and the assertions are deterministic.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { buildMediaRoot, buildStore } from "./fixture.ts";

const SERVER = join(import.meta.dirname, "..", "src", "server.ts");

/** A minimal JSON-RPC-over-stdio client, matching the transport Claude Code uses. */
class ServerClient {
  #proc: ChildProcessWithoutNullStreams;
  #buf = "";
  #nextId = 0;
  #waiters = new Map<number, (msg: Record<string, unknown>) => void>();
  stderr = "";

  constructor(dataDir: string) {
    this.#proc = spawn("node", ["--no-warnings", SERVER], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, WA_DATA_DIR: dataDir },
    });
    this.#proc.stdout.setEncoding("utf8");
    this.#proc.stderr.setEncoding("utf8");
    this.#proc.stderr.on("data", (d: string) => (this.stderr += d));
    this.#proc.stdout.on("data", (chunk: string) => {
      this.#buf += chunk;
      let i: number;
      while ((i = this.#buf.indexOf("\n")) >= 0) {
        const line = this.#buf.slice(0, i).trim();
        this.#buf = this.#buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as Record<string, unknown>;
        const id = msg["id"] as number | undefined;
        if (id !== undefined && this.#waiters.has(id)) {
          this.#waiters.get(id)!(msg);
          this.#waiters.delete(id);
        }
      }
    });
  }

  request(method: string, params: unknown): Promise<Record<string, unknown>> {
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), 15_000);
      this.#waiters.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.#proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method: string): void {
    this.#proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  }

  async handshake(): Promise<Record<string, unknown>> {
    const init = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    this.notify("notifications/initialized");
    return init;
  }

  /** Call a tool and return its parsed structured payload. */
  async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await this.request("tools/call", { name, arguments: args });
    const result = res["result"] as { content: Array<{ text: string }> } | undefined;
    assert.ok(result, `tools/call ${name} returned no result: ${JSON.stringify(res)}`);
    return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
  }

  kill(): void {
    this.#proc.kill();
  }
}

let dir: string;
let client: ServerClient;

before(async () => {
  // A fixture data dir the server can open, plus a media tree beside it.
  const store = buildStore();
  const media = buildMediaRoot();
  dir = mkdtempSync(join(tmpdir(), "wa-server-"));
  for (const name of ["ChatStorage.sqlite", "ContactsV2.sqlite", "LID.sqlite"]) {
    cpSync(join(store, name), join(dir, name));
  }
  rmSync(store, { recursive: true, force: true });
  // media root cleanup deferred to process exit; harmless in tmp
  void media;

  client = new ServerClient(dir);
  await client.handshake();
});

after(() => {
  client.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe("MCP handshake", () => {
  it("advertises the protocol version and server identity", async () => {
    const c = new ServerClient(dir);
    try {
      const init = await c.handshake();
      const result = init["result"] as Record<string, unknown>;
      assert.equal(result["protocolVersion"], "2025-06-18");
      assert.equal((result["serverInfo"] as { name: string }).name, "whatsapp-reader");
    } finally {
      c.kill();
    }
  });

  it("lists nine tools with correct read-only annotations", async () => {
    const res = await client.request("tools/list", {});
    const tools = (res["result"] as { tools: Array<Record<string, unknown>> }).tools;
    assert.equal(tools.length, 9);

    const byName = new Map(tools.map((t) => [t["name"], t]));
    for (const name of ["stats", "list_chats", "read_chat", "search_messages", "resolve_phone", "day_summary", "find_media"]) {
      const ann = byName.get(name)!["annotations"] as { readOnlyHint?: boolean };
      assert.equal(ann.readOnlyHint, true, `${name} should be read-only`);
    }
    for (const name of ["export_media", "refresh_snapshot"]) {
      const ann = byName.get(name)!["annotations"] as { readOnlyHint?: boolean };
      assert.notEqual(ann.readOnlyHint, true, `${name} writes and should not claim read-only`);
    }
  });

  it("derives JSON Schema from the zod input schemas", async () => {
    const res = await client.request("tools/list", {});
    const tools = (res["result"] as { tools: Array<Record<string, unknown>> }).tools;
    const readChat = tools.find((t) => t["name"] === "read_chat")!;
    const schema = readChat["inputSchema"] as { properties: Record<string, unknown>; required: string[] };
    assert.ok(schema.properties["chat"], "chat argument should be in the schema");
    assert.deepEqual(schema.required, ["chat"]);
  });
});

describe("tool dispatch", () => {
  it("stats returns the fixture totals", async () => {
    const s = await client.callTool("stats", {});
    assert.equal(s["messages"], 11);
    assert.equal(s["chats"], 3);
  });

  it("read_chat resolves senders over the wire", async () => {
    const r = await client.callTool("read_chat", { chat: "Dana Cohen" });
    const messages = r["messages"] as Array<{ sender: string }>;
    assert.equal(messages[0]!.sender, "Dana Cohen");
  });

  it("resolve_phone reaches a non-contact through the lid mapping", async () => {
    const r = await client.callTool("resolve_phone", { numbers: ["972500000222"] });
    const matches = r["matches"] as Array<{ bestName: string }>;
    assert.equal(matches[0]!.bestName, "Yossi");
  });

  it("find_media reports documents with their filename", async () => {
    const r = await client.callTool("find_media", { kinds: ["document"] });
    const media = r["media"] as Array<{ filename: string; mimeType: string }>;
    assert.equal(media[0]!.filename, "מסמך חשוב.pdf");
    assert.equal(media[0]!.mimeType, "application/pdf");
  });
});

describe("errors are data, not crashes", () => {
  it("an ambiguous chat returns candidates rather than throwing", async () => {
    const r = await client.callTool("read_chat", { chat: "Fam" });
    assert.match(r["error"] as string, /chats match/);
    assert.ok((r["candidates"] as string[]).length >= 2);
  });

  it("an unknown chat returns an error field", async () => {
    const r = await client.callTool("read_chat", { chat: "Nonexistent" });
    assert.match(r["error"] as string, /No chat matching/);
  });

  it("rejects input that violates the schema", async () => {
    // limit is capped at 500; the server should refuse rather than run it.
    const res = await client.request("tools/call", {
      name: "read_chat",
      arguments: { chat: "Dana Cohen", limit: 99999 },
    });
    const result = res["result"] as { isError?: boolean } | undefined;
    const isError = res["error"] !== undefined || result?.isError === true;
    assert.ok(isError, `expected a validation error, got ${JSON.stringify(res)}`);
  });

  it("rejects an unknown tool name", async () => {
    const res = await client.request("tools/call", { name: "delete_everything", arguments: {} });
    assert.ok(res["error"] !== undefined || (res["result"] as { isError?: boolean })?.isError,
      "unknown tool should error");
  });
});
