import { fc, test, unicodeString } from "@hackersandwizards/scaffolding/property";
import { expect } from "vitest";
import { asKey, docSlug, encodePath, fileHref, REPO_KEY } from "../src/repo-paths.ts";

const segment = unicodeString.map((text) => text.replaceAll("/", "-"));

test.prop([fc.array(segment)], { examples: [[[]], [["", "é😀", "%#?'&", "", "字".repeat(1024)]]] })(
  "path encoding round-trips each segment and preserves separators",
  (segments) => {
    const encoded = encodePath(segments.join("/"));
    expect(encoded.split("/").map(decodeURIComponent)).toEqual(segments.length ? segments : [""]);
    expect(encoded).toMatch(/^(?:[a-z\d_!~*'()./-]|%[\dA-F]{2})*$/i);
  },
);

test.prop([fc.array(segment)], {
  examples: [[[]], [["o'neil & co", "café?#%.md", "字".repeat(1024)]]],
})("a file href round-trips its absolute path without attribute delimiters", (segments) => {
  const path = "/" + segments.join("/");
  const href = fileHref(path);
  expect(href).toMatch(/^file:\/\/\//);
  expect(href.slice(7)).toMatch(/^(?:[a-zA-Z0-9_!~*()./:;=+$,@-]|%[\dA-F]{2})*$/);
  expect(decodeURIComponent(href.slice(7))).toBe(path);
});

test.prop([fc.array(segment), fc.constantFrom(".md", ".MD", ".mD")], {
  examples: [
    [[], ".MD"],
    [["docs", "indexish", "é".repeat(1024)], ".md"],
  ],
})("only a final index basename retains its Markdown extension", (folders, extension) => {
  const folder = folders.length ? folders.join("/") + "/" : "";
  expect(docSlug(`${folder}iNdEx${extension}`)).toBe(`doc/${folder}iNdEx${extension}`);
  expect(docSlug(`${folder}guide.index${extension}`)).toBe(`doc/${folder}guide.index`);
  expect(docSlug(`${folder}index.md-backup${extension}`)).toBe(`doc/${folder}index.md-backup`);
  expect(docSlug(`${folder}indexxmd`)).toBe(`doc/${folder}indexxmd`);
  expect(docSlug(`${folder}index.md.txt`)).toBe(`doc/${folder}index.md.txt`);
});

test.prop([unicodeString], {
  examples: [[""], [".𝔸_é\u0301-Ⅳ9"], ["../x:#?% 🧪"], ["字".repeat(1024)]],
})("a folder key preserves each permitted character and replaces others one for one", (folder) => {
  const expected = Array.from(folder, (character) =>
    character === "." ||
    character === "_" ||
    character === "-" ||
    /^[\p{L}\p{M}\p{N}]$/u.test(character)
      ? character
      : "-",
  ).join("");
  expect(asKey(folder)).toBe(expected);
});

test.prop([unicodeString], {
  examples: [[""], ["."], ["..."], [".𝔸_é\u0301-Ⅳ9"], ["x/.."], ["x\ny"], ["字".repeat(1024)]],
})(
  "configured keys are nonempty, contain an allowed non-dot character and require no rewriting",
  (key) => {
    expect(REPO_KEY.test(key)).toBe(key.replaceAll(".", "").length > 0 && asKey(key) === key);
  },
);
