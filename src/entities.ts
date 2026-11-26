// An attribute's or a title's text as a browser reads it, in one pass: numeric entities and the
// named ones Bun's renderer and hand-written HTML put there, apos in lower case only and the rest
// in lower or upper case.
const NAMED = { amp: "&", quot: '"', lt: "<", gt: ">", apos: "'" };

function isNamedEntity(key: string): key is keyof typeof NAMED {
  return Object.hasOwn(NAMED, key);
}

export function decodeEntity(token: string): string {
  if (!token.startsWith("#")) {
    const key = token.slice(0, -1).toLowerCase();
    if (!isNamedEntity(key)) throw new Error(`Named entity missing: ${token}`);
    return NAMED[key];
  }
  const hex = token[1] === "x" || token[1] === "X";
  const digits = token.slice(hex ? 2 : 1);
  return String.fromCodePoint(Math.min(parseInt(digits, hex ? 16 : 10), 0x10ffff));
}

export const entities = (v: string) =>
  v.replace(
    /&(#[xX][\da-fA-F]+;?|#\d+;?|(?:amp|AMP|quot|QUOT|lt|LT|gt|GT|apos);)/g,
    (_, token: string) => decodeEntity(token),
  );
