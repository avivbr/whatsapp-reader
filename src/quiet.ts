/**
 * Suppress node:sqlite's experimental notice.
 *
 * Must be imported before anything that loads node:sqlite. ESM evaluates
 * dependencies in declaration order but hoists all of them above top-level
 * statements, so this cannot live inline in cli.ts -- db.ts would load first and
 * the notice would already have fired.
 *
 * Overriding process.emitWarning does not work: Node's internal experimental
 * warning path captured its own reference at bootstrap. Replacing the 'warning'
 * listener does, because that is where the default printer lives.
 *
 * Only this one message is dropped; every other warning is still printed. A
 * shebang cannot portably carry --no-warnings, and the notice firing on every
 * invocation would pollute stderr, which callers check for genuine errors.
 */

process.removeAllListeners("warning");

process.on("warning", (warning: Error) => {
  if (warning.name === "ExperimentalWarning" && warning.message.includes("SQLite")) return;
  console.error(`${warning.name}: ${warning.message}`);
});
