import { test } from "node:test";
import assert from "node:assert/strict";
import { isPublicHttpUrl, previewEmbed } from "../edge/src/lib/embeds.js";

// A fake web: url -> { status, body, headers }
function fakeFetch(pages) {
  return async (url) => {
    const page = pages[url];
    if (!page) return new Response("not found", { status: 404 });
    return new Response(page.body ?? "", { status: page.status ?? 200, headers: page.headers ?? {} });
  };
}

test("oEmbed discovery gives an https iframe", async () => {
  const fetch = fakeFetch({
    "https://video.example.com/watch?v=1": {
      body: '<html><head><title>Ignored</title><link rel="alternate" type="application/json+oembed" href="https://video.example.com/oembed?url=x&amp;format=json"></head></html>',
    },
    "https://video.example.com/oembed?url=x&format=json": {
      body: JSON.stringify({ title: "18 secrets", width: 640, height: 360, thumbnail_url: "https://img.example.com/t.jpg", html: '<iframe src="https://video.example.com/embed/1" width="640" height="360"></iframe>' }),
    },
  });
  const result = await previewEmbed(fetch, "https://video.example.com/watch?v=1");
  assert.deepEqual(result, {
    kind: "iframe",
    url: "https://video.example.com/watch?v=1",
    src: "https://video.example.com/embed/1",
    width: 640,
    height: 360,
    title: "18 secrets",
    thumbnail: "https://img.example.com/t.jpg",
  });
});

test("og:video, then twitter:player; http players are ignored", async () => {
  const og = await previewEmbed(
    fakeFetch({ "https://a.example.com/v": { body: '<meta property="og:video:url" content="http://insecure.example.com/p"><meta property="og:video:secure_url" content="https://a.example.com/player"><meta property="og:video:width" content="1280"><meta property="og:video:height" content="720">' } }),
    "https://a.example.com/v",
  );
  assert.equal(og.src, "https://a.example.com/player");
  assert.equal(og.width, 1280);
  const tw = await previewEmbed(
    fakeFetch({ "https://b.example.com/v": { body: '<meta property="og:video:url" content="http://insecure.example.com/p"><meta name="twitter:player" content="https://b.example.com/tw">' } }),
    "https://b.example.com/v",
  );
  assert.equal(tw.src, "https://b.example.com/tw");
});

test("no player gives a link card; redirects are followed", async () => {
  const result = await previewEmbed(
    fakeFetch({
      "https://short.example.com/x": { status: 301, headers: { location: "https://blog.example.com/post" } },
      "https://blog.example.com/post": { body: '<title>A post</title><meta property="og:description" content="About &quot;videos&quot;"><meta property="og:image" content="https://blog.example.com/i.png">' },
    }),
    "https://short.example.com/x",
  );
  assert.deepEqual(result, { kind: "link", url: "https://short.example.com/x", title: "A post", thumbnail: "https://blog.example.com/i.png", description: 'About "videos"' });
});

test("private and local addresses are refused, including through redirects", async () => {
  for (const url of ["http://localhost/x", "https://127.0.0.1/x", "https://10.0.0.5/", "https://192.168.1.1/", "https://169.254.169.254/latest", "https://[::1]/", "file:///etc/passwd", "https://intranet/"]) {
    assert.equal(isPublicHttpUrl(url), false, url);
  }
  assert.equal(isPublicHttpUrl("https://www.youtube.com/watch?v=x"), true);
  await assert.rejects(
    previewEmbed(fakeFetch({ "https://evil.example.com/": { status: 302, headers: { location: "http://169.254.169.254/" } } }), "https://evil.example.com/"),
    /can't be previewed/,
  );
});
