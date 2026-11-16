import { test } from "node:test";
import assert from "node:assert/strict";
import { nextRequiredDocument } from "../web/js/lib/next-document.js";

const doc = (id, mandatory, status = "not_started", is_published = true) => ({ id, title: `Doc ${id}`, mandatory, is_published, progress: { status } });
const tree = {
  spaces: [
    { categories: [{ documents: [doc(1, true, "completed"), doc(2, false), doc(3, true, "in_progress")] }] },
    { categories: [{ documents: [doc(4, true, "not_started", false), doc(5, true)] }] },
  ],
};

test("next required document follows the sidebar order", () => {
  assert.deepEqual(nextRequiredDocument(tree, 1), { id: 3, title: "Doc 3" });
  assert.deepEqual(nextRequiredDocument(tree, 3), { id: 5, title: "Doc 5" });
});

test("next required document wraps around and skips the current one", () => {
  assert.deepEqual(nextRequiredDocument(tree, 5), { id: 3, title: "Doc 3" });
});

test("no next required document when everything is completed", () => {
  const done = { spaces: [{ categories: [{ documents: [doc(1, true, "completed"), doc(2, false)] }] }] };
  assert.equal(nextRequiredDocument(done, 1), null);
  assert.equal(nextRequiredDocument(null, 1), null);
});
