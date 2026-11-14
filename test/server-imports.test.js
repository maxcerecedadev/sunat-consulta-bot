"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SERVER_DIR = path.join(__dirname, "..", "src", "server");

/**
 * Los módulos de src/server comparten utilidades vía `require("./helpers")`.
 * Si un archivo usa una utilidad sin importarla, el error sólo aparece en
 * tiempo de ejecución (`X is not defined`), como pasó con
 * `isBrowserClosedError` en run-job.js. Este test lo detecta antes de compilar.
 */
function helperExports() {
  const source = fs.readFileSync(path.join(SERVER_DIR, "helpers.js"), "utf8");
  const block = source.match(/module\.exports\s*=\s*\{([\s\S]*?)\};/);
  assert.ok(block, "helpers.js debe declarar module.exports");

  return block[1]
    .split(",")
    .map((line) => line.split(":")[0].trim())
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
}

function importedFromHelpers(source) {
  const names = new Set();
  const pattern = /const\s*\{([^}]*)\}\s*=\s*require\("\.\/helpers"\)/g;
  let match;

  while ((match = pattern.exec(source)) !== null) {
    for (const entry of match[1].split(",")) {
      const name = entry.split(":")[0].trim();
      if (name) names.add(name);
    }
  }

  return names;
}

test("los módulos del servidor importan las utilidades de helpers que usan", () => {
  const exported = helperExports();
  const problems = [];

  for (const file of fs.readdirSync(SERVER_DIR)) {
    if (!file.endsWith(".js") || file === "helpers.js") continue;

    const source = fs.readFileSync(path.join(SERVER_DIR, file), "utf8");
    if (!source.includes('require("./helpers")')) continue;

    const imported = importedFromHelpers(source);

    for (const name of exported) {
      if (imported.has(name)) continue;

      const declaredLocally = new RegExp(
        `(?:function|const|let|var)\\s+${name}\\b`,
      ).test(source);

      const used = new RegExp(`\\b${name}\\s*\\(`).test(source);

      if (used && !declaredLocally) {
        problems.push(`${file} usa ${name}() sin importarlo de ./helpers`);
      }
    }
  }

  assert.deepEqual(problems, []);
});
