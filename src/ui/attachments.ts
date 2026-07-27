/**
 * Filename and file-type helpers for chat attachments (pasted, dropped, or
 * uploaded). Deliberately free of any `vscode` import so the rules that decide
 * where a user-supplied name is allowed to write are unit-testable.
 */

/** Where attachments are kept inside the workspace. */
export const UPLOAD_DIR = ".waycode/uploads";

/** Attachments above this are refused — the bytes cross the webview boundary. */
export const MAX_PASTE_BYTES = 20_000_000;

/**
 * Reduce anything the webview supplies to a bare, safe filename.
 *
 * The name arrives from the clipboard or a drag-and-drop, i.e. from outside our
 * control, and is joined onto a directory path — so a name like
 * `../../.ssh/authorized_keys` must not survive. Every directory separator is
 * dropped rather than escaped, leading dots are stripped so nothing lands as a
 * hidden dotfile, and only word characters, dots, dashes and spaces remain.
 */
export function sanitizeFileName(name: string): string {
  const base = (name || "").split(/[\\/]/).pop() || "";
  return base
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/^\.+/, "")
    .trim();
}

/** A clipboard screenshot arrives with no filename; build one from its MIME type. */
export function generatedName(mime: string): string {
  const ext = /image\/([\w+]+)/.exec(mime || "")?.[1]?.replace("jpeg", "jpg") ?? "bin";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `pasted-${stamp}.${sanitizeFileName(ext) || "bin"}`;
}

/** `logo.png` + 1 → `logo-1.png`, so an existing attachment is never overwritten. */
export function numbered(name: string, n: number): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
}

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i;

export function isImage(name: string): boolean {
  return IMAGE_EXTENSIONS.test(name);
}

/** Extensions whose contents are meaningless as text in a prompt. */
const BINARY_EXTENSIONS =
  /\.(png|jpe?g|gif|webp|bmp|ico|avif|pdf|zip|gz|tar|7z|rar|mp[34]|mov|avi|wav|ttf|otf|woff2?|eot|dmg|exe|dll|so|dylib|class|jar|wasm)$/i;

export function isBinary(name: string): boolean {
  return BINARY_EXTENSIONS.test(name);
}
