import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { rejection } from "@hackersandwizards/scaffolding/rejection";
import {
  cleanGitEnv,
  git,
  gitAsync,
  gitBytes,
  headSource,
  parseBatchBlobs,
  parseCommitLog,
  parseTreeBlobs,
  treeSource,
} from "../src/git.ts";
import { commit, scratch, sh } from "./admin-fixtures.ts";

describe("cleanGitEnv", () => {
  test("strips every GIT_ environment variable while keeping other keys", () => {
    expect(
      cleanGitEnv({ PATH: "/usr/bin", GIT_DIR: "/repo/.git", GIT_INDEX_FILE: "/tmp/idx" }),
    ).toEqual({ PATH: "/usr/bin" });
  });
});

describe("parseTreeBlobs", () => {
  test.each([
    ["empty output", Buffer.from(""), []],
    [
      "blobs, submodules, and paths with newlines",
      Buffer.from(
        "100644 blob aaa111\tdocs/line\nbreak.md\0" +
          "160000 commit bbb222\tdocs/sub.md\0" +
          "100755 blob ccc333\tscripts/run.sh\0",
      ),
      [
        { path: "docs/line\nbreak.md", oid: "aaa111" },
        { path: "scripts/run.sh", oid: "ccc333" },
      ],
    ],
  ])("parses %s", (_label, input, expected) => {
    expect(parseTreeBlobs(input)).toEqual(expected);
  });
});

describe("parseBatchBlobs", () => {
  test("reads consecutive blobs by byte length including multibyte UTF-8", () => {
    const first = Buffer.from("Café\n");
    const second = Buffer.from("two");
    const batch = Buffer.concat([
      Buffer.from(`aaa blob ${first.length}\n`),
      first,
      Buffer.from("\n"),
      Buffer.from(`bbb blob ${second.length}\n`),
      second,
      Buffer.from("\n"),
    ]);
    const cache = parseBatchBlobs(batch, ["docs/first.md", "docs/second.md"]);
    expect([...cache.entries()]).toEqual([
      ["docs/first.md", "Café\n"],
      ["docs/second.md", "two"],
    ]);
  });

  test("throws when git cat-file reports a missing object header", () => {
    expect(() => parseBatchBlobs(Buffer.from("deadbeef missing\n"), ["a.md"])).toThrow(
      'git cat-file answered "deadbeef missing"',
    );
  });
});

describe("parseCommitLog", () => {
  test.each([
    ["empty log", "", []],
    [
      "multiple commits with tabs in subject",
      "abc1234\t1700000000\tFirst\tsubject\ndef5678\t1700000100\tSecond\n",
      [
        { hash: "abc1234", time: 1700000000, subject: "First\tsubject" },
        { hash: "def5678", time: 1700000100, subject: "Second" },
      ],
    ],
  ])("parses %s", (_label, output, expected) => {
    expect(parseCommitLog(output)).toEqual(expected);
  });
});

describe("git commands and sources", () => {
  test("git helpers return empty output or undefined when a command fails", async () => {
    const dir = scratch();
    expect(git(dir, "rev-parse", "HEAD")).toBe("");
    expect(await gitBytes(dir, ["rev-parse", "HEAD"])).toBeUndefined();
    expect(await gitAsync(dir, ["rev-parse", "HEAD"])).toBe("");
  });

  test("headSource reads only wanted committed files and fails outside git", async () => {
    const plain = scratch();
    expect(await rejection(headSource(plain, () => true))).toContain("git ls-tree HEAD failed");

    const repo = scratch();
    sh(repo, "git", "init", "-q", "-b", "main");
    mkdirSync(join(repo, "docs"));
    writeFileSync(join(repo, "docs/kept.md"), "# Kept\n");
    writeFileSync(join(repo, "docs/skip.txt"), "skip");
    sh(repo, "git", "add", "docs");
    commit(repo, "initial");

    const source = await headSource(repo, (path) => path.endsWith(".md"));
    expect(source.paths).toEqual(["docs/kept.md", "docs/skip.txt"]);
    expect(source.read("docs/kept.md")).toBe("# Kept\n");
    expect(source.read("docs/skip.txt")).toBeUndefined();
  });

  test("treeSource walks a non-git folder while skipping .git and node_modules", () => {
    const dir = scratch();
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "node_modules"));
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, ".git/HEAD"), "ref");
    writeFileSync(join(dir, "node_modules/a.js"), "x");
    writeFileSync(join(dir, "docs/note.md"), "# Note");

    const source = treeSource(dir);
    expect(source.paths).toEqual(["docs/note.md"]);
    expect(source.read("docs/note.md")).toBe("# Note");
    expect(source.read("docs/absent.md")).toBeUndefined();
  });
});
