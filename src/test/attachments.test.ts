import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeFileName,
  generatedName,
  numbered,
  isImage,
  isBinary,
  mediaTypeFor,
} from "../ui/attachments";

test("a pasted name can never escape the uploads directory", () => {
  // The name comes from the clipboard — outside our control — and is joined onto
  // a directory path, so traversal must not survive.
  assert.equal(sanitizeFileName("../../.ssh/authorized_keys"), "authorized_keys");
  assert.equal(sanitizeFileName("a/b/c/logo.png"), "logo.png");
  assert.equal(sanitizeFileName("..\\..\\windows\\system32\\evil.dll"), "evil.dll");
  for (const evil of ["../x.png", "/etc/passwd", "..", "../../"]) {
    assert.ok(!sanitizeFileName(evil).includes("/"), evil);
    assert.ok(!sanitizeFileName(evil).includes("\\"), evil);
    assert.ok(!sanitizeFileName(evil).startsWith("."), evil);
  }
});

test("characters that do not belong in a filename are replaced", () => {
  assert.equal(sanitizeFileName('my file<>:"|?.png'), "my file_.png");
  assert.equal(sanitizeFileName("  spaced.txt  "), "spaced.txt");
});

test("a nameless clipboard image still gets a usable filename", () => {
  const png = generatedName("image/png");
  assert.match(png, /^pasted-[\d-]+T[\d-]+\.png$/);
  assert.match(generatedName("image/jpeg"), /\.jpg$/);
  assert.match(generatedName("image/svg+xml"), /\.svg\+xml$|\.svgxml$|\.svg_xml$/);
  // An unknown or absent MIME type must still produce something writable.
  assert.match(generatedName(""), /\.bin$/);
  assert.ok(!generatedName("").includes("/"));
});

test("a repeated name is numbered instead of overwriting", () => {
  assert.equal(numbered("logo.png", 1), "logo-1.png");
  assert.equal(numbered("archive.tar.gz", 2), "archive.tar-2.gz");
  assert.equal(numbered("LICENSE", 3), "LICENSE-3");
});

test("SVG counts as an image but stays readable as text", () => {
  // An SVG is XML: the agent can genuinely read and edit it, so it must be
  // inlined rather than reduced to "(image, 4 KB)" like a PNG.
  assert.ok(isImage("logo.svg"));
  assert.ok(!isBinary("logo.svg"));
});

test("images and binaries are recognised so they are not inlined as text", () => {
  for (const n of ["a.png", "b.JPG", "c.jpeg", "e.webp"]) {
    assert.ok(isImage(n), n);
    assert.ok(isBinary(n), n);
  }
  for (const n of ["a.pdf", "b.zip", "c.woff2", "d.dylib"]) {
    assert.ok(isBinary(n), n);
    assert.ok(!isImage(n), n);
  }
  for (const n of ["a.ts", "b.html", "c.md", "d.json"]) {
    assert.ok(!isBinary(n), n);
    assert.ok(!isImage(n), n);
  }
});

test("image MIME types are mapped for the provider's image block", () => {
  assert.equal(mediaTypeFor("a.png"), "image/png");
  assert.equal(mediaTypeFor("a.JPG"), "image/jpeg");
  assert.equal(mediaTypeFor("a.jpeg"), "image/jpeg");
  assert.equal(mediaTypeFor("a.webp"), "image/webp");
  assert.equal(mediaTypeFor("a.unknown"), "image/png");
});
