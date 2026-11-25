import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, test, vi } from "vitest";
import elements from "../../brand-elements.json";
import { createHub } from "../../src/serve.ts";
import { commit, repoFrom, scratch, sh } from "../admin-fixtures.ts";

const TIMEOUT = (60_000 * (Number(process.env.SCAFFOLDING_TEST_TIMEOUT_MS) || 5000)) / 5000;

function stubBuildSpawn(script: string) {
  const spawn = Bun.spawn;
  let count = 0;
  const spy = vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[], opts: object) => {
    if (!cmd[1]?.endsWith("serve.ts")) return spawn(cmd, opts as never);
    count++;
    return spawn([process.execPath, "-e", script], { stderr: "pipe" });
  }) as typeof Bun.spawn);
  return {
    calls: () => count,
    restore: () => spy.mockRestore(),
  };
}

function countBuildSpawns() {
  const spawn = Bun.spawn;
  let count = 0;
  const spy = vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[], opts: object) => {
    if (cmd[1]?.endsWith("serve.ts")) count++;
    return spawn(cmd, opts as never);
  }) as typeof Bun.spawn);
  return {
    calls: () => count,
    restore: () => spy.mockRestore(),
  };
}

function breakGoalObject(repo: string) {
  const blob = sh(repo, "git", "rev-parse", "HEAD:docs/agent-work/items/goal.md").trim();
  const object = join(repo, ".git/objects", blob.slice(0, 2), blob.slice(2));
  const bytes = readFileSync(object);
  rmSync(object);
  return { object, bytes };
}

describe("serve hub pinning on one site", () => {
  let hub: ReturnType<typeof createHub>;
  let coldFile: Response;
  let largeText = "";
  let animatedPng = Buffer.alloc(0);

  beforeAll(async () => {
    const repo = repoFrom("spoke");
    largeText = "line of committed text\n".repeat(100);
    writeFileSync(join(repo, "docs/plain-headingless.md"), "Paragraph without a heading.\n");
    writeFileSync(join(repo, "docs/large-note.txt"), largeText);
    writeFileSync(
      join(repo, "docs/agent-work/missing-lfs.svg"),
      `version https://git-lfs.github.com/spec/v1\noid sha256:${"cd".repeat(32)}\nsize 12\n`,
    );
    const pixel = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    const big = Buffer.from(await new Bun.Image(pixel).resize(1000, 1000).png().bytes());
    animatedPng = Buffer.concat([big, Buffer.from("acTL")]);
    writeFileSync(join(repo, "docs/agent-work/anim.png"), animatedPng);
    sh(repo, "git", "add", "-A");
    commit(repo, "pin fixtures");
    mkdirSync(join(repo, "node_modules/pkg"), { recursive: true });

    hub = createHub({ root: dirname(repo) });
    coldFile = await hub.fetch(
      new Request("http://admin.localhost/_file/spoke/docs/large-note.txt", {
        headers: { "accept-encoding": "gzip" },
      }),
    );
  }, TIMEOUT);

  test("cold-start /_file/ builds the site and serves uncompressed bytes with no-cache and vary", async () => {
    expect(coldFile.status).toBe(200);
    expect(await coldFile.text()).toBe(largeText);
    expect(coldFile.headers.get("cache-control")).toBe("no-cache");
    expect(coldFile.headers.get("vary")).toBe("accept-encoding");
    expect(coldFile.headers.get("content-encoding")).toBeNull();
  });

  test("rejects malformed percent-encoding with 400", async () => {
    const response = await hub.fetch(new Request("http://admin.localhost/%E0%A4%A"));
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("malformed path");
  });

  test.each([
    ["unknown repository", "/_file/unknown/README.md"],
    ["missing node_modules file", "/_file/spoke/node_modules/absent.css"],
    ["directory under node_modules", "/_file/spoke/node_modules/pkg"],
    ["missing committed blob", "/_file/spoke/no-such-file.txt"],
    ["LFS pointer with missing local object", "/_file/spoke/docs/agent-work/missing-lfs.svg"],
  ])("returns 404 not committed for %s", async (_label, path) => {
    const response = await hub.fetch(new Request(`http://admin.localhost${path}`));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("not committed");
  });

  test("falls through to the hub 404 page for an absent /_astro/ asset", async () => {
    const response = await hub.fetch(new Request("http://admin.localhost/_astro/absent.js"));
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Nothing on the hub answers at /_astro/absent.js:");
  });

  test("returns an animated PNG unmodified instead of resizing to WebP", async () => {
    const response = await hub.fetch(
      new Request("http://admin.localhost/_file/spoke/docs/agent-work/anim.png?w=480"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.bytes())).toEqual(animatedPng);
  });

  test("preserves query string on /catalog redirect", async () => {
    const response = await hub.fetch(new Request("http://admin.localhost/catalog?view=1"));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://admin.localhost/catalog/?view=1");
  });

  test(
    "serves /catalog/ with brand-elements CSP",
    async () => {
      const response = await hub.fetch(new Request("http://admin.localhost/catalog/"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toBe(elements.csp);
    },
    TIMEOUT,
  );

  test("fills a headingless doc shell without an anchor id", async () => {
    const response = await hub.fetch(
      new Request("http://admin.localhost/spoke/doc/docs/plain-headingless"),
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("Paragraph without a heading.");
    expect(html).not.toContain("admin-shell-anchor");
    expect(html).not.toContain(' id=""');
  });
});

describe("serve hub failure, concurrency, and rescan pinning", () => {
  test(
    "returns 503 with exit code fallback and caches initial build failure",
    async () => {
      const repo = repoFrom("spoke");
      const stub = stubBuildSpawn("console.error('plain failure'); process.exit(2)");
      try {
        const hub = createHub({ root: dirname(repo) });
        const first = await hub.fetch(new Request("http://admin.localhost/"));
        const second = await hub.fetch(new Request("http://admin.localhost/"));
        expect(first.status).toBe(503);
        expect(await first.text()).toContain("build failed: exit 2");
        expect(second.status).toBe(503);
        expect(stub.calls()).toBe(1);
      } finally {
        stub.restore();
      }
    },
    TIMEOUT,
  );

  test(
    "returns 404 for /_file/ when the initial build fails",
    async () => {
      const repo = repoFrom("spoke");
      const stub = stubBuildSpawn("console.error('TypeError: boom'); process.exit(1)");
      try {
        const hub = createHub({ root: dirname(repo) });
        const response = await hub.fetch(
          new Request("http://admin.localhost/_file/spoke/docs/agent-work/items/goal.md"),
        );
        expect(response.status).toBe(404);
        expect(await response.text()).toBe("not committed");
        expect(stub.calls()).toBe(1);
      } finally {
        stub.restore();
      }
    },
    TIMEOUT,
  );

  test(
    "returns 503 and caches a failed catalog build",
    async () => {
      const repo = repoFrom("spoke");
      const stub = stubBuildSpawn("console.error('TypeError: no catalog'); process.exit(1)");
      try {
        const hub = createHub({ root: dirname(repo) });
        const first = await hub.fetch(new Request("http://admin.localhost/catalog/"));
        const second = await hub.fetch(new Request("http://admin.localhost/catalog/"));
        expect(first.status).toBe(503);
        expect(await first.text()).toContain("catalog build failed: TypeError: no catalog");
        expect(second.status).toBe(503);
        expect(stub.calls()).toBe(1);
      } finally {
        stub.restore();
      }
    },
    TIMEOUT,
  );

  test(
    "two concurrent page fetch requests during one build cause one build",
    async () => {
      const repo = repoFrom("spoke");
      const counter = countBuildSpawns();
      try {
        const hub = createHub({ root: dirname(repo) });
        const [home, dashboard] = await Promise.all([
          hub.fetch(new Request("http://admin.localhost/")),
          hub.fetch(new Request("http://admin.localhost/spoke/dashboard")),
        ]);
        expect([home.status, dashboard.status]).toEqual([200, 200]);
        expect(counter.calls()).toBe(1);
      } finally {
        counter.restore();
      }
    },
    TIMEOUT,
  );

  test(
    "a page request arriving while a build is in flight shares that build",
    async () => {
      const repo = repoFrom("spoke");
      const counter = countBuildSpawns();
      try {
        const hub = createHub({ root: dirname(repo) });
        const building = hub.pages();
        const page = hub.fetch(new Request("http://admin.localhost/"));
        const [built, response] = await Promise.all([building, page]);
        expect(built.repos).toHaveLength(1);
        expect(response.status).toBe(200);
        expect(counter.calls()).toBe(1);
      } finally {
        counter.restore();
      }
    },
    TIMEOUT,
  );

  test(
    "keeps last pages on failure, skips retry inside window, and retries without rebuilding at window edge",
    async () => {
      const base = new Date(2026, 4, 10, 12, 0, 0).getTime();
      const clock = vi.spyOn(Date, "now").mockReturnValue(base);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const repo = repoFrom("spoke");
        const second = join(dirname(repo), "second");
        cpSync(repo, second, { recursive: true });
        const hub = createHub({ root: dirname(repo) });
        await hub.pages();
        breakGoalObject(second);
        sh(second, "git", "tag", "v-broken");
        const afterFail = await hub.pages();
        const dashboard = await hub.fetch(new Request("http://admin.localhost/second/dashboard"));
        const body = await dashboard.text();
        expect(dashboard.status).toBe(200);
        expect(body).toContain("Its pages show its last read.");

        clock.mockReturnValue(base + 59_999);
        await hub.pages();
        expect(errSpy).toHaveBeenCalledTimes(1);

        clock.mockReturnValue(base + 60_000);
        expect(await hub.pages()).toBe(afterFail);
        expect(errSpy).toHaveBeenCalledTimes(2);
      } finally {
        clock.mockRestore();
        errSpy.mockRestore();
      }
    },
    TIMEOUT,
  );

  test(
    "counts multiple unread repositories and drops a vanished repository after rescan",
    async () => {
      const base = new Date(2026, 4, 10, 12, 0, 0).getTime();
      const clock = vi.spyOn(Date, "now").mockReturnValue(base);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const root = scratch();
        const spoke = repoFrom("spoke");
        for (const name of ["spoke", "one", "two"])
          cpSync(spoke, join(root, name), { recursive: true });
        breakGoalObject(join(root, "one"));
        breakGoalObject(join(root, "two"));

        const hub = createHub({ root, rescanMs: 100 });
        const before = await (await hub.fetch(new Request("http://admin.localhost/"))).text();
        expect(before).toContain("The hub could not read 2 repositories.");

        rmSync(join(root, "two"), { recursive: true, force: true });
        clock.mockReturnValue(base + 200);
        await hub.pages();
        await vi.waitFor(
          async () => {
            const after = await (await hub.fetch(new Request("http://admin.localhost/"))).text();
            expect(after).toContain("The hub could not read a repository.");
            expect(after).not.toContain("two could not be read");
          },
          { timeout: 5_000, interval: 25 },
        );
      } finally {
        clock.mockRestore();
        errSpy.mockRestore();
      }
    },
    TIMEOUT,
  );
});
