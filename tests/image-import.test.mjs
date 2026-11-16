import { test } from "node:test";
import assert from "node:assert/strict";
import { imageSources, ownFileChecker, replaceImageSources } from "../web/js/editor/image-import.js";

const figure = (src) => ({ type: "figure", attrs: { src, alt: "", caption: "", width: "full" } });
const step = () => ({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Hello" }] },
    figure("https://lh7-us.googleusercontent.com/abc"),
    { type: "columns", content: [{ type: "column", content: [figure("data:image/png;base64,AAAA"), figure("https://files.example.com/uploads/a.png")] }] },
  ],
});

test("finds images that are not in the workspace's storage", () => {
  const own = ownFileChecker("https://files.example.com/");
  assert.deepEqual([...imageSources(step(), own)], ["https://lh7-us.googleusercontent.com/abc", "data:image/png;base64,AAAA"]);
  assert.equal(own("https://files.example.com.evil.net/x.png"), false);
  assert.equal(ownFileChecker("")("https://files.example.com/a.png"), false);
});

test("replaces an image everywhere, or removes it", () => {
  const json = step();
  replaceImageSources(json, "data:image/png;base64,AAAA", "https://files.example.com/uploads/b.png");
  assert.equal(json.content[2].content[0].content[0].attrs.src, "https://files.example.com/uploads/b.png");
  replaceImageSources(json, "https://lh7-us.googleusercontent.com/abc", null);
  assert.equal(json.content.length, 2);
  assert.equal(json.content[1].type, "columns");
});
