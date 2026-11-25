import { describe, expect, test } from "vitest";
import type { Report } from "../src/repo.ts";
import {
  reportBody,
  reportCommentDisclosure,
  reportContents,
  reportKey,
  reportStatusLine,
} from "../site/src/report.ts";

const makeReport = (overrides: Partial<Report> = {}): Report => ({
  path: "docs/agent-work/2026-01-15-notes.md",
  stem: "2026-01-15-notes",
  title: "Notes",
  version: "abc123",
  html: '<h2 id="intro">Intro</h2><p>Body</p>',
  ...overrides,
});

describe("reportKey", () => {
  test("prefixes repo and stem with #", () => {
    expect(reportKey("spoke", makeReport())).toBe("#spoke:2026-01-15-notes");
  });
});

describe("reportCommentDisclosure", () => {
  test("escapes section key and label and links label to textarea id", () => {
    const html = reportCommentDisclosure("spoke:2026-01-15-notes#a&b", 'Q&A "1"');
    expect(html).toContain('data-comment data-k="spoke:2026-01-15-notes#a&amp;b"');
    expect(html).toContain(
      '<label for="comment-spoke:2026-01-15-notes#a&amp;b">Comment on Q&amp;A &quot;1&quot;</label>',
    );
    expect(html).toContain('<textarea id="comment-spoke:2026-01-15-notes#a&amp;b"');
  });
});

describe("reportContents", () => {
  const five = [
    { id: "s1", label: "One" },
    { id: "s2", label: "Two" },
    { id: "s3", label: "Three" },
    { id: "s4", label: "Four" },
    { id: "s5", label: "Five" },
  ];

  test.each([
    ["returns empty string for five headings", five, ""],
    [
      "renders encoded hrefs and escaped labels in order for six headings",
      [...five, { id: "a&b", label: "Six & Seven" }],
      '<nav class="not-prose" aria-label="Contents"><p class="hw-label">Contents</p><ul class="hw-marker-list">' +
        '<li><a class="hw-link" href="#s1">One</a></li>' +
        '<li><a class="hw-link" href="#s2">Two</a></li>' +
        '<li><a class="hw-link" href="#s3">Three</a></li>' +
        '<li><a class="hw-link" href="#s4">Four</a></li>' +
        '<li><a class="hw-link" href="#s5">Five</a></li>' +
        '<li><a class="hw-link" href="#a%26b">Six &amp; Seven</a></li></ul></nav>',
    ],
  ])("%s", (_label, headings, expected) => {
    expect(reportContents(headings)).toBe(expected);
  });
});

describe("reportStatusLine", () => {
  test("renders no-commit copy without data-changed when changed is absent", () => {
    expect(reportStatusLine("#spoke:2026-01-15-notes&1", { version: "v1" })).toBe(
      '<p class="text-ui text-foreground/70" data-report data-k="#spoke:2026-01-15-notes&amp;1" data-version="v1"><span class="text-accent" data-updated hidden>updated</span> No commit recorded</p>',
    );
  });

  test("renders data-changed and Last changed when changed is present", () => {
    const html = reportStatusLine("#spoke:2026-01-15-notes", {
      version: "v2",
      changed: 1_700_000_000,
    });
    expect(html).toContain('data-changed="1700000000"');
    expect(html).toContain("Last changed ");
  });
});

describe("reportBody", () => {
  test("places status line before Contents and body, keeping h3 out of Contents", () => {
    const sixH2 = [1, 2, 3, 4, 5, 6].map((n) => `<h2 id="s${n}">S${n}</h2>`).join("");
    const html = reportBody("spoke", makeReport({ html: `${sixH2}<h3 id="sub">Sub &amp; A</h3>` }));
    expect(html.indexOf("data-report")).toBeLessThan(html.indexOf('aria-label="Contents"'));
    expect(html.indexOf('aria-label="Contents"')).toBeLessThan(html.indexOf('<h2 id="s1">'));
    expect(html).not.toContain('href="#sub"');
    expect(html).toContain('data-comment data-k="spoke:2026-01-15-notes#sub"');
    expect(html).toContain("Comment on Sub &amp; A");
  });

  test("falls back to decoded heading id when heading text is whitespace", () => {
    const html = reportBody("spoke", makeReport({ html: '<h2 id="a&amp;b">   </h2>' }));
    expect(html).toContain('data-k="spoke:2026-01-15-notes#a&amp;b"');
    expect(html).toContain("Comment on a&amp;b");
  });

  test("omits comment disclosures on non-plain report stems", () => {
    const html = reportBody("spoke", makeReport({ stem: "draft", html: '<h2 id="x">X</h2>' }));
    expect(html).not.toContain("data-comment");
  });
});
