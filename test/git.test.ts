import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { rejection } from "@hackersandwizards/scaffolding/rejection";
import {
  cleanGitEnv,
  git,
  gitAsync,
  gitBytes,
  gitEnv,
  headSource,
  parseBatchBlobs,
  parseCommitLog,
  parseTreeBlobs,
  readCommits,
  readGitMetadata,
} from "../src/git.ts";
import { wantsRepoFile } from "../src/repo.ts";
import { commit, scratch, sh } from "./admin-fixtures.ts";

describe("cleanGitEnv", () => {
  test("strips every GIT_ environment variable while keeping other keys", () => {
    expect(
      cleanGitEnv({ PATH: "/usr/bin", GIT_DIR: "/repo/.git", GIT_INDEX_FILE: "/tmp/idx" }),
    ).toEqual({ PATH: "/usr/bin" });
  });
});

describe("parseTreeBlobs", () => {
  test("parses blobs and paths with newlines while skipping submodules", () => {
    const input = Buffer.from(
      "100644 blob aaa111\tdocs/line\nbreak.md\0" +
        "160000 commit bbb222\tdocs/sub.md\0" +
        "100755 blob ccc333\tscripts/run.sh\0",
    );
    expect(parseTreeBlobs(input)).toEqual([
      { path: "docs/line\nbreak.md", oid: "aaa111" },
      { path: "scripts/run.sh", oid: "ccc333" },
    ]);
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

  test("headSource reads only repository files selected by wantsRepoFile and fails outside git", async () => {
    const plain = scratch();
    expect(await rejection(headSource(plain, wantsRepoFile))).toContain("git ls-tree HEAD failed");

    const repo = scratch();
    sh(repo, "git", "init", "-q", "-b", "main");
    mkdirSync(join(repo, "docs"));
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "docs/kept.md"), "# Kept\n");
    writeFileSync(join(repo, "src/skip.ts"), "export const x = 1;\n");
    sh(repo, "git", "add", "docs", "src");
    commit(repo, "initial");

    const source = await headSource(repo, wantsRepoFile);
    expect(source.paths).toEqual(["docs/kept.md", "src/skip.ts"]);
    expect(source.read("docs/kept.md")).toBe("# Kept\n");
    expect(source.read("src/skip.ts")).toBeUndefined();
  });

  test("readCommits returns formatted commits with timestamps and respects pathspec args", async () => {
    const repo = scratch();
    sh(repo, "git", "init", "-q", "-b", "main");
    mkdirSync(join(repo, "docs"));
    const commitAt = (iso: string, file: string, message: string) => {
      writeFileSync(join(repo, file), `# ${file}\n`);
      sh(repo, "git", "add", file);
      const r = Bun.spawnSync(
        [
          "git",
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@example.invalid",
          "commit",
          "-qm",
          message,
        ],
        { cwd: repo, env: { ...gitEnv, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso } },
      );
      expect(r.exitCode).toBe(0);
    };
    commitAt("2026-01-14T10:00:00Z", "docs/a.md", "First\tnote");
    commitAt("2026-01-14T11:00:00Z", "README.md", "Second");
    const secondHash = git(repo, "rev-parse", "--short", "HEAD").trim();
    const firstHash = git(repo, "rev-parse", "--short", "HEAD~1").trim();

    expect(await readCommits(repo, ["-n", "2"])).toEqual([
      { hash: secondHash, time: 1768388400, subject: "Second" },
      { hash: firstHash, time: 1768384800, subject: "First\tnote" },
    ]);
    expect(await readCommits(repo, ["-n", "2", "--", "docs"])).toEqual([
      { hash: firstHash, time: 1768384800, subject: "First\tnote" },
    ]);
  });

  test("readGitMetadata reads trimmed head, tracking log, full log, and work log for a repo", async () => {
    const repo = scratch();
    sh(repo, "git", "init", "-q", "-b", "main");
    mkdirSync(join(repo, "docs/agent-work"), { recursive: true });
    writeFileSync(join(repo, "docs/agent-work/note.md"), "# Note\n");
    sh(repo, "git", "add", "docs");
    const r = Bun.spawnSync(
      ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "Track"],
      {
        cwd: repo,
        env: {
          ...gitEnv,
          GIT_AUTHOR_DATE: "2026-01-14T10:00:00Z",
          GIT_COMMITTER_DATE: "2026-01-14T10:00:00Z",
        },
      },
    );
    expect(r.exitCode).toBe(0);
    const head = git(repo, "rev-parse", "--short", "HEAD").trim();

    const meta = await readGitMetadata(repo, "docs/agent-work");
    expect(meta).toEqual({
      workLog: "@1768384800\0\ndocs/agent-work/note.md\0",
      head,
      behind: undefined,
      trackingLog: [{ hash: head, time: 1768384800, subject: "Track" }],
      log: [{ hash: head, time: 1768384800, subject: "Track" }],
      fetched: undefined,
    });
  });
});
