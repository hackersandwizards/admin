import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import {
  chromeBinaryAsync,
  INSTALL_HINT,
  NO_KEYCHAIN,
} from "@hackersandwizards/scaffolding/chrome";
import {
  Window,
  type HTMLButtonElement as DomButton,
  type HTMLDialogElement as DomDialog,
  type HTMLElement as DomElement,
  type HTMLInputElement as DomInput,
  type HTMLTextAreaElement as DomTextArea,
} from "happy-dom";
import { buildSite, script, siteData } from "../../src/build.ts";
import { uniqueKeys } from "../../src/hub.ts";
import { readRepo, treeSource, when } from "../../src/repo.ts";
import { createHub, csp, linker } from "../../src/serve.ts";
import {
  FIX,
  commit,
  configured,
  evaluate,
  fromFiles,
  repoFrom,
  scratch,
  sh,
} from "../admin-fixtures.ts";

const testTimeout = (ms: number) =>
  ms * (Number(process.env.SCAFFOLDING_TEST_TIMEOUT_MS || 5000) / 5000);

// Each build draws its own nonce, so pages from two builds compare without it.
const SAMPLE_REPORT = "spoke/doc/docs/agent-work/2026-01-15-sample-topic";
const COMMENT = "spoke:2026-01-15-sample-topic#next";
const sansNonce = (html: string) => html.replace(/nonce(-|=")[\w-]+/g, "nonce$1");

// Happy DOM's raw-text parser stops at SVG style elements and drops the rest of the page.
const domMarkup = new HTMLRewriter().on(".admin-diagram svg style", {
  element(el) {
    el.remove();
  },
});
const readForDom = (file: string) => domMarkup.transform(readFileSync(file, "utf8"));

describe("admin-check", () => {
  test("a malformed item shows as a defect and leaves the pages building", async () => {
    const dir = join(scratch(), "r");
    cpSync(join(FIX, "spoke"), dir, { recursive: true });
    const front = "kind: decision\nstatus: open\npriority: 1\nowner: 5\ndue: 5";
    writeFileSync(
      join(dir, "docs/agent-work/items/odd.md"),
      `---\n${front}\noptions: foo\nimages:\n  - caption: x\n---\n# Odd\n`,
    );
    const repo = await readRepo(dir, treeSource(dir));
    expect(repo.defects.join("\n")).toContain("odd.md: options is not a list");
    const out = join(scratch(), "out");
    await buildSite(siteData([repo]), out);
    expect(readFileSync(join(out, "r/decisions.html"), "utf8")).toContain("Odd");
  });
});

describe("pages", () => {
  test("an admin link with a scheme other than http(s) renders its label as text", async () => {
    const files = {
      "package.json": JSON.stringify({
        admin: {
          designSystem: "javascript:alert(1)",
          products: [{ label: "Prod", href: "javascript:alert(2)" }],
          links: [{ label: "Lnk", href: "data:text/html,x" }],
        },
      }),
    };
    const out = join(scratch(), "out");
    const data = await fromFiles(files);
    await buildSite(siteData([data]), out);
    const pages = (readdirSync(out, { recursive: true }) as string[]).filter((p) =>
      p.endsWith(".html"),
    );
    const html = pages.map((p) => readFileSync(join(out, p), "utf8")).join("\n");
    expect(html).not.toMatch(/javascript:|data:text/);
    expect(html).toContain("<span>Lnk</span>");
    expect(html).toContain("Prod has no link");
  });

  test(
    "a doc's javascript: link renders as text in the pages built to disk",
    async () => {
      const out = join(scratch(), "out");
      const data = await fromFiles({
        "docs/x.md": "# X\n\n[run](javascript:alert(1)) [ok](https://a.test/)",
      });
      await buildSite(siteData([data]), out);
      const pages = (readdirSync(out, { recursive: true }) as string[]).filter((p) =>
        p.endsWith(".html"),
      );
      const html = pages.map((p) => readFileSync(join(out, p), "utf8")).join("\n");
      expect(html).toContain('href="https://a.test/"');
      expect(html).not.toContain("javascript:");
    },
    testTimeout(60_000),
  );

  test(
    "build pages that open from disk",
    async () => {
      const repo = repoFrom("spoke");
      const out = join(dirname(repo), "out");
      // A second repo without catalog or products, for the switcher's fallbacks.
      const plain = repoFrom("legacy", "plain");
      // A doc named index.md ends its page's path in "index", which Astro reads as the folder's own.
      mkdirSync(join(plain, "docs/guide"), { recursive: true });
      writeFileSync(join(plain, "docs/index.md"), "# Start here\n");
      writeFileSync(join(plain, "docs/guide/index.md"), "# Guide\n");
      sh(plain, "git", "add", "-A");
      commit(plain, "d");
      await buildSite(siteData([await readRepo(repo), await readRepo(plain)]), out);
      const html = readFileSync(join(out, "index.html"), "utf8");
      expect(html).toContain("Which variant ships?");
      // Waiting on others links a person's item to its row; an agent's item shows under its own
      // heading, collapsed, as a link to its row, and no person filter hides it.
      const waiting = html.slice(html.indexOf("Waiting on others"), html.indexOf("Agents on it"));
      expect(waiting).toContain('href="spoke/work.html#spoke:ask-the-printer"');
      expect(waiting).toContain('href="spoke/decisions.html#spoke:check-the-copy"');
      expect(waiting).toContain("Waiting on pick-a-variant");
      expect(html.indexOf("Sort the sample files")).toBeGreaterThan(html.indexOf("Agents on it"));
      const agents = html.slice(html.indexOf("Agents on it"), html.indexOf("Repositories"));
      expect(agents).not.toMatch(/<details[^>]*data-group[^>]* open/);
      expect(agents).toContain('href="spoke/work.html#spoke:sort-the-samples"');
      expect(agents).not.toContain("<textarea");
      expect(agents).not.toMatch(/<div[^>]*data-row[^>]*data-who/);
      // Settled items come last, after the repositories.
      expect(html.indexOf(">Settled</h2>")).toBeGreaterThan(html.indexOf(">Repositories</h2>"));
      expect(html.indexOf('id="spoke:name-the-command"')).toBeGreaterThan(
        html.indexOf(">Settled</h2>"),
      );
      const dashboard = readFileSync(join(out, "spoke/dashboard.html"), "utf8");
      expect(dashboard).toContain("Sort the sample files");
      // Most urgent lists the hub's user's own rows; other people's wait under their own heading.
      const [from, to] = [">Most urgent</h2>", "Waiting on others"].map((x) =>
        dashboard.indexOf(x),
      );
      expect(0 < from! && from! < to!).toBe(true);
      const urgent = dashboard.slice(from, to);
      expect(urgent).toContain("data-who=");
      const { others } = siteData([await readRepo(repo), await readRepo(plain)]);
      expect(others.length).toBeGreaterThan(0);
      for (const who of others) expect(urgent).not.toContain(`data-who="${who}"`);
      // On a phone the repositories table keeps three columns; the most urgent item goes under the
      // repository's name.
      const table = html.slice(html.indexOf(">Repositories</h2>"));
      expect(
        table
          .slice(0, table.indexOf("</thead>"))
          .match(/<th(?=[\s>])(?![^>]*max-sm:hidden)[^>]*>/g),
      ).toHaveLength(3);
      expect(readFileSync(join(out, "spoke/work.html"), "utf8")).toContain(
        'id="spoke:ask-the-printer"',
      );
      const pages = readdirSync(join(out, "spoke"), { recursive: true }) as string[];
      expect(pages).toContain("decisions.html");
      const rendered = new Window().document;
      rendered.body.innerHTML = readForDom(join(out, "spoke/decisions.html"));
      const summary = (id: string) =>
        rendered.getElementById(`spoke:${id}`)?.firstElementChild?.textContent;
      expect(summary("pick-a-variant")).toContain("2 open items wait on this");
      expect(summary("check-the-copy")).toContain("1 open item waits on this");
      expect(summary("cache-folder")).toContain("Waiting on pick-a-variant");
      expect(summary("cache-folder")).not.toMatch(/waits? on this/);
      expect(summary("name-the-command")).toContain("Waiting on goal");
      expect(summary("name-the-command")).not.toMatch(/waits? on this/);
      rendered.body.innerHTML = readForDom(join(out, "spoke/work.html"));
      expect(summary("goal")).toContain("1 open item waits on this");
      expect(summary("work-wire-the-gate")).toContain(
        "Waiting on check-the-copy, goal, pick-a-variant",
      );
      expect(pages).toContain("products-1.html");
      expect(pages).toContain("doc/docs/agent-work/2026-01-15-sample-topic.html");
      const plainDocs = readFileSync(join(out, "plain/docs.html"), "utf8");
      for (const [title, id, to] of [
        ["Start here", "start-here", "doc/docs/index"],
        ["Guide", "guide", "doc/docs/guide/index"],
      ] as const) {
        const link = plainDocs.match(new RegExp(`href="([^"]+)">\\s*${title}`))![1]!;
        expect(link.startsWith(to)).toBe(true);
        expect(readFileSync(join(out, "plain", link), "utf8")).toContain(
          `<h1 id="${id}">${title}</h1>`,
        );
      }
      for (const page of [
        "index.html",
        "spoke/decisions.html",
        "spoke/doc/docs/agent-work/2026-01-15-sample-topic.html",
      ]) {
        const text = readFileSync(join(out, page), "utf8");
        // Every script is a classic file script: no module, which a page from disk cannot load, and
        // nothing inline, which the pages' policy refuses; each carries the build's nonce.
        const nonce = text.match(/script-src 'nonce-([\w-]+)'/)![1];
        expect(text).toMatch(/<script nonce=/);
        for (const [tag] of text.matchAll(/<script[^>]*>/g))
          expect(tag).toMatch(new RegExp(`^<script nonce="${nonce}" src="[^"]+">$`));
        expect(text).not.toContain('"/_astro/');
        for (const [, ref] of text.matchAll(/(?:href|src)="([^"]*_astro\/[^"]+)"/g))
          expect(existsSync(resolve(dirname(join(out, page)), ref!))).toBe(true);
      }
      const docPath = join(out, "spoke/doc/docs/agent-work/2026-01-15-sample-topic.html");
      const doc = readFileSync(docPath, "utf8");
      expect(doc).toContain('<article class="prose hw-prose');
      for (const el of ["hw-quote", "hw-code"]) expect(doc).toContain(`class="${el} not-prose"`);
      expect(doc).toContain(
        '<div class="hw-table-scroll" tabindex="0" role="region" aria-label="Scores by reader"><table class="hw-table not-prose">',
      );
      expect(doc).not.toContain("<table>");
      expect(doc).toContain('<a class="hw-link" href=');
      expect(doc).not.toMatch(/<a [^>]*not-prose/);
      // The title shows above the article, so the article opens on what follows it.
      expect(doc).toMatch(/<article[^>]*><p[^>]*data-report[\s\S]*?<\/nav><p>A report/);
      expect(doc.match(/<article[^>]*>[\s\S]*?<\/article>/)?.[0]).not.toContain("<h1");
      const sheets = [...doc.matchAll(/href="([^"]+\.css)"/g)]
        .map(([, css]) => readFileSync(resolve(dirname(docPath), css!), "utf8"))
        .join("");
      // Typography's plugin is loaded: without it, prose styles nothing.
      expect(sheets).toContain(".prose :where(p)");
      expect(doc).toContain(`file://${repo}/docs/agent-work/2026-01-15-sample-topic/variant-a.svg`);
      const where = (html: string) => html.match(/<nav[^>]*aria-label="Where"[\s\S]*?<\/nav>/)![0];
      const repos = (html: string) => html.match(/<div id="admin-repos"[\s\S]*?<\/div>/)![0];
      expect(where(doc)).toContain('href="../../../../index.html"');
      expect(repos(doc)).toContain('href="../../../../plain/docs.html"');
      const decisions = readFileSync(join(out, "spoke/decisions.html"), "utf8");
      // brand's element script reaches the page as one classic script, which a page from disk loads.
      const [, script] = decisions.match(/<script nonce="[^"]+" src="([^"]*admin[^"]*\.js)"/)!;
      const bundled = readFileSync(resolve(out, "spoke", script!), "utf8");
      expect(bundled).toContain("hw-menu");
      expect(bundled).not.toMatch(/^import\b/m);
      expect(repos(decisions)).toContain('href="decisions.html"');
      expect(repos(html)).toContain('href="spoke/dashboard.html"');
      expect(repos(decisions)).toContain('href="../plain/decisions.html"');
      // Answers given on a repo page are copied there, not on a trip back to the hub.
      for (const page of ["dashboard", "work", "reviews"])
        expect(readFileSync(join(out, `spoke/${page}.html`), "utf8")).toContain('id="copy"');
      // brand's enhance() wires the Copy button by its data-hw-copy attribute.
      expect(decisions).toMatch(/id="copy"[^>]*data-hw-copy/);
      expect(bundled).toContain("[data-hw-copy]");
      // The copy time is set from brand's hw-copy event, which says whether the copy worked.
      expect(bundled).toMatch(/addEventListener\("hw-copy"[^]*?\.detail\?\.ok/);
      // Astro drops a line break next to a tag: the pill keeps an explicit space before its label.
      expect(decisions).toMatch(/Recommended\s*<\/span>\s+<b>/);
      for (const [from, to] of [
        ["spoke/catalog.html", "../plain/dashboard.html"],
        ["spoke/products-1.html", "../plain/dashboard.html"],
        ["spoke/products-1.html", 'href="products-1.html"'],
      ])
        expect(repos(readFileSync(join(out, from!), "utf8"))).toContain(to!);
    },
    testTimeout(60_000),
  );
  test(
    "the hub ranks every repository's rows in one order; Reviews lists review requests",
    async () => {
      const spoke = await readRepo(repoFrom("spoke"));
      const base = spoke.items.find((i) => i.id === "ask-the-printer")!;
      const late = { ...base, id: "late", owner: "Alex", order: 80 };
      // Kim's, ranked first in its repository: the Repositories table counts every person's items,
      // so its Most urgent names Kim's, while the dashboard's names the hub's user's own.
      const kims = {
        ...base,
        id: "kims",
        title: "The printers proof, Kim alone",
        owner: "Kim",
        priority: 1 as const,
        due: "2020-01-01",
      };
      // An assumption stated by its recommended option alone.
      const picked = spoke.items.find((i) => i.id === "pick-a-variant")!;
      const bare = { ...picked, id: "bare", status: "assumed" as const };
      const other = {
        ...spoke,
        key: "other",
        label: "other",
        path: `${spoke.path}-other`,
        behind: 2,
        fetched: 1_700_000_000,
        items: [{ ...base, id: "early", owner: "Alex", order: 20 }],
      };
      const out = join(scratch(), "out");
      await buildSite(
        siteData([{ ...spoke, items: [...spoke.items, late, bare, kims] }, other]),
        out,
      );
      const html = readFileSync(join(out, "index.html"), "utf8");
      // Opened, it still says what was assumed, where the closed line leaves.
      const bareRow = html.match(/id="spoke:bare"[\s\S]*?<\/details>/)![0];
      expect(bareRow).toMatch(/<p class="hw-callout"><b>Assumed:<\/b>\s*Variant A/);
      expect(html.indexOf('id="other:early"')).toBeLessThan(html.indexOf('id="spoke:late"'));
      // A line linking to an item names its repository by label too.
      expect(html.match(/<div[^>]*data-k="spoke:kims"[\s\S]*?<\/div>/)![0]).toContain(
        "Sample spoke · ",
      );
      // Repositories list by the name a person reads.
      expect(html.indexOf('data-repo-row="other"')).toBeLessThan(
        html.indexOf('data-repo-row="spoke"'),
      );
      const spokeRow = html.match(/<tr data-row data-repo-row="spoke">[\s\S]*?<\/tr>/)![0];
      expect(spokeRow).toContain(`<td class="max-w-md max-sm:hidden">${kims.title}</td>`);
      // Each row names its repository.
      expect(html).toMatch(/id="other:early"[\s\S]*?<\/summary>/);
      expect(html.match(/id="other:early"[\s\S]*?<\/summary>/)![0]).toContain("other · to do");
      const reviews = readFileSync(join(out, "spoke/reviews.html"), "utf8");
      for (const id of ["check-the-copy", "pick-recipients", "pick-a-variant"])
        expect(reviews).toContain(`id="spoke:${id}"`);
      for (const id of ["goal", "ask-the-printer"])
        expect(reviews).not.toContain(`id="spoke:${id}"`);
      // A settled row says what was assumed or decided, never what was recommended.
      const settled = (id: string) =>
        html.match(new RegExp(`id="spoke:${id}"[\\s\\S]*?</summary>`))![0];
      expect(settled("cache-folder")).toContain("Assumed: The build writes to node_modules/.cache");
      expect(settled("name-the-command")).toContain("Decided by Alex: Keep the short name");
      expect(settled("name-the-command")).not.toContain("Recommended");
      // Closed, that line holds two lines at most; opened, it leaves, since the row's callout says it
      // in full.
      expect(settled("cache-folder")).toMatch(/<span class="[^"]*group-open:hidden">Assumed:/);
      // A closed row answers nothing: a control that commits an answer sits beside the text it answers.
      const summaries = html.match(/<summary[\s\S]*?<\/summary>/g)!;
      expect(summaries.length).toBeGreaterThan(5);
      for (const s of summaries) expect(s).not.toMatch(/<(button|input|textarea|select)\b/);
      // An opened decision shows its options before its context.
      const variant = html.match(/id="spoke:pick-a-variant"[\s\S]*?<\/details>/)![0];
      expect(variant.indexOf('value="a"')).toBeLessThan(variant.indexOf(">Context<"));
      expect(variant.indexOf("Pick recommended")).toBeLessThan(variant.indexOf(">Context<"));
      // A letter key, which the item's text names an option by, stands before its label; a word key,
      // which restates the label, stays out.
      expect(variant).toMatch(/data-option-key[^>]*>a<\/span>\s*<b>Variant A<\/b>/);
      const recipients = html.match(/id="spoke:pick-recipients"[\s\S]*?<\/details>/)![0];
      expect(recipients).not.toContain("data-option-key");
      // Its options form one group, named by the question they answer.
      expect(variant).toMatch(/role="radiogroup" aria-label="[^"]+"[^>]*>\s*<label/);
      // The hub's provenance names the checkouts behind and says when it is from, at the page's end,
      // so the lists come first.
      expect(html).toMatch(/class="admin-provenance[^>]*>[^<]*· as of <span data-stamp>\d/);
      expect(html.match(/<p class="admin-provenance[^>]*>([^<]*)/)?.[1]).toContain(
        "1 behind their push branch: other",
      );
      expect(readFileSync(join(out, "other/dashboard.html"), "utf8")).toContain(
        "2 commits behind the push branch, fetched",
      );
      expect(html.indexOf("admin-provenance")).toBeGreaterThan(html.indexOf(">Settled</h2>"));
      expect(html).toContain("Decide P2");
    },
    testTimeout(60_000),
  );

  test(
    "an item's own images show above its answer, options or none",
    async () => {
      const spoke = await readRepo(repoFrom("spoke"));
      const base = spoke.items.find((i) => i.id === "pick-recipients")!;
      const shown = {
        ...base,
        id: "shown",
        images: ["variant-b.svg"],
        options: [
          { key: "ask", label: "Ask for more" },
          { key: "b2", label: "Second" },
        ],
        recommended: "b2",
        multiple: false,
      };
      const pair = { ...shown, id: "pair", images: ["a.svg", "b.svg"] };
      const out = join(scratch(), "out");
      await buildSite(siteData([{ ...spoke, items: [...spoke.items, shown, pair] }]), out);
      const html = readFileSync(join(out, "spoke/decisions.html"), "utf8");
      const rowOf = (id: string) =>
        html.match(new RegExp(`id="spoke:${id}"[\\s\\S]*?</details>`))![0];
      const row = rowOf("shown");
      expect(row.indexOf("shown/variant-b.svg")).toBeGreaterThan(0);
      expect(row.indexOf("shown/variant-b.svg")).toBeLessThan(row.indexOf("data-option"));
      expect(row).toMatch(/data-option-key[^>]*>b2<\/span>/);
      expect(row).not.toMatch(/data-option-key[^>]*>ask</);
      // A lone image takes the row's width, up to 36rem tall: large enough to judge, with its
      // options in view below it at 900 px. Several stand two beside each other from sm up, one per
      // row on a phone.
      expect(row).toMatch(
        /<div class="grid gap-3">\s*<span[^>]*>\s*<button[^>]*data-zoom="[^"]*shown\/variant-b[^>]*>\s*<img[^>]*max-h-144/,
      );
      // Each image opens in the page's one image dialog, which stands outside every option's label,
      // so a click on the large image picks nothing.
      expect(html.match(/id="admin-zoom"/g)).toHaveLength(1);
      expect(html.indexOf('id="admin-zoom"')).toBeGreaterThan(html.lastIndexOf("</label>"));
      expect(rowOf("pair")).toContain('<div class="grid gap-3 sm:grid-cols-2">');
      // A long path or address in an opened row breaks inside the row rather than widening a phone's
      // page.
      expect(row).toMatch(/<div class="[^"]*\bwrap-anywhere\b[^"]*">\s*<p class="hw-status"/);
      // Opened, the row's own recommendation badge says what the closed line said.
      expect(row).toMatch(/<span class="[^"]*group-open:hidden">Recommended:/);
    },
    testTimeout(60_000),
  );

  test(
    "on a phone too, a row a link opens shows its title below the copy bar, and every person's button shows",
    async () => {
      const out = join(scratch(), "out");
      const spoke = await readRepo(repoFrom("spoke"));
      // Five more people, each with an open item, so the person buttons run wider than a phone.
      const more = ["Annabelle", "Bartholomew", "Constance", "Dorothea", "Evangeline"].map(
        (owner) => ({ ...spoke.items.find((i) => i.id === "ask-the-printer")!, id: owner, owner }),
      );
      await buildSite(siteData([{ ...spoke, items: [...spoke.items, ...more] }]), out);
      const executablePath = await chromeBinaryAsync();
      if (!executablePath) throw new Error(INSTALL_HINT);
      const browser = await puppeteer.launch({ executablePath, headless: true, args: NO_KEYCHAIN });
      try {
        const page = await browser.newPage();
        for (const [width, height] of [
          [390, 844],
          [1440, 900],
        ]) {
          await page.setViewport({ width: width!, height: height! });
          // A page long enough that the row can reach the top, as on a full repository's page.
          await page.goto(`file://${out}/spoke/work.html`);
          const [bar, row] = await page.evaluate(() => {
            document.body.append(
              Object.assign(document.createElement("div"), { style: "height:200vh" }),
            );
            location.hash = "#spoke:ask-the-printer";
            return [
              document.querySelector(".admin-action")!.getBoundingClientRect().bottom,
              document.getElementById("spoke:ask-the-printer")!.getBoundingClientRect().top,
            ];
          });
          expect({ width, row: row! >= bar! }).toEqual({ width, row: true });
          await page.goto(`file://${out}/index.html`);
          const cut = await page.evaluate(() =>
            [...document.querySelectorAll("[data-who-button], [data-kind-button]")]
              .filter((b) => b.getBoundingClientRect().right > innerWidth)
              .map((b) => b.textContent!.trim()),
          );
          expect({ width, cut }).toEqual({ width, cut: [] });
          // A settled row's closed line holds two lines at most, however long its text.
          const lines = await page.evaluate(() => {
            const line = document.querySelector<HTMLElement>(
              '[data-status="assumed"] summary .line-clamp-2',
            )!;
            line.closest<HTMLDetailsElement>("details[data-group]")!.open = true;
            document.querySelector<HTMLElement>('[data-who-button="all"]')!.click();
            line.textContent = "Assumed: a long assumption. ".repeat(40);
            return line.offsetHeight / parseFloat(getComputedStyle(line).lineHeight);
          });
          expect(lines).toBeGreaterThan(0.5);
          expect(lines).toBeLessThan(2.5);
          // A row without a recommendation or an answer leaves no empty line where Reset waits: the
          // next line sits one gap below the one before.
          await page.goto(`file://${out}/spoke/work.html#spoke:ask-the-printer`);
          const gaps = await page.evaluate(() => {
            const line = document
              .getElementById("spoke:ask-the-printer")!
              .querySelector(".clear")!.parentElement!;
            const box = (e: Element) => e.getBoundingClientRect();
            return [
              box(line.nextElementSibling!).top - box(line.previousElementSibling!).bottom,
              parseFloat(getComputedStyle(line.parentElement!).rowGap),
            ];
          });
          expect(gaps[0]).toBeCloseTo(gaps[1]!);
        }
      } finally {
        await browser.close();
      }
    },
    testTimeout(60_000),
  );
  test(
    "a Work page without a needs edge has no graph fold",
    async () => {
      const out = join(scratch(), "out");
      const repo = await fromFiles({
        "docs/agent-work/items/goal.md": "---\nkind: goal\nstatus: open\n---\n# A sample goal",
      });
      await buildSite(siteData([repo]), out);
      const work = readFileSync(join(out, repo.key, "work.html"), "utf8");
      expect(work).toContain("A sample goal");
      expect(work).not.toContain("What waits on what");
    },
    testTimeout(60_000),
  );

  test(
    "every needs graph node link names a row that exists and opens it in Chrome",
    async () => {
      const out = join(scratch(), "out");
      const spoke = await readRepo(repoFrom("spoke"));
      await buildSite(siteData([spoke]), out);
      const work = join(out, "spoke/work.html");
      const doc = new Window().document;
      doc.body.innerHTML = readForDom(work);
      const fold = doc.querySelector("details:has(figure.admin-diagram)")!;
      expect(fold.hasAttribute("open")).toBe(false);
      const links = [...fold.querySelectorAll("svg a")];
      expect(links).toHaveLength(6);
      expect(fold.querySelectorAll("svg .node")).toHaveLength(links.length);
      const targets = links.map((link) => {
        expect(link.querySelectorAll(".node")).toHaveLength(1);
        const [file, id] = link.getAttribute("href")!.split("#") as [string, string];
        const item = spoke.items.find((item) => id === `${spoke.key}:${item.id}`)!;
        expect(link.querySelector(".node text")?.textContent).toBe(item.title);
        const target = new Window().document;
        target.body.innerHTML = readForDom(join(dirname(work), file));
        expect(target.getElementById(id)?.hasAttribute("data-row"), `${file}#${id}`).toBe(true);
        return id;
      });
      expect(targets.sort()).toEqual(
        [
          "cache-folder",
          "check-the-copy",
          "goal",
          "name-the-command",
          "pick-a-variant",
          "work-wire-the-gate",
        ].map((id) => `spoke:${id}`),
      );

      const executablePath = await chromeBinaryAsync();
      if (!executablePath) throw new Error(INSTALL_HINT);
      const browser = await puppeteer.launch({ executablePath, headless: true, args: NO_KEYCHAIN });
      try {
        const page = await browser.newPage();
        await page.evaluateOnNewDocument(() => {
          document.addEventListener("securitypolicyviolation", (event) => {
            console.error("CSP violation:", event.violatedDirective, event.blockedURI);
          });
        });
        const violations: string[] = [];
        page.on("console", (message) => {
          if (message.text().startsWith("CSP violation:")) violations.push(message.text());
        });
        await page.goto(`file://${work}`);
        await page.type("#admin-search", "an unmatched search");
        await page.click("details:has(figure.admin-diagram) > summary");
        const graph = await page.locator("figure.admin-diagram svg").waitHandle();
        const box = await graph.boundingBox();
        expect(box?.width).toBeGreaterThan(0);
        expect(box?.height).toBeGreaterThan(0);
        await Promise.all([
          page.waitForNavigation(),
          page.click('svg a[href="decisions.html#spoke:pick-a-variant"] text'),
        ]);
        expect(new URL(page.url()).hash).toBe("#spoke:pick-a-variant");
        await page.waitForSelector('details[id="spoke:pick-a-variant"][open]', { visible: true });
        expect(violations).toEqual([]);
      } finally {
        await browser.close();
      }
    },
    testTimeout(60_000),
  );

  test(
    "Chrome copies a comment from a served report below the copy bar without CSP violations",
    async () => {
      const repo = repoFrom("spoke");
      const stem = "2026-01-15-sample-topic";
      const item = `docs/agent-work/items/${stem}.md`;
      writeFileSync(
        join(repo, item),
        `---\nkind: review\nstatus: open\npriority: 1\nowner: Alex\ntopic: ${stem}\n---\n# Check the sample file\n`,
      );
      sh(repo, "git", "add", item);
      commit(repo, "Add sample question");
      const hub = createHub({ root: dirname(repo) });
      const executablePath = await chromeBinaryAsync();
      if (!executablePath) throw new Error(INSTALL_HINT);
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: hub.fetch });
      try {
        const browser = await puppeteer.launch({
          executablePath,
          headless: true,
          args: NO_KEYCHAIN,
        });
        try {
          await browser
            .defaultBrowserContext()
            .overridePermissions(server.url.origin, [
              "clipboard-read",
              "clipboard-sanitized-write",
            ]);
          const page = await browser.newPage();
          await page.setViewport({ width: 390, height: 844 });
          await page.evaluateOnNewDocument(() => {
            document.addEventListener("securitypolicyviolation", (event) => {
              console.error("CSP violation:", event.violatedDirective, event.blockedURI);
            });
          });
          const violations: string[] = [];
          page.on("console", (message) => {
            if (message.text().startsWith("CSP violation:")) violations.push(message.text());
          });
          const response = await page.goto(new URL(SAMPLE_REPORT, server.url).href);
          expect(response?.status()).toBe(200);
          await page.click('nav[aria-label="Contents"] a[href="#next"]');
          await page.waitForFunction(() => {
            const bar = document.querySelector(".admin-action")!.getBoundingClientRect();
            const heading = document.getElementById("next")!.getBoundingClientRect();
            return (
              location.hash === "#next" && heading.top >= bar.bottom && heading.bottom < innerHeight
            );
          });
          const fold = '[data-k="' + COMMENT + '"]';
          await page.click(fold + " summary");
          await page.type(fold + " textarea", "why   dotted?");
          await page.bringToFront();
          await page.click("#copy");
          await page.waitForFunction(() =>
            document.querySelector("#state")?.textContent?.includes("copied at"),
          );
          expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
            "Answers from the admin pages:\nspoke:2026-01-15-sample-topic#next: why dotted?",
          );
          const row = 'details.item[id="spoke:' + stem + '"]';
          await page.click(row + " summary");
          await page.type(row + " textarea", "ready");
          expect(await page.$eval("#copy", (b) => b.getAttribute("data-hw-copy"))).toBe(
            `Answers from the admin pages:\nspoke:${stem}: ready`,
          );
          await page.reload();
          expect(
            await page.$eval(row + " textarea", (field) => (field as HTMLTextAreaElement).value),
          ).toBe("ready");
          expect(
            await page.$eval(fold + " textarea", (field) => (field as HTMLTextAreaElement).value),
          ).toBe("why   dotted?");
          expect(
            await page.evaluate((key) => {
              const versions = JSON.parse(
                localStorage.getItem("admin-answers:versions")!,
              ) as Record<string, string>;
              return [versions[key], versions["#" + key]];
            }, "spoke:" + stem),
          ).toEqual([expect.any(String), expect.any(String)]);
          expect(violations).toEqual([]);
        } finally {
          await browser.close();
        }
      } finally {
        await server.stop(true);
      }
    },
    testTimeout(60_000),
  );

  test(
    "Mermaid fits its labels, follows the page theme, and causes no CSP violations",
    async () => {
      const repo = await readRepo(repoFrom("spoke"));
      const classes = await fromFiles({
        "docs/classes.md":
          "# Sample classes\n\n```mermaid\nclassDiagram\n  class Sample {\n    +archive()\n  }\n```",
      });
      const out = join(scratch(), "out");
      await buildSite(siteData([repo, classes]), out);
      const executablePath = await chromeBinaryAsync();
      if (!executablePath) throw new Error(INSTALL_HINT);
      const browser = await puppeteer.launch({ executablePath, headless: true, args: NO_KEYCHAIN });
      try {
        const page = await browser.newPage();
        await page.evaluateOnNewDocument(() => {
          document.addEventListener("securitypolicyviolation", (event) => {
            console.error("CSP violation:", event.violatedDirective, event.blockedURI);
          });
        });
        const violations: string[] = [];
        page.on("console", (message) => {
          if (message.text().startsWith("CSP violation:")) violations.push(message.text());
        });
        await page.setViewport({ width: 390, height: 844 });
        await page.goto(`file://${out}/spoke/doc/docs/agent-work/2026-01-15-sample-topic.html`);
        const diagram = await page.locator("article .admin-diagram > svg").waitHandle();
        const view = await diagram.evaluate(async (svg) => {
          await document.fonts.ready;
          const { width, height } = svg.getBoundingClientRect();
          const figure = svg.parentElement!;
          const nodes = [...svg.querySelectorAll(".node")];
          const measurements = nodes.map((node) => {
            const label = node.querySelector("text")!;
            const box = node.querySelector("rect")!;
            return [label.textContent, label.getBBox().width, box.getBBox().width] as const;
          });
          const root = document.documentElement;
          const first = nodes[0]!.querySelector("rect")!;
          root.dataset.theme = "light";
          const day = getComputedStyle(first).fill;
          root.dataset.theme = "dark";
          return {
            width,
            height,
            scrollWidth: figure.scrollWidth,
            clientWidth: figure.clientWidth,
            overflow: getComputedStyle(figure).overflowX,
            font: getComputedStyle(nodes[0]!.querySelector("text")!).fontFamily,
            measurements,
            day,
            night: getComputedStyle(first).fill,
          };
        });
        expect(view.width).toBeGreaterThan(0);
        expect(view.height).toBeGreaterThan(0);
        expect(view.scrollWidth).toBeGreaterThan(view.clientWidth);
        expect(view.overflow).toBe("auto");
        expect(view.font).toContain("Inter");
        expect(view.measurements).toHaveLength(3);
        for (const [label, width, box] of view.measurements) {
          expect(width, label ?? "").toBeGreaterThan(0);
          expect(width, label ?? "").toBeLessThanOrEqual(box);
        }
        expect(view.day).not.toBe(view.night);
        expect(violations).toEqual([]);
        await page.goto(`file://${out}/spoke/work.html#spoke:sort-the-samples`);
        expect(
          await page.$eval(
            '[id="spoke:sort-the-samples"] .admin-diagram svg',
            (svg) => svg.textContent,
          ),
        ).toContain("Dated folders");
        expect(
          await page.$eval('[id="spoke:work-wire-the-gate"] > summary', (row) => row.textContent),
        ).toContain("Waiting on check-the-copy, goal, pick-a-variant");
        expect(violations).toEqual([]);
        await page.goto(`file://${out}/x/doc/docs/classes.html`);
        const [member, mono, sans] = await page.$eval(".admin-diagram text.mono", (label) => {
          const reference = document.createElement("span");
          reference.style.fontFamily = "var(--font-mono)";
          label.closest("figure")!.append(reference);
          const title = label.closest("svg")!.querySelector("text:not(.mono)")!;
          return [
            getComputedStyle(label).fontFamily,
            getComputedStyle(reference).fontFamily,
            getComputedStyle(title).fontFamily,
          ];
        });
        expect(member).toBe(mono);
        expect(member).not.toBe(sans);
        expect(violations).toEqual([]);
      } finally {
        await browser.close();
      }
    },
    testTimeout(60_000),
  );

  test(
    "a page opened from disk runs the hub's scripts and none of a doc's, and a doc's q&a link resolves",
    async () => {
      const repo = join(scratch(), "r");
      const files: Record<string, string> = {
        "package.json": "{}",
        "docs/x.md": [
          "# X",
          "",
          "[qa](q&a.md) [roll](<rock & roll's.md>)",
          "",
          `<a href="q&#38;a.md">raw</a>`,
          "",
          `<script>document.title += "|inline"</script>`,
          `<script src="evil.js"></script>`,
          `<img src="missing.png" onerror="document.title += '|onerror'">`,
          `<form action="https://a.test/"><button id="post">Post</button></form>`,
        ].join("\n"),
        // An open attribute swallows the markup up to the hub's own script, nonce included.
        "docs/y.md": `# Y\n\n<script src="evil.js" x="`,
        "docs/evil.js": `document.title += "|file";`,
        "docs/q&a.md": "# Q and A",
        "docs/rock & roll's.md": "# Rock",
      };
      for (const [f, text] of Object.entries(files)) {
        mkdirSync(dirname(join(repo, f)), { recursive: true });
        writeFileSync(join(repo, f), text);
      }
      sh(repo, "git", "init", "-q", "-b", "main");
      sh(repo, "git", "add", "-A");
      commit(repo, "c");
      const data = await readRepo(repo);
      const out = join(scratch(), "out");
      await buildSite(siteData([data]), out);
      const html = readFileSync(join(out, "r/doc/docs/x.html"), "utf8");
      for (const name of ["qa", "roll", "raw"]) {
        const to = html.match(new RegExp(`href="([^"]*)">${name}<`))![1]!;
        expect([name, existsSync(decodeURIComponent(new URL(to).pathname))]).toEqual([name, true]);
      }
      const qa = html.match(/href="([^"]*)">qa</)![1]!;
      expect(linker([data]).pages(`href="${qa}"`)).toBe('href="/r/doc/docs/q%26a"');
      const executablePath = await chromeBinaryAsync();
      if (!executablePath) throw new Error(INSTALL_HINT);
      const browser = await puppeteer.launch({ executablePath, headless: true, args: NO_KEYCHAIN });
      try {
        const page = await browser.newPage();
        await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
        const posts: string[] = [];
        page.on("request", (r) => r.url().startsWith("https:") && posts.push(r.url()));
        await page.goto(`file://${out}/r/doc/docs/x.html`, { waitUntil: "load" });
        await page.keyboard.press("/");
        const ran = await page.evaluate(() => [
          document.title,
          document.documentElement.dataset.theme,
          document.activeElement?.id,
        ]);
        // theme.js darkens the page, admin.js focuses the search on "/".
        expect(ran).toEqual(["X · r · Admin", "dark", "admin-search"]);
        // The header's theme switch turns the page and stores the choice, which outlasts a reload
        // and the system's theme.
        await page.click("#theme-toggle");
        const theme = () =>
          page.evaluate(() => [
            document.documentElement.dataset.theme,
            document.getElementById("theme-toggle")?.getAttribute("aria-pressed"),
            localStorage.getItem("theme"),
          ]);
        expect(await theme()).toEqual(["light", "false", "light"]);
        await page.reload({ waitUntil: "load" });
        expect(await theme()).toEqual(["light", "false", "light"]);
        await page.click("#post").catch(() => {});
        await new Promise((r) => setTimeout(r, 300));
        expect(posts).toEqual([]);
        await page.goto(`file://${out}/r/doc/docs/y.html`, { waitUntil: "load" });
        expect(await page.title()).not.toContain("|file");
      } finally {
        await browser.close();
      }
    },
    testTimeout(60_000),
  );
});

describe("admin.js", () => {
  // Built pages with the bundled script run in a DOM of their own, one browser's storage shared.
  let out = "";
  let code = "";
  const opened: Window[] = [];
  afterAll(async () => {
    await Promise.all(opened.map((w) => w.happyDOM.close()));
  });
  // Storage null is a browser that blocks site data: reading localStorage throws.
  const open = (page: string, storage: Record<string, string> | null, now?: number) => {
    const window = new Window({ url: `http://admin.localhost/${page}` });
    opened.push(window);
    if (now !== undefined) window.Date.now = () => now;
    if (!storage)
      Object.defineProperty(window, "localStorage", {
        get: () => {
          throw new window.DOMException("site data blocked", "SecurityError");
        },
      });
    for (const [k, v] of Object.entries(storage ?? {})) window.localStorage.setItem(k, v);
    window.document.write(
      readForDom(join(out, `${page}.html`)).replace(/<script[^>]*><\/script>/g, ""),
    );
    evaluate(window, code);
    return window;
  };
  const stored = (w: Window) => ({ ...w.localStorage }) as Record<string, string>;

  const rawDoc = "spoke/doc/docs/controls";
  const rawReport = "spoke/doc/docs/agent-work/2026-01-13-raw-heading";
  const sampleVersionKey = "#spoke:2026-01-15-sample-topic";

  beforeAll(async () => {
    out = join(scratch(), "out");
    const repo = repoFrom("spoke");
    const doc = "docs/controls.md";
    const field = "docs/comment-field.md";
    const report = "docs/agent-work/2026-01-13-raw-heading.md";
    writeFileSync(
      join(repo, doc),
      '# Controls\n\n<span data-report data-k="#spoke:2026-01-15-sample-topic" data-version="fake" data-sample="sample">Sample span</span>\n\n<button popovertarget="admin-repo-choice">Sample button</button>\n',
    );
    writeFileSync(
      join(repo, report),
      '# Raw heading\n\n<h2 id="überblick_日本語-١-cafe&#x301;&#10;spoke:pick-a-variant: a (Variant A)&#10;x">Überblick</h2>\n\n<h2 id="outer">Outer <span><h3 id="inner">Inner</h3></span> tail</h2>\n',
    );
    writeFileSync(
      join(repo, field),
      '# Field\n\n<details data-comment data-k="x"><textarea></textarea></details>\n',
    );
    sh(repo, "git", "add", doc, field, report);
    commit(repo, "Add raw markup samples");
    await buildSite(siteData([await readRepo(repo)]), out);
    code = await script();
  }, testTimeout(60_000));

  test("the theme switch turns the page by its own button, and a catalog page without night stays day", async () => {
    const theme = readFileSync(join(import.meta.dirname, "../../site/src/theme.js"), "utf8");
    // `catalog` null is the hub; else a catalog page, with or without the shell's data-hw-night.
    const run = (catalog: null | { night: boolean }) => {
      const window = new Window({ url: "http://admin.localhost/index" });
      opened.push(window);
      window.localStorage.setItem("theme", "dark");
      // brand's switch in the catalog shell's header, ahead of the page's own under the same id.
      window.document.write(
        readForDom(join(out, "index.html"))
          .replace(/<script[^>]*><\/script>/g, "")
          .replace(/<body[^>]*>/, '$&<button id="theme-toggle" data-shell></button>'),
      );
      const doc = window.document;
      if (catalog) doc.documentElement.dataset.adminCatalog = "";
      if (catalog?.night) doc.documentElement.dataset.hwNight = "";
      evaluate(window, theme);
      evaluate(window, code);
      expect(
        window.localStorage.getItem(catalog ? "admin-catalog:seen" : "admin-answers:seen"),
      ).not.toBeNull();
      expect(
        window.localStorage.getItem(catalog ? "admin-answers:seen" : "admin-catalog:seen"),
      ).toBeNull();
      const shell = doc.querySelector("[data-shell]")!;
      const own = doc.querySelector("[data-admin-theme]") as unknown as HTMLElement;
      const read = () => [
        doc.documentElement.dataset.theme,
        own.getAttribute("aria-pressed"),
        window.localStorage.getItem("theme"),
      ];
      return { doc, own, shell: shell as unknown as HTMLElement, read };
    };
    const tick = () => new Promise((r) => setTimeout(r, 0));
    for (const catalog of [null, { night: true }]) {
      const page = run(catalog);
      expect(page.read()).toEqual(["dark", "true", "dark"]);
      page.shell.click();
      expect(page.read()).toEqual(["dark", "true", "dark"]);
      page.own.click();
      await tick();
      expect(page.read()).toEqual(["light", "false", "light"]);
      page.own.click();
      await tick();
      expect(page.read()).toEqual(["dark", "true", "dark"]);
      // A flip by the shell's switch reaches the page's own.
      page.doc.documentElement.dataset.theme = "light";
      await tick();
      expect(page.read()).toEqual(["light", "false", "dark"]);
    }
    const alone = run({ night: false });
    expect(alone.read()).toEqual(["light", "false", "dark"]);
    alone.own.click();
    await tick();
    expect(alone.read()).toEqual(["light", "false", "dark"]);
  });

  test("a browser that blocks site data still filters its rows", () => {
    const doc = open("index", null).document;
    (doc.querySelector('[data-kind-button="decision"]') as unknown as HTMLElement).click();
    const kinds = [...doc.querySelectorAll("[data-row]")]
      .filter((r) => !r.closest("[hidden]"))
      .map((r) => (r as unknown as HTMLElement).dataset.kind);
    expect(kinds).toContain("decision");
    expect(kinds.filter((k) => k && k !== "decision")).toEqual([]);
  });

  test("a browser that blocks site data can pick and clear an answer during the visit", () => {
    const page = open("spoke/decisions", null);
    const row = page.document.getElementById("spoke:pick-a-variant")!;
    (row.querySelector("summary + div .pick") as DomElement).click();
    expect(row.querySelector(".mark")!.textContent).toBe("✓ Variant A");
    expect(page.document.getElementById("copy")!.textContent).toBe("Copy 1 answer");
    (row.querySelector(".clear") as DomElement).click();
    expect(row.querySelector(".mark")!.textContent).toBe("");
    expect(page.document.getElementById("copy")!.textContent).not.toContain("1 answer");
  });

  test("full storage keeps the theme switch working while unexpected write errors propagate", () => {
    const window = new Window({ url: "http://admin.localhost/index" });
    opened.push(window);
    let failWith: Error = new window.DOMException("quota full", "QuotaExceededError");
    Object.defineProperty(window, "localStorage", {
      value: {
        length: 0,
        getItem: () => null,
        setItem: () => {
          throw failWith;
        },
        removeItem: () => {},
        key: () => null,
      },
    });
    const errors: string[] = [];
    window.addEventListener("error", (event) => {
      errors.push((event as unknown as { error: Error }).error.message);
    });
    window.document.write(
      readForDom(join(out, "index.html")).replace(/<script[^>]*><\/script>/g, ""),
    );
    evaluate(window, code);
    const toggle = window.document.querySelector("[data-admin-theme]") as DomButton;
    toggle.click();
    expect(window.document.documentElement.dataset.theme).toBe("dark");
    expect(errors).toEqual([]);
    failWith = new window.TypeError("unexpected write failure");
    toggle.click();
    expect(errors).toEqual(["unexpected write failure"]);
  });

  test("a full store stops visit bookkeeping when saving before fails", () => {
    const window = new Window({ url: "http://admin.localhost/index" });
    opened.push(window);
    const oldSeen = String(Date.now() - 2 * 36e5);
    const deferred = JSON.stringify({ later: true, note: "", at: "2026-01-01T10:00:00.000Z" });
    const backing = window.localStorage;
    backing.setItem("admin-answers:seen", oldSeen);
    backing.setItem("admin-answers:who", "Kim");
    backing.setItem("admin-answers:versions", "{}");
    backing.setItem("admin-answers:spoke:pick-a-logo", deferred);
    const writes = [
      (k: string, v: string) => backing.setItem(k, v),
      () => {
        throw new window.DOMException("quota full", "QuotaExceededError");
      },
    ];
    let step = 0;
    Object.defineProperty(window, "localStorage", {
      value: {
        get length() {
          return backing.length;
        },
        getItem: (k: string) => backing.getItem(k),
        setItem: (k: string, v: string) => writes[step++]!(k, v),
        removeItem: (k: string) => backing.removeItem(k),
        key: (i: number) => backing.key(i),
      },
    });
    window.document.write(
      readForDom(join(out, "index.html")).replace(/<script[^>]*><\/script>/g, ""),
    );
    evaluate(window, code);
    expect(backing.getItem("admin-answers:who")).toBe("Kim");
    expect(backing.getItem("admin-answers:seen")).toBe(oldSeen);
    expect(backing.getItem("admin-answers:spoke:pick-a-logo")).toBe(deferred);
    expect(window.document.querySelectorAll("[data-updated]:not([hidden])").length).toBe(0);
  });

  test("corrupt visit history stops bookkeeping without overwriting versions or marking rows", () => {
    const oldSeen = String(Date.now() - 2 * 36e5);
    const page = open("index", {
      "admin-answers:seen": oldSeen,
      "admin-answers:who": "Kim",
      "admin-answers:versions": "{broken",
    });
    expect(stored(page)["admin-answers:versions"]).toBe("{broken");
    expect(stored(page)["admin-answers:seen"]).toBe(oldSeen);
    expect(stored(page)["admin-answers:who"]).toBe("Kim");
    expect(page.document.querySelectorAll("[data-updated]:not([hidden])").length).toBe(0);
  });

  test("filtering without a search term does not clone rows", () => {
    const window = new Window({ url: "http://admin.localhost/index" });
    opened.push(window);
    window.document.write(
      readForDom(join(out, "index.html")).replace(/<script[^>]*><\/script>/g, ""),
    );
    const cloneSpy = vi.spyOn(window.HTMLElement.prototype, "cloneNode");
    evaluate(window, code);
    (window.document.querySelector('[data-kind-button="decision"]') as DomButton).click();
    expect(cloneSpy).not.toHaveBeenCalled();
    const search = window.document.getElementById("admin-search") as DomInput;
    search.value = "variant";
    search.dispatchEvent(new window.Event("input"));
    expect(cloneSpy).toHaveBeenCalled();
  });

  test("a stored non-string note loads as an empty field", () => {
    const page = open("spoke/decisions", {
      "admin-answers:spoke:check-the-copy": JSON.stringify({
        note: 42,
        at: "2026-01-01T12:00:00.000Z",
      }),
    });
    const field = page.document.querySelector<DomTextArea>("#spoke\\:check-the-copy textarea")!;
    expect(field.value).toBe("");
  });

  test("opening a variant image gives the dialog an accessible name before it opens", () => {
    const page = open("spoke/decisions", {});
    const row = page.document.getElementById("spoke:pick-a-variant")!;
    const shot = row.querySelector<DomButton>('button[aria-label="light, 600 px: open large"]')!;
    const dialog = page.document.querySelector<DomDialog>("dialog#admin-zoom")!;
    const errors: unknown[] = [];
    page.addEventListener("error", (event) => errors.push(event));
    const observer = new page.MutationObserver(() => {});
    observer.observe(dialog, { attributes: true, attributeFilter: ["aria-label", "open"] });
    shot.click();
    expect(dialog.open).toBe(true);
    expect(observer.takeRecords().map((record) => record.attributeName)).toEqual([
      "aria-label",
      "open",
    ]);
    observer.disconnect();
    expect(dialog.getAttribute("aria-label")).toBe("light, 600 px");
    expect(dialog.querySelector("img")?.alt).toBe("light, 600 px");
    expect(dialog.querySelector("img")?.src).toMatch(/\/pick-a-variant\/variant-b\.svg$/);
    dialog.querySelector<DomButton>('button[aria-label="Close"]')!.click();
    expect(dialog.open).toBe(false);
    expect(dialog.getAttribute("aria-label")).toBe("light, 600 px");
    expect(errors).toEqual([]);
  });

  test("a click on an option card's text picks the option", () => {
    const doc = open("spoke/decisions", {}).document;
    const card = (key: string) =>
      doc
        .getElementById("spoke:pick-a-variant")!
        .querySelector(`input[data-option][value="${key}"]`)!
        .closest("label")!;
    // The card's label names its option's input, though the image's button stands before it.
    for (const key of ["a", "b"])
      expect((card(key) as unknown as HTMLLabelElement).control?.dataset.option).toBe("");
    (card("b").querySelector("b") as unknown as HTMLElement).click();
    expect((card("b").querySelector("input[data-option]") as DomInput).checked).toBe(true);
  });

  test("a copied answer leaves with its item, never while the item stays", () => {
    const at = (h: number) => new Date(Date.UTC(2026, 0, 1, h)).toISOString();
    const answer = (h: number) => JSON.stringify({ done: true, note: "x", at: at(h) });
    const page = open("spoke/decisions", {
      "admin-answers:copied": at(12),
      // A work item lists on the work page, not here, and stays.
      "admin-answers:spoke:ask-the-printer": answer(10),
      "admin-answers:spoke:gone": answer(10),
      "admin-answers:spoke:gone-uncopied": answer(13),
      "admin-answers:other:gone": answer(10),
    });
    expect(Object.keys(stored(page)).sort()).toEqual([
      "admin-answers:before",
      "admin-answers:copied",
      "admin-answers:other:gone",
      "admin-answers:seen",
      "admin-answers:spoke:ask-the-printer",
      "admin-answers:spoke:gone-uncopied",
      "admin-answers:versions",
      "admin-answers:visit",
    ]);
  });

  test("pruning copied answers leaves another tool's storage alone", () => {
    const at = "2026-01-01T12:00:00.000Z";
    const answer = JSON.stringify({ done: true, at });
    const uncopied = open("spoke/decisions", { "admin-answers:spoke:gone": answer });
    expect(uncopied.localStorage.getItem("admin-answers:spoke:gone")).toBe(answer);
    const page = open("spoke/decisions", {
      "admin-answers:spoke:gone": answer,
      "admin-answers:spoke:old-answer": '{"done":true}',
      "admin-answers:copied": at,
      "other-storage:spoke:gone": answer,
    });
    expect(page.localStorage.getItem("admin-answers:spoke:gone")).toBeNull();
    expect(page.localStorage.getItem("admin-answers:spoke:old-answer")).toBeNull();
    expect(page.localStorage.getItem("other-storage:spoke:gone")).toBe(answer);
  });

  test("an unreadable saved answer does not keep another question put off", () => {
    const page = open("spoke/decisions", {
      "admin-answers:seen": String(Date.now() - 2 * 36e5),
      "admin-answers:spoke:cache-folder": "unreadable",
      "admin-answers:spoke:pick-a-variant": JSON.stringify({
        later: true,
        note: "ask the printer",
        at: "2026-01-01T12:00:00.000Z",
      }),
    });
    const row = page.document.getElementById("spoke:pick-a-variant")!;
    expect(row.querySelector(".mark")!.textContent).toBe("✓ note");
    expect((page.document.getElementById("copy") as DomElement).dataset.hwCopy).toContain(
      "spoke:pick-a-variant: ask the printer",
    );
  });

  test("an answer is stored as it is given, and the copy button counts it", () => {
    const page = open("spoke/decisions", {});
    const row = page.document.getElementById("spoke:pick-a-variant")!;
    // Reset shows only once there is an answer to take back.
    expect((row.querySelector(".clear") as DomElement).hidden).toBe(true);
    const pick = row.querySelector('input[data-option][value="b"]') as DomInput;
    pick.checked = true;
    row.dispatchEvent(new page.Event("change"));
    expect(
      JSON.parse(page.localStorage.getItem("admin-answers:spoke:pick-a-variant")!),
    ).toMatchObject({ option: "b", label: ["Variant B"] });
    expect(row.querySelector(".mark")!.textContent).toBe("✓ Variant B");
    expect(page.document.getElementById("copy")!.textContent).toBe("Copy 1 answer");
    const reset = row.querySelector(".clear") as DomElement;
    expect(reset.hidden).toBe(false);
    // Pressed, it leaves; focus moves to the row's first answer, not back to the page's top.
    reset.focus();
    reset.click();
    expect(reset.hidden).toBe(true);
    expect(page.document.activeElement === row.querySelector("input[data-option]")).toBe(true);
    // Where a search hid the first option, focus goes to the first one shown.
    (page.document.querySelector('[data-who-button="all"]') as DomElement).click();
    const list = page.document.getElementById("spoke:pick-recipients")!;
    const second = list.querySelectorAll("input[data-option]")[1] as DomInput;
    second.checked = true;
    list.dispatchEvent(new page.Event("change"));
    (list.querySelector("[data-option-row]") as DomElement).hidden = true;
    (list.querySelector(".clear") as DomElement).click();
    expect(page.document.activeElement === second).toBe(true);
  });

  test("an opened row picks its recommendation, an assumption takes agree or veto, and a question put off copies nothing until the next visit", () => {
    const page = open("spoke/decisions", {});
    const row = (k: string) => page.document.getElementById(k) as unknown as DomElement;
    const variant = row("spoke:pick-a-variant");
    (variant.querySelector("summary + div .pick") as DomElement).click();
    expect(variant.querySelector(".mark")!.textContent).toBe("✓ Variant A");
    // An assumption has no recommendation to pick: Agree and Veto answer it.
    const cache = row("spoke:cache-folder");
    expect(cache.querySelector(".pick")).toBeNull();
    const veto = cache.querySelector("input[data-stance][value=veto]") as DomInput;
    veto.checked = true;
    cache.dispatchEvent(new page.Event("change"));
    (cache.querySelector("textarea") as unknown as HTMLTextAreaElement).value = "keep a line";
    cache.querySelector("textarea")!.dispatchEvent(new page.Event("input"));
    expect(cache.querySelector(".mark")!.textContent).toBe("✓ veto");
    // The item's own task list keeps its ticks.
    expect(
      [...cache.querySelectorAll(".task-list-item-checkbox")].map((b) => (b as DomInput).checked),
    ).toEqual([true, false]);
    // Putting a question off clears its pick, and the copy leaves it out.
    const logo = row("spoke:pick-a-logo");
    (logo.querySelector(".pick") as DomElement).click();
    const later = logo.querySelector("input[data-later]") as DomInput;
    later.checked = true;
    later.dispatchEvent(new page.Event("change", { bubbles: true }));
    expect(logo.querySelectorAll("input[data-option]:checked").length).toBe(0);
    expect(logo.querySelector(".mark")!.textContent).toBe("later");
    const text = (page.document.getElementById("copy") as DomElement).dataset.hwCopy;
    expect(text).toContain("spoke:pick-a-variant: a (Variant A)");
    expect(text).toContain("spoke:cache-folder: veto, keep a line");
    expect(text).not.toContain("pick-a-logo");
    // The next visit asks it again; the answers stay.
    const back = open("spoke/decisions", {
      ...stored(page),
      "admin-answers:seen": String(Date.now() - 2 * 36e5),
    });
    expect(back.localStorage.getItem("admin-answers:spoke:pick-a-logo")).toBeNull();
    // A note written before a question is put off is its answer on the next visit.
    const review = row("spoke:check-the-copy");
    (review.querySelector("textarea") as unknown as HTMLTextAreaElement).value = "looks fine";
    review.querySelector("textarea")!.dispatchEvent(new page.Event("input"));
    const off = review.querySelector("input[data-later]") as DomInput;
    off.checked = true;
    off.dispatchEvent(new page.Event("change", { bubbles: true }));
    expect((page.document.getElementById("copy") as DomElement).dataset.hwCopy).not.toContain(
      "check-the-copy",
    );
    const next = open("spoke/decisions", {
      ...stored(page),
      "admin-answers:seen": String(Date.now() - 2 * 36e5),
    });
    expect((next.document.getElementById("copy") as DomElement).dataset.hwCopy).toContain(
      "spoke:check-the-copy: looks fine",
    );
    // An option whose key is "later" or "done" is a pick like any other.
    const variant2 = page.document.getElementById("spoke:pick-a-variant") as unknown as DomElement;
    const b = variant2.querySelector('input[data-option][value="b"]') as DomInput;
    b.value = "later";
    b.checked = true;
    variant2.dispatchEvent(new page.Event("change"));
    expect(
      JSON.parse(page.localStorage.getItem("admin-answers:spoke:pick-a-variant")!),
    ).toMatchObject({ option: "later", later: false });
    // A note is an answer: it takes a question put off up again.
    later.checked = true;
    later.dispatchEvent(new page.Event("change", { bubbles: true }));
    (logo.querySelector("textarea") as unknown as HTMLTextAreaElement).value = "ask the printer";
    logo.querySelector("textarea")!.dispatchEvent(new page.Event("input"));
    expect(later.checked).toBe(false);
    expect((page.document.getElementById("copy") as DomElement).dataset.hwCopy).toContain(
      "spoke:pick-a-logo: ask the printer",
    );
    expect(back.localStorage.getItem("admin-answers:spoke:cache-folder")).not.toBeNull();
  });

  test("an answer given before its question or options changed is no current pick and copies as given", () => {
    const at = new Date(2026, 0, 1, 9).toISOString();
    const first = open("spoke/decisions", {});
    const asked = (k: string) =>
      (first.document.getElementById(k) as unknown as HTMLElement).dataset.asked!;
    const page = open("spoke/decisions", {
      // A label the item no longer carries for its key.
      "admin-answers:spoke:pick-a-variant": JSON.stringify({
        option: "a",
        label: ["The old label"],
        asked: "older",
        note: "go",
        at,
      }),
      // Stored before answers carried their question: compared by the label they copied.
      "admin-answers:spoke:name-the-command": JSON.stringify({
        option: "short",
        label: "A short name",
        at,
      }),
      "admin-answers:spoke:pick-a-logo": JSON.stringify({ option: "v02", label: "Variant 2", at }),
      // Several picks copy each label.
      "admin-answers:spoke:pick-recipients": JSON.stringify({
        option: "ben-sample,ada-example",
        asked: asked("spoke:pick-recipients"),
        label: ["Ben Sample", "Ada Example"],
        at,
      }),
    });
    const row = (k: string) => page.document.getElementById(k)!;
    const checked = (k: string) =>
      [...row(k).querySelectorAll("input[data-option]:checked")].map((i) => (i as DomInput).value);
    expect(checked("spoke:pick-a-variant")).toEqual([]);
    expect(checked("spoke:name-the-command")).toEqual([]);
    expect(checked("spoke:pick-a-logo")).toEqual(["v02"]);
    expect(checked("spoke:pick-recipients").sort()).toEqual(["ada-example", "ben-sample"]);
    expect(row("spoke:pick-a-variant").querySelector(".mark")!.textContent).toBe(
      "! answered before the question changed",
    );
    expect(row("spoke:pick-recipients").querySelector(".mark")!.textContent).toBe("✓ 2 picked");
    const notice = row("spoke:pick-a-variant").querySelector("[data-stale]")!;
    expect(notice.hasAttribute("hidden")).toBe(false);
    expect(notice.textContent).toContain("The old label");
    expect(notice.textContent).toMatch(/1 Jan.*09:00/);
    expect(row("spoke:pick-a-logo").querySelector("[data-stale]")!.hasAttribute("hidden")).toBe(
      true,
    );
    const block = (page.document.getElementById("copy") as DomElement).dataset.hwCopy!;
    expect(block).toContain("spoke:pick-a-variant: a (The old label), go; answered ");
    expect(block).toMatch(/spoke:name-the-command: short \(A short name\); answered .*changed/);
    expect(block).toContain(
      "spoke:pick-recipients: ben-sample (Ben Sample), ada-example (Ada Example)\n",
    );
    // Lines follow the page.
    const order = [...block.matchAll(/^spoke:([\w-]+):/gm)].map((m) => m[1]);
    const onPage = [...page.document.querySelectorAll("details.item[data-k]")]
      .map((d) => (d as unknown as HTMLElement).dataset.k!.slice("spoke:".length))
      .filter((k) => order.includes(k));
    expect(order).toEqual(onPage);
    // Picking again is the answer to the question as it stands now.
    const pick = row("spoke:pick-a-variant").querySelector('input[value="b"]') as DomInput;
    pick.checked = true;
    row("spoke:pick-a-variant").dispatchEvent(new page.Event("change"));
    expect(
      JSON.parse(page.localStorage.getItem("admin-answers:spoke:pick-a-variant")!),
    ).toMatchObject({ option: "b", label: ["Variant B"], asked: asked("spoke:pick-a-variant") });
    expect(row("spoke:pick-a-variant").querySelector("[data-stale]")!.hasAttribute("hidden")).toBe(
      true,
    );
  });

  test("a copy holds what was not copied yet, and everything again once nothing is new", () => {
    const at = (h: number) => new Date(2026, 0, 1, h).toISOString();
    const page = open("spoke/decisions", {
      "admin-answers:copied": at(12),
      "admin-answers:spoke:pick-a-logo": JSON.stringify({
        option: "v02",
        label: "Variant 2",
        at: at(10),
      }),
      "admin-answers:spoke:check-the-copy": JSON.stringify({ note: "fine", at: at(13) }),
    });
    const copy = page.document.getElementById("copy") as DomElement;
    expect(copy.dataset.hwCopy).toContain("spoke:check-the-copy: fine");
    expect(copy.dataset.hwCopy).not.toContain("pick-a-logo");
    expect(copy.textContent).toBe("Copy 1 answer");
    expect(page.document.getElementById("state")!.textContent).toContain("1 not copied yet");
    expect(
      page.document.getElementById("spoke:pick-a-logo")!.querySelector(".saved")!.textContent,
    ).toBe("saved 10:00, copied 12:00");
    const done = open("spoke/decisions", { ...stored(page), "admin-answers:copied": at(14) });
    const again = done.document.getElementById("copy") as DomElement;
    expect(again.dataset.hwCopy).toContain("pick-a-logo");
    expect(again.dataset.hwCopy).toContain("check-the-copy");
    expect(again.textContent).toBe("Copy 2 answers again");
    // The row says it went out.
    expect(
      done.document.getElementById("spoke:pick-a-logo")!.querySelector(".mark")!.textContent,
    ).toContain("copied");
    // A copy made in another tab marks the rows here too.
    const mark = () =>
      page.document.getElementById("spoke:check-the-copy")!.querySelector(".mark")!.textContent;
    expect(mark()).not.toContain("copied");
    page.localStorage.setItem("admin-answers:copied", at(14));
    page.dispatchEvent(new page.StorageEvent("storage", { key: "admin-answers:copied" }));
    expect(mark()).toContain("copied");
  });

  test(
    "the fold holding a person's first question opens with the page, below a fold of work",
    async () => {
      const spoke = await readRepo(repoFrom("spoke"));
      // Alex, the hub's user, has only work in Priority 1 and every question in Priority 2.
      const items = spoke.items.map((i) => (i.id === "pick-a-variant" ? { ...i, priority: 2 } : i));
      const task = items.find((i) => i.id === "ask-the-printer")!;
      const dir = join(scratch(), "out");
      const repos = [{ ...spoke, items: [...items, { ...task, id: "alex-task", owner: "Alex" }] }];
      await buildSite(siteData(repos), dir);
      const window = new Window({ url: "http://admin.localhost/index" });
      opened.push(window);
      window.document.write(
        readForDom(join(dir, "index.html")).replace(/<script[^>]*><\/script>/g, ""),
      );
      evaluate(window, code);
      const fold = (id: string) =>
        window.document.getElementById(id)!.closest("details[data-group]") as unknown as {
          open: boolean;
        };
      expect(fold("spoke:alex-task").open).toBe(true);
      expect(fold("spoke:pick-a-variant").open).toBe(true);
    },
    testTimeout(60_000),
  );

  test("the filters: kinds counted per person, own rows once, the first fold opens, a search finds what a row says", () => {
    const page = open("index", {});
    const doc = page.document;
    const button = (attr: string, v: string) =>
      doc.querySelector(`[${attr}="${v}"]`) as unknown as HTMLButtonElement;
    const count = (k: string) =>
      button("data-kind-button", k).querySelector("[data-kind-count]")!.textContent;
    const visible = () =>
      [...doc.querySelectorAll("[data-row]")].filter(
        (r) => !r.closest("[hidden]"),
      ) as unknown as HTMLElement[];
    const openRows = [
      ...doc.querySelectorAll("details.item[data-status=open]"),
    ] as unknown as HTMLElement[];
    const first = (doc.querySelector("[data-who-button]") as unknown as HTMLElement).dataset
      .whoButton!;
    const mine = openRows.filter((r) => !r.dataset.who || r.dataset.who === first);
    expect(Number(count("all"))).toBe(mine.length);
    // Each person's button counts their open rows, All every one, which the rail's count names.
    const people = (p: string) =>
      Number(button("data-who-button", p).querySelector("[data-who-count]")!.textContent);
    expect(people(first)).toBe(mine.length);
    expect(people("all")).toBe(openRows.length);
    expect(people("all")).toBeGreaterThan(people(first));
    expect(Number(count("decision"))).toBe(
      mine.filter((r) => r.dataset.kind === "decision").length,
    );
    // A kind filters the rows.
    button("data-kind-button", "decision").click();
    expect(visible().filter((r) => r.dataset.kind && r.dataset.kind !== "decision")).toEqual([]);
    button("data-kind-button", "all").click();
    // Kim's rows show under "Needs you", not a second time under "Waiting on others".
    button("data-who-button", "Kim").click();
    const kim = doc.querySelector('[data-who-group="Kim"]')!;
    expect(kim.closest("[hidden]")).not.toBeNull();
    expect(Number(count("all"))).toBeGreaterThan(0);
    // Kim has no Priority 2 or 3 row open by default: a fold with rows opens.
    const needs = doc.querySelector("[data-who-button]")!.closest("section")!;
    expect(
      [...needs.querySelectorAll("details[data-group]")].some(
        (g) => !g.closest("[hidden]") && (g as unknown as HTMLDetailsElement).open,
      ),
    ).toBe(true);
    button("data-who-button", "all").click();
    // The hidden "updated" mark is no text a search finds.
    const search = doc.getElementById("admin-search") as DomInput;
    search.value = "updated since";
    search.dispatchEvent(new page.Event("input"));
    expect(visible()).toEqual([]);
    expect(doc.getElementById("admin-nohit")!.hasAttribute("hidden")).toBe(false);
    expect(doc.getElementById("admin-nohit")!.textContent).toContain("“updated since”");
    // Every section without a row to show steps aside, but the one holding the filters.
    const filters = button("data-who-button", "all").closest("section");
    const left = [...doc.querySelectorAll("main section")].filter((x) => !x.hasAttribute("hidden"));
    expect(left.length === 1 && (left[0] as unknown) === filters).toBe(true);
    search.value = "";
    search.dispatchEvent(new page.Event("input"));
    expect(
      [...doc.querySelectorAll("main section")].filter((x) => x.hasAttribute("hidden")).length,
    ).toBe(0);
    // Another person's row the search finds shows under "Waiting on others".
    button("data-who-button", first).click();
    search.value = "printer";
    search.dispatchEvent(new page.Event("input"));
    expect(visible().length).toBeGreaterThan(0);
    expect(doc.getElementById("admin-nohit")!.hasAttribute("hidden")).toBe(true);
    // Where no other list shows it, a row of another person the search finds is named.
    const decisions = open("spoke/decisions", { "admin-answers:who": first });
    const find = decisions.document.getElementById("admin-search") as DomInput;
    find.value = "monthly";
    find.dispatchEvent(new decisions.Event("input"));
    expect(decisions.document.getElementById("admin-nohit")!.textContent).toContain(
      "1 row of other people does",
    );
    // A link followed on the page shows its row whatever person the filter is on.
    search.value = "";
    search.dispatchEvent(new page.Event("input"));
    const other = openRows.find((r) => r.dataset.who && r.dataset.who !== first)!;
    page.location.hash = `#${other.id}`;
    page.dispatchEvent(new page.Event("hashchange"));
    expect(!!other.closest("[hidden]")).toBe(false);
  });

  test("hidden repositories: their rows leave the hub, the counts follow, the hub says so, a link still opens", () => {
    const answer = JSON.stringify({ note: "fine", at: new Date().toISOString() });
    const kept = {
      "admin-answers:repos": '["spoke"]',
      "admin-answers:spoke:check-the-copy": answer,
    };
    const page = open("index", kept);
    const doc = page.document;
    const shown = () =>
      [...doc.querySelectorAll("[data-repo]")].filter((r) => !r.closest("[hidden]")).length;
    expect(shown()).toBe(0);
    expect(doc.querySelector('[data-kind-button="all"] [data-kind-count]')!.textContent).toBe("0");
    expect(doc.querySelector("[data-repo-count]")!.textContent).toBe("0 of 1");
    // The fixture's admin.label names it wherever a person reads it; the key stays its address.
    expect(doc.querySelector("[data-repo-said]")!.textContent).toBe(
      "1 repository hidden: Sample spoke.",
    );
    expect(
      doc.querySelector('[data-repo-box][value="spoke"]')!.closest("label")!.textContent,
    ).toMatch(/^\s*Sample spoke\s+spoke\s*$/);
    expect(doc.querySelector('[data-repo-row="spoke"] a')!.textContent!.trim()).toBe(
      "Sample spoke",
    );
    expect(
      open("spoke/decisions", null).document.querySelector(".hw-nav-group")!.textContent!.trim(),
    ).toBe("Sample spoke");
    expect(
      doc.querySelector('[data-repo-row="spoke"] [data-repo-off]')!.hasAttribute("hidden"),
    ).toBe(false);
    // The choice is no answer: the copy holds the one answer alone.
    const copy = (doc.getElementById("copy") as DomElement).dataset.hwCopy!;
    expect(copy).toBe("Answers from the admin pages:\nspoke:check-the-copy: fine");
    // A search finding rows only there says so.
    const search = doc.getElementById("admin-search") as DomInput;
    search.value = "monthly";
    search.dispatchEvent(new page.Event("input"));
    expect(doc.getElementById("admin-nohit")!.textContent).toMatch(/rows? in hidden repositories/);
    search.value = "";
    search.dispatchEvent(new page.Event("input"));
    // A link to an item there opens it.
    page.location.hash = "#spoke:pick-a-variant";
    page.dispatchEvent(new page.Event("hashchange"));
    expect(!!doc.getElementById("spoke:pick-a-variant")!.closest("[hidden]")).toBe(false);
    // Another page hides nothing by repository.
    const decisions = open("spoke/decisions", kept);
    expect(decisions.document.querySelector("details.item:not([hidden])")).not.toBeNull();
    // "Show all" brings every row back and forgets the choice.
    (doc.querySelector("[data-repo-all]") as unknown as HTMLButtonElement).click();
    expect(shown()).toBeGreaterThan(0);
    expect(stored(page)["admin-answers:repos"]).toBeUndefined();
    expect(doc.querySelector("[data-repo-said]")!.textContent).toBe("");
    // "Hide all" unchecks every box and keeps the choice; with nothing left to hide it steps aside.
    const none = doc.querySelector("[data-repo-none]") as unknown as HTMLButtonElement;
    expect(none.hasAttribute("hidden")).toBe(false);
    none.click();
    expect(shown()).toBe(1);
    expect(stored(page)["admin-answers:repos"]).toBe('["spoke"]');
    expect(doc.querySelector("[data-repo-count]")!.textContent).toBe("0 of 1");
    expect(none.hasAttribute("hidden")).toBe(true);
    expect(doc.querySelector("[data-repo-all]")!.hasAttribute("hidden")).toBe(false);
    // Each steps aside; focus goes to the choice's own button rather than the page's top.
    const choice = doc.querySelector("[popovertarget=admin-repo-choice]");
    expect(doc.activeElement === choice).toBe(true);
    (doc.querySelector("[data-repo-all]") as unknown as HTMLButtonElement).click();
    expect(doc.activeElement === choice).toBe(true);
    // Unchecking the box hides it again and keeps the choice.
    const box = doc.querySelector('[data-repo-box][value="spoke"]') as unknown as DomInput;
    box.checked = false;
    box.dispatchEvent(new page.Event("change"));
    // All but the row the address names.
    expect(shown()).toBe(1);
    expect(stored(page)["admin-answers:repos"]).toBe('["spoke"]');
    // Once the address names another row, the row it named before hides with its repository.
    page.location.hash = "";
    page.dispatchEvent(new page.Event("hashchange"));
    expect(shown()).toBe(0);
    // Another tab showing it again shows it here, and a write of anything else leaves a note being
    // typed as it is.
    page.localStorage.removeItem("admin-answers:repos");
    page.dispatchEvent(new page.StorageEvent("storage", { key: "admin-answers:repos" }));
    expect(shown()).toBeGreaterThan(0);
    const note = doc.querySelector(
      '[data-k="spoke:check-the-copy"] textarea',
    ) as unknown as DomInput;
    note.value = "fine ";
    page.dispatchEvent(new page.StorageEvent("storage", { key: "admin-answers:seen" }));
    expect(note.value).toBe("fine ");
    // The word on a repository's "hidden" mark is no text a search finds.
    search.value = "hidden";
    search.dispatchEvent(new page.Event("input"));
    expect(doc.querySelector('[data-repo-row="spoke"]')!.hasAttribute("hidden")).toBe(true);
  });

  test("a new visit starts on the hub's user; a link to an item gone says so", () => {
    const hours = (h: number) => String(Date.now() - h * 36e5);
    const pressed = (w: Window) =>
      (w.document.querySelector('[data-who-button][aria-pressed="true"]') as unknown as HTMLElement)
        .dataset.whoButton;
    const later = open("index", { "admin-answers:who": "Kim", "admin-answers:seen": hours(0.5) });
    expect(pressed(later)).toBe("Kim");
    const back = open("index", { "admin-answers:who": "Kim", "admin-answers:seen": hours(30) });
    expect(pressed(back)).not.toBe("Kim");
    const window = new Window({ url: "http://admin.localhost/spoke/decisions#spoke:gone-item" });
    opened.push(window);
    window.document.write(
      readForDom(join(out, "spoke/decisions.html")).replace(/<script[^>]*><\/script>/g, ""),
    );
    evaluate(window, code);
    const gone = window.document.getElementById("admin-gone")!;
    expect(gone.hasAttribute("hidden")).toBe(false);
    expect(gone.textContent).toContain("spoke:gone-item is no longer open");
  });

  test("returning exactly an hour later keeps the selected person for the same visit", () => {
    const seen = Date.UTC(2026, 0, 1, 9);
    const page = open(
      "index",
      { "admin-answers:who": "Kim", "admin-answers:seen": String(seen) },
      seen + 36e5,
    );
    expect(
      page.document
        .querySelector('[data-who-button][aria-pressed="true"]')
        ?.getAttribute("data-who-button"),
    ).toBe("Kim");
  });

  const commentField = (w: Window) =>
    w.document.querySelector<DomTextArea>("#next + [data-comment] textarea")!;
  const typeComment = (w: Window) => {
    const field = commentField(w);
    field.value = "why   dotted?\n  Any reason?";
    field.dispatchEvent(new w.Event("input", { bubbles: true }));
  };
  const commentKey = "admin-answers:" + COMMENT;
  const copiedComment = (w: Window): Record<string, string> => ({
    ...stored(w),
    "admin-answers:copied": new Date(Date.now() + 1000).toISOString(),
  });

  test("a heading comment copies exactly one line, survives reload, and resets", () => {
    const first = open(SAMPLE_REPORT, {});
    expect(first.document.querySelector("#next + [data-comment]")?.hasAttribute("open")).toBe(
      false,
    );
    typeComment(first);
    const copy = first.document.getElementById("copy")!;
    expect(copy.getAttribute("data-hw-copy")).toBe(
      "Answers from the admin pages:\nspoke:2026-01-15-sample-topic#next: why dotted? Any reason?",
    );
    expect(copy.textContent).toBe("Copy 1 answer");
    const back = open(SAMPLE_REPORT, copiedComment(first));
    expect(commentField(back).value).toBe("why   dotted?\n  Any reason?");
    expect(back.document.querySelector('[data-k="' + COMMENT + '"] .mark')?.textContent).toBe(
      "✓ comment · copied",
    );
    expect(back.document.getElementById("copy")?.textContent).toBe("Copy 1 answer again");
    (back.document.querySelector('[data-k="' + COMMENT + '"] .clear') as DomElement).click();
    expect(stored(back)[commentKey]).toBeUndefined();
  });

  test("a copied comment stays until the report version changes", () => {
    const first = open(SAMPLE_REPORT, {});
    typeComment(first);
    const copied = copiedComment(first);
    const same = open(SAMPLE_REPORT, copied);
    expect(stored(same)[commentKey]).toBe(copied[commentKey]);
    const written = {
      ...(JSON.parse(copied[commentKey]!) as Record<string, unknown>),
      version: "earlier",
    };
    const changed = open(SAMPLE_REPORT, { ...copied, [commentKey]: JSON.stringify(written) });
    expect(commentField(changed).value).toBe("");
    expect(stored(changed)[commentKey]).toBeUndefined();
    const unsent = open(SAMPLE_REPORT, { ...stored(first), [commentKey]: JSON.stringify(written) });
    expect(commentField(unsent).value).toContain("why");
  });

  test("a raw heading id keeps Unicode and cannot add a line to the copy block", () => {
    const page = open(rawReport, {});
    const heading = [...page.document.querySelectorAll("article h2")].find(
      (h) => h.textContent === "Überblick",
    )!;
    const id = "überblick_日本語-١-cafe\u0301-spoke-pick-a-variant--a--Variant-A--x";
    expect(heading.id).toBe(id);
    const field = heading.nextElementSibling!.querySelector<DomTextArea>("textarea")!;
    field.value = "Review this paragraph.";
    field.dispatchEvent(new page.Event("input", { bubbles: true }));
    expect(page.document.getElementById("copy")!.getAttribute("data-hw-copy")).toBe(
      `Answers from the admin pages:\nspoke:2026-01-13-raw-heading#${id}: Review this paragraph.`,
    );
  });

  test("nested raw headings label each comment with its own text", () => {
    const page = open(rawReport, {});
    const labels = [...page.document.querySelectorAll("[data-comment] label")];
    expect(labels.slice(1).map((el) => el.textContent)).toEqual([
      "Comment on Inner",
      "Comment on Outer tail",
    ]);
  });

  test("raw report data leaves the copied comment and report version alone", () => {
    const first = open(SAMPLE_REPORT, {});
    typeComment(first);
    const storage = copiedComment(first);
    const doc = open(rawDoc, storage);
    expect(doc.document.querySelector("article span")?.outerHTML).toBe("<span>Sample span</span>");
    expect(stored(doc)[commentKey]).toBe(storage[commentKey]);
    expect(stored(doc)["admin-answers:versions"]).toBe(storage["admin-answers:versions"]);
  });

  test("raw markup loses unknown data attributes and keeps its popover target", () => {
    const { document } = open(rawDoc, {});
    expect(document.querySelector("article span")?.hasAttribute("data-sample")).toBe(false);
    expect(document.querySelector("article button")?.getAttribute("popovertarget")).toBe(
      "admin-repo-choice",
    );
  });

  test("a raw comment field can take input without attaching to the answer store", () => {
    const page = open("spoke/doc/docs/comment-field", {});
    const errors: unknown[] = [];
    page.addEventListener("error", (event) => errors.push(event));
    const field = page.document.querySelector<DomTextArea>("article textarea")!;
    field.value = "Sample field";
    field.dispatchEvent(new page.Event("input", { bubbles: true }));
    expect(errors).toEqual([]);
    expect(field.closest("details")?.hasAttribute("data-comment")).toBe(false);
    expect(stored(page)["admin-answers:x"]).toBeUndefined();
  });

  test("Docs clears a copied comment when its report version changes", () => {
    const first = open(SAMPLE_REPORT, {});
    typeComment(first);
    const copied = copiedComment(first);
    expect(stored(open("spoke/docs", copied))[commentKey]).toBe(copied[commentKey]);
    const written = {
      ...(JSON.parse(copied[commentKey]!) as Record<string, unknown>),
      version: "earlier",
    };
    const changed = open("spoke/docs", { ...copied, [commentKey]: JSON.stringify(written) });
    expect(stored(changed)[commentKey]).toBeUndefined();
  });

  test("a visit to the hub or Decisions keeps a copied comment and the report's change mark", () => {
    const first = open(SAMPLE_REPORT, {});
    typeComment(first);
    const storage = copiedComment(first);
    const versions = JSON.parse(storage["admin-answers:versions"]!) as Record<string, string>;
    expect(versions[sampleVersionKey]).toBeTruthy();
    for (const path of ["index", "spoke/decisions"]) {
      const away = stored(open(path, storage));
      expect(away[commentKey], path).toBe(storage[commentKey]);
      const awayVersions = JSON.parse(away["admin-answers:versions"]!) as Record<string, string>;
      expect(awayVersions[sampleVersionKey], path).toBe(versions[sampleVersionKey]);

      const back = stored(
        open(SAMPLE_REPORT, {
          ...away,
          "admin-answers:seen": String(Date.now() - 2 * 36e5),
          "admin-answers:versions": JSON.stringify({
            ...awayVersions,
            [sampleVersionKey]: "old-report-hash",
          }),
        }),
      );
      const marked = open(SAMPLE_REPORT, stored(open(path, back)));
      expect(marked.document.querySelector("article [data-report]")?.textContent, path).toMatch(
        /^Changed since your last visit · Last changed /,
      );
    }
  });

  test("a report row says it changed since the visit before on Docs and Latest reports", () => {
    const old = Date.now() - 2 * 36e5;
    for (const path of ["spoke/docs", "spoke/dashboard"]) {
      const mark = (w: Window) => w.document.querySelector("[data-report] [data-updated]")!;
      expect(mark(open(path, {})).hasAttribute("hidden")).toBe(true);
      const back = open(path, { "admin-answers:seen": String(old) });
      expect(mark(back).hasAttribute("hidden")).toBe(false);
      expect(mark(back).textContent).toBe("Changed since your last visit");
      const first = stored(open(path, {}));
      const versions = JSON.parse(first["admin-answers:versions"]!) as Record<string, string>;
      expect(versions["#spoke:2026-01-15-sample-topic"]).toBeTruthy();
    }
  });

  test("an item changed since the visit before says so; a first visit marks nothing", () => {
    const shown = (w: Window) =>
      w.document.querySelectorAll("[data-row] [data-updated]:not([hidden])").length;
    expect(shown(open("index", {}))).toBe(0);
    const hours = (h: number) => String(Date.now() - h * 36e5);
    // Two hours away: every item of the fixture's one commit is newer than the last visit.
    const back = open("index", { "admin-answers:seen": hours(2) });
    expect(shown(back)).toBeGreaterThan(0);
    expect(Number(stored(back)["admin-answers:visit"])).toBeLessThan(Date.now() - 36e5);
    // A page view within the hour belongs to the same visit, and keeps its marks.
    expect(shown(open("spoke/work", stored(back)))).toBeGreaterThan(0);
    // Each fold that holds a marked row counts it, and the page says how many changed.
    const fold = back.document.querySelector(
      "details[data-group] [data-updated-count]:not([hidden])",
    )!;
    expect(fold.textContent).toMatch(/\d+ updated/);
    expect(back.document.getElementById("admin-since")!.textContent).toContain(
      "changed since your last visit",
    );
    // A hidden repository's rows count nowhere.
    const away = open("index", {
      "admin-answers:seen": hours(2),
      "admin-answers:repos": '["spoke"]',
    });
    expect(away.document.querySelector("[data-updated-count]:not([hidden])")).toBeNull();
    expect(away.document.getElementById("admin-since")!.hasAttribute("hidden")).toBe(true);
    // But the row a link opens there.
    away.location.hash = "#spoke:check-the-copy";
    away.dispatchEvent(new away.Event("hashchange"));
    expect(away.document.getElementById("admin-since")!.textContent?.startsWith("1 item ")).toBe(
      true,
    );
  });

  test("a row shown on the visit before compares its file, not its commit time", () => {
    const first = stored(open("index", {}));
    const saved: unknown = JSON.parse(first["admin-answers:versions"]!);
    if (
      !saved ||
      typeof saved !== "object" ||
      Array.isArray(saved) ||
      !Object.values(saved).every((version: unknown) => typeof version === "string")
    )
      throw new Error("Expected stored versions to map row keys to strings");
    const versions = saved as Record<string, string>;
    const [changed] = Object.keys(versions);
    // Every item's commit is newer than the visit, but only one file differs from what it showed.
    const back = open("index", {
      "admin-answers:seen": String(Date.now() - 2 * 36e5),
      "admin-answers:versions": JSON.stringify({ ...versions, [changed!]: "older" }),
    });
    const marked = [...back.document.querySelectorAll("[data-row]")].filter((r) =>
      r.querySelector("[data-updated]:not([hidden])"),
    );
    expect([...new Set(marked.map((r) => (r as unknown as HTMLElement).dataset.k))]).toEqual([
      changed,
    ]);
    // A stored question that differs says the question changed; the file alone, that it was edited.
    const [file] = versions[changed!].split(" ");
    const asked = open("index", {
      "admin-answers:seen": String(Date.now() - 2 * 36e5),
      "admin-answers:versions": JSON.stringify({ ...versions, [changed!]: "older older" }),
    });
    const mark = (w: Window) =>
      w.document.querySelector(`[data-k="${changed}"] [data-updated]`)!.textContent;
    // The row's mark is short: the line above the lists says since when.
    expect(mark(asked)).toBe("question or options changed ·");
    const edited = open("index", {
      "admin-answers:seen": String(Date.now() - 2 * 36e5),
      "admin-answers:versions": JSON.stringify({
        ...versions,
        [changed!]: `older ${versions[changed!].split(" ")[1]}`,
      }),
    });
    expect(mark(edited)).toBe("edited ·");
    expect(file).toBeTypeOf("string");
  });
});

describe("serve", () => {
  test(
    "refreshes the behind count when the push remote changes without moving refs",
    async () => {
      const origin = repoFrom("spoke");
      const root = scratch();
      const clone = join(root, "spoke");
      sh(root, "git", "clone", "-q", origin, clone);
      sh(clone, "git", "config", "push.default", "current");
      sh(clone, "git", "remote", "add", "mirror", origin);
      writeFileSync(join(origin, "extra.md"), "# Extra\n");
      sh(origin, "git", "add", "extra.md");
      commit(origin, "extra");
      sh(clone, "git", "fetch", "-q", "mirror");
      const hub = createHub({ root });
      expect((await hub.pages()).repos[0]?.behind).toBe(0);
      sh(clone, "git", "config", "branch.main.pushRemote", "mirror");
      expect((await hub.pages()).repos[0]?.behind).toBe(1);
    },
    testTimeout(120_000),
  );

  test(
    "rebuilds on a new day, since a due date comes within a week with no commit",
    async () => {
      const hub = createHub({ root: dirname(repoFrom("spoke")) });
      const first = await hub.pages();
      expect(await hub.pages()).toBe(first);
      const now = Date.now;
      Date.now = () => now() + 864e5;
      try {
        expect(await hub.pages()).not.toBe(first);
      } finally {
        Date.now = now;
      }
    },
    testTimeout(120_000),
  );

  test(
    "a fetch that moves no ref rebuilds nothing, and the pages print its time",
    async () => {
      const repo = repoFrom("spoke");
      const hub = createHub({ root: dirname(repo) });
      const get = async (path: string) =>
        (await hub.fetch(new Request(`http://admin.localhost${path}`))).text();
      await hub.pages();
      const head = join(repo, ".git/FETCH_HEAD");
      writeFileSync(head, "");
      utimesSync(head, new Date(2026, 0, 2, 9, 5), new Date(2026, 0, 2, 9, 5));
      // A first fetch changes what the pages say: fetched or never.
      const fetched = await hub.pages();
      // The build runs in a child, whose time zone the test runner does not set.
      const at = (page: string) => page.match(/fetched <span data-stamp>([^<]+)</)?.[1];
      const before = at(await get("/spoke/dashboard"));
      expect(before).toBeTypeOf("string");
      utimesSync(head, new Date(2026, 0, 3, 10, 7), new Date(2026, 0, 3, 10, 7));
      expect(await hub.pages()).toBe(fetched);
      const after = at(await get("/spoke/dashboard"));
      expect(after).not.toBe(before);
      // As a build from scratch prints it.
      const fresh = createHub({ root: dirname(repo) });
      const control = await (
        await fresh.fetch(new Request("http://admin.localhost/spoke/dashboard"))
      ).text();
      expect(after).toBe(at(control));
    },
    testTimeout(120_000),
  );

  test(
    "a doc's javascript: link renders as text on the served hub",
    async () => {
      const repo = repoFrom("spoke");
      writeFileSync(
        join(repo, "docs/x.md"),
        "# X\n\n[run](javascript:alert(1)) [ok](https://a.test/)\n",
      );
      sh(repo, "git", "add", "docs/x.md");
      commit(repo, "x");
      const hub = createHub({ root: dirname(repo) });
      const page = await (
        await hub.fetch(new Request("http://admin.localhost/spoke/doc/docs/x"))
      ).text();
      expect(page).toContain('href="https://a.test/"');
      expect(page).not.toContain("javascript:");
    },
    testTimeout(60_000),
  );

  test(
    "serves committed pages and files, rebuilding only after a commit",
    async () => {
      const repo = repoFrom("spoke");
      const hub = createHub({ root: dirname(repo) });
      const get = (path: string) => hub.fetch(new Request(`http://admin.localhost${path}`));
      const asked = Date.now();
      const first = await (await get("/")).text();
      expect(first).toContain("Which variant ships?");
      expect(first).not.toContain("file://");
      expect(first).toContain("/_file/spoke/docs/agent-work/");
      const decisions = await get("/spoke/decisions");
      expect(decisions.status).toBe(200);
      expect(decisions.headers.get("content-security-policy")).toBe(csp("http://admin.localhost"));
      expect(csp("http://admin.localhost")).toMatch(
        /(^|; )script-src http:\/\/admin\.localhost\/_astro\/(;|$)/,
      );
      // A committed form posts nowhere else, and no outside page is framed into the hub.
      expect(csp("http://admin.localhost")).toMatch(/(^|; )form-action 'self'(;|$)/);
      expect(csp("http://admin.localhost")).toMatch(/(^|; )frame-src 'self'(;|$)/);
      // Nothing a body commits loads from elsewhere, so no image or stylesheet reports a view or
      // reads the page out; a catalog's dev server is still asked whether it runs.
      for (const directive of [
        "default-src 'self'",
        "img-src 'self' data:",
        "style-src 'self' 'unsafe-inline'",
        "connect-src 'self' http://127.0.0.1:* http://localhost:*",
        "frame-ancestors 'self'",
      ])
        expect(csp("http://admin.localhost").split("; ")).toContain(directive);
      // A page elsewhere may link the hub, but loads nothing from it to learn what exists.
      const from = (site: string, mode: string, dest: string) =>
        hub.fetch(
          new Request("http://admin.localhost/_file/spoke/scripts/sample.ts", {
            headers: { "sec-fetch-site": site, "sec-fetch-mode": mode, "sec-fetch-dest": dest },
          }),
        );
      expect((await from("cross-site", "no-cors", "script")).status).toBe(403);
      // Another port of this machine is the same site, and asks no more than a site elsewhere.
      expect((await from("same-site", "cors", "empty")).status).toBe(403);
      expect((await from("cross-site", "navigate", "document")).status).toBe(200);
      expect((await from("same-site", "navigate", "document")).status).toBe(200);
      expect((await from("same-origin", "no-cors", "script")).status).toBe(200);
      expect((await from("none", "navigate", "document")).status).toBe(200);
      expect(decisions.headers.get("x-content-type-options")).toBe("nosniff");
      expect(decisions.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      for (const bare of ["/spoke", "/spoke/?who=A"]) {
        const r = await get(bare);
        expect([r.status, r.headers.get("location")]).toEqual([
          302,
          `http://admin.localhost/spoke/dashboard${bare.slice(6).replace(/^\//, "")}`,
        ]);
      }
      const none = await get("/nosuchrepo/");
      expect(none.status).toBe(404);
      // In the hub's styles, with the way back.
      const lost = await none.text();
      expect(lost).toMatch(/<a class="hw-link" href="\/index\.html">\s*Open the hub\s*<\/a>/);
      expect(lost).toMatch(/<link rel="stylesheet" href="\/_astro\/[^"]+\.css">/);
      expect(lost).not.toMatch(/(?:href|src)="(?!\/|#|[a-z]+:)/);
      expect((await get("/index.html")).status).toBe(200);
      expect(lost).toContain("Nothing on the hub answers at /nosuchrepo/:");
      for (const own of ["/404", "/404.html"]) {
        const r = await get(own);
        expect([r.status, (await r.text()).includes("admin-missing-path")]).toEqual([404, false]);
      }
      expect(await (await get("/a/<b>")).text()).toContain("answers at /a/%3Cb%3E:");
      // The hub says it is current as of the request, in the minute it was asked or the next.
      const stamp = first.match(/· as of <span data-stamp>([^<]*)<\/span>/)?.[1];
      expect([when(asked), when(Date.now())]).toContain(stamp!);
      // So does the hub's other page, a day after its build.
      const later = Date.now() + 864e5;
      const clock = vi.spyOn(Date, "now").mockReturnValue(later);
      const packages = await (await get("/architecture")).text();
      clock.mockRestore();
      expect(packages).toContain(`· as of <span data-stamp>${when(later)}</span>`);
      const nested = await decisions.text();
      // A page travels gzipped where the browser takes it, and a hashed asset stays in its cache.
      const zipped = await hub.fetch(
        new Request("http://admin.localhost/spoke/decisions", {
          headers: { "accept-encoding": "gzip, br" },
        }),
      );
      expect(zipped.headers.get("content-encoding")).toBe("gzip");
      expect(sansNonce(new TextDecoder().decode(Bun.gunzipSync(await zipped.bytes())))).toBe(
        sansNonce(nested),
      );
      const css = first.match(/href="\.\/(_astro\/[^"]+\.css)"/)![1]!;
      expect((await get(`/${css}`)).headers.get("cache-control")).toContain("immutable");
      expect(decisions.headers.get("cache-control")).toBe("no-store");
      // Every script, on the hub and on a nested page, resolves under the one path the policy runs.
      for (const [page, html] of [
        ["/", first],
        ["/spoke/decisions", nested],
      ] as const) {
        const srcs = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]!);
        expect(srcs.length).toBeGreaterThan(0);
        for (const src of srcs)
          expect(
            new URL(src, `http://admin.localhost${page}`).pathname.startsWith("/_astro/"),
          ).toBe(true);
      }
      for (const query of ["", "?who=A"]) {
        const slash = await get(`/spoke/decisions/${query}`);
        expect([slash.status, slash.headers.get("location")]).toEqual([
          302,
          `http://admin.localhost/spoke/decisions${query}`,
        ]);
      }
      const svg = await get("/_file/spoke/docs/agent-work/2026-01-15-sample-topic/variant-a.svg");
      expect(svg.headers.get("content-type")).toContain("image/svg");
      writeFileSync(join(repo, "uncommitted.txt"), "uncommitted");
      expect((await get("/_file/spoke/node_modules/..%2Funcommitted.txt")).status).toBe(404);
      Bun.spawnSync(["mkdir", "-p", join(repo, "node_modules/pkg")]);
      writeFileSync(join(repo, "node_modules/pkg/tokens.css"), ":root{}");
      expect(await (await get("/_file/spoke/node_modules/pkg/tokens.css")).text()).toBe(":root{}");
      const outside = scratch();
      writeFileSync(join(outside, "secret.txt"), "secret");
      symlinkSync(outside, join(repo, "node_modules/escape"));
      symlinkSync(join(outside, "secret.txt"), join(repo, "node_modules/pkg/secret.txt"));
      expect((await get("/_file/spoke/node_modules/escape/secret.txt")).status).toBe(404);
      expect((await get("/_file/spoke/node_modules/pkg/secret.txt")).status).toBe(404);
      expect((await hub.fetch(new Request("http://evil.example/"))).status).toBe(403);
      const oid = "ab".repeat(32);
      const store = join(repo, ".git/lfs/objects/ab/ab");
      Bun.spawnSync(["mkdir", "-p", store]);
      writeFileSync(join(store, oid), "<svg>stored</svg>");
      writeFileSync(
        join(repo, "docs/agent-work/lfs.svg"),
        `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 17\n`,
      );
      sh(repo, "git", "add", "docs/agent-work/lfs.svg");
      commit(repo, "l");
      expect(await (await get("/_file/spoke/docs/agent-work/lfs.svg")).text()).toBe(
        "<svg>stored</svg>",
      );
      const item = join(repo, "docs/agent-work/items/check-the-copy.md");
      writeFileSync(item, readFileSync(item, "utf8").replace("# ", "# Renamed "));
      const cached = await hub.pages();
      expect(await hub.pages()).toBe(cached);
      sh(
        repo,
        "git",
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "commit",
        "-qam",
        "r",
      );
      expect(await hub.pages()).not.toBe(cached);
      expect(await (await get("/")).text()).toContain("Renamed ");
    },
    testTimeout(60_000),
  );

  test(
    "a failed read or build shows on every page and is tried again once a state moves or a minute passed",
    async () => {
      const repo = repoFrom("spoke");
      const second = join(dirname(repo), "second");
      cpSync(repo, second, { recursive: true });
      // A missing object reads as a failed git call, never as a repository without items.
      const blob = sh(second, "git", "rev-parse", "HEAD:docs/agent-work/items/goal.md").trim();
      const object = join(second, ".git/objects", blob.slice(0, 2), blob.slice(2));
      const bytes = readFileSync(object);
      rmSync(object);
      const now = Date.now;
      const later = (ms: number) => (Date.now = () => now() + ms);
      const hub = createHub({ root: dirname(repo) });
      const get = async (path: string) =>
        (await hub.fetch(new Request(`http://admin.localhost${path}`))).text();
      const notice = (html: string) =>
        html.match(/<div id="admin-problem"[^>]*>[\s\S]*?<\/div>/)![0];
      const first = await hub.pages();
      expect(notice(await get("/"))).toContain("second could not be read: git cat-file answered");
      expect(notice(await get("/spoke/doc/docs/agent-work/2026-01-15-sample-topic"))).toContain(
        "It is left out.",
      );
      expect(await hub.pages()).toBe(first);
      const spawn = Bun.spawn;
      let builds = 0;
      const failing = vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[], opts: object) => {
        if (!cmd[1]?.endsWith("serve.ts")) return spawn(cmd, opts as never);
        builds++;
        return spawn(
          [process.execPath, "-e", "console.error('TypeError: boom'); process.exit(1)"],
          {
            stderr: "pipe",
          },
        );
      }) as typeof Bun.spawn);
      try {
        writeFileSync(join(repo, "moved.md"), "# Moved\n");
        sh(repo, "git", "add", "moved.md");
        commit(repo, "m");
        // The last pages stay on show, saying since when.
        expect(await hub.pages()).toBe(first);
        expect(await hub.pages()).toBe(first);
        expect(builds).toBe(1);
        expect(notice(await get("/spoke/dashboard"))).toMatch(
          /could not rebuild on [^<]+<\/b> These pages show the repositories as of [\s\S]*The build stopped: build failed: TypeError: boom/,
        );
        later(61_000);
        expect(await hub.pages()).toBe(first);
        expect(builds).toBe(2);
      } finally {
        Date.now = now;
        failing.mockRestore();
      }
      writeFileSync(join(repo, "moved.md"), "# Moved again\n");
      sh(repo, "git", "add", "moved.md");
      commit(repo, "n");
      expect(await hub.pages()).not.toBe(first);
      expect(notice(await get("/"))).not.toContain("The build stopped");
      expect(await get("/")).toContain("second could not be read");
      // A read that failed for a passing cause comes back a minute later, with no commit there.
      writeFileSync(object, bytes);
      try {
        // Past the retry the mocked minute above set.
        later(125_000);
        expect(await get("/")).not.toContain("could not be read");
      } finally {
        Date.now = now;
      }
      // A read failing at a new state, then the state its last read was taken at again: the notice
      // goes, since the pages show that state.
      rmSync(object);
      sh(second, "git", "tag", "t");
      expect(await get("/")).toContain("second could not be read");
      writeFileSync(object, bytes);
      sh(second, "git", "tag", "-d", "t");
      expect(await get("/")).not.toContain("could not be read");
    },
    testTimeout(120_000),
  );

  test(
    "two checkouts with one key, or a key the hub's pages take, each keep their own pages",
    async () => {
      const repo = repoFrom("spoke", "catalog");
      const root = dirname(repo);
      for (const at of ["a", "b"]) cpSync(repo, join(root, at, "web"), { recursive: true });
      writeFileSync(join(root, "b/web/README.md"), "# Only in b\n");
      sh(join(root, "b/web"), "git", "add", "README.md");
      commit(join(root, "b/web"), "b");
      const hub = createHub({ root });
      const get = async (path: string) =>
        (await hub.fetch(new Request(`http://admin.localhost${path}`))).text();
      const home = await get("/");
      for (const key of ["a-web", "b-web", `${basename(root)}-catalog`])
        expect(home).toContain(`>${key}<`);
      expect(home).toContain("key web names another checkout too: its pages are under b-web");
      expect(await get("/b-web/doc/README")).toContain("Only in b");
      // Two checkouts giving one label each name their folder beside it; one without goes by its key.
      const renamed = uniqueKeys([
        await configured("/n/a/web", { label: "Web" }),
        await configured("/n/b/web", { label: "Web" }),
        await configured("/n/c/web", {}),
      ]);
      expect(siteData(renamed).repos.map((r) => [r.key, r.label])).toEqual([
        ["c-web", "c-web"],
        ["a-web", "Web (a)"],
        ["b-web", "Web (b)"],
      ]);
      expect(await get("/a-web/doc/README")).toContain("<h1>No such page</h1>");
    },
    testTimeout(120_000),
  );

  test(
    "serves the topic report as built and fills other reports and docs from shells",
    async () => {
      // A path with characters a page escapes in its attributes.
      const plain = repoFrom("spoke");
      const repo = join(dirname(plain), "o'neil & co", "spoke");
      cpSync(plain, repo, { recursive: true });
      rmSync(plain, { recursive: true, force: true });
      mkdirSync(join(repo, "docs/guide"), { recursive: true });
      const files: Record<string, string> = {
        "README.md":
          "# Read me\n\nSee [setup](docs/guide/index.md#setup) and [notes](docs/c%23-notes.md).\n",
        "docs/guide/index.md": "# Guide\n\n## Setup\n",
        "docs/agent-work/2026-01-14-standalone.md":
          "# Standalone\n\n" +
          ["One", "Two", "Three", "Four", "Five"].map((h) => `## ${h}\n\n`).join(""),
        "docs/shell-html.md": "# admin-shell-html\n\nSample body.\n",
        "docs/shell-title.md": "# admin-shell-title\n\nAnother body.\n",
        "docs/c#-notes.md": "# C# notes & more\n",
        "docs/50% off.md": "# Half off\n",
        "docs/rock & roll's.md": "# Rock and roll\n",
      };
      for (const [path, text] of Object.entries(files)) writeFileSync(join(repo, path), text);
      sh(repo, "git", "add", "-A");
      commit(repo, "docs");
      const hub = createHub({ root: dirname(repo) });
      const at = "http://admin.localhost/spoke/docs";
      const get = (path: string) => hub.fetch(new Request(new URL(path, at)));
      const list = await (await get(at)).text();
      const data = await readRepo(repo);
      for (const doc of [...data.reports, ...data.docs]) {
        const link = list.match(
          new RegExp(`href="([^"]+)">\\s*${RegExp.escape(Bun.escapeHTML(doc.title))}`),
        );
        const page = await get(link![1]!);
        expect([doc.path, page.status]).toEqual([doc.path, 200]);
        expect(await page.text()).toContain(
          `<h1 id="${doc.titleId}">${Bun.escapeHTML(doc.title)}</h1>`,
        );
      }
      const readme = await (await get("/spoke/doc/README")).text();
      // A link to another doc opens its page, the fragment kept.
      expect(readme).toContain('href="/spoke/doc/docs/guide/index.md#setup"');
      expect(readme).toContain('href="/spoke/doc/docs/c%23-notes"');
      expect((await get("/spoke/doc/docs/c%23-notes")).status).toBe(200);
      const notes = await (await get("/spoke/doc/docs/c%23-notes")).text();
      expect(notes).toContain("<title>C# notes &amp; more · Sample spoke · Admin</title>");
      expect(notes).toContain('href="/_file/spoke/docs/c%23-notes.md"');
      expect(await (await get("/_file/spoke/docs/c%23-notes.md")).text()).toBe(
        files["docs/c#-notes.md"],
      );
      expect(await (await get("/spoke/doc/docs/rock%20&%20roll's")).text()).toContain(
        'href="/_file/spoke/docs/rock%20%26%20roll%27s.md"',
      );
      // A doc's address with a slash leads to it.
      const slash = await get("/spoke/doc/README/?x=1");
      expect([slash.status, slash.headers.get("location")]).toEqual([
        302,
        "http://admin.localhost/spoke/doc/README?x=1",
      ]);
      const docFor = async (path: string) => {
        const doc = new Window().document;
        doc.body.innerHTML = domMarkup.transform(await (await get(path)).text());
        return doc;
      };
      const topic = await docFor("/" + SAMPLE_REPORT);
      const options = topic.querySelector('details.item[id="spoke:pick-a-variant"]');
      expect(options).not.toBeNull();
      expect(options!.querySelector('input[data-option][value="a"]')).not.toBeNull();
      expect(options!.querySelector(".pick")?.textContent).toContain("Pick recommended");
      const graph = topic.querySelector("details:has(figure.admin-diagram)")!;
      expect(graph.hasAttribute("open")).toBe(false);
      expect(graph.querySelectorAll("svg .node")).toHaveLength(4);
      expect(graph.querySelectorAll("svg .edge")).toHaveLength(2);
      const settled = topic.getElementById("spoke:cache-folder")!;
      expect(settled.closest("[data-group]")?.querySelector("summary")?.textContent).toContain(
        "Assumed and decided",
      );
      const topicHtml = topic.querySelector("#admin-content")!.innerHTML;
      expect(topicHtml.indexOf("Open questions")).toBeLessThan(
        topicHtml.indexOf("What waits on what"),
      );
      expect(topicHtml.indexOf("What waits on what")).toBeLessThan(
        topicHtml.indexOf("Assumed and decided"),
      );
      expect(topicHtml.indexOf("Assumed and decided")).toBeLessThan(topicHtml.indexOf("<article"));
      const contents = [...topic.querySelectorAll('nav[aria-label="Contents"] a')];
      expect(contents).toHaveLength(6);
      expect(contents.map((a) => a.getAttribute("href"))).toEqual(
        [...topic.querySelectorAll("article h2")].map((h) => "#" + h.id),
      );
      expect(topic.querySelector("article h3 + [data-comment]")).not.toBeNull();
      expect(topic.querySelector("article [data-report]")?.textContent).toContain("Last changed");

      const standalone = await docFor("/spoke/doc/docs/agent-work/2026-01-14-standalone");
      expect(standalone.querySelectorAll("article h2")).toHaveLength(5);
      expect(standalone.querySelector('nav[aria-label="Contents"]')).toBeNull();
      expect(standalone.querySelectorAll("[data-comment]")).toHaveLength(5);
      expect(standalone.getElementById("copy")).not.toBeNull();
      expect(standalone.querySelector("article [data-report]")?.textContent).toContain(
        "Last changed",
      );
      expect(standalone.querySelector("details.item, .admin-diagram")).toBeNull();

      const ordinary = await docFor("/spoke/doc/docs/guide/index.md");
      expect(ordinary.getElementById("copy")).toBeNull();
      expect(ordinary.querySelector("[data-comment]")).toBeNull();

      // A doc filled into its shell is the page a full build renders, served with the same links:
      // the article's links to docs open their pages, the line above it opens the file.
      const out = join(scratch(), "out");
      await buildSite(siteData([data]), out);
      const served = linker([data]);
      for (const page of [
        "README",
        "docs/guide/index.md",
        "docs/agent-work/2026-01-15-sample-topic",
        "docs/agent-work/2026-01-14-standalone",
        "docs/shell-html",
        "docs/shell-title",
        "docs/rock & roll's",
      ]) {
        const built = readFileSync(join(out, `spoke/doc/${page}.html`), "utf8");
        const got = await (await get(`/spoke/doc/${page}`)).text();
        // A shell's scripts carry the nonce its policy names.
        const nonce = got.match(/'nonce-([\w-]+)'/)![1];
        expect([...got.matchAll(/<script nonce="([^"]+)"/g)].map((m) => m[1])).toEqual([
          nonce,
          nonce,
        ]);
        expect(sansNonce(got)).toBe(sansNonce(served.files(served.pages(built))));
      }
      // A doc's slug may itself end in .html, which only the hub's shells serve: Astro builds none.
      writeFileSync(join(repo, "docs/page.html.md"), "# Named like a page\n");
      sh(repo, "git", "add", "docs/page.html.md");
      commit(repo, "page");
      expect((await get("/spoke/doc/docs/page.html")).status).toBe(200);
    },
    testTimeout(120_000),
  );

  describe("non-plain dated reports", () => {
    const datedReports = [
      {
        label: "plain archive",
        stem: "2026-01-15-archive",
        title: "Sample report 0",
        body: "\n[Open the archive](2026-01-15-archive.html.md)\n",
      },
      {
        label: "html suffix",
        stem: "2026-01-15-archive.html",
        title: "Sample report 1",
        body: "",
      },
      {
        label: "hash in name",
        stem: "2026-01-15-hash#note",
        title: "Sample report 2",
        body: "",
      },
      {
        label: "question mark in name",
        stem: "2026-01-15-question?",
        title: "Sample report 3",
        body: "",
      },
      {
        label: "space in name",
        stem: "2026-01-15-first draft",
        title: "Sample report 4",
        body: "",
      },
      {
        label: "newline in name",
        stem: "2026-01-15-two\nlines",
        title: "Sample report 5",
        body: "",
      },
    ];
    let indexHtml = "";
    const responses = new Map<string, { status: number; html: string }>();

    beforeAll(async () => {
      const repo = repoFrom("spoke");
      for (const report of datedReports) {
        const path = `docs/agent-work/${report.stem}.md`;
        writeFileSync(join(repo, path), `# ${report.title}\n\n## Section\n${report.body}`);
        sh(repo, "git", "add", path);
      }
      for (const [index, report] of datedReports.slice(2, 4).entries()) {
        const path = `docs/agent-work/items/sample-${index}.md`;
        writeFileSync(
          join(repo, path),
          `---\nkind: work\nstatus: open\npriority: 1\nowner: Alex\ntopic: "${report.stem}"\n---\n# Sample work\n`,
        );
        sh(repo, "git", "add", path);
      }
      commit(repo, "Add dated samples");
      const hub = createHub({ root: dirname(repo) });
      const get = (path: string) => hub.fetch(new Request(`http://admin.localhost/spoke/${path}`));
      indexHtml = await (await get("docs")).text();
      for (const { stem } of datedReports) {
        const response = await get(`doc/docs/agent-work/${encodeURIComponent(stem)}.html`);
        responses.set(stem, { status: response.status, html: await response.text() });
      }
    }, testTimeout(60_000));

    test("the Docs index links every dated report", () => {
      const hrefs = [...indexHtml.matchAll(/href="(doc\/docs\/agent-work\/[^"]+)"/g)].map(
        (m) => m[1],
      );
      expect(hrefs).toEqual(
        expect.arrayContaining([
          "doc/docs/agent-work/2026-01-15-archive.html",
          "doc/docs/agent-work/2026-01-15-archive.html.html",
          "doc/docs/agent-work/2026-01-15-hash%23note.html",
          "doc/docs/agent-work/2026-01-15-question%3F.html",
          "doc/docs/agent-work/2026-01-15-first%20draft.html",
          "doc/docs/agent-work/2026-01-15-two%0Alines.html",
        ]),
      );
    });

    test.each(datedReports)(
      "serves $label at its encoded address with its heading and change line",
      ({ stem, title }) => {
        const { status, html } = responses.get(stem)!;
        expect(status).toBe(200);
        expect(html).toContain(`>${title}</h1>`);
        expect(html).toContain("Last changed");
      },
    );

    test.each([
      { label: "plain archive", stem: "2026-01-15-archive", expected: true },
      { label: "html suffix", stem: "2026-01-15-archive.html", expected: false },
      { label: "hash in name", stem: "2026-01-15-hash#note", expected: false },
      { label: "question mark in name", stem: "2026-01-15-question?", expected: false },
      { label: "space in name", stem: "2026-01-15-first draft", expected: false },
      { label: "newline in name", stem: "2026-01-15-two\nlines", expected: false },
    ])(
      "gives copy and comment controls only to plain dated report names ($label)",
      ({ stem, expected }) => {
        const { status, html } = responses.get(stem)!;
        expect(status).toBe(200);
        expect(html.includes('id="copy"')).toBe(expected);
        expect(html.includes("data-comment data-k")).toBe(expected);
      },
    );

    test.each(datedReports)(
      "omits the topic graph on $label without work or a goal for a plain topic",
      ({ stem }) => {
        const { status, html } = responses.get(stem)!;
        expect(status).toBe(200);
        expect(html).not.toContain("What waits on what");
      },
    );

    test("the archive page links the served page of the report whose stem ends in .html", () => {
      expect(responses.get("2026-01-15-archive")!.html).toContain(
        'href="/spoke/doc/docs/agent-work/2026-01-15-archive.html.html"',
      );
    });
  });

  test(
    "a topic graph needs work or a goal and can draw a lone goal",
    async () => {
      const repo = await fromFiles({
        "docs/agent-work/2026-01-15-review.md": "# Review\n",
        "docs/agent-work/2026-01-15-goal.md": "# Goal\n",
        "docs/agent-work/items/review.md":
          "---\nkind: review\nstatus: open\npriority: 1\nowner: Alex\ntopic: 2026-01-15-review\n---\n# Review the sample\n",
        "docs/agent-work/items/goal.md":
          "---\nkind: goal\nstatus: open\ntopic: 2026-01-15-goal\n---\n# Sort the samples\n",
      });
      const out = join(scratch(), "out");
      await buildSite(siteData([repo]), out);
      const html = (name: string) =>
        readFileSync(
          join(out, repo.key, "doc", "docs", "agent-work", `2026-01-15-${name}.html`),
          "utf8",
        );
      expect(html("review")).toContain("Review the sample");
      expect(html("review")).not.toContain("What waits on what");
      expect(html("goal")).toContain("What waits on what");
      expect(html("goal")).toContain("Sort the samples");
    },
    testTimeout(60_000),
  );

  test(
    "the hub serves a committed image at a thumbnail's width",
    async () => {
      const pixel = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
      );
      const png = (w: number, h: number) => new Bun.Image(pixel).resize(w, h).png().bytes();
      const repo = repoFrom("spoke");
      const dir = join(repo, "docs/agent-work/2026-01-15-sample-topic");
      writeFileSync(join(dir, "wide.png"), await png(2000, 1000));
      writeFileSync(join(dir, "tall.png"), await png(400, 2000));
      writeFileSync(join(dir, "small.png"), await png(100, 100));
      writeFileSync(join(dir, "broken.png"), "no image");
      sh(repo, "git", "add", "-A");
      commit(repo, "i");
      const hub = createHub({ root: dirname(repo) });
      const page = await (
        await hub.fetch(new Request("http://admin.localhost/spoke/reviews"))
      ).text();
      const img = page.match(/<img[^>]*small\.png[^>]*>/)![0];
      const at = "/_file/spoke/docs/agent-work/2026-01-15-sample-topic";
      expect(img).toContain(`src="${at}/small.png?w=480"`);
      expect(img).toContain(`srcset="${at}/small.png?w=480 480w, ${at}/small.png?w=960 960w"`);
      const get = (q: string, headers = {}) =>
        hub.fetch(new Request(`http://admin.localhost${at}/${q}`, { headers }));
      const small = await get("wide.png?w=480");
      expect(small.headers.get("content-type")).toBe("image/webp");
      expect((await new Bun.Image(await small.bytes()).metadata()).width).toBe(480);
      const tall = await new Bun.Image(await (await get("tall.png?w=480")).bytes()).metadata();
      expect([tall.width, tall.height]).toEqual([54, 270]);
      // The full file: no width, a width the hub does not offer, an image that already fits, or a
      // file that is no image.
      for (const q of ["wide.png", "wide.png?w=123", "small.png?w=480", "broken.png?w=480"])
        expect((await get(q)).headers.get("content-type")).toBe("image/png");
      const repeat = await get("wide.png?w=480", { "if-none-match": small.headers.get("etag")! });
      expect(repeat.status).toBe(304);
      expect((await get("wide.png?w=960")).headers.get("etag")).not.toBe(small.headers.get("etag"));
    },
    testTimeout(60_000),
  );
});

describe("catalog", () => {
  test(
    "the hub serves the catalog at /catalog/ and links it",
    async () => {
      const hub = createHub({ root: dirname(repoFrom("spoke")) });
      const get = (path: string) => hub.fetch(new Request(`http://admin.localhost${path}`));
      const hubPage = await get("/");
      expect(hubPage.status).toBe(200);
      expect(await hubPage.text()).toMatch(/<a href="\/catalog\/"[^>]*>\s*Catalog\s*</);
      const bare = await get("/catalog");
      expect([bare.status, bare.headers.get("location")]).toEqual([
        302,
        "http://admin.localhost/catalog/",
      ]);
      const home = await get("/catalog/");
      expect(home.status).toBe(200);
      const html = await home.text();
      expect(html).toContain("Every page and component of the admin engine");
      const sheet = html.match(/href="(\/catalog\/_astro\/[^"]+\.css)"/)![1]!;
      expect((await get(sheet)).headers.get("cache-control")).toContain("immutable");
      const story = await get("/catalog/stories/Items/shot/captioned");
      expect(story.status).toBe(200);
      const src = (await story.text()).match(/<img[^>]*src="([^"]+)"/)![1]!;
      expect(src.startsWith("/catalog/test/fixtures/spoke/")).toBe(true);
      expect((await get(src)).headers.get("content-type")).toContain("image/svg");
      const graphPath = "/catalog/stories/Items/needs-graph/graph/";
      const graph = await get(graphPath);
      expect(graph.status).toBe(200);
      const graphLinks = [...(await graph.text()).matchAll(/href="([^"]+)"><g class="node"/g)];
      expect(graphLinks).toHaveLength(6);
      for (const [, href] of graphLinks) {
        const target = new URL(href!, `http://admin.localhost${graphPath}`);
        const row = await get(target.pathname);
        expect(row.status).toBe(200);
        expect(await row.text()).toContain(`id="${target.hash.slice(1)}"`);
      }
      expect((await get("/catalog/no-such-page")).status).toBe(404);
    },
    testTimeout(60_000),
  );
});
