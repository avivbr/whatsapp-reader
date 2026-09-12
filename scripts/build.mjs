#!/usr/bin/env node
/**
 * Emit dist/ from src/ using only Node built-ins.
 *
 * Why not tsc: this has to run wherever the package is built, including places
 * that have no devDependencies installed. Node can strip types itself, so the
 * build needs nothing beyond Node.
 *
 * tsc is still the typechecker (`npm run typecheck`). This script only erases
 * types; it validates nothing, which is fine because CI typechecks separately.
 */

import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, relative } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");
const OUT = join(import.meta.dirname, "..", "dist");

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return e.name.endsWith(".ts") ? [path] : [];
  });
}

rmSync(OUT, { recursive: true, force: true });

// Whatever package.json exposes as a bin must end up executable.
const BIN_FILES = new Set(
  Object.values(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).bin)
    .map((p) => p.replace(/^\.\/dist\//, "").replace(/\.js$/, ".ts")),
);

let count = 0;
for (const file of sources(SRC)) {
  const stripped = stripTypeScriptTypes(readFileSync(file, "utf8"), {
    mode: "strip",
    sourceMap: false,
  });

  // Source uses explicit .ts specifiers because Node's type stripping requires
  // them. On disk the emitted files are .js, so relative specifiers must follow.
  // Covers `from "x"`, `import("x")`, and bare `import "x"` side-effect imports --
  // the last of those was missed on the first attempt and only showed up at
  // runtime, hence the assertion below.
  const rewritten = stripped.replace(
    /(["'])(\.{1,2}\/[^"']+)\.ts\1/g,
    (_m, quote, path) => `${quote}${path}.js${quote}`,
  );

  const leftover = rewritten.match(/["']\.{1,2}\/[^"']+\.ts["']/);
  if (leftover) {
    throw new Error(`${relative(SRC, file)}: unrewritten specifier ${leftover[0]}`);
  }

  const target = join(OUT, relative(SRC, file)).replace(/\.ts$/, ".js");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, rewritten);

  // The bin entry has to be executable. npm sets this during an install, but a
  // plain rebuild does not -- and since dist/ is committed, git records the mode,
  // so a 644 here ships a `wa` that dies with "permission denied".
  if (BIN_FILES.has(relative(SRC, file))) chmodSync(target, 0o755);

  count += 1;
}

console.log(`built ${count} file(s) -> dist/`);
