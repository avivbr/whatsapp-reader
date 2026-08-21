import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { DatabaseSync } from "node:sqlite";

import { openSnapshot } from "../src/db.ts";
import { exportMedia, findMedia } from "../src/queries/media.ts";
import { AmbiguousChatError, ChatNotFoundError } from "../src/queries/types.ts";
import { buildMediaRoot, buildStore } from "./fixture.ts";

let dir: string;
let mediaRoot: string;
let db: DatabaseSync;
let out: string;

before(() => {
  dir = buildStore();
  mediaRoot = buildMediaRoot();
  db = openSnapshot(dir);
});
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(mediaRoot, { recursive: true, force: true });
});
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), "wa-out-"));
});

describe("findMedia", () => {
  it("returns every attachment with its metadata", () => {
    const found = findMedia(db, { mediaRoot });
    assert.equal(found.length, 5);
    for (const item of found) assert.ok(item.mimeType, `${item.kind} has no MIME type`);
  });

  it("filters by kind", () => {
    const docs = findMedia(db, { kinds: ["document"], mediaRoot });
    assert.equal(docs.length, 1);
    assert.equal(docs[0]!.kind, "document");
    assert.equal(docs[0]!.mimeType, "application/pdf");
  });

  it("accepts several kinds at once", () => {
    const found = findMedia(db, { kinds: ["image", "video"], mediaRoot });
    assert.deepEqual(new Set(found.map((f) => f.kind)), new Set(["image", "video"]));
    assert.equal(found.length, 3);
  });

  it("exposes the original filename for documents only", () => {
    const [doc] = findMedia(db, { kinds: ["document"], mediaRoot });
    assert.equal(doc!.filename, "מסמך חשוב.pdf");
    for (const other of findMedia(db, { kinds: ["image", "video", "voice"], mediaRoot })) {
      assert.equal(other.filename, null, `${other.kind} should carry no filename`);
    }
  });

  it("exposes captions and sizes", () => {
    const [image] = findMedia(db, { kinds: ["image"], mediaRoot, since: "2026-06-10", until: "2026-06-11" });
    assert.equal(image!.caption, "at the beach");
    assert.equal(image!.sizeBytes, 2048);
  });

  it("marks an attachment that was never downloaded", () => {
    const missing = findMedia(db, { mediaRoot }).filter((f) => !f.onDisk);
    assert.equal(missing.length, 1);
    assert.equal(missing[0]!.source, "Media/1/e/never.jpg");
  });

  it("can exclude what is not on disk", () => {
    const found = findMedia(db, { mediaRoot, onDiskOnly: true });
    assert.equal(found.length, 4);
    assert.ok(found.every((f) => f.onDisk));
  });

  it("resolves senders and chats", () => {
    const [doc] = findMedia(db, { kinds: ["document"], mediaRoot });
    assert.equal(doc!.sender, "Ada Lovelace");
    assert.equal(doc!.chat, "Family");
  });

  it("scopes to one chat", () => {
    assert.equal(findMedia(db, { chat: "Family Reunion", mediaRoot }).length, 0);
    assert.equal(findMedia(db, { chat: "Family", mediaRoot }).length, 5);
  });

  it("filters by sender and date window", () => {
    assert.equal(findMedia(db, { sender: "Ada", mediaRoot }).length, 2);
    assert.equal(findMedia(db, { since: "2026-06-13", mediaRoot }).length, 2);
  });

  it("honours the limit", () => {
    assert.equal(findMedia(db, { mediaRoot, limit: 2 }).length, 2);
  });
});

describe("exportMedia", () => {
  it("copies files and reports what was written", () => {
    const r = exportMedia(db, out, { mediaRoot });
    assert.equal(r.written, 4);
    assert.equal(r.missing, 1);
    assert.equal(readdirSync(out).length, 4);
  });

  it("writes real bytes, not empty files", () => {
    exportMedia(db, out, { mediaRoot, kinds: ["document"] });
    const [file] = readdirSync(out);
    assert.equal(readFileSync(join(out, file!), "utf8"), "%PDF-1.4 fake");
  });

  it("gives documents back their original filename", () => {
    exportMedia(db, out, { mediaRoot, kinds: ["document"] });
    const [file] = readdirSync(out);
    assert.ok(file!.includes("מסמך_חשוב.pdf"), `unexpected name: ${file}`);
  });

  it("names other kinds by timestamp and direction", () => {
    exportMedia(db, out, { mediaRoot, kinds: ["video"] });
    const [file] = readdirSync(out);
    // The video is outgoing, so it should be tagged as from me.
    assert.match(file!, /^2026-06-12_\d{6}_me_clip\.mp4$/);
  });

  it("can omit the timestamp prefix", () => {
    exportMedia(db, out, { mediaRoot, kinds: ["document"], timestampNames: false });
    assert.deepEqual(readdirSync(out), ["מסמך_חשוב.pdf"]);
  });

  it("reports a never-downloaded attachment without failing", () => {
    const r = exportMedia(db, out, { mediaRoot, kinds: ["image"] });
    assert.equal(r.written, 1);
    assert.equal(r.missing, 1);
    const absent = r.exported.find((e) => e.exported === null);
    assert.equal(absent!.source, "Media/1/e/never.jpg");
  });

  it("creates nothing when the filter matches nothing", () => {
    const r = exportMedia(db, out, { mediaRoot, kinds: ["sticker"] });
    assert.equal(r.written, 0);
    assert.deepEqual(r.exported, []);
  });

  it("propagates chat resolution failures", () => {
    assert.throws(() => exportMedia(db, out, { chat: "Nonexistent", mediaRoot }), ChatNotFoundError);
    assert.throws(() => exportMedia(db, out, { chat: "Fam", mediaRoot }), AmbiguousChatError);
  });

  it("never writes outside the destination", () => {
    const r = exportMedia(db, out, { mediaRoot });
    for (const item of r.exported) {
      if (item.exported) assert.ok(item.exported.startsWith(out), `escaped: ${item.exported}`);
    }
  });
});
