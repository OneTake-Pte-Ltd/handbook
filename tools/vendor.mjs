// Copies the browser libraries listed in tools/vendor.json from npm into
// web/vendor/, and writes the import map in web/index.html.
//
//   node tools/vendor.mjs
//
// Why: the app loads no library from a CDN at runtime. Every file comes from
// this repository, with exact versions, and each prosemirror-* package exists
// once (Tiptap breaks with several copies). No bundler: the published ES
// module files are copied as they are. Only the files reachable from the
// entry points in vendor.json are kept, plus each package's licence.
//
// Needs Node 22 and npm (shipped with Node). Uses no other tool.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(root, "tools", "vendor.json"), "utf8"));
const vendorDir = join(root, "web", "vendor");
const indexHtml = join(root, "web", "index.html");

function fail(message) {
  console.error(`vendor: ${message}`);
  process.exit(1);
}

// 1. Install the exact versions in a temporary folder.
const work = mkdtempSync(join(tmpdir(), "handbook-vendor-"));
writeFileSync(join(work, "package.json"), JSON.stringify({ name: "vendor", private: true }));
const specs = Object.entries(config.packages).map(([name, version]) => `${name}@${version}`);
console.log(`Installing ${specs.join(" ")}`);
execFileSync("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--save-exact", ...specs], {
  cwd: work,
  stdio: "inherit",
  shell: process.platform === "win32",
});
const modules = join(work, "node_modules");

// 2. One copy of each package: refuse nested node_modules folders.
function findNested(dir, depth = 0) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    if (entry.name === "node_modules" && depth > 0) fail(`two versions of a package were installed (${relative(modules, path)}). Align the versions in vendor.json.`);
    findNested(path, depth + 1);
  }
}
findNested(modules);

// 3. Resolve bare specifiers through each package's "exports" (import condition).
const packageInfo = new Map();
function pkg(name) {
  if (!packageInfo.has(name)) {
    const dir = join(modules, name);
    if (!existsSync(join(dir, "package.json"))) fail(`package ${name} is not installed`);
    packageInfo.set(name, { dir, json: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) });
  }
  return packageInfo.get(name);
}

function pickCondition(target) {
  if (typeof target === "string") return target;
  if (!target || typeof target !== "object") return null;
  for (const key of ["browser", "import", "module", "default"]) {
    if (key in target) {
      const found = pickCondition(target[key]);
      if (found) return found;
    }
  }
  return null;
}

function splitSpecifier(specifier) {
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const subpath = "." + specifier.slice(name.length);
  return { name, subpath: subpath === "." ? "." : subpath };
}

function resolveBare(specifier) {
  const { name, subpath } = splitSpecifier(specifier);
  const { dir, json } = pkg(name);
  let target = null;
  const exportsField = json.exports;
  if (exportsField) {
    const map = typeof exportsField === "string" || !Object.keys(exportsField).some((k) => k.startsWith(".")) ? { ".": exportsField } : exportsField;
    target = pickCondition(map[subpath]);
  } else if (subpath === ".") {
    target = json.module || (json.type === "module" ? json.main : null);
  }
  if (!target) fail(`can't find an ES module file for "${specifier}"`);
  return { name, file: join(dir, target) };
}

// 4. Follow imports from the entry points.
const IMPORT_RE = /(?:^|[;\s}])(?:import|export)\s*(?:[\w*{}\s,$]*?\s*from\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
const files = new Map(); // absolute path -> package name
const bareUsed = new Map(); // specifier -> absolute file
const queue = [];

function addBare(specifier) {
  if (bareUsed.has(specifier)) return;
  const { name, file } = resolveBare(specifier);
  bareUsed.set(specifier, file);
  queue.push([file, name]);
}

for (const entry of config.entries) addBare(entry);
while (queue.length) {
  const [file, name] = queue.pop();
  if (files.has(file)) continue;
  if (!existsSync(file)) fail(`missing file ${relative(modules, file)}`);
  files.set(file, name);
  const code = readFileSync(file, "utf8");
  for (const match of code.matchAll(IMPORT_RE)) {
    const specifier = match[1] || match[2];
    if (specifier.startsWith(".")) queue.push([resolve(dirname(file), specifier), name]);
    else if (!specifier.startsWith("node:")) addBare(specifier);
  }
}

// 5. Copy the files to web/vendor/<name>@<version>/..., with licences.
rmSync(vendorDir, { recursive: true, force: true });
mkdirSync(vendorDir, { recursive: true });
const folder = (name) => `${name}@${pkg(name).json.version}`;
const urlOf = (file) => {
  const name = files.get(file);
  return "./vendor/" + posix.join(folder(name), relative(pkg(name).dir, file).split("\\").join("/"));
};
let bytes = 0;
for (const [file, name] of files) {
  const target = join(vendorDir, folder(name), relative(pkg(name).dir, file));
  mkdirSync(dirname(target), { recursive: true });
  cpSync(file, target);
  bytes += readFileSync(file).length;
}
const packages = [...new Set(files.values())].sort();
for (const name of packages) {
  for (const licence of readdirSync(pkg(name).dir).filter((f) => /^(licen[cs]e|copying)/i.test(f))) {
    cpSync(join(pkg(name).dir, licence), join(vendorDir, folder(name), licence));
  }
}
const manifest = Object.fromEntries(packages.map((name) => [name, pkg(name).json.version]));
writeFileSync(join(vendorDir, "manifest.json"), JSON.stringify({ generated_by: "tools/vendor.mjs", packages: manifest }, null, 2) + "\n");

// 6. Write the import map into web/index.html.
const imports = Object.fromEntries([...bareUsed].sort(([a], [b]) => a.localeCompare(b)).map(([specifier, file]) => [specifier, urlOf(file)]));
const html = readFileSync(indexHtml, "utf8");
const block = /(<script type="importmap">)[\s\S]*?(<\/script>)/;
if (!block.test(html)) fail("no <script type=\"importmap\"> block in web/index.html");
const json = JSON.stringify({ imports }, null, 2).replace(/\n/g, "\n      ");
writeFileSync(indexHtml, html.replace(block, `$1\n      ${json}\n    $2`));

rmSync(work, { recursive: true, force: true });
console.log(`Copied ${files.size} files from ${packages.length} packages (${Math.round(bytes / 1024)} KB) into web/vendor/.`);
console.log(`Import map: ${Object.keys(imports).length} entries.`);
