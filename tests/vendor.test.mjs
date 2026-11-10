import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Guards web/vendor/ and the import map written by tools/vendor.mjs.
const html = readFileSync("web/index.html", "utf8");
const imports = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports;
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const files = walk("web/vendor").filter((f) => /\.m?js$/.test(f));
const IMPORT_RE = /(?:^|[;\s}])(?:import|export)\s*(?:[\w*{}\s,$]*?\s*from\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

test("every import map entry points to a vendored file", () => {
  for (const [specifier, url] of Object.entries(imports)) {
    assert.ok(url.startsWith("./vendor/"), `${specifier} must be local, not a CDN`);
    assert.ok(existsSync(join("web", url)), `${specifier} -> ${url} is missing`);
  }
});

test("every import inside the vendored files resolves", () => {
  for (const file of files) {
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT_RE)) {
      const specifier = match[1] || match[2];
      if (specifier.startsWith(".")) assert.ok(existsSync(resolve(dirname(file), specifier)), `${file} imports missing ${specifier}`);
      else assert.ok(imports[specifier], `${file} imports ${specifier}, which is not in the import map`);
    }
  }
});

test("one version of each package, and the manifest matches tools/vendor.json", () => {
  const manifest = JSON.parse(readFileSync("web/vendor/manifest.json", "utf8")).packages;
  const config = JSON.parse(readFileSync("tools/vendor.json", "utf8")).packages;
  for (const [name, version] of Object.entries(config)) assert.equal(manifest[name], version, name);
  const folders = walk("web/vendor").map((f) => f.split(/[\\/]/).slice(2).find((part, i, all) => part.includes("@") && (i === 0 ? !part.startsWith("@") : all[i - 1].startsWith("@") || !part.startsWith("@")))).filter(Boolean);
  const byName = new Map();
  for (const folder of new Set(folders)) {
    const name = folder.slice(0, folder.lastIndexOf("@"));
    byName.set(name, (byName.get(name) || 0) + 1);
  }
  for (const [name, count] of byName) assert.equal(count, 1, `${name} is vendored ${count} times`);
});
