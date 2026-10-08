/**
 * Runs the checks in tests/parse_test.html from the command line, so they can
 * run before every commit without opening a browser:
 *
 *   node tests/run_tests.js
 *
 * The test page stays the single place the checks are written. This file only
 * stands in for the few browser features the page uses (fetch, a little of
 * document). Exits with status 1 if any check fails.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const HERE = __dirname;
const page = fs.readFileSync(path.join(HERE, "parse_test.html"), "utf8");
const script = /<script>([\s\S]*)<\/script>/.exec(page)[1];

const lines = [];
const node = () => ({ className: "", textContent: "", appendChild(child) { lines.push(child.textContent); } });
const sandbox = {
  console,
  // Files next to the test page; a missing one answers like a 404.
  fetch: async (rel) => {
    const file = path.resolve(HERE, rel);
    if (!fs.existsSync(file)) return { ok: false };
    const text = fs.readFileSync(file, "utf8");
    return { ok: true, text: async () => text, json: async () => JSON.parse(text) };
  },
  document: {
    getElementById: node,
    createElement: node,
    body: { insertAdjacentHTML(_where, html) { lines.push(html); } },
    // The page loads deals.js by adding a <script> tag.
    head: { append(tag) { vm.runInContext(fs.readFileSync(path.resolve(HERE, tag.src), "utf8"), context); tag.onload(); } },
  },
};
sandbox.window = sandbox;
const context = vm.createContext(sandbox);

(async () => {
  await vm.runInContext(script, context); // the page's script ends with the promise of its checks
  const result = sandbox.testResult || { error: "the test page didn't finish" };
  const failed = result.error ? [result.error] : result.failed;
  for (const line of lines) if (/^FAIL/.test(line)) console.log(line);
  const passed = lines.filter((l) => /^PASS/.test(l)).length;
  console.log(`${passed} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
