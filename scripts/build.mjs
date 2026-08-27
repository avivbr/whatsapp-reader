#!/usr/bin/env node
/**
 * Emit dist/ from src/ using only Node built-ins.
 *
 * Why not tsc: `prepare` runs during `npm install`, and npm does not reliably
 * provide devDependencies to it — a git install fails with "tsc: command not
 * found". Node can strip types itself, so the build needs nothing installed and
 * works wherever the package is being installed from.
 *
 * tsc is still the typechecker (`npm run typecheck`). This script only erases
 * types; it validates nothing, which is fine because CI typechecks separately.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  count += 1;
}

console.log(`built ${count} file(s) -> dist/`);
