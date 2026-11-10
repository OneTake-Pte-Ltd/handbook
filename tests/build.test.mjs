import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

test("the edge script builds into one file with its package imports at the top", () => {
  execFileSync(process.execPath, ["edge/build.mjs"], { stdio: "pipe" });
  const code = readFileSync("edge/dist/edge.mjs", "utf8");
  const imports = code.split("\n").filter((line) => line.startsWith("import "));
  assert.ok(imports.length >= 2);
  assert.ok(imports.every((line) => /from "(npm|node):/.test(line)), "only package imports remain");
  assert.ok(code.includes("BunnySDK.net.http.serve"));
  assert.ok(!/^export /m.test(code));
});
