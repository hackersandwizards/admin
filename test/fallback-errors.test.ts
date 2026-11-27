import { rejection } from "@hackersandwizards/scaffolding/rejection";
import { chmod, readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { decodeHash } from "../site/src/filter-rules.ts";
import { parseJson, parseRecord } from "../site/src/storage.ts";
import { findRepos } from "../src/hub.ts";
import { decodeLinkPath, stripFrontmatter } from "../src/markdown.ts";
import { parseAdminFile, parsePackageJson } from "../src/repo-config.ts";
import { agentDescription } from "../src/repo.ts";
import { parseRequest } from "../src/serve-http.ts";

vi.mock(import("node:fs/promises"), { spy: true });

test.each([
  ["parseJson", parseJson],
  ["parseRecord", parseRecord],
  ["parsePackageJson", parsePackageJson],
  ["parseAdminFile", parseAdminFile],
] as const)("%s propagates an unexpected JSON parser error", (_name, parse) => {
  const failure = new TypeError("JSON parser failed");
  const parser = vi.spyOn(JSON, "parse").mockImplementation(() => {
    throw failure;
  });
  try {
    expect(() => parse("{}")).toThrow(failure);
  } finally {
    parser.mockRestore();
  }
});

test.each([
  ["stripFrontmatter", stripFrontmatter],
  ["agentDescription", agentDescription],
] as const)("%s propagates an unexpected YAML parser error", (_name, parse) => {
  const failure = new TypeError("YAML parser failed");
  const parser = vi.spyOn(Bun.YAML, "parse").mockImplementation(() => {
    throw failure;
  });
  try {
    expect(() => parse("---\ndescription: A helper\n---\n")).toThrow(failure);
  } finally {
    parser.mockRestore();
  }
});

test.each([
  ["decodeLinkPath", () => decodeLinkPath("a%20b.md")],
  ["decodeHash", () => decodeHash("#a%20b")],
  ["parseRequest", () => parseRequest(new Request("http://localhost/a%20b"))],
] as const)("%s propagates an unexpected URI decoder error", (_name, decode) => {
  const failure = new TypeError("URI decoder failed");
  const decoder = vi.spyOn(globalThis, "decodeURIComponent").mockImplementation(() => {
    throw failure;
  });
  try {
    expect(decode).toThrow(failure);
  } finally {
    decoder.mockRestore();
  }
});

test("findRepos propagates an unexpected directory read error", async () => {
  const failure = Object.assign(new Error("directory read denied"), { code: "EACCES" });
  const read = vi.mocked(readdir).mockRejectedValue(failure);
  try {
    expect(await rejection(findRepos(import.meta.dirname))).toBe("Error: directory read denied");
  } finally {
    read.mockRestore();
  }
});

test("findRepos skips an unreadable subfolder", async () => {
  const root = join(import.meta.dirname, "fixtures");
  const failure = Object.assign(new Error("directory read denied"), { code: "EACCES" });
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const read = vi.mocked(readdir).mockImplementationOnce(actual.readdir).mockRejectedValue(failure);
  try {
    expect(await findRepos(root)).toEqual([]);
    expect(read).toHaveBeenCalledWith(join(root, "spoke"), { withFileTypes: true });
    expect(chmod).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
});
