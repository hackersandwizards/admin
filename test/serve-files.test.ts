import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assert, describe, expect, test, vi } from "vitest";
import {
  fileEtag,
  lfsPointerOid,
  readCommittedFile,
  readInstalledFile,
  readRepoFile,
  resizeThumbnail,
} from "../src/serve-files.ts";
import { commit, scratch, sh } from "./admin-fixtures.ts";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

describe("lfsPointerOid", () => {
  const oid = "ab".repeat(32);

  test.each([
    [
      "valid LFS pointer",
      Buffer.from(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 10\n`),
      oid,
    ],
    ["ordinary file text", Buffer.from("hello world\n"), undefined],
    [
      "pointer with short sha256",
      Buffer.from("version https://git-lfs.github.com/spec/v1\noid sha256:abcd\n"),
      undefined,
    ],
    [
      "pointer oid past first 200 bytes",
      Buffer.from(
        `version https://git-lfs.github.com/spec/${"a".repeat(160)}\noid sha256:${oid}\n`,
      ),
      undefined,
    ],
  ])("extracts oid for %s", (_label, blob, expected) => {
    expect(lfsPointerOid(blob)).toBe(expected);
  });
});

describe("readInstalledFile", () => {
  test("reads a regular file inside node_modules and rejects directories, missing files, and escaping symlinks", () => {
    const repo = scratch();
    const outside = scratch();
    mkdirSync(join(repo, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(repo, "node_modules/pkg/tokens.css"), ":root{}");
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(join(outside, "secret.txt"), join(repo, "node_modules/pkg/escape.txt"));

    expect(readInstalledFile(repo, "node_modules/pkg/tokens.css")?.toString("utf8")).toBe(
      ":root{}",
    );
    expect(readInstalledFile(repo, "node_modules/pkg")).toBeUndefined();
    expect(readInstalledFile(repo, "node_modules/pkg/missing.css")).toBeUndefined();
    expect(readInstalledFile(repo, "node_modules/pkg/escape.txt")).toBeUndefined();
  });
});

describe("readCommittedFile and readRepoFile", () => {
  test("reads committed blobs and resolves LFS objects, returning undefined when absent or escaping", async () => {
    const repo = scratch();
    sh(repo, "git", "init", "-q", "-b", "main");
    const presentOid = "12".repeat(32);
    const missingOid = "34".repeat(32);
    mkdirSync(join(repo, ".git/lfs/objects/12/12"), { recursive: true });
    writeFileSync(join(repo, ".git/lfs/objects/12/12", presentOid), "lfs-bytes");
    writeFileSync(join(repo, "plain.txt"), "committed");
    writeFileSync(
      join(repo, "present.lfs"),
      `version https://git-lfs.github.com/spec/v1\noid sha256:${presentOid}\nsize 9\n`,
    );
    writeFileSync(
      join(repo, "missing.lfs"),
      `version https://git-lfs.github.com/spec/v1\noid sha256:${missingOid}\nsize 9\n`,
    );
    sh(repo, "git", "add", "-A");
    commit(repo, "files");

    expect((await readCommittedFile(repo, "plain.txt"))?.toString("utf8")).toBe("committed");
    expect((await readCommittedFile(repo, "present.lfs"))?.toString("utf8")).toBe("lfs-bytes");
    expect(await readCommittedFile(repo, "missing.lfs")).toBeUndefined();
    expect(await readRepoFile(undefined, "plain.txt")).toBeUndefined();
    expect(await readRepoFile(repo, "node_modules/../plain.txt")).toBeUndefined();
  });
});

describe("resizeThumbnail", () => {
  test("resizes an oversized PNG into WebP inside the box", async () => {
    const large = Buffer.from(await new Bun.Image(ONE_PIXEL_PNG).resize(1200, 600).png().bytes());
    const resized = await resizeThumbnail(large, [480, 360]);
    assert(resized, "resized thumbnail buffer");
    const meta = await new Bun.Image(resized).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(480);
    expect(resized.length).toBeLessThan(large.length);
  });

  test("returns undefined for already fitting, animated, and unknown-format inputs without logging", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const large = Buffer.from(
        await new Bun.Image(ONE_PIXEL_PNG).resize(1000, 1000).png().bytes(),
      );
      const apng = Buffer.concat([large, Buffer.from("acTL")]);
      const animatedWebp = Buffer.concat([large, Buffer.from("ANIM")]);
      expect(await resizeThumbnail(ONE_PIXEL_PNG, [480, 360])).toBeUndefined();
      expect(await resizeThumbnail(apng, [480, 360])).toBeUndefined();
      expect(await resizeThumbnail(animatedWebp, [480, 360])).toBeUndefined();
      expect(await resizeThumbnail(Buffer.from("not an image"), [480, 360])).toBeUndefined();
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("fileEtag", () => {
  test.each([
    {
      label: "without box",
      body: Buffer.from("sample bytes"),
      box: undefined,
      expected: '"1fbmfdrc7cn9z"',
    },
    {
      label: "with box width",
      body: Buffer.from("sample bytes"),
      box: [480, 360] as const,
      expected: '"1fbmfdrc7cn9z-480"',
    },
  ])("formats etag $label", ({ body, box, expected }) => {
    expect(fileEtag(body, box)).toBe(expected);
  });
});
