// A key is letters, digits, ".", "_" and "-", never only dots: a slash, a dot segment or one
// percent-encoded would write pages outside the build, a "?" or "#" breaks its addresses, and
// admin.js reads the repository of an answer's key up to its first colon. A folder's name keeps
// its other characters as "-"; the hub finds no folder whose name starts with a dot.
export const REPO_KEY = /^(?!\.+$)[\p{L}\p{M}\p{N}_.-]+$/u;
export const asKey = (folder: string) => folder.replace(/[^\p{L}\p{M}\p{N}_.-]/gu, "-");

// A page path ending in "index" is its folder's own route to Astro, so index.md keeps its extension.
export const docSlug = (path: string) =>
  `doc/${/(^|\/)index\.md$/i.test(path) ? path : path.replace(/\.md$/i, "")}`;

// "#" or "?" would end the path, and an "&" or "'" left as is comes out of the pages' attributes
// escaped, where the hub's link rewriting no longer finds it.
export const encodeFile = (path: string) =>
  encodeURI(path).replace(/[#?&']/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export const fileHref = (abs: string) => "file://" + encodeFile(abs);
// A path whose every segment is encoded, so a "#", "%" or "?" in a name stays in its path.
export const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

export const IMAGE = /\.(jpe?g|png|gif|webp|svg|avif)$/i;
