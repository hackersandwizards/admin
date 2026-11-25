import { describe, expect, test } from "vitest";
import { withLinks } from "../site/src/data.ts";

describe("withLinks", () => {
  test.each([
    [
      "leaves URLs inside pre blocks as text",
      "<pre>fetch https://pre.example/feed</pre>",
      "<pre>fetch https://pre.example/feed</pre>",
    ],
    [
      "leaves URLs inside svg blocks as text",
      "<svg><text>https://svg.example/diagram</text></svg>",
      "<svg><text>https://svg.example/diagram</text></svg>",
    ],
    [
      "does not let a mismatched closing tag swallow a URL after an unclosed anchor",
      "<a>https://mismatch.example/a</code>",
      '<a><a class="hw-link" href="https://mismatch.example/a">https://mismatch.example/a</a></code>',
    ],
    [
      "does not let an unclosed code tag suppress linking",
      "<code>https://unclosed.example/c",
      '<code><a class="hw-link" href="https://unclosed.example/c">https://unclosed.example/c</a>',
    ],
    [
      "keeps a pre block intact even when a stray closing anchor appears inside it",
      "<pre>https://inside.example/p</a></pre>",
      "<pre>https://inside.example/p</a></pre>",
    ],
    [
      "turns an escaped angle-bracketed URL into a link without the brackets",
      "<p>&lt;https://angle.example/p?q=1&gt;</p>",
      '<p><a class="hw-link" href="https://angle.example/p?q=1">https://angle.example/p?q=1</a></p>',
    ],
    [
      "trims trailing punctuation and closing parenthesis from bare URLs",
      "<p>see https://bare.example/doc, and (https://paren.example/a)!</p>",
      '<p>see <a class="hw-link" href="https://bare.example/doc">https://bare.example/doc</a>, and (<a class="hw-link" href="https://paren.example/a">https://paren.example/a</a>)!</p>',
    ],
    [
      "stops a URL before an escaped quote entity inside angle brackets",
      "<p>&lt;https://stop.example/a&quot;&gt;</p>",
      '<p>&lt;<a class="hw-link" href="https://stop.example/a">https://stop.example/a</a>&quot;&gt;</p>',
    ],
  ])("%s", (_label, input, expected) => {
    expect(withLinks(input)).toBe(expected);
  });
});
