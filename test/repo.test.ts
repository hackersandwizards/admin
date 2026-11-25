import { describe, expect, test } from "vitest";
import type { Item } from "../src/items.ts";
import {
  agentDescription,
  attachItemChanges,
  firstComment,
  parseWorkLog,
  readAgentNames,
  readDocs,
  readRepo,
  readReports,
  readReviews,
  readScriptFiles,
} from "../src/repo.ts";

describe("readRepo defect order", () => {
  test("reports defects across items, config, package fields, and hrefs in order", async () => {
    const files: Record<string, string> = {
      "docs/agent-work/items/broken.md": "No frontmatter\n",
      "docs/agent-work/admin.json": JSON.stringify({ label: "Ignored" }),
      "package.json": JSON.stringify({
        admin: {
          name: "../bad",
          label: 42,
          designSystem: "javascript:alert(1)",
          products: [{ label: "Catalog", href: "data:text/html,x" }],
          links: [{ label: "Guide", href: "vbscript:x" }],
        },
        scripts: { ok: "echo ok", bad: 1 },
        dependencies: { bad: false },
        devDependencies: "nope",
        bin: ["wrong"],
      }),
    };

    const repo = await readRepo("/nonexistent/sample-repo", {
      paths: Object.keys(files),
      read: (path) => files[path],
    });

    expect(repo.defects).toEqual([
      "docs/agent-work/items/broken.md: no frontmatter between --- lines",
      "docs/agent-work/admin.json: ignored, package.json holds admin",
      'package.json: admin.name "../bad" is not letters, digits, ".", "_" and "-": its pages are under sample-repo',
      "package.json: admin.label is not text",
      "package.json: scripts holds a value that is not text",
      "package.json: dependencies holds a value that is not text",
      "package.json: devDependencies holds a value that is not text",
      "package.json: admin.designSystem: scheme not allowed, not linked",
      "package.json: bin holds a value that is not text",
      'package.json: admin.products "Catalog": scheme not allowed, not linked',
      'package.json: admin.links "Guide": scheme not allowed, not linked',
    ]);
  });
});

describe("agentDescription", () => {
  test.each([
    [
      "string description in frontmatter",
      "---\ndescription: Ada, who checks builds\n---\n",
      "Ada, who checks builds",
    ],
    ["non-string description", "---\ndescription: 42\n---\n", ""],
    ["invalid YAML frontmatter", "---\n[broken\n---\n", ""],
    ["missing frontmatter", "# Agent", ""],
  ])("reads %s", (_label, text, expected) => {
    expect(agentDescription(text)).toBe(expected);
  });
});

describe("firstComment", () => {
  test.each([
    ["line slash comment", "// Checks files  \nconst a = 1;", "Checks files"],
    ["hash comment after shebang", "#!/usr/bin/env bash\n# Syncs assets\n", "Syncs assets"],
    ["block comment with closing marker", "/* Runs checks */\n", "Runs checks"],
    ["multiline block comment star line", "/*\n * Builds output\n */\n", "Builds output"],
    ["comment past line 12 ignored", "\n".repeat(12) + "// Too late\n", ""],
  ])("extracts %s", (_label, text, expected) => {
    expect(firstComment(text)).toBe(expected);
  });
});

describe("parseWorkLog", () => {
  test("records the newest timestamp per path from git log -z output", () => {
    const workLog =
      "@200\0\ndocs/agent-work/items/a.md\0docs/agent-work/2026-01-15-r.md\0" +
      "\n@100\0\ndocs/agent-work/items/a.md\0docs/agent-work/items/b.md\0";
    expect([...parseWorkLog(workLog).entries()]).toEqual([
      ["docs/agent-work/items/a.md", 200],
      ["docs/agent-work/2026-01-15-r.md", 200],
      ["docs/agent-work/items/b.md", 100],
    ]);
  });
});

describe("attachItemChanges", () => {
  test("attaches change time and content hash version to each item", () => {
    const item: Item = {
      id: "goal",
      kind: "goal",
      status: "open",
      title: "Goal",
      body: "",
    };
    const text = "---\nkind: goal\nstatus: open\n---\n# Goal\n";
    const files: Record<string, string> = { "docs/agent-work/items/goal.md": text };
    const src = {
      paths: Object.keys(files),
      read: (p: string) => files[p],
    };
    const changed = new Map([["docs/agent-work/items/goal.md", 1700000000]]);
    expect(attachItemChanges([item], src, changed)).toEqual([
      { ...item, changed: 1700000000, version: Bun.hash(text).toString(36) },
    ]);
  });
});

describe("readReports", () => {
  test("parses dated reports, falls back to stem without h1, and sorts newest first", () => {
    const files: Record<string, string> = {
      "docs/agent-work/2026-01-14-b.md": "# Second\n\nText\n",
      "docs/agent-work/2026-01-15-a.md": "Plain body\n",
      "docs/agent-work/2026-01-14-a.md": "# First\n",
      "docs/agent-work/items/2026-01-16-item.md": "# Not a report\n",
    };
    const changed = new Map([["docs/agent-work/2026-01-15-a.md", 500]]);
    const reports = readReports(
      "/r",
      { paths: Object.keys(files), read: (p) => files[p] },
      changed,
    );
    expect(
      reports.map((r) => ({ path: r.path, title: r.title, date: r.date, changed: r.changed })),
    ).toEqual([
      {
        path: "docs/agent-work/2026-01-15-a.md",
        title: "2026-01-15-a",
        date: "2026-01-15",
        changed: 500,
      },
      {
        path: "docs/agent-work/2026-01-14-a.md",
        title: "First",
        date: "2026-01-14",
        changed: undefined,
      },
      {
        path: "docs/agent-work/2026-01-14-b.md",
        title: "Second",
        date: "2026-01-14",
        changed: undefined,
      },
    ]);
  });
});

describe("readReviews", () => {
  test("groups dated review folders with sorted images and matching reports", () => {
    const paths = [
      "docs/agent-work/2026-01-14-old/b.png",
      "docs/agent-work/2026-01-14-old/a.webp",
      "docs/agent-work/2026-01-14-old/notes.txt",
      "docs/agent-work/2026-01-15-new/shot.JPG",
      "docs/agent-work/items/pick/shot.png",
    ];
    const reported = new Set(["docs/agent-work/2026-01-14-old.md"]);
    expect(readReviews(paths, reported)).toEqual([
      { dir: "docs/agent-work/2026-01-15-new", images: ["shot.JPG"], report: undefined },
      {
        dir: "docs/agent-work/2026-01-14-old",
        images: ["a.webp", "b.png"],
        report: "docs/agent-work/2026-01-14-old.md",
      },
    ]);
  });
});

describe("readDocs", () => {
  test("reads root and docs markdown excluding reports and items, sorted by path", () => {
    const files: Record<string, string> = {
      "README.md": "# Readme\n\nHi\n",
      "docs/guide.md": "No heading\n",
      "docs/agent-work/2026-01-15-report.md": "# Report\n",
      "docs/agent-work/items/goal.md": "# Goal\n",
      "src/notes.md": "# Ignored nested doc\n",
    };
    const reported = new Set(["docs/agent-work/2026-01-15-report.md"]);
    const docs = readDocs("/r", { paths: Object.keys(files), read: (p) => files[p] }, reported);
    expect(docs).toEqual([
      { path: "docs/guide.md", title: "docs/guide.md", html: "<p>No heading</p>\n" },
      { path: "README.md", title: "Readme", titleId: "readme", html: "<p>Hi</p>\n" },
    ]);
  });
});

describe("readScriptFiles", () => {
  test("reads scripts and bin files with their leading comment", () => {
    const files: Record<string, string> = {
      "scripts/build.ts": "// Builds site\n",
      "bin/run.sh": "#!/bin/sh\n# Runs check\n",
      "scripts/readme.md": "# Not a script\n",
    };
    expect(readScriptFiles({ paths: Object.keys(files), read: (p) => files[p] })).toEqual([
      { path: "scripts/build.ts", comment: "Builds site" },
      { path: "bin/run.sh", comment: "Runs check" },
    ]);
  });
});

describe("readAgentNames", () => {
  test("extracts colleague names preceding ', who' from agent definitions", () => {
    const files: Record<string, string> = {
      ".claude/agents/ada.md": "---\ndescription: Ada-Lee, who checks builds\n---\n",
      ".claude/agents/helper.md": "---\ndescription: runs helper commands\n---\n",
      ".claude/agents/sub/nested.md": "---\ndescription: Sam, who is nested\n---\n",
    };
    expect(readAgentNames({ paths: Object.keys(files), read: (p) => files[p] })).toEqual([
      "Ada-Lee",
    ]);
  });
});
