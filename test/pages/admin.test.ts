import { afterAll, assert, beforeAll, describe, expect, test, vi } from "vitest";
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
import { buildSite, script } from "../../src/build.ts";
import { siteData } from "../../src/site-data.ts";
import { uniqueKeys } from "../../src/hub.ts";
import { treeSource } from "../../src/git.ts";
import { readRepo } from "../../src/repo.ts";
import { createHub } from "../../src/serve.ts";
import { linker } from "../../src/serve-pages.ts";
import {
  FIX,
  commit,
  configured,
  evaluate,
  fromFiles,
  repoFrom,
  scratch,
  sh,
  stubBuildSpawn,
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

  describe("built pages that open from disk", () => {
    let repo = "";
    let out = "";
    let hubHtml = "";
    let dashboardHtml = "";
    let decisionsHtml = "";
    let docPath = "";
    let docHtml = "";
    let plainDocsHtml = "";
    const where = (html: string) => html.match(/<nav[^>]*aria-label="Where"[\s\S]*?<\/nav>/)![0];
    const repos = (html: string) => html.match(/<div id="admin-repos"[\s\S]*?<\/div>/)![0];

    beforeAll(async () => {
      repo = repoFrom("spoke");
      out = join(dirname(repo), "out");
      // A second repo without catalog or products, for the switcher's fallbacks.
      const plain = repoFrom("legacy", "plain");
      // A doc named index.md ends its page's path in "index", which Astro reads as the folder's own.
      mkdirSync(join(plain, "docs/guide"), { recursive: true });
      writeFileSync(join(plain, "docs/index.md"), "# Start here\n");
      writeFileSync(join(plain, "docs/guide/index.md"), "# Guide\n");
      sh(plain, "git", "add", "-A");
      commit(plain, "d");
      await buildSite(siteData([await readRepo(repo), await readRepo(plain)]), out);
      hubHtml = readFileSync(join(out, "index.html"), "utf8");
      dashboardHtml = readFileSync(join(out, "spoke/dashboard.html"), "utf8");
      decisionsHtml = readFileSync(join(out, "spoke/decisions.html"), "utf8");
      docPath = join(out, "spoke/doc/docs/agent-work/2026-01-15-sample-topic.html");
      docHtml = readFileSync(docPath, "utf8");
      plainDocsHtml = readFileSync(join(out, "plain/docs.html"), "utf8");
    }, testTimeout(60_000));

    test("the hub lists open items and puts settled items after Repositories", () => {
      expect(hubHtml).toContain("Which variant ships?");
      // Settled items come last, after the repositories.
      const headings = [...hubHtml.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1]);
      expect(headings).toEqual([
        "Needs you",
        "Waiting on others",
        "Agents on it",
        "Repositories",
        "Defects",
        "Settled",
      ]);
      const settledSection = hubHtml.match(
        /<section[^>]*>\s*<h2[^>]*>Settled<\/h2>[\s\S]*?<\/section>/,
      );
      expect(settledSection).not.toBeNull();
      expect(settledSection![0]).toContain('id="spoke:name-the-command"');
    });

    test("the hub's Waiting on others section links each person's item to its row and names prerequisites", () => {
      // Waiting on others links a person's item to its row; an agent's item shows under its own
      // heading, collapsed, as a link to its row, and no person filter hides it.
      const waiting = hubHtml.slice(
        hubHtml.indexOf("Waiting on others"),
        hubHtml.indexOf("Agents on it"),
      );
      expect(waiting).toContain('href="spoke/work.html#spoke:ask-the-printer"');
      expect(waiting).toContain('href="spoke/decisions.html#spoke:check-the-copy"');
      expect(waiting).toContain("Waiting on pick-a-variant");
    });

    test("the hub's Agents on it section puts agent items inside a collapsed disclosure", () => {
      const agentsSection = hubHtml.match(
        /<section[^>]*>\s*<h2[^>]*>Agents on it<\/h2>[\s\S]*?<\/section>/,
      );
      expect(agentsSection).not.toBeNull();
      const disclosure = agentsSection![0].match(
        /<details[^>]*data-group[^>]*>[\s\S]*?<\/details>/,
      );
      expect(disclosure).not.toBeNull();
      expect(agentsSection![0]).not.toMatch(/<details[^>]*data-group[^>]* open/);
      expect(disclosure![0]).toContain("Sort the sample files");
    });

    test("the hub's Agents on it rows link to their work rows without textareas or person attributes", () => {
      const agentsSection = hubHtml.match(
        /<section[^>]*>\s*<h2[^>]*>Agents on it<\/h2>[\s\S]*?<\/section>/,
      );
      expect(agentsSection).not.toBeNull();
      const agents = agentsSection![0];
      expect(agents).toContain('href="spoke/work.html#spoke:sort-the-samples"');
      expect(agents).not.toContain("<textarea");
      expect(agents).not.toMatch(/<div[^>]*data-row[^>]*data-who/);
    });

    test("the hub's Repositories table keeps three columns visible on a phone", () => {
      // On a phone the repositories table keeps three columns; the most urgent item goes under the
      // repository's name.
      const table = hubHtml.slice(hubHtml.indexOf(">Repositories</h2>"));
      expect(
        table
          .slice(0, table.indexOf("</thead>"))
          .match(/<th(?=[\s>])(?![^>]*max-sm:hidden)[^>]*>/g),
      ).toHaveLength(3);
    });

    test("a repository dashboard lists agent work and limits Most urgent to the hub user's own rows", () => {
      expect(dashboardHtml).toContain("Sort the sample files");
      // Most urgent lists the hub's user's own rows; other people's wait under their own heading.
      const from = dashboardHtml.indexOf(">Most urgent</h2>");
      const to = dashboardHtml.indexOf("Waiting on others");
      expect(from).toBeGreaterThan(0);
      expect(to).toBeGreaterThan(from);
      const urgent = dashboardHtml.slice(from, to);
      const urgentOwners = [...urgent.matchAll(/data-who="([^"]+)"/g)].map((m) => m[1]);
      expect(urgentOwners).toEqual(["Alex", "Alex", "Alex"]);
    });

    test("the build writes a repository's Decisions, Work, product and report pages", () => {
      expect(readFileSync(join(out, "spoke/work.html"), "utf8")).toContain(
        'id="spoke:ask-the-printer"',
      );
      const pages = readdirSync(join(out, "spoke"), { recursive: true }) as string[];
      expect(pages).toContain("decisions.html");
      expect(pages).toContain("products-1.html");
      expect(pages).toContain("doc/docs/agent-work/2026-01-15-sample-topic.html");
    });

    test.each([
      {
        page: "spoke/decisions.html",
        id: "pick-a-variant",
        label: "2 open items wait on this",
        waitsOnThis: true,
      },
      {
        page: "spoke/decisions.html",
        id: "check-the-copy",
        label: "1 open item waits on this",
        waitsOnThis: true,
      },
      {
        page: "spoke/decisions.html",
        id: "cache-folder",
        label: "Waiting on pick-a-variant",
        waitsOnThis: false,
      },
      {
        page: "spoke/decisions.html",
        id: "name-the-command",
        label: "Waiting on goal",
        waitsOnThis: false,
      },
      {
        page: "spoke/work.html",
        id: "goal",
        label: "1 open item waits on this",
        waitsOnThis: true,
      },
      {
        page: "spoke/work.html",
        id: "work-wire-the-gate",
        label: "Waiting on check-the-copy, goal, pick-a-variant",
        waitsOnThis: false,
      },
    ])("row $id on $page shows its prerequisite summary", ({ page, id, label, waitsOnThis }) => {
      const rendered = new Window().document;
      rendered.body.innerHTML = readForDom(join(out, page));
      const row = rendered.getElementById(`spoke:${id}`);
      assert(row, `row spoke:${id} should exist on ${page}`);
      const summary = row.firstElementChild;
      assert(summary, `summary for spoke:${id} should exist on ${page}`);
      const text = summary.textContent;
      expect(text).toContain(label);
      expect(/waits? on this/.test(text)).toBe(waitsOnThis);
    });

    test.each([
      { title: "Start here", id: "start-here", to: "doc/docs/index" },
      { title: "Guide", id: "guide", to: "doc/docs/guide/index" },
    ])("index.md doc $title in plain links to $to and renders its heading", ({ title, id, to }) => {
      const match = plainDocsHtml.match(new RegExp(`href="([^"]+)">\\s*${title}`));
      assert(match, `link for ${title} should exist on plain/docs.html`);
      const link = match[1]!;
      expect(link.startsWith(to)).toBe(true);
      expect(readFileSync(join(out, "plain", link), "utf8")).toContain(
        `<h1 id="${id}">${title}</h1>`,
      );
    });

    test.each([
      "index.html",
      "spoke/decisions.html",
      "spoke/doc/docs/agent-work/2026-01-15-sample-topic.html",
    ])("%s loads only classic nonced file scripts and existing relative _astro assets", (page) => {
      const text = readFileSync(join(out, page), "utf8");
      // Every script is a classic file script: no module, which a page from disk cannot load, and
      // nothing inline, which the pages' policy refuses; each carries the build's nonce.
      const nonceMatch = text.match(/script-src 'nonce-([\w-]+)'/);
      assert(nonceMatch, `${page} should declare a script-src nonce`);
      const validScript = new RegExp(`^<script nonce="${nonceMatch[1]}" src="[^"]+">$`);
      const scriptTags = [...text.matchAll(/<script[^>]*>/g)].map(([tag]) => tag);
      expect(scriptTags.length).toBeGreaterThan(0);
      expect(scriptTags.filter((tag) => !validScript.test(tag))).toEqual([]);
      expect(text).not.toContain('"/_astro/');
      const assetRefs = [...text.matchAll(/(?:href|src)="([^"]*_astro\/[^"]+)"/g)].map(
        ([, ref]) => ref!,
      );
      expect(assetRefs.length).toBeGreaterThan(0);
      expect(
        assetRefs.filter((ref) => !existsSync(resolve(dirname(join(out, page)), ref))),
      ).toEqual([]);
    });

    test("a built report renders prose with brand quote, code and table wrappers", () => {
      expect(docHtml).toContain('<article class="prose hw-prose');
      expect(docHtml).toContain('class="hw-quote not-prose"');
      expect(docHtml).toContain('class="hw-code not-prose"');
      expect(docHtml).toContain(
        '<div class="hw-table-scroll" tabindex="0" role="region" aria-label="Scores by reader"><table class="hw-table not-prose">',
      );
      expect(docHtml).not.toContain("<table>");
    });

    test("a built report renders its heading above the article and opens the article on what follows it", () => {
      expect(docHtml).toMatch(/<h1[^>]*>Sample topic<\/h1>/);
      expect(docHtml.indexOf("<h1")).toBeLessThan(docHtml.indexOf("<article"));
      // The title shows above the article, so the article opens on what follows it.
      expect(docHtml).toMatch(/<article[^>]*><p[^>]*data-report[\s\S]*?<\/nav><p>A report/);
      const article = docHtml.match(/<article[^>]*>[\s\S]*?<\/article>/);
      expect(article).not.toBeNull();
      expect(article![0]).not.toContain("<h1");
    });

    test("a built report renders prose links with hw-link and without not-prose", () => {
      expect(docHtml).toContain('<a class="hw-link" href=');
      expect(docHtml).not.toMatch(/<a [^>]*not-prose/);
    });

    test("a built report loads the typography plugin stylesheet", () => {
      const sheets = [...docHtml.matchAll(/href="([^"]+\.css)"/g)]
        .map(([, css]) => readFileSync(resolve(dirname(docPath), css!), "utf8"))
        .join("");
      // Typography's plugin is loaded: without it, prose styles nothing.
      expect(sheets).toContain(".prose :where(p)");
    });

    test("a built report resolves relative images to repository file URLs", () => {
      expect(docHtml).toContain(
        `file://${repo}/docs/agent-work/2026-01-15-sample-topic/variant-a.svg`,
      );
    });

    test("a built report's breadcrumb links back to the hub", () => {
      expect(where(docHtml)).toContain('href="../../../../index.html"');
    });

    test("the bundled admin script ships brand elements and copy-button wiring as one classic script", () => {
      // brand's element script reaches the page as one classic script, which a page from disk loads.
      const scriptMatch = decisionsHtml.match(/<script nonce="[^"]+" src="([^"]*admin[^"]*\.js)"/);
      assert(scriptMatch, "decisions page should link the bundled admin script");
      const bundled = readFileSync(resolve(out, "spoke", scriptMatch[1]!), "utf8");
      expect(bundled).toContain("hw-menu");
      expect(bundled).not.toMatch(/^import\b/m);
      // brand's enhance() wires the Copy button by its data-hw-copy attribute.
      expect(decisionsHtml).toMatch(/id="copy"[^>]*data-hw-copy/);
      expect(bundled).toContain("[data-hw-copy]");
      // The copy time is set from brand's hw-copy event, which says whether the copy worked.
      expect(bundled).toMatch(/addEventListener\("hw-copy"[^]*?\.detail\?\.ok/);
    });

    // Answers given on a repo page are copied there, not on a trip back to the hub.
    test.each(["dashboard", "work", "reviews"])(
      "spoke/%s.html includes the Copy button",
      (page) => {
        expect(readFileSync(join(out, `spoke/${page}.html`), "utf8")).toContain('id="copy"');
      },
    );

    test("a recommended option keeps a space between its pill and label", () => {
      // Astro drops a line break next to a tag: the pill keeps an explicit space before its label.
      expect(decisionsHtml).toMatch(/Recommended\s*<\/span>\s+<b>/);
    });

    test.each([
      { from: "index.html", target: 'href="spoke/dashboard.html"' },
      { from: "spoke/decisions.html", target: 'href="decisions.html"' },
      { from: "spoke/decisions.html", target: 'href="../plain/decisions.html"' },
      {
        from: "spoke/doc/docs/agent-work/2026-01-15-sample-topic.html",
        target: 'href="../../../../plain/docs.html"',
      },
      { from: "spoke/catalog.html", target: "../plain/dashboard.html" },
      { from: "spoke/products-1.html", target: "../plain/dashboard.html" },
      { from: "spoke/products-1.html", target: 'href="products-1.html"' },
    ])("the repository switcher on $from links to $target", ({ from, target }) => {
      expect(repos(readFileSync(join(out, from), "utf8"))).toContain(target);
    });
  });

  describe("ranking, reviews, settled rows and provenance across repositories", () => {
    let out = "";
    let html = "";
    let reviews = "";
    const kimsTitle = "The printers proof, Kim alone";

    beforeAll(async () => {
      const spoke = await readRepo(repoFrom("spoke"));
      const base = spoke.items.find((i) => i.id === "ask-the-printer")!;
      const late = { ...base, id: "late", owner: "Alex", order: 80 };
      // Kim's, ranked first in its repository: the Repositories table counts every person's items,
      // so its Most urgent names Kim's, while the dashboard's names the hub's user's own.
      const kims = {
        ...base,
        id: "kims",
        title: kimsTitle,
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
        label: "Zebra repo",
        path: `${spoke.path}-other`,
        behind: 2,
        fetched: 1_700_000_000,
        items: [{ ...base, id: "early", owner: "Alex", order: 20 }],
      };
      out = join(scratch(), "out");
      await buildSite(
        siteData([other, { ...spoke, items: [...spoke.items, late, bare, kims] }]),
        out,
      );
      html = readFileSync(join(out, "index.html"), "utf8");
      reviews = readFileSync(join(out, "spoke/reviews.html"), "utf8");
    }, testTimeout(60_000));

    test("the hub ranks items across every repository in one order", () => {
      const order = [...html.matchAll(/id="(other:early|spoke:late)"/g)].map((m) => m[1]);
      expect(order).toEqual(["other:early", "spoke:late"]);
    });

    test("each row and item link on the hub names its repository by label", () => {
      // A line linking to an item names its repository by label too.
      const kimsLink = html.match(/<div[^>]*data-k="spoke:kims"[\s\S]*?<\/div>/);
      expect(kimsLink).not.toBeNull();
      expect(kimsLink![0]).toContain("Sample spoke · ");
      // Each row names its repository.
      const earlySummary = html.match(/id="other:early"[\s\S]*?<\/summary>/);
      expect(earlySummary).not.toBeNull();
      expect(earlySummary![0]).toContain("Zebra repo · to do");
    });

    test("the hub's Repositories table includes the Decide P2 column", () => {
      const repoSection = html.match(
        /<section[^>]*>\s*<h2[^>]*>Repositories<\/h2>[\s\S]*?<\/section>/,
      );
      expect(repoSection).not.toBeNull();
      const headers = [...repoSection![0].matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map((m) => m[1]);
      expect(headers).toEqual([
        "Repo",
        "Decide P1",
        "Decide P2",
        "Decide P3",
        "Review",
        "Work for a person",
        "Assumed",
        "Most urgent",
      ]);
    });

    test("the Repositories table sorts repositories by label rather than key", () => {
      // Repositories list by the name a person reads.
      const repoRows = [...html.matchAll(/data-repo-row="([^"]+)"/g)].map((m) => m[1]);
      expect(repoRows).toEqual(["spoke", "other"]);
    });

    test("the Repositories table names each repository's top-ranked item across every owner", () => {
      const repoSection = html.match(
        /<section[^>]*>\s*<h2[^>]*>Repositories<\/h2>[\s\S]*?<\/section>/,
      );
      expect(repoSection).not.toBeNull();
      const topByRepo = [
        ...repoSection![0].matchAll(
          /<tr data-row data-repo-row="([^"]+)">(?:(?!<\/tr>)[\s\S])*?<td class="max-w-md max-sm:hidden">([^<]*)<\/td>/g,
        ),
      ].map(([, key, title]) => [key, title]);
      expect(topByRepo).toEqual([
        ["spoke", kimsTitle],
        ["other", "Ask the printer for a second proof"],
      ]);
    });

    test.each([
      { label: "includes", id: "check-the-copy", shown: true },
      { label: "includes", id: "pick-recipients", shown: true },
      { label: "includes", id: "pick-a-variant", shown: true },
      { label: "excludes", id: "goal", shown: false },
      { label: "excludes", id: "ask-the-printer", shown: false },
    ])("Reviews $label spoke:$id", ({ id, shown }) => {
      expect(reviews.includes(`id="spoke:${id}"`)).toBe(shown);
    });

    test("settled rows state what was assumed or decided, hide the closed line when open, and show a bare assumption callout", () => {
      // Opened, it still says what was assumed, where the closed line leaves.
      const bareRow = html.match(/id="spoke:bare"[\s\S]*?<\/details>/);
      assert(bareRow, "hub should render spoke:bare row");
      expect(bareRow[0]).toMatch(/<p class="hw-callout"><b>Assumed:<\/b>\s*Variant A/);
      // A settled row says what was assumed or decided, never what was recommended.
      const settled = (id: string) => {
        const match = html.match(new RegExp(`id="spoke:${id}"[\\s\\S]*?</summary>`));
        assert(match, `hub should render summary for spoke:${id}`);
        return match[0];
      };
      expect(settled("cache-folder")).toContain("Assumed: The build writes to node_modules/.cache");
      expect(settled("name-the-command")).toContain("Decided by Alex: Keep the short name");
      expect(settled("name-the-command")).not.toContain("Recommended");
      // Closed, that line holds two lines at most; opened, it leaves, since the row's callout says it
      // in full.
      expect(settled("cache-folder")).toMatch(/<span class="[^"]*group-open:hidden">Assumed:/);
    });

    test("closed row summaries contain no controls that commit an answer", () => {
      // A closed row answers nothing: a control that commits an answer sits beside the text it answers.
      const summaries = html.match(/<summary[\s\S]*?<\/summary>/g);
      assert(summaries, "hub should render row summaries");
      expect(summaries.length).toBeGreaterThan(5);
      expect(summaries.filter((s) => /<(button|input|textarea|select)\b/.test(s))).toEqual([]);
    });

    test("an opened decision places Pick recommended and its radiogroup options before Context", () => {
      // An opened decision shows its options before its context.
      const variantMatch = html.match(/id="spoke:pick-a-variant"[\s\S]*?<\/details>/);
      expect(variantMatch).not.toBeNull();
      const variant = variantMatch![0];
      const markers = [
        ...variant.matchAll(
          /Pick recommended|role="radiogroup" aria-label="[^"]+"|value="a"|>Context</g,
        ),
      ].map((m) => m[0]);
      expect(markers).toEqual([
        "Pick recommended",
        'role="radiogroup" aria-label="Which variant ships?"',
        'value="a"',
        ">Context<",
      ]);
      // Its options form one group, named by the question they answer.
      expect(variant).toMatch(/role="radiogroup" aria-label="[^"]+"[^>]*>\s*<label/);
    });

    test("an opened decision prints short letter option keys and omits word keys", () => {
      const variantMatch = html.match(/id="spoke:pick-a-variant"[\s\S]*?<\/details>/);
      expect(variantMatch).not.toBeNull();
      // A letter key, which the item's text names an option by, stands before its label; a word key,
      // which restates the label, stays out.
      expect(variantMatch![0]).toMatch(/data-option-key[^>]*>a<\/span>\s*<b>Variant A<\/b>/);
      const recipientsMatch = html.match(/id="spoke:pick-recipients"[\s\S]*?<\/details>/);
      expect(recipientsMatch).not.toBeNull();
      expect(recipientsMatch![0]).not.toContain("data-option-key");
    });

    test("provenance lists checkouts behind their push branch and sits after Settled", () => {
      // The hub's provenance names the checkouts behind and says when it is from, at the page's end,
      // so the lists come first.
      expect(html).toMatch(/class="admin-provenance[^>]*>[^<]*· as of <span data-stamp>\d/);
      const provenance = html.match(/<p class="admin-provenance[^>]*>([^<]*)/);
      expect(provenance).not.toBeNull();
      expect(provenance![1]).toContain("1 behind their push branch: other");
      expect(readFileSync(join(out, "other/dashboard.html"), "utf8")).toContain(
        "2 commits behind the push branch, fetched",
      );
      expect(
        [...html.matchAll(/>Settled<\/h2>|class="admin-provenance/g)].map((m) => m[0]),
      ).toEqual([">Settled</h2>", 'class="admin-provenance']);
    });
  });

  describe("item images and opened row markup", () => {
    let html = "";
    const rowOf = (id: string) => {
      const match = html.match(new RegExp(`id="spoke:${id}"[\\s\\S]*?</details>`));
      assert(match, `decisions page should render spoke:${id}`);
      return match[0];
    };

    beforeAll(async () => {
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
      html = readFileSync(join(out, "spoke/decisions.html"), "utf8");
    }, testTimeout(60_000));

    test("an item's own images render above its options in one column when alone and two columns from sm up when paired", () => {
      const row = rowOf("shown");
      expect(row.indexOf("shown/variant-b.svg")).toBeGreaterThan(0);
      expect(row.indexOf("shown/variant-b.svg")).toBeLessThan(row.indexOf("data-option"));
      // A lone image takes the row's width, up to 36rem tall: large enough to judge, with its
      // options in view below it at 900 px. Several stand two beside each other from sm up, one per
      // row on a phone.
      expect(row).toMatch(
        /<div class="grid gap-3">\s*<span[^>]*>\s*<button[^>]*data-zoom="[^"]*shown\/variant-b[^>]*>\s*<img[^>]*max-h-144/,
      );
      expect(rowOf("pair")).toContain('<div class="grid gap-3 sm:grid-cols-2">');
    });

    test("the page renders one shared zoom dialog after every option label", () => {
      // Each image opens in the page's one image dialog, which stands outside every option's label,
      // so a click on the large image picks nothing.
      expect(html.match(/id="admin-zoom"/g)).toHaveLength(1);
      expect(html.indexOf('id="admin-zoom"')).toBeGreaterThan(html.lastIndexOf("</label>"));
    });

    test("an opened row prints short alphanumeric option keys and omits word keys", () => {
      const row = rowOf("shown");
      expect(row).toMatch(/data-option-key[^>]*>b2<\/span>/);
      expect(row).not.toMatch(/data-option-key[^>]*>ask</);
    });

    test("an opened row wraps long strings inside the row", () => {
      // A long path or address in an opened row breaks inside the row rather than widening a phone's
      // page.
      expect(rowOf("shown")).toMatch(
        /<div class="[^"]*\bwrap-anywhere\b[^"]*">\s*<p class="hw-status"/,
      );
    });

    test("an opened row hides its closed recommendation line", () => {
      // Opened, the row's own recommendation badge says what the closed line said.
      expect(rowOf("shown")).toMatch(/<span class="[^"]*group-open:hidden">Recommended:/);
    });
  });

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

  describe("in Chrome", () => {
    let browser: Awaited<ReturnType<typeof puppeteer.launch>>;

    beforeAll(async () => {
      const executablePath = await chromeBinaryAsync();
      assert(executablePath, INSTALL_HINT);
      browser = await puppeteer.launch({ executablePath, headless: true, args: NO_KEYCHAIN });
    }, testTimeout(60_000));

    afterAll(async () => {
      if (browser) await browser.close();
    });

    const openPage = async (owner: Awaited<ReturnType<typeof browser.createBrowserContext>>) => {
      const page = await owner.newPage();
      const violations: string[] = [];
      await page.exposeFunction("__adminCsp", (msg: string) => {
        violations.push(msg);
      });
      await page.evaluateOnNewDocument(() => {
        document.addEventListener("securitypolicyviolation", (event) => {
          (window as unknown as { __adminCsp: (m: string) => void }).__adminCsp(
            `CSP violation: ${event.violatedDirective} ${event.blockedURI}`,
          );
        });
      });
      return { page, violations };
    };

    describe("unchanged spoke fixture", () => {
      let out = "";
      let workPath = "";

      beforeAll(async () => {
        out = join(scratch(), "out");
        const spoke = await readRepo(repoFrom("spoke"));
        await buildSite(siteData([spoke]), out);
        workPath = join(out, "spoke/work.html");
      }, testTimeout(60_000));

      const needsNodes = [
        {
          file: "decisions.html",
          id: "spoke:cache-folder",
          title: "Where the build writes its pages",
        },
        {
          file: "decisions.html",
          id: "spoke:check-the-copy",
          title: "Check the new copy on the start page",
        },
        { file: "work.html", id: "spoke:goal", title: "Goal" },
        {
          file: "decisions.html",
          id: "spoke:name-the-command",
          title: "Which name the command keeps",
        },
        { file: "decisions.html", id: "spoke:pick-a-variant", title: "Which variant ships?" },
        {
          file: "work.html",
          id: "spoke:work-wire-the-gate",
          title: "Wire admin-check into the gate",
        },
      ];

      test("the needs graph starts collapsed with six linked nodes", () => {
        const doc = new Window().document;
        doc.body.innerHTML = readForDom(workPath);
        const fold = doc.querySelector("details:has(figure.admin-diagram)");
        expect(fold).not.toBeNull();
        const links = [...fold!.querySelectorAll("svg a")];
        expect(fold!.hasAttribute("open")).toBe(false);
        expect(fold!.querySelectorAll("svg .node")).toHaveLength(6);
        expect(links.map((link) => link.getAttribute("href")).sort()).toEqual([
          "decisions.html#spoke:cache-folder",
          "decisions.html#spoke:check-the-copy",
          "decisions.html#spoke:name-the-command",
          "decisions.html#spoke:pick-a-variant",
          "work.html#spoke:goal",
          "work.html#spoke:work-wire-the-gate",
        ]);
      });

      test.each(needsNodes)(
        "needs graph node $id carries its item title and points to an existing row",
        ({ file, id, title }) => {
          const doc = new Window().document;
          doc.body.innerHTML = readForDom(workPath);
          const link = doc.querySelector(
            `details:has(figure.admin-diagram) svg a[href="${file}#${id}"]`,
          );
          expect(link).not.toBeNull();
          expect(link!.querySelectorAll(".node")).toHaveLength(1);
          expect(link!.querySelector(".node text")!.textContent).toBe(title);
          const target = new Window().document;
          target.body.innerHTML = readForDom(join(dirname(workPath), file));
          const row = target.getElementById(id);
          expect(row).not.toBeNull();
          expect(row!.hasAttribute("data-row")).toBe(true);
        },
      );

      test(
        "the CSP observer records a violation when a built page attempts an unnonced inline script",
        async () => {
          const context = await browser.createBrowserContext();
          try {
            const { page, violations } = await openPage(context);
            await page.goto(`file://${workPath}`);
            await page.evaluate(() => {
              const inline = document.createElement("script");
              inline.textContent = "window.__cspControl = true";
              document.body.append(inline);
            });
            await new Promise((r) => setTimeout(r, 50));
            expect(violations).toEqual(["CSP violation: script-src-elem inline"]);
          } finally {
            await context.close();
          }
        },
        testTimeout(60_000),
      );

      test(
        "clicking a needs graph node opens its target row in Chrome without CSP violations",
        async () => {
          const context = await browser.createBrowserContext();
          try {
            const { page, violations } = await openPage(context);
            await page.goto(`file://${workPath}`);
            await page.type("#admin-search", "an unmatched search");
            await page.click("details:has(figure.admin-diagram) > summary");
            const graph = await page.locator("figure.admin-diagram svg").waitHandle();
            const box = await graph.boundingBox();
            assert(box, "needs graph SVG should have a bounding box");
            expect(box.width).toBeGreaterThan(0);
            expect(box.height).toBeGreaterThan(0);
            await Promise.all([
              page.waitForNavigation(),
              page.click('svg a[href="decisions.html#spoke:pick-a-variant"] text'),
            ]);
            expect(new URL(page.url()).hash).toBe("#spoke:pick-a-variant");
            await page.waitForSelector('details[id="spoke:pick-a-variant"][open]', {
              visible: true,
            });
            expect(violations).toEqual([]);
          } finally {
            await context.close();
          }
        },
        testTimeout(60_000),
      );

      test.each([
        { rel: "spoke/dashboard.html", width: 390 },
        { rel: "spoke/dashboard.html", width: 360 },
        { rel: "index.html", width: 390 },
        { rel: "index.html", width: 360 },
      ])(
        "the header repository selector does not overlap the theme switch on $rel at $width px",
        async ({ rel, width }) => {
          const context = await browser.createBrowserContext();
          try {
            const page = await context.newPage();
            await page.setViewport({ width, height: 844 });
            await page.goto(`file://${join(out, rel)}`, { waitUntil: "load" });
            await page.evaluate(() => document.fonts.ready);
            const gap = await page.evaluate(() => {
              const right = document
                .querySelector("[popovertarget=admin-repos]")!
                .getBoundingClientRect().right;
              const left = document
                .querySelector("[data-admin-theme]")!
                .getBoundingClientRect().left;
              return left - right;
            });
            expect(gap).toBeGreaterThanOrEqual(0);
          } finally {
            await context.close();
          }
        },
        testTimeout(60_000),
      );
    });

    describe("layout across phone and desktop viewports", () => {
      let out = "";
      const viewports = [
        { label: "phone", width: 390, height: 844 },
        { label: "desktop", width: 1440, height: 900 },
      ];

      beforeAll(async () => {
        out = join(scratch(), "out");
        const spoke = await readRepo(repoFrom("spoke"));
        // Five more people, each with an open item, so the person buttons run wider than a phone.
        const more = ["Annabelle", "Bartholomew", "Constance", "Dorothea", "Evangeline"].map(
          (owner) => ({
            ...spoke.items.find((i) => i.id === "ask-the-printer")!,
            id: owner,
            owner,
          }),
        );
        await buildSite(siteData([{ ...spoke, items: [...spoke.items, ...more] }]), out);
      }, testTimeout(60_000));

      test.each(viewports)(
        "a hash-linked row opens below the copy bar inside the viewport on $label ($width px)",
        async ({ width, height }) => {
          const context = await browser.createBrowserContext();
          try {
            const page = await context.newPage();
            await page.setViewport({ width, height });
            // A page long enough that the row can reach the top, as on a full repository's page.
            await page.goto(`file://${out}/spoke/work.html`);
            const row = await page.evaluate(
              () =>
                new Promise<{ open: boolean; belowBar: boolean; inView: boolean }>((resolve) => {
                  document.body.append(
                    Object.assign(document.createElement("div"), { style: "height:200vh" }),
                  );
                  addEventListener(
                    "hashchange",
                    () =>
                      requestAnimationFrame(() => {
                        const el = document.getElementById(
                          "spoke:ask-the-printer",
                        ) as HTMLDetailsElement;
                        const bar = document
                          .querySelector(".admin-action")!
                          .getBoundingClientRect();
                        const rect = el.getBoundingClientRect();
                        const summary = el.firstElementChild!.getBoundingClientRect();
                        resolve({
                          open: el.open,
                          belowBar: rect.top >= bar.bottom,
                          inView: summary.bottom <= innerHeight,
                        });
                      }),
                    { once: true },
                  );
                  location.hash = "#spoke:ask-the-printer";
                }),
            );
            expect(row).toEqual({ open: true, belowBar: true, inView: true });
          } finally {
            await context.close();
          }
        },
        testTimeout(60_000),
      );

      test(
        "every person and kind filter button fits inside the viewport on phone (390 px)",
        async () => {
          const context = await browser.createBrowserContext();
          try {
            const page = await context.newPage();
            await page.setViewport({ width: 390, height: 844 });
            await page.goto(`file://${out}/index.html`);
            const buttons = await page.evaluate(() => {
              const all = [...document.querySelectorAll("[data-who-button], [data-kind-button]")];
              const shown = all.filter((b) => !b.hasAttribute("hidden"));
              return {
                labels: shown.map((b) => b.textContent!.trim().replace(/\s+/g, " ")),
                cut: all
                  .filter((b) => b.getBoundingClientRect().right > innerWidth)
                  .map((b) => b.textContent!.trim()),
              };
            });
            expect(buttons.labels).toEqual([
              "Alex3",
              "Sam2",
              "Annabelle1",
              "Bartholomew1",
              "Constance1",
              "Dorothea1",
              "Evangeline1",
              "Kim1",
              "All11",
              "All3",
              "To decide2",
              "To do1",
            ]);
            expect(buttons.cut).toEqual([]);
          } finally {
            await context.close();
          }
        },
        testTimeout(60_000),
      );

      test(
        "with All stored, every person and kind filter button including Review fits inside the viewport on desktop (1440 px)",
        async () => {
          const context = await browser.createBrowserContext();
          try {
            const page = await context.newPage();
            await page.setViewport({ width: 1440, height: 900 });
            await page.goto(`file://${out}/index.html`);
            await page.evaluate(() => {
              localStorage.setItem("admin-answers:who", "all");
            });
            await page.reload();
            const buttons = await page.evaluate(() => {
              const all = [...document.querySelectorAll("[data-who-button], [data-kind-button]")];
              const shown = all.filter((b) => !b.hasAttribute("hidden"));
              return {
                labels: shown.map((b) => b.textContent!.trim().replace(/\s+/g, " ")),
                cut: all
                  .filter((b) => b.getBoundingClientRect().right > innerWidth)
                  .map((b) => b.textContent!.trim()),
              };
            });
            expect(buttons.labels).toEqual([
              "Alex3",
              "Sam2",
              "Annabelle1",
              "Bartholomew1",
              "Constance1",
              "Dorothea1",
              "Evangeline1",
              "Kim1",
              "All11",
              "All11",
              "To decide2",
              "To review2",
              "To do7",
            ]);
            expect(buttons.cut).toEqual([]);
          } finally {
            await context.close();
          }
        },
        testTimeout(60_000),
      );

      test.each(viewports)(
        "a settled row's closed line clamps to at most two lines on $label ($width px)",
        async ({ width, height }) => {
          const context = await browser.createBrowserContext();
          try {
            const page = await context.newPage();
            await page.setViewport({ width, height });
            await page.goto(`file://${out}/index.html`);
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
          } finally {
            await context.close();
          }
        },
        testTimeout(60_000),
      );

      test.each(viewports)(
        "a row without a recommendation or answer keeps the gap across Reset equal to the row gap on $label ($width px)",
        async ({ width, height }) => {
          const context = await browser.createBrowserContext();
          try {
            const page = await context.newPage();
            await page.setViewport({ width, height });
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
          } finally {
            await context.close();
          }
        },
        testTimeout(60_000),
      );
    });

    describe("served report comments", () => {
      const stem = "2026-01-15-sample-topic";
      const fold = `[data-k="${COMMENT}"]`;
      const row = `details.item[id="spoke:${stem}"]`;
      let server: ReturnType<typeof Bun.serve>;

      beforeAll(async () => {
        const repo = repoFrom("spoke");
        const item = `docs/agent-work/items/${stem}.md`;
        writeFileSync(
          join(repo, item),
          `---\nkind: review\nstatus: open\npriority: 1\nowner: Alex\ntopic: ${stem}\n---\n# Check the sample file\n`,
        );
        sh(repo, "git", "add", item);
        commit(repo, "Add sample question");
        const hub = createHub({ root: dirname(repo) });
        server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: hub.fetch });
      }, testTimeout(60_000));

      afterAll(async () => {
        if (server) await server.stop(true);
      });

      const jumpToNextStage = async (
        context: Awaited<ReturnType<typeof browser.createBrowserContext>>,
      ) => {
        await context.overridePermissions(server.url.origin, [
          "clipboard-read",
          "clipboard-sanitized-write",
        ]);
        const { page, violations } = await openPage(context);
        await page.setViewport({ width: 390, height: 844 });
        const response = await page.goto(new URL(SAMPLE_REPORT, server.url).href);
        await page.click('nav[aria-label="Contents"] a[href="#next"]');
        await page.waitForFunction(() => {
          const bar = document.querySelector(".admin-action")!.getBoundingClientRect();
          const heading = document.getElementById("next")!.getBoundingClientRect();
          const hashMiss = Number(location.hash !== "#next") * -1e6;
          return (
            Math.min(hashMiss, heading.top - bar.bottom, innerHeight - heading.bottom - 1e-6) >= 0
          );
        });
        const pos = await page.evaluate(() => {
          const bar = document.querySelector(".admin-action")!.getBoundingClientRect();
          const heading = document.getElementById("next")!.getBoundingClientRect();
          return {
            hash: location.hash,
            belowBar: heading.top >= bar.bottom,
            inView: heading.bottom < innerHeight,
          };
        });
        return { page, violations, status: response!.status(), pos };
      };

      const copyCommentStage = async (
        context: Awaited<ReturnType<typeof browser.createBrowserContext>>,
      ) => {
        const stage = await jumpToNextStage(context);
        await stage.page.click(`${fold} summary`);
        await stage.page.type(`${fold} textarea`, "why   dotted?");
        await stage.page.bringToFront();
        await stage.page.click("#copy");
        await stage.page.waitForFunction(() =>
          document.querySelector("#state")!.textContent!.includes("copied at"),
        );
        const clipboard = await stage.page.evaluate(() => navigator.clipboard.readText());
        return { ...stage, clipboard };
      };

      const answerItemStage = async (
        context: Awaited<ReturnType<typeof browser.createBrowserContext>>,
      ) => {
        const stage = await copyCommentStage(context);
        await stage.page.click(`${row} summary`);
        await stage.page.type(`${row} textarea`, "ready");
        const copyAttr = await stage.page.$eval("#copy", (b) => b.getAttribute("data-hw-copy"));
        return { ...stage, copyAttr };
      };

      describe("after clicking Contents #next", () => {
        let context: Awaited<ReturnType<typeof browser.createBrowserContext>> | undefined;
        let status = 0;
        let pos = { hash: "", belowBar: false, inView: false };
        let violations: string[] = [];

        afterAll(async () => {
          if (context) await context.close();
        });

        beforeAll(async () => {
          context = await browser.createBrowserContext();
          const stage = await jumpToNextStage(context);
          status = stage.status;
          pos = stage.pos;
          violations = stage.violations;
        }, testTimeout(60_000));

        test("serves the report with status 200 and scrolls #next below the copy bar without CSP violations", () => {
          expect(status).toBe(200);
          expect(pos).toEqual({ hash: "#next", belowBar: true, inView: true });
          expect(violations).toEqual([]);
        });
      });

      describe("after copying a report comment", () => {
        let context: Awaited<ReturnType<typeof browser.createBrowserContext>> | undefined;
        let clipboard = "";
        let violations: string[] = [];

        afterAll(async () => {
          if (context) await context.close();
        });

        beforeAll(async () => {
          context = await browser.createBrowserContext();
          const stage = await copyCommentStage(context);
          clipboard = stage.clipboard;
          violations = stage.violations;
        }, testTimeout(60_000));

        test("writes the normalised comment line to the clipboard without CSP violations", () => {
          expect(clipboard).toBe(
            "Answers from the admin pages:\nspoke:2026-01-15-sample-topic#next: why dotted?",
          );
          expect(violations).toEqual([]);
        });
      });

      describe("after answering the report's item", () => {
        let context: Awaited<ReturnType<typeof browser.createBrowserContext>> | undefined;
        let copyAttr: string | null = null;

        afterAll(async () => {
          if (context) await context.close();
        });

        beforeAll(async () => {
          context = await browser.createBrowserContext();
          const stage = await answerItemStage(context);
          copyAttr = stage.copyAttr;
        }, testTimeout(60_000));

        test("queues only the new item answer for Copy", () => {
          expect(copyAttr).toBe(`Answers from the admin pages:\nspoke:${stem}: ready`);
        });
      });

      describe("after reloading the report with #next", () => {
        let context: Awaited<ReturnType<typeof browser.createBrowserContext>> | undefined;
        let rowValue = "";
        let commentValue = "";
        let versions: [string | undefined, string | undefined] = [undefined, undefined];
        let violations: string[] = [];

        afterAll(async () => {
          if (context) await context.close();
        });

        beforeAll(async () => {
          context = await browser.createBrowserContext();
          const stage = await answerItemStage(context);
          await stage.page.reload();
          rowValue = await stage.page.$eval(
            `${row} textarea`,
            (field) => (field as HTMLTextAreaElement).value,
          );
          commentValue = await stage.page.$eval(
            `${fold} textarea`,
            (field) => (field as HTMLTextAreaElement).value,
          );
          versions = await stage.page.evaluate((key) => {
            const stored = JSON.parse(localStorage.getItem("admin-answers:versions")!) as Record<
              string,
              string
            >;
            return [stored[key], stored[`#${key}`]] as [string | undefined, string | undefined];
          }, `spoke:${stem}`);
          violations = stage.violations;
        }, testTimeout(60_000));

        test("restores both the item answer and the report comment with version stamps and no CSP violations", () => {
          expect(rowValue).toBe("ready");
          expect(commentValue).toBe("why   dotted?");
          expect(versions).toEqual([expect.any(String), expect.any(String)]);
          expect(violations).toEqual([]);
        });
      });
    });

    describe("Mermaid diagrams", () => {
      let out = "";

      beforeAll(async () => {
        const repo = await readRepo(repoFrom("spoke"));
        const classes = await fromFiles({
          "docs/classes.md":
            "# Sample classes\n\n```mermaid\nclassDiagram\n  class Sample {\n    +archive()\n  }\n```",
        });
        out = join(scratch(), "out");
        await buildSite(siteData([repo, classes]), out);
      }, testTimeout(60_000));

      describe("report flowchart at phone width", () => {
        let view: {
          width: number;
          height: number;
          scrollWidth: number;
          clientWidth: number;
          overflow: string;
          font: string;
          measurements: { label: string; width: number; box: number }[];
          day: string;
          night: string;
        };
        let violations: string[] = [];

        let context: Awaited<ReturnType<typeof browser.createBrowserContext>> | undefined;

        afterAll(async () => {
          if (context) await context.close();
        });

        beforeAll(async () => {
          context = await browser.createBrowserContext();
          const opened = await openPage(context);
          await opened.page.setViewport({ width: 390, height: 844 });
          await opened.page.goto(
            `file://${out}/spoke/doc/docs/agent-work/2026-01-15-sample-topic.html`,
          );
          const diagram = await opened.page.locator("article .admin-diagram > svg").waitHandle();
          view = await diagram.evaluate(async (svg) => {
            await document.fonts.ready;
            const { width, height } = svg.getBoundingClientRect();
            const figure = svg.parentElement!;
            const nodes = [...svg.querySelectorAll(".node")];
            const measurements = nodes.map((node) => {
              const label = node.querySelector("text")!;
              const box = node.querySelector("rect")!;
              return {
                label: label.textContent!,
                width: label.getBBox().width,
                box: box.getBBox().width,
              };
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
          violations = opened.violations;
        }, testTimeout(60_000));

        test("renders with non-zero size inside a horizontally scrollable container without CSP violations", () => {
          expect(view.width).toBeGreaterThan(0);
          expect(view.height).toBeGreaterThan(0);
          expect(view.scrollWidth).toBeGreaterThan(view.clientWidth);
          expect(view.overflow).toBe("auto");
          expect(violations).toEqual([]);
        });

        test("uses Inter for report flowchart node labels", () => {
          expect(view.font).toContain("Inter");
        });

        test("updates report flowchart node fills when the page theme switches", () => {
          expect(view.day).not.toBe(view.night);
        });

        test("renders the three flowchart nodes in order", () => {
          expect(view.measurements.map((m) => m.label)).toEqual([
            "Draft sample",
            "Sort by date",
            "Archive samples",
          ]);
        });

        test.each(["Draft sample", "Sort by date", "Archive samples"])(
          "fits label %s inside its node box",
          (label) => {
            const measurement = view.measurements.find((entry) => entry.label === label);
            assert(measurement, `node ${label} should be measured`);
            expect(measurement.width).toBeGreaterThan(0);
            expect(measurement.width).toBeLessThanOrEqual(measurement.box);
          },
        );
      });

      test(
        "renders a work item's Mermaid diagram and prerequisite summary without CSP violations",
        async () => {
          const context = await browser.createBrowserContext();
          try {
            const { page, violations } = await openPage(context);
            await page.setViewport({ width: 390, height: 844 });
            await page.goto(`file://${out}/spoke/work.html#spoke:sort-the-samples`);
            expect(
              await page.$eval(
                '[id="spoke:sort-the-samples"] .admin-diagram svg',
                (svg) => svg.textContent,
              ),
            ).toContain("Dated folders");
            expect(
              await page.$eval(
                '[id="spoke:work-wire-the-gate"] > summary',
                (row) => row.textContent,
              ),
            ).toContain("Waiting on check-the-copy, goal, pick-a-variant");
            expect(violations).toEqual([]);
          } finally {
            await context.close();
          }
        },
        testTimeout(60_000),
      );

      test(
        "renders class diagram members in the monospace font without CSP violations",
        async () => {
          const context = await browser.createBrowserContext();
          try {
            const { page, violations } = await openPage(context);
            await page.setViewport({ width: 390, height: 844 });
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
            await context.close();
          }
        },
        testTimeout(60_000),
      );
    });

    describe("disk page script isolation and doc links", () => {
      let out = "";
      let data: Awaited<ReturnType<typeof readRepo>>;
      let xHtml = "";

      beforeAll(async () => {
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
        data = await readRepo(repo);
        out = join(scratch(), "out");
        await buildSite(siteData([data]), out);
        xHtml = readFileSync(join(out, "r/doc/docs/x.html"), "utf8");
      }, testTimeout(60_000));

      test.each(["qa", "roll", "raw"])(
        "doc link %s resolves to an existing file on disk",
        (name) => {
          const match = xHtml.match(new RegExp(`href="([^"]*)">${name}<`));
          assert(match, `doc link ${name} should exist on x.html`);
          expect(existsSync(decodeURIComponent(new URL(match[1]!).pathname))).toBe(true);
        },
      );

      test("linker rewrites a doc's encoded q&a file link to its served route", () => {
        const match = xHtml.match(/href="([^"]*)">qa</);
        assert(match, "qa link should exist on x.html");
        expect(linker([data]).pages(`href="${match[1]!}"`)).toBe('href="/r/doc/docs/q%26a"');
      });

      const openDiskPageStage = async (
        context: Awaited<ReturnType<typeof browser.createBrowserContext>>,
      ) => {
        const page = await context.newPage();
        await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
        const requests: string[] = [];
        page.on("request", (r) => {
          requests.push(r.url());
        });
        await page.goto(`file://${out}/r/doc/docs/x.html`, { waitUntil: "load" });
        await page.keyboard.press("/");
        // theme.js darkens the page, admin.js focuses the search on "/".
        const initial = await page.evaluate(() => ({
          title: document.title,
          theme: document.documentElement.dataset.theme,
          activeId: document.activeElement!.id,
        }));
        return { page, requests, initial };
      };

      const readThemeState = (page: Awaited<ReturnType<typeof browser.newPage>>) =>
        page.evaluate(() => [
          document.documentElement.dataset.theme,
          document.getElementById("theme-toggle")!.getAttribute("aria-pressed"),
          localStorage.getItem("theme"),
        ]);

      const toggleThemeStage = async (
        context: Awaited<ReturnType<typeof browser.createBrowserContext>>,
      ) => {
        const stage = await openDiskPageStage(context);
        // The header's theme switch turns the page and stores the choice, which outlasts a reload
        // and the system's theme.
        await stage.page.click("#theme-toggle");
        const afterToggle = await readThemeState(stage.page);
        return { ...stage, afterToggle };
      };

      const reloadAfterThemeStage = async (
        context: Awaited<ReturnType<typeof browser.createBrowserContext>>,
      ) => {
        const stage = await toggleThemeStage(context);
        await stage.page.reload({ waitUntil: "load" });
        const afterReload = await readThemeState(stage.page);
        return { ...stage, afterReload };
      };

      const submitFormStage = async (
        context: Awaited<ReturnType<typeof browser.createBrowserContext>>,
      ) => {
        const stage = await reloadAfterThemeStage(context);
        await stage.page.click("#post");
        await new Promise((r) => setTimeout(r, 300));
        return stage;
      };

      describe("on initial dark load of x.html from disk", () => {
        let context: Awaited<ReturnType<typeof browser.createBrowserContext>> | undefined;
        let initial: { title: string; theme: string | undefined; activeId: string } = {
          title: "",
          theme: undefined,
          activeId: "",
        };

        afterAll(async () => {
          if (context) await context.close();
        });

        beforeAll(async () => {
          context = await browser.createBrowserContext();
          const stage = await openDiskPageStage(context);
          initial = stage.initial;
        }, testTimeout(60_000));

        test("blocks inline, external and onerror doc scripts on x.html", () => {
          expect(initial.title).toBe("X · r · Admin");
        });

        test("darkens x.html to follow the system theme on load", () => {
          expect(initial.theme).toBe("dark");
        });

        test("focuses the search input when / is pressed on x.html", () => {
          expect(initial.activeId).toBe("admin-search");
        });
      });

      describe("after toggling the theme switch on x.html", () => {
        let context: Awaited<ReturnType<typeof browser.createBrowserContext>> | undefined;
        let afterToggle: (string | null | undefined)[] = [];

        afterAll(async () => {
          if (context) await context.close();
        });

        beforeAll(async () => {
          context = await browser.createBrowserContext();
          const stage = await toggleThemeStage(context);
          afterToggle = stage.afterToggle;
        }, testTimeout(60_000));

        test("turns the page light and stores the choice in localStorage", () => {
          expect(afterToggle).toEqual(["light", "false", "light"]);
        });
      });

      describe("after reloading x.html with the stored light theme", () => {
        let context: Awaited<ReturnType<typeof browser.createBrowserContext>> | undefined;
        let afterReload: (string | null | undefined)[] = [];

        afterAll(async () => {
          if (context) await context.close();
        });

        beforeAll(async () => {
          context = await browser.createBrowserContext();
          const stage = await reloadAfterThemeStage(context);
          afterReload = stage.afterReload;
        }, testTimeout(60_000));

        test("keeps the stored light theme despite dark system preference", () => {
          expect(afterReload).toEqual(["light", "false", "light"]);
        });
      });

      describe("after submitting a doc form on the reloaded light page", () => {
        let context: Awaited<ReturnType<typeof browser.createBrowserContext>> | undefined;
        let requests: string[] = [];

        afterAll(async () => {
          if (context) await context.close();
        });

        beforeAll(async () => {
          context = await browser.createBrowserContext();
          const stage = await submitFormStage(context);
          requests = stage.requests;
        }, testTimeout(60_000));

        test("blocks form posts and sends no https request across reload and submit", () => {
          expect(requests.filter((u) => u.startsWith("https:"))).toEqual([]);
        });
      });

      describe("after navigating from x.html to y.html", () => {
        let context: Awaited<ReturnType<typeof browser.createBrowserContext>> | undefined;
        let title = "";

        afterAll(async () => {
          if (context) await context.close();
        });

        beforeAll(async () => {
          context = await browser.createBrowserContext();
          const stage = await submitFormStage(context);
          await stage.page.goto(`file://${out}/r/doc/docs/y.html`, { waitUntil: "load" });
          title = await stage.page.title();
        }, testTimeout(60_000));

        test("an unclosed script attribute in a doc cannot hijack the hub's nonce", () => {
          expect(title).not.toContain("|file");
        });
      });
    });
  });
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

  const themeScript = readFileSync(join(import.meta.dirname, "../../site/src/theme.js"), "utf8");
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const openThemePage = (attributes: readonly string[]) => {
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
    for (const attribute of attributes) doc.documentElement.setAttribute(attribute, "");
    evaluate(window, themeScript);
    evaluate(window, code);
    const shell = doc.querySelector("[data-shell]") as unknown as HTMLElement;
    const own = doc.querySelector("[data-admin-theme]") as unknown as HTMLElement;
    const read = () => [
      doc.documentElement.dataset.theme,
      own.getAttribute("aria-pressed"),
      window.localStorage.getItem("theme"),
    ];
    return { window, doc, own, shell, read };
  };

  test.each([
    {
      label: "the hub",
      attributes: [] as string[],
      written: "admin-answers:seen",
      untouched: "admin-catalog:seen",
    },
    {
      label: "a catalog page",
      attributes: ["data-admin-catalog"],
      written: "admin-catalog:seen",
      untouched: "admin-answers:seen",
    },
  ])("keeps visit storage separate on $label", ({ attributes, written, untouched }) => {
    const page = openThemePage(attributes);
    expect(page.window.localStorage.getItem(written)).not.toBeNull();
    expect(page.window.localStorage.getItem(untouched)).toBeNull();
  });

  test.each([
    ["the hub", []],
    ["a catalog page with night", ["data-admin-catalog", "data-hw-night"]],
  ])(
    "the theme switch turns %s by its own button, ignores the shell switch, and follows a shell flip",
    async (_label, attributes) => {
      const page = openThemePage(attributes);
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
    },
  );

  test("a catalog page without night stays day even when its own switch is clicked", async () => {
    const alone = openThemePage(["data-admin-catalog"]);
    expect(alone.read()).toEqual(["light", "false", "dark"]);
    alone.own.click();
    await tick();
    expect(alone.read()).toEqual(["light", "false", "dark"]);
  });

  test.each([
    { label: "with site data allowed", storage: {} as Record<string, string> | null },
    { label: "when site data is blocked", storage: null },
  ])("choosing a kind hides rows of other kinds ($label)", ({ storage }) => {
    const doc = open("index", storage).document;
    // A kind filters the rows.
    (doc.querySelector('[data-kind-button="decision"]') as unknown as HTMLElement).click();
    const kinds = [...doc.querySelectorAll("[data-row][data-kind]")]
      .filter((r) => !r.closest("[hidden]"))
      .map((r) => (r as unknown as HTMLElement).dataset.kind);
    expect(kinds).toEqual(["decision", "decision", "decision", "decision"]);
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
    const attempted: string[] = [];
    const writeByKey: Record<string, (k: string, v: string) => void> = {
      "admin-answers:visit": (k, v) => backing.setItem(k, v),
      "admin-answers:before": () => {
        throw new window.DOMException("quota full", "QuotaExceededError");
      },
      "admin-answers:seen": (k, v) => backing.setItem(k, v),
      "admin-answers:versions": (k, v) => backing.setItem(k, v),
    };
    const storageProto = {
      get length() {
        return backing.length;
      },
      getItem: (k: string) => backing.getItem(k),
      setItem: (k: string, v: string) => {
        attempted.push(k);
        writeByKey[k]!(k, v);
      },
      removeItem: (k: string) => backing.removeItem(k),
      key: (i: number) => backing.key(i),
    };
    const fakeStorage = Object.assign(Object.create(storageProto) as Record<string, string>, {
      "admin-answers:seen": oldSeen,
      "admin-answers:who": "Kim",
      "admin-answers:versions": "{}",
      "admin-answers:spoke:pick-a-logo": deferred,
    });
    Object.defineProperty(window, "localStorage", { value: fakeStorage });
    window.document.write(
      readForDom(join(out, "index.html")).replace(/<script[^>]*><\/script>/g, ""),
    );
    evaluate(window, code);
    expect(attempted).toEqual(["admin-answers:visit", "admin-answers:before"]);
    expect(
      window.document
        .querySelector('[data-who-button][aria-pressed="true"]')
        ?.getAttribute("data-who-button"),
    ).toBe("Kim");
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

  test.each([
    ["a falsy stored note loads as an empty field", 0, ""],
    ["a numeric stored note loads as written", 42, "42"],
  ])("%s", (_label, note, expected) => {
    const page = open("spoke/decisions", {
      "admin-answers:seen": String(Date.now()),
      "admin-answers:spoke:check-the-copy": JSON.stringify({
        later: true,
        note,
        at: "2026-01-01T12:00:00.000Z",
      }),
    });
    const field = page.document.querySelector<DomTextArea>("#spoke\\:check-the-copy textarea")!;
    expect(field.value).toBe(expected);
  });

  test("opening a variant image gives the dialog an accessible name before it opens", () => {
    const page = open("spoke/decisions", {});
    const row = page.document.getElementById("spoke:pick-a-variant")!;
    const shot = row.querySelector<DomButton>('button[aria-label="light, 600 px: open large"]')!;
    const dialog = page.document.querySelector<DomDialog>("dialog#admin-zoom")!;
    const observer = new page.MutationObserver(() => {});
    observer.observe(dialog, { attributes: true, attributeFilter: ["aria-label", "open"] });
    shot.click();
    expect(dialog.open).toBe(true);
    expect(observer.takeRecords().map((record) => record.attributeName)).toEqual([
      "aria-label",
      "open",
    ]);
    observer.disconnect();
    const img = dialog.querySelector("img");
    assert(img, "zoom dialog must contain an image");
    expect(dialog.getAttribute("aria-label")).toBe("light, 600 px");
    expect(img.alt).toBe("light, 600 px");
    expect(img.src).toMatch(/\/pick-a-variant\/variant-b\.svg$/);
  });

  test("closing the variant image dialog shuts it without errors and keeps its accessible name", () => {
    const page = open("spoke/decisions", {});
    const row = page.document.getElementById("spoke:pick-a-variant")!;
    const shot = row.querySelector<DomButton>('button[aria-label="light, 600 px: open large"]')!;
    const dialog = page.document.querySelector<DomDialog>("dialog#admin-zoom")!;
    const errors: unknown[] = [];
    page.addEventListener("error", (event) => errors.push(event));
    shot.click();
    assert(dialog.open, "zoom dialog must open before closing");
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

  test("an answer is stored as it is given, reveals Reset, and the copy button counts it", () => {
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
    expect((row.querySelector(".clear") as DomElement).hidden).toBe(false);
  });

  test("resetting an answer hides Reset and moves focus to the row's first answer", () => {
    const page = open("spoke/decisions", {});
    const row = page.document.getElementById("spoke:pick-a-variant")!;
    const pick = row.querySelector('input[data-option][value="b"]') as DomInput;
    pick.checked = true;
    row.dispatchEvent(new page.Event("change"));
    const reset = row.querySelector(".clear") as DomElement;
    // Pressed, it leaves; focus moves to the row's first answer, not back to the page's top.
    reset.focus();
    reset.click();
    expect(reset.hidden).toBe(true);
    expect(page.document.activeElement === row.querySelector("input[data-option]")).toBe(true);
  });

  test("resetting an answer moves focus to the first shown option when a search hid the first", () => {
    const page = open("spoke/decisions", {});
    // Where a search hid the first option, focus goes to the first one shown.
    (page.document.querySelector('[data-who-button="all"]') as DomElement).click();
    const list = page.document.getElementById("spoke:pick-recipients")!;
    const second = list.querySelectorAll("input[data-option]")[1] as DomInput;
    second.checked = true;
    list.dispatchEvent(new page.Event("change"));
    const search = page.document.getElementById("admin-search") as DomInput;
    search.value = "Ben Sample";
    search.dispatchEvent(new page.Event("input"));
    expect((list.querySelector("[data-option-row]") as DomElement).hidden).toBe(true);
    (list.querySelector(".clear") as DomElement).click();
    expect(page.document.activeElement === second).toBe(true);
  });

  describe("answering, vetoing, and deferring on Decisions", () => {
    const afterPickingRecommendation = () => {
      const page = open("spoke/decisions", {});
      const row = (k: string) => page.document.getElementById(k) as unknown as DomElement;
      const variant = row("spoke:pick-a-variant");
      (variant.querySelector("summary + div .pick") as DomElement).click();
      return { page, row, variant };
    };

    const afterVetoingAssumption = () => {
      const state = afterPickingRecommendation();
      const cache = state.row("spoke:cache-folder");
      const veto = cache.querySelector("input[data-stance][value=veto]") as DomInput;
      veto.checked = true;
      cache.dispatchEvent(new state.page.Event("change"));
      (cache.querySelector("textarea") as unknown as HTMLTextAreaElement).value = "keep a line";
      cache.querySelector("textarea")!.dispatchEvent(new state.page.Event("input"));
      return { ...state, cache };
    };

    const afterDeferringLogo = () => {
      const state = afterVetoingAssumption();
      const logo = state.row("spoke:pick-a-logo");
      (logo.querySelector(".pick") as DomElement).click();
      const later = logo.querySelector("input[data-later]") as DomInput;
      later.checked = true;
      later.dispatchEvent(new state.page.Event("change", { bubbles: true }));
      return { ...state, logo, later };
    };

    const afterDeferringNotedReview = () => {
      const state = afterDeferringLogo();
      const review = state.row("spoke:check-the-copy");
      (review.querySelector("textarea") as unknown as HTMLTextAreaElement).value = "looks fine";
      review.querySelector("textarea")!.dispatchEvent(new state.page.Event("input"));
      const off = review.querySelector("input[data-later]") as DomInput;
      off.checked = true;
      off.dispatchEvent(new state.page.Event("change", { bubbles: true }));
      return { ...state, review, off };
    };

    const afterPickingLaterKeyedOption = () => {
      const state = afterDeferringNotedReview();
      const b = state.variant.querySelector('input[data-option][value="b"]') as DomInput;
      b.value = "later";
      b.checked = true;
      state.variant.dispatchEvent(new state.page.Event("change"));
      return state;
    };

    const afterTakingDeferredQuestionUpWithNote = () => {
      const state = afterPickingLaterKeyedOption();
      state.later.checked = true;
      state.later.dispatchEvent(new state.page.Event("change", { bubbles: true }));
      (state.logo.querySelector("textarea") as unknown as HTMLTextAreaElement).value =
        "ask the printer";
      state.logo.querySelector("textarea")!.dispatchEvent(new state.page.Event("input"));
      return state;
    };

    describe("after picking a recommendation", () => {
      let stage!: ReturnType<typeof afterPickingRecommendation>;
      beforeAll(() => {
        stage = afterPickingRecommendation();
      });

      test("marks the picked recommendation on the row", () => {
        expect(stage.variant.querySelector(".mark")!.textContent).toBe("✓ Variant A");
      });

      test("shows no recommendation button on an assumption", () => {
        // An assumption has no recommendation to pick: Agree and Veto answer it.
        expect(stage.row("spoke:cache-folder").querySelector(".pick")).toBeNull();
      });
    });

    describe("after vetoing an assumption with a note", () => {
      let stage!: ReturnType<typeof afterVetoingAssumption>;
      beforeAll(() => {
        stage = afterVetoingAssumption();
      });

      test("marks the assumption vetoed and keeps its task list ticks", () => {
        expect(stage.cache.querySelector(".mark")!.textContent).toBe("✓ veto");
        // The item's own task list keeps its ticks.
        expect(
          [...stage.cache.querySelectorAll(".task-list-item-checkbox")].map(
            (b) => (b as DomInput).checked,
          ),
        ).toEqual([true, false]);
      });
    });

    describe("after putting a question off", () => {
      let stage!: ReturnType<typeof afterDeferringLogo>;
      beforeAll(() => {
        stage = afterDeferringLogo();
      });

      test("clears the pick, marks the row later, and leaves it out of the copy", () => {
        // Putting a question off clears its pick, and the copy leaves it out.
        expect(stage.logo.querySelectorAll("input[data-option]:checked").length).toBe(0);
        expect(stage.logo.querySelector(".mark")!.textContent).toBe("later");
        const text = (stage.page.document.getElementById("copy") as DomElement).dataset.hwCopy;
        expect(text).toContain("spoke:pick-a-variant: a (Variant A)");
        expect(text).toContain("spoke:cache-folder: veto, keep a line");
        expect(text).not.toContain("pick-a-logo");
      });

      test("the next visit drops the deferral and keeps every other stored answer", () => {
        // The next visit asks it again; the answers stay.
        const back = open("spoke/decisions", {
          ...stored(stage.page),
          "admin-answers:seen": String(Date.now() - 2 * 36e5),
        });
        const bookkeeping = new Set([
          "admin-answers:before",
          "admin-answers:seen",
          "admin-answers:versions",
          "admin-answers:visit",
        ]);
        const answers = Object.fromEntries(
          Object.entries(stored(back))
            .filter(([key]) => !bookkeeping.has(key))
            .map(([key, value]) => {
              const { at: _at, ...answer } = JSON.parse(value) as Record<string, unknown>;
              return [key, answer];
            }),
        );
        assert(stage.variant.dataset.asked, "variant row must carry data-asked");
        assert(stage.cache.dataset.asked, "cache row must carry data-asked");
        expect(answers).toEqual({
          "admin-answers:spoke:pick-a-variant": {
            later: false,
            stance: "",
            option: "a",
            label: ["Variant A"],
            asked: stage.variant.dataset.asked,
            done: false,
            note: "",
          },
          "admin-answers:spoke:cache-folder": {
            later: false,
            stance: "veto",
            option: "",
            label: [],
            asked: stage.cache.dataset.asked,
            done: false,
            note: "keep a line",
          },
        });
      });
    });

    describe("after putting a noted question off", () => {
      let stage!: ReturnType<typeof afterDeferringNotedReview>;
      beforeAll(() => {
        stage = afterDeferringNotedReview();
      });

      test("keeps earlier answers in the copy while leaving the deferred note out", () => {
        // A note written before a question is put off is its answer on the next visit.
        expect((stage.page.document.getElementById("copy") as DomElement).dataset.hwCopy).toBe(
          [
            "Answers from the admin pages:",
            "spoke:pick-a-variant: a (Variant A)",
            "spoke:cache-folder: veto, keep a line",
          ].join("\n"),
        );
      });

      test("copies the deferred note on the next visit", () => {
        const next = open("spoke/decisions", {
          ...stored(stage.page),
          "admin-answers:seen": String(Date.now() - 2 * 36e5),
        });
        expect((next.document.getElementById("copy") as DomElement).dataset.hwCopy).toContain(
          "spoke:check-the-copy: looks fine",
        );
      });
    });

    describe("after picking an option whose key is later", () => {
      let stage!: ReturnType<typeof afterPickingLaterKeyedOption>;
      beforeAll(() => {
        stage = afterPickingLaterKeyedOption();
      });

      test("stores the option as a pick rather than deferring the question", () => {
        // An option whose key is "later" or "done" is a pick like any other.
        expect(
          JSON.parse(stage.page.localStorage.getItem("admin-answers:spoke:pick-a-variant")!),
        ).toMatchObject({ option: "later", later: false });
      });
    });

    describe("after writing a note on a deferred question", () => {
      let stage!: ReturnType<typeof afterTakingDeferredQuestionUpWithNote>;
      beforeAll(() => {
        stage = afterTakingDeferredQuestionUpWithNote();
      });

      test("unchecks Decide later and includes the note in the copy", () => {
        // A note is an answer: it takes a question put off up again.
        expect(stage.later.checked).toBe(false);
        expect((stage.page.document.getElementById("copy") as DomElement).dataset.hwCopy).toContain(
          "spoke:pick-a-logo: ask the printer",
        );
      });
    });
  });

  describe("stored answers when questions or options change", () => {
    const openStaleAnswersPage = () => {
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
        "admin-answers:spoke:pick-a-logo": JSON.stringify({
          option: "v02",
          label: "Variant 2",
          at,
        }),
        // Several picks copy each label.
        "admin-answers:spoke:pick-recipients": JSON.stringify({
          option: "ben-sample,ada-example",
          asked: asked("spoke:pick-recipients"),
          label: ["Ben Sample", "Ada Example"],
          at,
        }),
      });
      return { page, asked };
    };

    let shared!: ReturnType<typeof openStaleAnswersPage>;
    beforeAll(() => {
      shared = openStaleAnswersPage();
    });

    test.each([
      {
        label: "a changed question hash",
        id: "spoke:pick-a-variant",
        expectedChecked: [] as string[],
        expectedMark: "! answered before the question changed",
        staleHidden: false,
      },
      {
        label: "a legacy answer whose label changed",
        id: "spoke:name-the-command",
        expectedChecked: [] as string[],
        expectedMark: "! answered before the question changed",
        staleHidden: false,
      },
      {
        label: "a legacy answer whose label still matches",
        id: "spoke:pick-a-logo",
        expectedChecked: ["v02"],
        expectedMark: "✓ Variant 2",
        staleHidden: true,
      },
      {
        label: "multiple current picks",
        id: "spoke:pick-recipients",
        expectedChecked: ["ada-example", "ben-sample"],
        expectedMark: "✓ 2 picked",
        staleHidden: true,
      },
    ])(
      "loads stored answers according to whether their question changed ($label)",
      ({ id, expectedChecked, expectedMark, staleHidden }) => {
        const row = shared.page.document.getElementById(id)!;
        const checked = [...row.querySelectorAll("input[data-option]:checked")]
          .map((i) => (i as DomInput).value)
          .sort();
        expect(checked).toEqual(expectedChecked);
        expect(row.querySelector(".mark")!.textContent).toBe(expectedMark);
        expect(row.querySelector("[data-stale]")!.hasAttribute("hidden")).toBe(staleHidden);
      },
    );

    test("a stale answer's notice quotes the old label and when it was answered", () => {
      const notice = shared.page.document
        .getElementById("spoke:pick-a-variant")!
        .querySelector("[data-stale]")!;
      expect(notice.textContent).toContain("The old label");
      expect(notice.textContent).toMatch(/1 Jan.*09:00/);
    });

    test("the copy block formats stale and multi-pick answers in page order", () => {
      const block = (shared.page.document.getElementById("copy") as DomElement).dataset.hwCopy!;
      expect(block).toContain("spoke:pick-a-variant: a (The old label), go; answered ");
      expect(block).toMatch(/spoke:name-the-command: short \(A short name\); answered .*changed/);
      expect(block).toContain(
        "spoke:pick-recipients: ben-sample (Ben Sample), ada-example (Ada Example)\n",
      );
      // Lines follow the page.
      const expectedOrder = [
        "pick-a-variant",
        "pick-a-logo",
        "pick-recipients",
        "name-the-command",
      ];
      const renderedOrder = [...shared.page.document.querySelectorAll("details.item[data-k]")]
        .map((d) => (d as unknown as HTMLElement).dataset.k!.slice("spoke:".length))
        .filter((k) => expectedOrder.includes(k));
      expect(renderedOrder).toEqual(expectedOrder);
      expect([...block.matchAll(/^spoke:([\w-]+):/gm)].map((m) => m[1])).toEqual(expectedOrder);
    });

    test("picking again on a stale row records the current question and clears its notice", () => {
      const { page, asked } = openStaleAnswersPage();
      const row = page.document.getElementById("spoke:pick-a-variant")!;
      // Picking again is the answer to the question as it stands now.
      const pick = row.querySelector('input[value="b"]') as DomInput;
      pick.checked = true;
      row.dispatchEvent(new page.Event("change"));
      expect(
        JSON.parse(page.localStorage.getItem("admin-answers:spoke:pick-a-variant")!),
      ).toMatchObject({ option: "b", label: ["Variant B"], asked: asked("spoke:pick-a-variant") });
      expect(row.querySelector("[data-stale]")!.hasAttribute("hidden")).toBe(true);
    });
  });

  describe("copying uncopied and previously copied answers", () => {
    const at = (h: number) => new Date(2026, 0, 1, h).toISOString();
    const copySeed = () => ({
      "admin-answers:copied": at(12),
      "admin-answers:spoke:pick-a-logo": JSON.stringify({
        option: "v02",
        label: "Variant 2",
        at: at(10),
      }),
      "admin-answers:spoke:check-the-copy": JSON.stringify({ note: "fine", at: at(13) }),
    });

    let first!: Window;
    beforeAll(() => {
      first = open("spoke/decisions", copySeed());
    });

    test("a copy holds only answers not copied yet and shows saved and copied times", () => {
      const copy = first.document.getElementById("copy") as DomElement;
      expect(copy.dataset.hwCopy).toContain("spoke:check-the-copy: fine");
      expect(copy.dataset.hwCopy).not.toContain("pick-a-logo");
      expect(copy.textContent).toBe("Copy 1 answer");
      expect(first.document.getElementById("state")!.textContent).toContain("1 not copied yet");
      expect(
        first.document.getElementById("spoke:pick-a-logo")!.querySelector(".saved")!.textContent,
      ).toBe("saved 10:00, copied 12:00");
    });

    test("once every answer from the visit before is copied, the button copies all of them again and marks rows copied", () => {
      const done = open("spoke/decisions", { ...stored(first), "admin-answers:copied": at(14) });
      const again = done.document.getElementById("copy") as DomElement;
      expect(again.dataset.hwCopy).toContain("pick-a-logo");
      expect(again.dataset.hwCopy).toContain("check-the-copy");
      expect(again.textContent).toBe("Copy 2 answers again");
      // The row says it went out.
      expect(
        done.document.getElementById("spoke:pick-a-logo")!.querySelector(".mark")!.textContent,
      ).toContain("copied");
    });

    test("a copy made in another tab marks uncopied rows here as copied", () => {
      const page = open("spoke/decisions", copySeed());
      // A copy made in another tab marks the rows here too.
      const mark = () =>
        page.document.getElementById("spoke:check-the-copy")!.querySelector(".mark")!.textContent;
      expect(mark()).not.toContain("copied");
      page.localStorage.setItem("admin-answers:copied", at(14));
      page.dispatchEvent(new page.StorageEvent("storage", { key: "admin-answers:copied" }));
      expect(mark()).toContain("copied");
    });
  });

  test(
    "the fold holding a person's first question opens with the page, below a fold of work",
    async () => {
      const spoke = await readRepo(repoFrom("spoke"));
      // Alex, the hub's user, has only work in Priority 1 and every question in Priority 2.
      const variant = spoke.items.find((i) => i.id === "pick-a-variant");
      assert(variant, "spoke fixture must include pick-a-variant");
      const task = spoke.items.find((i) => i.id === "ask-the-printer");
      assert(task, "spoke fixture must include ask-the-printer");
      const items = [
        ...spoke.items.filter((i) => i.id !== "pick-a-variant"),
        { ...variant, priority: 2 },
        { ...task, id: "alex-task", owner: "Alex" },
      ];
      const dir = join(scratch(), "out");
      const repos = [{ ...spoke, items }];
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

  test("the hub counts open rows per person and per kind for the selected person", () => {
    const doc = open("index", {}).document;
    const button = (attr: string, v: string) =>
      doc.querySelector(`[${attr}="${v}"]`) as unknown as HTMLButtonElement;
    const count = (k: string) =>
      Number(button("data-kind-button", k).querySelector("[data-kind-count]")!.textContent);
    const people = (p: string) =>
      Number(button("data-who-button", p).querySelector("[data-who-count]")!.textContent);
    expect(count("all")).toBe(3);
    // Each person's button counts their open rows, All every one, which the rail's count names.
    expect(people("Alex")).toBe(3);
    expect(people("all")).toBe(6);
    expect(people("all")).toBeGreaterThan(people("Alex"));
    expect(count("decision")).toBe(2);
  });

  test("after resetting the kind filter, selecting another person shows their rows under Needs you once and opens a fold with rows", () => {
    const doc = open("index", {}).document;
    (doc.querySelector('[data-kind-button="decision"]') as unknown as HTMLButtonElement).click();
    (doc.querySelector('[data-kind-button="all"]') as unknown as HTMLButtonElement).click();
    // Kim's rows show under "Needs you", not a second time under "Waiting on others".
    (doc.querySelector('[data-who-button="Kim"]') as unknown as HTMLButtonElement).click();
    const kim = doc.querySelector('[data-who-group="Kim"]')!;
    expect(kim.closest("[hidden]")).not.toBeNull();
    expect(
      Number(doc.querySelector('[data-kind-button="all"] [data-kind-count]')!.textContent),
    ).toBe(1);
    // Kim has no Priority 2 or 3 row open by default: a fold with rows opens.
    const needs = doc.querySelector("[data-who-button]")!.closest("section")!;
    const visibleFolds = [...needs.querySelectorAll("details[data-group]")].filter(
      (g) => !g.closest("[hidden]"),
    );
    expect(visibleFolds.map((g) => (g as unknown as HTMLDetailsElement).open)).toEqual([true]);
  });

  test("searching for text in the hidden updated mark finds nothing, hides empty sections, and clearing restores them", () => {
    const page = open("index", {});
    const doc = page.document;
    (doc.querySelector('[data-who-button="all"]') as unknown as HTMLButtonElement).click();
    // The hidden "updated" mark is no text a search finds.
    const search = doc.getElementById("admin-search") as DomInput;
    search.value = "updated";
    search.dispatchEvent(new page.Event("input"));
    const visible = [...doc.querySelectorAll("[data-row]")].filter((r) => !r.closest("[hidden]"));
    expect(visible).toEqual([]);
    expect(doc.getElementById("admin-nohit")!.hasAttribute("hidden")).toBe(false);
    expect(doc.getElementById("admin-nohit")!.textContent).toContain("“updated”");
    // Every section without a row to show steps aside, but the one holding the filters.
    const filters = doc.querySelector('[data-who-button="all"]')!.closest("section");
    const left = [...doc.querySelectorAll("main section")].filter((x) => !x.hasAttribute("hidden"));
    expect(left).toEqual([filters]);
    search.value = "";
    search.dispatchEvent(new page.Event("input"));
    expect(
      [...doc.querySelectorAll("main section")].filter((x) => x.hasAttribute("hidden")).length,
    ).toBe(0);
  });

  test("a search for another person's row on the hub shows it under Waiting on others", () => {
    const page = open("index", {});
    const doc = page.document;
    // Another person's row the search finds shows under "Waiting on others".
    const search = doc.getElementById("admin-search") as DomInput;
    search.value = "printer";
    search.dispatchEvent(new page.Event("input"));
    const waiting = doc.querySelector("[data-who-group]")!.closest("section")!;
    const heading = waiting.querySelector("h2");
    assert(heading, "Waiting on others section heading must exist");
    assert(heading.textContent === "Waiting on others", "section must be Waiting on others");
    const visibleWaitingKeys = [...waiting.querySelectorAll("[data-row]")]
      .filter((r) => !r.closest("[hidden]"))
      .map((r) => (r as unknown as HTMLElement).dataset.k);
    expect(visibleWaitingKeys).toEqual(["spoke:ask-the-printer"]);
    expect(doc.getElementById("admin-nohit")!.hasAttribute("hidden")).toBe(true);
  });

  test("a search matching only another person's row on Decisions says so", () => {
    // Where no other list shows it, a row of another person the search finds is named.
    const decisions = open("spoke/decisions", { "admin-answers:who": "Alex" });
    const find = decisions.document.getElementById("admin-search") as DomInput;
    find.value = "monthly";
    find.dispatchEvent(new decisions.Event("input"));
    expect(decisions.document.getElementById("admin-nohit")!.textContent).toContain(
      "1 row of other people does",
    );
  });

  test("following a hash link shows its row whatever person the filter is on", () => {
    const page = open("index", {});
    // A link followed on the page shows its row whatever person the filter is on.
    const other = page.document.getElementById("spoke:ask-the-printer");
    assert(other, "spoke:ask-the-printer row must exist on the hub");
    assert(other.closest("[hidden]"), "another person's row must start hidden");
    page.location.hash = "#spoke:ask-the-printer";
    page.dispatchEvent(new page.Event("hashchange"));
    expect(other.closest("[hidden]")).toBeNull();
  });

  describe("hidden repositories", () => {
    const shownRepoRows = (doc: Window["document"]) =>
      [...doc.querySelectorAll("[data-repo]")].filter((r) => !r.closest("[hidden]")).length;
    const shownRepoKeys = (doc: Window["document"]) =>
      [...doc.querySelectorAll("[data-repo]")]
        .filter((r) => !r.closest("[hidden]"))
        .map((r) => (r as unknown as HTMLElement).dataset.k);
    const hiddenRepoSeed = () => ({
      "admin-answers:repos": '["spoke"]',
      "admin-answers:spoke:check-the-copy": JSON.stringify({
        note: "fine",
        at: new Date().toISOString(),
      }),
    });

    let hiddenHub!: Window;
    beforeAll(() => {
      hiddenHub = open("index", hiddenRepoSeed());
    });

    test("hiding a repository removes its rows from the hub, zeros counts, announces it, and marks its table row", () => {
      const doc = hiddenHub.document;
      expect(shownRepoRows(doc)).toBe(0);
      expect(doc.querySelector('[data-kind-button="all"] [data-kind-count]')!.textContent).toBe(
        "0",
      );
      expect(doc.querySelector("[data-repo-count]")!.textContent).toBe("0 of 1");
      expect(doc.querySelector("[data-repo-said]")!.textContent).toBe(
        "1 repository hidden: Sample spoke.",
      );
      expect(
        doc.querySelector('[data-repo-row="spoke"] [data-repo-off]')!.hasAttribute("hidden"),
      ).toBe(false);
    });

    test("a repository's admin.label names it everywhere a person reads it while keeping its key as address", () => {
      const doc = hiddenHub.document;
      // The fixture's admin.label names it wherever a person reads it; the key stays its address.
      expect(
        doc.querySelector('[data-repo-box][value="spoke"]')!.closest("label")!.textContent,
      ).toMatch(/^\s*Sample spoke\s+spoke\s*$/);
      expect(doc.querySelector('[data-repo-row="spoke"] a')!.textContent!.trim()).toBe(
        "Sample spoke",
      );
      expect(
        open("spoke/decisions", null).document.querySelector(".hw-nav-group")!.textContent!.trim(),
      ).toBe("Sample spoke");
    });

    test("hiding a repository is not an answer and leaves the copy block with real answers alone", () => {
      // The choice is no answer: the copy holds the one answer alone.
      const copy = (hiddenHub.document.getElementById("copy") as DomElement).dataset.hwCopy!;
      expect(copy).toBe("Answers from the admin pages:\nspoke:check-the-copy: fine");
    });

    test("a repository page shows its rows even when that repository is hidden on the hub", () => {
      // Another page hides nothing by repository.
      const decisions = open("spoke/decisions", hiddenRepoSeed());
      expect(decisions.document.querySelector("details.item:not([hidden])")).not.toBeNull();
    });

    test("searching for a row in a hidden repository names hidden repositories", () => {
      const page = open("index", hiddenRepoSeed());
      const doc = page.document;
      // A search finding rows only there says so.
      const search = doc.getElementById("admin-search") as DomInput;
      search.value = "monthly";
      search.dispatchEvent(new page.Event("input"));
      expect(doc.getElementById("admin-nohit")!.textContent).toMatch(
        /rows? in hidden repositories/,
      );
    });

    test("a hash link reveals a row in a hidden repository and clearing the hash hides it again", () => {
      const page = open("index", hiddenRepoSeed());
      const doc = page.document;
      // A link to an item there opens it.
      page.location.hash = "#spoke:pick-a-variant";
      page.dispatchEvent(new page.Event("hashchange"));
      expect(doc.getElementById("spoke:pick-a-variant")!.closest("[hidden]")).toBeNull();
      expect(shownRepoKeys(doc)).toEqual(["spoke:pick-a-variant"]);
      // Once the address names another row, the row it named before hides with its repository.
      page.location.hash = "";
      page.dispatchEvent(new page.Event("hashchange"));
      expect(shownRepoRows(doc)).toBe(0);
    });

    test("after opening a row by hash, Show all restores every hidden repository row and forgets the stored choice", () => {
      const page = open("index", hiddenRepoSeed());
      const doc = page.document;
      page.location.hash = "#spoke:pick-a-variant";
      page.dispatchEvent(new page.Event("hashchange"));
      // "Show all" brings every row back and forgets the choice.
      (doc.querySelector("[data-repo-all]") as unknown as HTMLButtonElement).click();
      expect(shownRepoRows(doc)).toBe(9);
      expect(stored(page)["admin-answers:repos"]).toBeUndefined();
      expect(doc.querySelector("[data-repo-said]")!.textContent).toBe("");
    });

    test("after opening a row by hash and clicking Show all, Hide all hides every other row, stores the choice, and swaps the buttons", () => {
      const page = open("index", hiddenRepoSeed());
      const doc = page.document;
      page.location.hash = "#spoke:pick-a-variant";
      page.dispatchEvent(new page.Event("hashchange"));
      (doc.querySelector("[data-repo-all]") as unknown as HTMLButtonElement).click();
      // "Hide all" unchecks every box and keeps the choice; with nothing left to hide it steps aside.
      const none = doc.querySelector("[data-repo-none]") as unknown as HTMLButtonElement;
      none.click();
      expect(shownRepoKeys(doc)).toEqual(["spoke:pick-a-variant"]);
      expect(stored(page)["admin-answers:repos"]).toBe('["spoke"]');
      expect(doc.querySelector("[data-repo-count]")!.textContent).toBe("0 of 1");
      expect(none.hasAttribute("hidden")).toBe(true);
      expect(doc.querySelector("[data-repo-all]")!.hasAttribute("hidden")).toBe(false);
    });

    test("after opening a row by hash, Hide all and Show all each move focus to the repository choice button", () => {
      const page = open("index", hiddenRepoSeed());
      const doc = page.document;
      page.location.hash = "#spoke:pick-a-variant";
      page.dispatchEvent(new page.Event("hashchange"));
      const showAll = doc.querySelector<DomButton>("[data-repo-all]")!;
      const none = doc.querySelector<DomButton>("[data-repo-none]")!;
      showAll.click();
      expect(none.hasAttribute("hidden")).toBe(false);
      // Each steps aside; focus goes to the choice's own button rather than the page's top.
      const choice = doc.querySelector("[popovertarget=admin-repo-choice]");
      none.focus();
      assert(doc.activeElement === none, "focus must sit on Hide all before clicking it");
      none.click();
      expect(doc.activeElement === choice).toBe(true);
      showAll.focus();
      assert(doc.activeElement === showAll, "focus must sit on Show all before clicking it");
      showAll.click();
      expect(doc.activeElement === choice).toBe(true);
    });

    test("after Show all, unchecking a repository box hides all its rows except the hash target and stores the choice", () => {
      const page = open("index", hiddenRepoSeed());
      const doc = page.document;
      page.location.hash = "#spoke:pick-a-variant";
      page.dispatchEvent(new page.Event("hashchange"));
      (doc.querySelector("[data-repo-all]") as unknown as HTMLButtonElement).click();
      // Unchecking the box hides it again and keeps the choice.
      const box = doc.querySelector('[data-repo-box][value="spoke"]') as unknown as DomInput;
      box.checked = false;
      box.dispatchEvent(new page.Event("change"));
      // All but the row the address names.
      expect(shownRepoKeys(doc)).toEqual(["spoke:pick-a-variant"]);
      expect(stored(page)["admin-answers:repos"]).toBe('["spoke"]');
    });

    test("another tab showing a repository updates the hub while unrelated storage writes leave a typed note alone", () => {
      const page = open("index", hiddenRepoSeed());
      const doc = page.document;
      // Another tab showing it again shows it here, and a write of anything else leaves a note being
      // typed as it is.
      page.localStorage.removeItem("admin-answers:repos");
      page.dispatchEvent(new page.StorageEvent("storage", { key: "admin-answers:repos" }));
      expect(shownRepoRows(doc)).toBe(9);
      const note = doc.querySelector(
        '[data-k="spoke:check-the-copy"] textarea',
      ) as unknown as DomInput;
      note.value = "fine ";
      page.dispatchEvent(new page.StorageEvent("storage", { key: "admin-answers:seen" }));
      expect(note.value).toBe("fine ");
    });

    test("after a hidden repository is shown again, its hidden mark is not text a search finds", () => {
      const page = open("index", hiddenRepoSeed());
      const doc = page.document;
      page.localStorage.removeItem("admin-answers:repos");
      page.dispatchEvent(new page.StorageEvent("storage", { key: "admin-answers:repos" }));
      expect(shownRepoRows(doc)).toBe(9);
      expect(doc.querySelector('[data-repo-row="spoke"]')!.hasAttribute("hidden")).toBe(false);
      // The word on a repository's "hidden" mark is no text a search finds.
      const search = doc.getElementById("admin-search") as DomInput;
      search.value = "hidden";
      search.dispatchEvent(new page.Event("input"));
      expect(doc.querySelector('[data-repo-row="spoke"]')!.hasAttribute("hidden")).toBe(true);
    });
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

  test("a heading comment starts closed and collapses whitespace into one copy line", () => {
    const first = open(SAMPLE_REPORT, {});
    const fold = first.document.querySelector("#next + [data-comment]");
    assert(fold, "heading comment fold must exist");
    expect(fold.hasAttribute("open")).toBe(false);
    typeComment(first);
    const copy = first.document.getElementById("copy")!;
    expect(copy.getAttribute("data-hw-copy")).toBe(
      "Answers from the admin pages:\nspoke:2026-01-15-sample-topic#next: why dotted? Any reason?",
    );
    expect(copy.textContent).toBe("Copy 1 answer");
  });

  test("a copied heading comment survives reload with its raw text and clears on reset", () => {
    const first = open(SAMPLE_REPORT, {});
    typeComment(first);
    const back = open(SAMPLE_REPORT, copiedComment(first));
    expect(commentField(back).value).toBe("why   dotted?\n  Any reason?");
    const mark = back.document.querySelector('[data-k="' + COMMENT + '"] .mark');
    assert(mark, "heading comment mark must exist");
    expect(mark.textContent).toBe("✓ comment · copied");
    const copy = back.document.getElementById("copy");
    assert(copy, "copy button must exist");
    expect(copy.textContent).toBe("Copy 1 answer again");
    (back.document.querySelector('[data-k="' + COMMENT + '"] .clear') as DomElement).click();
    expect(stored(back)[commentKey]).toBeUndefined();
    expect(commentField(back).value).toBe("");
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

  describe("changed items since last visit", () => {
    const markedUpdatedCount = (w: Window) =>
      w.document.querySelectorAll("[data-row] [data-updated]:not([hidden])").length;
    const hours = (h: number) => String(Date.now() - h * 36e5);

    let back!: Window;
    beforeAll(() => {
      // Two hours away: every item of the fixture's one commit is newer than the last visit.
      back = open("index", { "admin-answers:seen": hours(2) });
    });

    test("a first visit marks no rows, while a later visit marks changed rows and keeps marks within the hour", () => {
      expect(markedUpdatedCount(open("index", {}))).toBe(0);
      expect(markedUpdatedCount(back)).toBe(12);
      expect(Number(stored(back)["admin-answers:visit"])).toBeLessThan(Date.now() - 36e5);
      // A page view within the hour belongs to the same visit, and keeps its marks.
      expect(markedUpdatedCount(open("spoke/work", stored(back)))).toBe(3);
    });

    test("a fold with changed rows counts them and the page banner reports how many changed", () => {
      // Each fold that holds a marked row counts it, and the page says how many changed.
      const fold = back.document.querySelector(
        "details[data-group] [data-updated-count]:not([hidden])",
      )!;
      expect(fold.textContent).toBe("· 1 updated");
      expect(back.document.getElementById("admin-since")!.textContent).toContain(
        "9 items on this page changed since your last visit",
      );
    });

    test("a hidden repository's changed rows count nowhere unless a hash link opens one", () => {
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
      expect(away.document.getElementById("admin-since")!.textContent).toMatch(/^1 item /);
    });
  });

  describe("row version comparison across visits", () => {
    const changed = "spoke:pick-a-variant";
    let rawVersions = "";
    beforeAll(() => {
      rawVersions = stored(open("index", {}))["admin-answers:versions"]!;
    });

    test("a row shown on the visit before compares its file, not its commit time", () => {
      const saved: unknown = JSON.parse(rawVersions);
      assert(saved !== null, "stored versions must not be null");
      assert(typeof saved === "object", "stored versions must be an object");
      assert(!Array.isArray(saved), "stored versions must not be an array");
      const versions = saved as Record<string, string>;
      assert(
        Object.values(versions).every((version: unknown) => typeof version === "string"),
        "Expected stored versions to map row keys to strings",
      );
      const [file] = versions[changed]!.split(" ");
      // Every item's commit is newer than the visit, but only one file differs from what it showed.
      const back = open("index", {
        "admin-answers:seen": String(Date.now() - 2 * 36e5),
        "admin-answers:versions": JSON.stringify({ ...versions, [changed]: "older" }),
      });
      const marked = [...back.document.querySelectorAll("[data-row]")].filter((r) =>
        r.querySelector("[data-updated]:not([hidden])"),
      );
      expect([...new Set(marked.map((r) => (r as unknown as HTMLElement).dataset.k))]).toEqual([
        changed,
      ]);
      expect(file).toBeTypeOf("string");
    });

    test.each([
      [
        "question or options changed ·",
        "the stored question hash differs",
        (_asked: string) => "older older",
      ],
      ["edited ·", "only the stored file hash differs", (asked: string) => `older ${asked}`],
    ])("a changed row marks %s when %s", (expectedMark, _reason, storedVersion) => {
      const versions = JSON.parse(rawVersions) as Record<string, string>;
      const [file, askedHash] = versions[changed]!.split(" ");
      assert(file, "stored version must hold a file hash");
      assert(askedHash, "stored version must hold an asked hash");
      // A stored question that differs says the question changed; the file alone, that it was edited.
      const page = open("index", {
        "admin-answers:seen": String(Date.now() - 2 * 36e5),
        "admin-answers:versions": JSON.stringify({
          ...versions,
          [changed]: storedVersion(askedHash),
        }),
      });
      // The row's mark is short: the line above the lists says since when.
      const mark = page.document.querySelector(`[data-k="${changed}"] [data-updated]`);
      assert(mark, "updated mark must exist on the changed row");
      expect(mark.hasAttribute("hidden")).toBe(false);
      expect(mark.textContent).toBe(expectedMark);
    });
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

  describe("serves committed pages and files, rebuilding only after a commit", () => {
    type BuiltSite = Awaited<ReturnType<ReturnType<typeof createHub>["pages"]>>;
    const HUB_CSP =
      "default-src 'self'; script-src http://admin.localhost/_astro/; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'none'; form-action 'self'; frame-src 'self'; frame-ancestors 'self'";
    const fetchSiteCases = [
      {
        label: "cross-site no-cors script",
        site: "cross-site",
        mode: "no-cors",
        dest: "script",
        status: 403,
      },
      // Another port of this machine is the same site, and asks no more than a site elsewhere.
      {
        label: "same-site cors fetch",
        site: "same-site",
        mode: "cors",
        dest: "empty",
        status: 403,
      },
      {
        label: "cross-site navigation",
        site: "cross-site",
        mode: "navigate",
        dest: "document",
        status: 200,
      },
      {
        label: "same-site navigation",
        site: "same-site",
        mode: "navigate",
        dest: "document",
        status: 200,
      },
      {
        label: "same-origin no-cors script",
        site: "same-origin",
        mode: "no-cors",
        dest: "script",
        status: 200,
      },
      {
        label: "direct navigation",
        site: "none",
        mode: "navigate",
        dest: "document",
        status: 200,
      },
    ];
    const bareRedirectCases = [
      {
        label: "bare repository address",
        path: "/spoke",
        location: "http://admin.localhost/spoke/dashboard",
      },
      {
        label: "repository address with slash and query",
        path: "/spoke/?who=A",
        location: "http://admin.localhost/spoke/dashboard?who=A",
      },
    ];
    const slashRedirectCases = [
      {
        label: "page with trailing slash",
        path: "/spoke/decisions/",
        location: "http://admin.localhost/spoke/decisions",
      },
      {
        label: "page with trailing slash and query",
        path: "/spoke/decisions/?who=A",
        location: "http://admin.localhost/spoke/decisions?who=A",
      },
    ];
    const missing404Cases = [
      { path: "/404", expectedLine: "answers at /404:" },
      { path: "/404.html", expectedLine: "answers at /404.html:" },
      { path: "/a/<b>", expectedLine: "answers at /a/%3Cb%3E:" },
    ];
    const nodeModulesRejectCases = [
      {
        label: "parent-directory traversal",
        path: "/_file/spoke/node_modules/..%2Funcommitted.txt",
      },
      {
        label: "escaping directory symlink",
        path: "/_file/spoke/node_modules/escape/secret.txt",
      },
      {
        label: "escaping file symlink",
        path: "/_file/spoke/node_modules/pkg/secret.txt",
      },
    ];

    let first = "";
    let homeTwoMinLater = "";
    let decisions: Response;
    let nested = "";
    const fetchSiteStatuses = new Map<string, number>();
    const redirectResults = new Map<string, [number, string | null]>();
    let unknownStatus = 0;
    let lost = "";
    let indexAliasStatus = 0;
    let indexAliasHtml = "";
    const missing404Results = new Map<string, { status: number; html: string }>();
    let packages = "";
    let zippedEncoding: string | null = null;
    let zippedBytes = new Uint8Array(0);
    let cssCacheControl: string | null = null;
    let svgContentType: string | null = null;
    const nodeModulesRejectStatuses = new Map<string, number>();
    let installedCss = "";
    let nonLocalStatus = 0;
    let lfsText = "";
    let cached: BuiltSite;
    let afterUncommittedEdit1: BuiltSite;
    let afterUncommittedEdit2: BuiltSite;
    let afterCommit: BuiltSite;
    let homeAfterCommit = "";

    beforeAll(async () => {
      // Fix a midday clock so +2 minutes stays on the same calendar day and never triggers a day-rollover rebuild.
      const base = new Date(2026, 4, 10, 12, 0, 0).getTime();
      const clock = vi.spyOn(Date, "now").mockReturnValue(base);
      try {
        // Stage 1: initial committed spoke checkout.
        const repo = repoFrom("spoke");
        const hub = createHub({ root: dirname(repo) });
        const get = (path: string) => hub.fetch(new Request(`http://admin.localhost${path}`));
        first = await (await get("/")).text();
        decisions = await get("/spoke/decisions");
        for (const { label, site, mode, dest } of fetchSiteCases) {
          const res = await hub.fetch(
            new Request("http://admin.localhost/_file/spoke/scripts/sample.ts", {
              headers: { "sec-fetch-site": site, "sec-fetch-mode": mode, "sec-fetch-dest": dest },
            }),
          );
          fetchSiteStatuses.set(label, res.status);
        }
        for (const { path } of bareRedirectCases) {
          const r = await get(path);
          redirectResults.set(path, [r.status, r.headers.get("location")]);
        }
        const none = await get("/nosuchrepo/");
        unknownStatus = none.status;
        lost = await none.text();
        const indexAlias = await get("/index.html");
        indexAliasStatus = indexAlias.status;
        indexAliasHtml = await indexAlias.text();
        for (const { path } of missing404Cases) {
          const r = await get(path);
          missing404Results.set(path, { status: r.status, html: await r.text() });
        }

        // Stage 2: request-time stamping on a cached build and a day later, then returning to base day.
        clock.mockReturnValue(base + 120_000);
        homeTwoMinLater = await (await get("/")).text();
        // So does the hub's other page, a day after its build.
        clock.mockReturnValue(base + 864e5);
        packages = await (await get("/architecture")).text();
        clock.mockReturnValue(base);
        nested = await decisions.text();
        const zipped = await hub.fetch(
          new Request("http://admin.localhost/spoke/decisions", {
            headers: { "accept-encoding": "gzip, br" },
          }),
        );
        zippedEncoding = zipped.headers.get("content-encoding");
        zippedBytes = await zipped.bytes();
        const cssMatch = first.match(/href="\.\/(_astro\/[^"]+\.css)"/);
        assert(
          cssMatch,
          'tested by "serves the hub home page with committed items and /_file/ links"',
        );
        cssCacheControl = (await get(`/${cssMatch[1]!}`)).headers.get("cache-control");
        for (const { path } of slashRedirectCases) {
          const r = await get(path);
          redirectResults.set(path, [r.status, r.headers.get("location")]);
        }
        const svg = await get("/_file/spoke/docs/agent-work/2026-01-15-sample-topic/variant-a.svg");
        svgContentType = svg.headers.get("content-type");

        // Stage 3: uncommitted files, installed node_modules, escaping symlinks, and non-local host.
        writeFileSync(join(repo, "uncommitted.txt"), "uncommitted");
        nodeModulesRejectStatuses.set(
          "parent-directory traversal",
          (await get("/_file/spoke/node_modules/..%2Funcommitted.txt")).status,
        );
        mkdirSync(join(repo, "node_modules/pkg"), { recursive: true });
        writeFileSync(join(repo, "node_modules/pkg/tokens.css"), ":root{}");
        installedCss = await (await get("/_file/spoke/node_modules/pkg/tokens.css")).text();
        const outside = scratch();
        writeFileSync(join(outside, "secret.txt"), "secret");
        symlinkSync(outside, join(repo, "node_modules/escape"));
        symlinkSync(join(outside, "secret.txt"), join(repo, "node_modules/pkg/secret.txt"));
        nodeModulesRejectStatuses.set(
          "escaping directory symlink",
          (await get("/_file/spoke/node_modules/escape/secret.txt")).status,
        );
        nodeModulesRejectStatuses.set(
          "escaping file symlink",
          (await get("/_file/spoke/node_modules/pkg/secret.txt")).status,
        );
        nonLocalStatus = (await hub.fetch(new Request("http://evil.example/"))).status;

        // Stage 4: LFS object committed after the hub is already warm.
        const oid = "ab".repeat(32);
        const store = join(repo, ".git/lfs/objects/ab/ab");
        mkdirSync(store, { recursive: true });
        writeFileSync(join(store, oid), "<svg>stored</svg>");
        writeFileSync(
          join(repo, "docs/agent-work/lfs.svg"),
          `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 17\n`,
        );
        sh(repo, "git", "add", "docs/agent-work/lfs.svg");
        commit(repo, "l");
        lfsText = await (await get("/_file/spoke/docs/agent-work/lfs.svg")).text();

        // Stage 5: baseline cached build, uncommitted edit (no rebuild on either call), then commit (rebuild).
        cached = await hub.pages();
        const item = join(repo, "docs/agent-work/items/check-the-copy.md");
        writeFileSync(item, readFileSync(item, "utf8").replace("# ", "# Renamed "));
        afterUncommittedEdit1 = await hub.pages();
        afterUncommittedEdit2 = await hub.pages();
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
        afterCommit = await hub.pages();
        homeAfterCommit = await (await get("/")).text();
      } finally {
        clock.mockRestore();
      }
    }, testTimeout(60_000));

    test("serves the hub home page with committed items and /_file/ links", () => {
      expect(first).toContain("Which variant ships?");
      expect(first).not.toContain("file://");
      expect(first).toContain("/_file/spoke/docs/agent-work/");
      expect(first).toMatch(/href="\.\/(_astro\/[^"]+\.css)"/);
    });

    test("serves /index.html as an alias for the hub home page", () => {
      expect(indexAliasStatus).toBe(200);
      expect(sansNonce(indexAliasHtml)).toBe(sansNonce(first));
    });

    test("serves /spoke/decisions with hub CSP, security headers, and no-store cache", () => {
      // A committed form posts nowhere else, and no outside page is framed into the hub.
      // Nothing a body commits loads from elsewhere, so no image or stylesheet reports a view or
      // reads the page out; a catalog's dev server is still asked whether it runs.
      expect(decisions.status).toBe(200);
      expect(decisions.headers.get("content-security-policy")).toBe(HUB_CSP);
      expect(decisions.headers.get("x-content-type-options")).toBe("nosniff");
      expect(decisions.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(decisions.headers.get("cache-control")).toBe("no-store");
    });

    // A page elsewhere may link the hub, but loads nothing from it to learn what exists.
    test.each(fetchSiteCases)(
      "responds $status to /_file/ request for $label",
      ({ label, status }) => {
        expect(fetchSiteStatuses.get(label)).toBe(status);
      },
    );

    test("rejects requests for a non-local host with 403", () => {
      expect(nonLocalStatus).toBe(403);
    });

    test.each([...bareRedirectCases, ...slashRedirectCases])(
      "redirects $label with 302",
      ({ path, location }) => {
        expect(redirectResults.get(path)).toEqual([302, location]);
      },
    );

    test("renders a styled 404 page with root-relative links for an unknown path", () => {
      expect(unknownStatus).toBe(404);
      // In the hub's styles, with the way back.
      expect(lost).toMatch(/<a class="hw-link" href="\/index\.html">\s*Open the hub\s*<\/a>/);
      expect(lost).toMatch(/<link rel="stylesheet" href="\/_astro\/[^"]+\.css">/);
      expect(lost).not.toMatch(/(?:href|src)="(?!\/|#|[a-z]+:)/);
      expect(lost).toContain("Nothing on the hub answers at /nosuchrepo/:");
    });

    test.each(missing404Cases)(
      "renders the 404 page with the requested path for $path",
      ({ path, expectedLine }) => {
        const res = missing404Results.get(path);
        expect(res).toBeDefined();
        expect(res!.status).toBe(404);
        expect(res!.html).not.toContain("admin-missing-path");
        expect(res!.html).toContain(expectedLine);
      },
    );

    test("stamps the hub home page with the request minute", () => {
      // The hub says it is current as of the request, in the minute it was asked or the next.
      const stamp = first.match(/· as of <span data-stamp>([^<]*)<\/span>/);
      expect(stamp).not.toBeNull();
      expect(stamp![1]).toBe("10 May at 12:00");
      expect(homeTwoMinLater).toContain("· as of <span data-stamp>10 May at 12:02</span>");
    });

    test("stamps /architecture with the request time a day after its build", () => {
      expect(packages).toContain("· as of <span data-stamp>11 May at 12:00</span>");
    });

    test("gzips HTML responses when the client accepts gzip", () => {
      // A page travels gzipped where the browser takes it, and a hashed asset stays in its cache.
      expect(zippedEncoding).toBe("gzip");
      expect(sansNonce(new TextDecoder().decode(Bun.gunzipSync(zippedBytes)))).toBe(
        sansNonce(nested),
      );
    });

    test("caches hashed _astro stylesheets immutably", () => {
      expect(cssCacheControl).toContain("immutable");
    });

    // Every script, on the hub and on a nested page, resolves under the one path the policy runs.
    test.each([
      { page: "/", getHtml: () => first },
      { page: "/spoke/decisions", getHtml: () => nested },
    ])("resolves every script on $page under /_astro/", ({ page, getHtml }) => {
      const paths = [...getHtml().matchAll(/<script[^>]*src="([^"]+)"/g)].map(
        (m) => new URL(m[1]!, `http://admin.localhost${page}`).pathname,
      );
      expect(paths.length).toBeGreaterThan(0);
      expect(paths.filter((p) => !p.startsWith("/_astro/"))).toEqual([]);
    });

    test("serves a committed SVG with an image/svg content-type", () => {
      expect(svgContentType).toContain("image/svg");
    });

    test("resolves a committed Git LFS object on a warm hub", () => {
      expect(lfsText).toBe("<svg>stored</svg>");
    });

    test("serves an installed file from node_modules", () => {
      expect(installedCss).toBe(":root{}");
    });

    test.each(nodeModulesRejectCases)("returns 404 for $label under node_modules", ({ label }) => {
      expect(nodeModulesRejectStatuses.get(label)).toBe(404);
    });

    test("rebuilds only after a commit, leaving uncommitted edits unserved", () => {
      expect(afterUncommittedEdit1).toBe(cached);
      expect(afterUncommittedEdit2).toBe(cached);
      expect(afterCommit).not.toBe(cached);
      expect(homeAfterCommit).toContain("Renamed ");
    });
  });

  describe("a failed read or build shows on every page and retries on state change or after a minute", () => {
    type BuiltSite = Awaited<ReturnType<ReturnType<typeof createHub>["pages"]>>;
    type PageReply = { status: number; html: string };
    const problemBox = (html: string) => html.match(/<div id="admin-problem"[^>]*>[\s\S]*?<\/div>/);

    let first: BuiltSite;
    let homeInitial: PageReply;
    let docInitial: PageReply;
    let cachedInitial: BuiltSite;
    let afterFail1: BuiltSite;
    let afterFail2: BuiltSite;
    let buildsAfterCommit = 0;
    let dashboardAfterFail: PageReply;
    let buildsAfterDashboard = 0;
    let afterMinute: BuiltSite;
    let buildsAfterMinute = 0;
    let recoveredBuild: BuiltSite;
    let homeAfterRebuild1: PageReply;
    let homeAfterRebuild2: PageReply;
    let homeAfterReadRecovery: PageReply;
    let homeAfterTaggedFail: PageReply;
    let homeAfterRevert: PageReply;

    beforeAll(async () => {
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
      const get = async (path: string): Promise<PageReply> => {
        const res = await hub.fetch(new Request(`http://admin.localhost${path}`));
        return { status: res.status, html: await res.text() };
      };

      first = await hub.pages();
      homeInitial = await get("/");
      docInitial = await get("/spoke/doc/docs/agent-work/2026-01-15-sample-topic");
      cachedInitial = await hub.pages();

      const failing = stubBuildSpawn("console.error('TypeError: boom'); process.exit(1)");
      try {
        writeFileSync(join(repo, "moved.md"), "# Moved\n");
        sh(repo, "git", "add", "moved.md");
        commit(repo, "m");
        // The last pages stay on show, saying since when.
        afterFail1 = await hub.pages();
        afterFail2 = await hub.pages();
        buildsAfterCommit = failing.calls();
        dashboardAfterFail = await get("/spoke/dashboard");
        buildsAfterDashboard = failing.calls();
        later(61_000);
        afterMinute = await hub.pages();
        buildsAfterMinute = failing.calls();
      } finally {
        Date.now = now;
        failing.restore();
      }

      writeFileSync(join(repo, "moved.md"), "# Moved again\n");
      sh(repo, "git", "add", "moved.md");
      commit(repo, "n");
      recoveredBuild = await hub.pages();
      homeAfterRebuild1 = await get("/");
      homeAfterRebuild2 = await get("/");

      // A read that failed for a passing cause comes back a minute later, with no commit there.
      writeFileSync(object, bytes);
      try {
        // Past the retry the mocked minute above set.
        later(125_000);
        homeAfterReadRecovery = await get("/");
      } finally {
        Date.now = now;
      }

      // A read failing at a new state, then the state its last read was taken at again: the notice
      // goes, since the pages show that state.
      rmSync(object);
      sh(second, "git", "tag", "t");
      homeAfterTaggedFail = await get("/");
      writeFileSync(object, bytes);
      sh(second, "git", "tag", "-d", "t");
      homeAfterRevert = await get("/");
    }, testTimeout(120_000));

    test("shows an unreadable repository notice on every page and caches the initial build", () => {
      const homeNotice = problemBox(homeInitial.html);
      const docNotice = problemBox(docInitial.html);
      expect(homeNotice).not.toBeNull();
      expect(homeNotice![0]).toContain("second could not be read: git cat-file answered");
      expect(docNotice).not.toBeNull();
      expect(docNotice![0]).toContain("It is left out.");
      expect(cachedInitial).toBe(first);
    });

    test("keeps the last pages with a build-failure notice and skips immediate retry on a failed rebuild", () => {
      const dashNotice = problemBox(dashboardAfterFail.html);
      expect(afterFail1).toBe(first);
      expect(afterFail2).toBe(first);
      expect(buildsAfterCommit).toBe(1);
      expect(dashNotice).not.toBeNull();
      expect(dashNotice![0]).toMatch(
        /could not rebuild on [^<]+<\/b> These pages show the repositories as of [\s\S]*The build stopped: build failed: TypeError: boom/,
      );
    });

    test("retries a failed rebuild once a minute has passed", () => {
      expect(buildsAfterDashboard).toBe(1);
      expect(afterMinute).toBe(first);
      expect(buildsAfterMinute).toBe(2);
    });

    test("clears the build-failure notice after a successful rebuild while keeping the unread-repository notice", () => {
      const rebuildNotice = problemBox(homeAfterRebuild1.html);
      expect(recoveredBuild).not.toBe(first);
      expect(rebuildNotice).not.toBeNull();
      expect(rebuildNotice![0]).not.toContain("The build stopped");
      expect(homeAfterRebuild2.html).toContain("second could not be read");
    });

    test("clears the unread-repository notice once the missing object returns and the retry window passes", () => {
      expect(homeAfterReadRecovery.status).toBe(200);
      expect(homeAfterReadRecovery.html).toContain("Which variant ships?");
      expect(homeAfterReadRecovery.html).toContain(">second<");
      expect(homeAfterReadRecovery.html).not.toContain("could not be read");
    });

    test("shows the notice on a new broken state and clears it when the repository reverts to its last read", () => {
      expect(homeAfterTaggedFail.status).toBe(200);
      expect(homeAfterTaggedFail.html).toContain("second could not be read");
      expect(homeAfterRevert.status).toBe(200);
      expect(homeAfterRevert.html).toContain(">second<");
      expect(homeAfterRevert.html).not.toContain("could not be read");
    });
  });

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

  describe("serves the topic report as built and fills other reports and docs from shells", () => {
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
    const expectedDocs = [
      {
        path: "docs/agent-work/2026-01-15-sample-topic.md",
        escapedTitle: "Sample topic",
        heading: '<h1 id="sample-topic">Sample topic</h1>',
      },
      {
        path: "docs/agent-work/2026-01-14-standalone.md",
        escapedTitle: "Standalone",
        heading: '<h1 id="standalone">Standalone</h1>',
      },
      {
        path: "docs/50% off.md",
        escapedTitle: "Half off",
        heading: '<h1 id="half-off">Half off</h1>',
      },
      {
        path: "docs/c#-notes.md",
        escapedTitle: "C# notes &amp; more",
        heading: '<h1 id="c-notes-more">C# notes &amp; more</h1>',
      },
      {
        path: "docs/guide/index.md",
        escapedTitle: "Guide",
        heading: '<h1 id="guide">Guide</h1>',
      },
      {
        path: "docs/rock & roll's.md",
        escapedTitle: "Rock and roll",
        heading: '<h1 id="rock-and-roll">Rock and roll</h1>',
      },
      {
        path: "docs/shell-html.md",
        escapedTitle: "admin-shell-html",
        heading: '<h1 id="section-admin-shell-html">admin-shell-html</h1>',
      },
      {
        path: "docs/shell-title.md",
        escapedTitle: "admin-shell-title",
        heading: '<h1 id="section-admin-shell-title">admin-shell-title</h1>',
      },
      {
        path: "README.md",
        escapedTitle: "Read me",
        heading: '<h1 id="read-me">Read me</h1>',
      },
    ];
    const parityOrder = [
      "README",
      "docs/guide/index.md",
      "docs/agent-work/2026-01-15-sample-topic",
      "docs/agent-work/2026-01-14-standalone",
      "docs/shell-html",
      "docs/shell-title",
      "docs/rock & roll's",
    ];
    const shellFilledPages = [
      "README",
      "docs/guide/index.md",
      "docs/agent-work/2026-01-14-standalone",
      "docs/shell-html",
      "docs/shell-title",
      "docs/rock & roll's",
    ];
    const prebuiltTopicPage = "docs/agent-work/2026-01-15-sample-topic";
    const linkedPages = new Map<string, { status: number; html: string }>();
    const servedPages = new Map<string, string>();
    let docList = "";
    let builtSiteFiles: ReadonlyMap<string, Buffer> = new Map();
    let readme = "";
    let notesStatus = 0;
    let notes = "";
    let notesFileStatus = 0;
    let notesFile = "";
    let rock = "";
    let slash: Response;
    let topic: Window["document"];
    let standalone: Window["document"];
    let ordinaryStatus = 0;
    let ordinary: Window["document"];
    let out = "";
    let served: ReturnType<typeof linker>;
    let htmlSlugStatus = 0;
    let htmlSlugHtml = "";

    beforeAll(async () => {
      // A path with characters a page escapes in its attributes.
      const plain = repoFrom("spoke");
      const repo = join(dirname(plain), "o'neil & co", "spoke");
      cpSync(plain, repo, { recursive: true });
      rmSync(plain, { recursive: true, force: true });
      mkdirSync(join(repo, "docs/guide"), { recursive: true });
      for (const [path, text] of Object.entries(files)) writeFileSync(join(repo, path), text);
      sh(repo, "git", "add", "-A");
      commit(repo, "docs");
      const hub = createHub({ root: dirname(repo) });
      const at = "http://admin.localhost/spoke/docs";
      const get = (path: string) => hub.fetch(new Request(new URL(path, at)));
      docList = await (await get(at)).text();
      builtSiteFiles = (await hub.pages()).files;
      const data = await readRepo(repo);

      for (const { path, escapedTitle } of expectedDocs) {
        const link = docList.match(new RegExp(`href="([^"]+)">\\s*${RegExp.escape(escapedTitle)}`));
        assert(
          link,
          `tested by "links $path from the Docs index and serves its heading" (${path})`,
        );
        const page = await get(link[1]!);
        linkedPages.set(path, { status: page.status, html: await page.text() });
      }
      readme = await (await get("/spoke/doc/README")).text();
      notesStatus = (await get("/spoke/doc/docs/c%23-notes")).status;
      notes = await (await get("/spoke/doc/docs/c%23-notes")).text();
      const notesFileRes = await get("/_file/spoke/docs/c%23-notes.md");
      notesFileStatus = notesFileRes.status;
      notesFile = await notesFileRes.text();
      rock = await (await get("/spoke/doc/docs/rock%20&%20roll's")).text();
      slash = await get("/spoke/doc/README/?x=1");
      const docFor = async (path: string) => {
        const res = await get(path);
        const doc = new Window().document;
        doc.body.innerHTML = domMarkup.transform(await res.text());
        return { status: res.status, doc };
      };
      topic = (await docFor("/" + SAMPLE_REPORT)).doc;
      standalone = (await docFor("/spoke/doc/docs/agent-work/2026-01-14-standalone")).doc;
      const ordinaryRes = await docFor("/spoke/doc/docs/guide/index.md");
      ordinaryStatus = ordinaryRes.status;
      ordinary = ordinaryRes.doc;

      // A doc filled into its shell is the page a full build renders, served with the same links:
      // the article's links to docs open their pages, the line above it opens the file.
      out = join(scratch(), "out");
      await buildSite(siteData([data]), out);
      served = linker([data]);
      for (const page of parityOrder)
        servedPages.set(page, await (await get(`/spoke/doc/${page}`)).text());

      // A doc's slug may itself end in .html, which only the hub's shells serve: Astro builds none.
      writeFileSync(join(repo, "docs/page.html.md"), "# Named like a page\n");
      sh(repo, "git", "add", "docs/page.html.md");
      commit(repo, "page");
      const htmlSlugRes = await get("/spoke/doc/docs/page.html");
      htmlSlugStatus = htmlSlugRes.status;
      htmlSlugHtml = await htmlSlugRes.text();
    }, testTimeout(120_000));

    test.each(expectedDocs)(
      "links $path from the Docs index and serves its heading",
      ({ path, escapedTitle, heading }) => {
        expect(docList).toMatch(new RegExp(`href="([^"]+)">\\s*${RegExp.escape(escapedTitle)}`));
        const entry = linkedPages.get(path)!;
        expect(entry.status).toBe(200);
        expect(entry.html).toContain(heading);
      },
    );

    test("rewrites markdown doc links in README with fragments and percent-encoding", () => {
      // A link to another doc opens its page, the fragment kept.
      expect(readme).toContain('href="/spoke/doc/docs/guide/index.md#setup"');
      expect(readme).toContain('href="/spoke/doc/docs/c%23-notes"');
    });

    test("escapes special characters in doc titles and /_file/ links", () => {
      expect(notesStatus).toBe(200);
      expect(notes).toContain("<title>C# notes &amp; more · Sample spoke · Admin</title>");
      expect(notes).toContain('href="/_file/spoke/docs/c%23-notes.md"');
      expect(rock).toContain('href="/_file/spoke/docs/rock%20%26%20roll%27s.md"');
    });

    test("serves a committed doc's raw markdown under a percent-encoded /_file/ path", () => {
      expect(notesFileStatus).toBe(200);
      expect(notesFile).toBe(files["docs/c#-notes.md"]);
    });

    test("redirects a doc address with a trailing slash while keeping its query string", () => {
      // A doc's address with a slash leads to it.
      expect([slash.status, slash.headers.get("location")]).toEqual([
        302,
        "http://admin.localhost/spoke/doc/README?x=1",
      ]);
    });

    test("renders open decision options and the pick-recommended button on the topic report", () => {
      const options = topic.querySelector('details.item[id="spoke:pick-a-variant"]');
      expect(options).not.toBeNull();
      expect(options!.querySelector('input[data-option][value="a"]')).not.toBeNull();
      const pick = options!.querySelector(".pick");
      expect(pick).not.toBeNull();
      expect(pick!.textContent).toContain("Pick recommended");
    });

    test("renders the topic prerequisite graph collapsed with four nodes and two edges", () => {
      const graph = topic.querySelector("details:has(figure.admin-diagram)");
      expect(graph).not.toBeNull();
      expect(graph!.hasAttribute("open")).toBe(false);
      expect(graph!.querySelectorAll("svg .node")).toHaveLength(4);
      expect(graph!.querySelectorAll("svg .edge")).toHaveLength(2);
    });

    test("groups settled items under Assumed and decided on the topic report", () => {
      const settled = topic.getElementById("spoke:cache-folder");
      expect(settled).not.toBeNull();
      const group = settled!.closest("[data-group]");
      expect(group).not.toBeNull();
      const summary = group!.querySelector("summary");
      expect(summary).not.toBeNull();
      expect(summary!.textContent).toContain("Assumed and decided");
    });

    test("orders topic sections before the report article", () => {
      const content = topic.querySelector("#admin-content");
      expect(content).not.toBeNull();
      const topicHtml = content!.innerHTML;
      const openIdx = topicHtml.indexOf("Open questions");
      const waitsIdx = topicHtml.indexOf("What waits on what");
      const assumedIdx = topicHtml.indexOf("Assumed and decided");
      const articleIdx = topicHtml.indexOf("<article");
      expect(openIdx).toBeGreaterThanOrEqual(0);
      expect(openIdx).toBeLessThan(waitsIdx);
      expect(waitsIdx).toBeLessThan(assumedIdx);
      expect(assumedIdx).toBeLessThan(articleIdx);
    });

    test("renders the topic contents navigation matching every article h2 heading", () => {
      const expectedHeadings = [
        "#scores-by-reader",
        "#next",
        "#files",
        "#sorting",
        "#checks",
        "#archive",
      ];
      const contents = [...topic.querySelectorAll('nav[aria-label="Contents"] a')];
      expect(contents.map((a) => a.getAttribute("href"))).toEqual(expectedHeadings);
      expect([...topic.querySelectorAll("article h2")].map((h) => "#" + h.id)).toEqual(
        expectedHeadings,
      );
    });

    test("places a comment disclosure after a subsection h3 heading on the topic report", () => {
      expect(topic.querySelector("article h3 + [data-comment]")).not.toBeNull();
    });

    test("shows the Last changed report metadata line on the topic report", () => {
      const reportMeta = topic.querySelector("article [data-report]");
      expect(reportMeta).not.toBeNull();
      expect(reportMeta!.textContent).toContain("Last changed");
    });

    test("omits the contents navigation, items, and diagram on a standalone dated report with five headings", () => {
      expect(standalone.querySelectorAll("article h2")).toHaveLength(5);
      expect(standalone.querySelector('nav[aria-label="Contents"]')).toBeNull();
      expect(standalone.querySelector("details.item, .admin-diagram")).toBeNull();
    });

    test("gives a standalone dated report copy and per-section comment controls", () => {
      expect(
        [...standalone.querySelectorAll("article h2 + [data-comment]")].map((el) =>
          el.getAttribute("data-k"),
        ),
      ).toEqual([
        "spoke:2026-01-14-standalone#one",
        "spoke:2026-01-14-standalone#two",
        "spoke:2026-01-14-standalone#three",
        "spoke:2026-01-14-standalone#four",
        "spoke:2026-01-14-standalone#five",
      ]);
      expect(standalone.querySelectorAll("[data-comment]")).toHaveLength(5);
      expect(standalone.getElementById("copy")).not.toBeNull();
    });

    test("shows the Last changed report metadata line on a standalone dated report", () => {
      const reportMeta = standalone.querySelector("article [data-report]");
      expect(reportMeta).not.toBeNull();
      expect(reportMeta!.textContent).toContain("Last changed");
    });

    test("serves an ordinary doc without copy or comment controls", () => {
      expect(ordinaryStatus).toBe(200);
      expect(ordinary.body.textContent).toContain("Setup");
      expect(ordinary.getElementById("copy")).toBeNull();
      expect(ordinary.querySelector("[data-comment]")).toBeNull();
    });

    test("serves the prebuilt topic report with matching script nonces and full-build parity", () => {
      const built = readFileSync(join(out, `spoke/doc/${prebuiltTopicPage}.html`), "utf8");
      const got = servedPages.get(prebuiltTopicPage)!;
      expect(builtSiteFiles.has(`spoke/doc/${prebuiltTopicPage}.html`)).toBe(true);
      const nonceMatch = got.match(/'nonce-([\w-]+)'/);
      expect(nonceMatch).not.toBeNull();
      const nonce = nonceMatch![1]!;
      expect([...got.matchAll(/<script nonce="([^"]+)"/g)].map((m) => m[1])).toEqual([
        nonce,
        nonce,
      ]);
      expect(sansNonce(got)).toBe(sansNonce(served.files(served.pages(built))));
    });

    test.each(shellFilledPages)(
      "fills %s into its shell with matching script nonces and full-build parity",
      (page) => {
        const built = readFileSync(join(out, `spoke/doc/${page}.html`), "utf8");
        const got = servedPages.get(page)!;
        expect(builtSiteFiles.has(`spoke/doc/${page}.html`)).toBe(false);
        // A shell's scripts carry the nonce its policy names.
        const nonceMatch = got.match(/'nonce-([\w-]+)'/);
        expect(nonceMatch).not.toBeNull();
        const nonce = nonceMatch![1]!;
        expect([...got.matchAll(/<script nonce="([^"]+)"/g)].map((m) => m[1])).toEqual([
          nonce,
          nonce,
        ]);
        expect(sansNonce(got)).toBe(sansNonce(served.files(served.pages(built))));
      },
    );

    test("serves a doc whose slug ends in .html through a shell", () => {
      expect(htmlSlugStatus).toBe(200);
      expect(htmlSlugHtml).toContain('<h1 id="named-like-a-page">Named like a page</h1>');
    });
  });

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

  describe("committed image thumbnails", () => {
    const at = "/_file/spoke/docs/agent-work/2026-01-15-sample-topic";
    const originalCases = [
      { label: "no width", query: "wide.png", file: "wide.png" },
      { label: "unoffered width", query: "wide.png?w=123", file: "wide.png" },
      { label: "image that already fits", query: "small.png?w=480", file: "small.png" },
      { label: "file that is no image", query: "broken.png?w=480", file: "broken.png" },
    ];
    const originals = new Map<string, Buffer>();
    const fullResponses = new Map<string, { contentType: string | null; bytes: Buffer }>();
    let reviewsPage = "";
    let small: Response;
    let smallBytes = Buffer.alloc(0);
    let tallRes: Response;
    let tallBytes = Buffer.alloc(0);
    let smallEtag: string | null = null;
    let repeatMatched: { status: number; bytes: Buffer };
    let repeatMismatched: { status: number; contentType: string | null; bytes: Buffer };
    let wide960Etag: string | null = null;

    beforeAll(async () => {
      const pixel = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
      );
      const png = async (w: number, h: number) =>
        Buffer.from(await new Bun.Image(pixel).resize(w, h).png().bytes());
      const repo = repoFrom("spoke");
      const dir = join(repo, "docs/agent-work/2026-01-15-sample-topic");
      const wideFile = await png(2000, 1000);
      const tallFile = await png(400, 2000);
      const smallFile = await png(100, 100);
      const brokenFile = Buffer.from("no image");
      originals.set("wide.png", wideFile);
      originals.set("small.png", smallFile);
      originals.set("broken.png", brokenFile);
      writeFileSync(join(dir, "wide.png"), wideFile);
      writeFileSync(join(dir, "tall.png"), tallFile);
      writeFileSync(join(dir, "small.png"), smallFile);
      writeFileSync(join(dir, "broken.png"), brokenFile);
      sh(repo, "git", "add", "-A");
      commit(repo, "i");
      const hub = createHub({ root: dirname(repo) });
      reviewsPage = await (
        await hub.fetch(new Request("http://admin.localhost/spoke/reviews"))
      ).text();
      const get = (q: string, headers = {}) =>
        hub.fetch(new Request(`http://admin.localhost${at}/${q}`, { headers }));
      small = await get("wide.png?w=480");
      smallBytes = Buffer.from(await small.bytes());
      tallRes = await get("tall.png?w=480");
      tallBytes = Buffer.from(await tallRes.bytes());
      for (const { query } of originalCases) {
        const res = await get(query);
        fullResponses.set(query, {
          contentType: res.headers.get("content-type"),
          bytes: Buffer.from(await res.bytes()),
        });
      }
      smallEtag = small.headers.get("etag");
      assert(smallEtag, 'tested by "assigns distinct ETags per thumbnail width"');
      const matchedRes = await get("wide.png?w=480", { "if-none-match": smallEtag });
      repeatMatched = {
        status: matchedRes.status,
        bytes: Buffer.from(await matchedRes.bytes()),
      };
      const mismatchedRes = await get("wide.png?w=480", { "if-none-match": '"other-tag"' });
      repeatMismatched = {
        status: mismatchedRes.status,
        contentType: mismatchedRes.headers.get("content-type"),
        bytes: Buffer.from(await mismatchedRes.bytes()),
      };
      wide960Etag = (await get("wide.png?w=960")).headers.get("etag");
    }, testTimeout(60_000));

    test("renders thumbnail src and srcset on /spoke/reviews", () => {
      const img = reviewsPage.match(/<img[^>]*small\.png[^>]*>/);
      expect(img).not.toBeNull();
      expect(img![0]).toContain(`src="${at}/small.png?w=480"`);
      expect(img![0]).toContain(`srcset="${at}/small.png?w=480 480w, ${at}/small.png?w=960 960w"`);
    });

    test.each([
      {
        label: "wide PNG",
        getRes: () => small,
        getBytes: () => smallBytes,
        expectedSize: [480, 240],
      },
      {
        label: "tall PNG",
        getRes: () => tallRes,
        getBytes: () => tallBytes,
        expectedSize: [54, 270],
      },
    ])(
      "resizes an oversized $label into the 480w box as WebP",
      async ({ getRes, getBytes, expectedSize }) => {
        const bytes = getBytes();
        expect(getRes().headers.get("content-type")).toBe("image/webp");
        expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
        expect(bytes.subarray(8, 12).toString("ascii")).toBe("WEBP");
        const meta = await new Bun.Image(bytes).metadata();
        expect([meta.width, meta.height]).toEqual(expectedSize);
      },
    );

    // The full file: no width, a width the hub does not offer, an image that already fits, or a
    // file that is no image.
    test.each(originalCases)("serves the original PNG for $label", ({ query, file }) => {
      const res = fullResponses.get(query);
      expect(res).toBeDefined();
      expect(res!.contentType).toBe("image/png");
      expect(res!.bytes).toEqual(originals.get(file)!);
    });

    test("assigns distinct ETags per thumbnail width", () => {
      expect(smallEtag).not.toBeNull();
      expect(wide960Etag).not.toBeNull();
      expect(wide960Etag).not.toBe(smallEtag);
    });

    test("returns 304 with an empty body when If-None-Match matches the thumbnail ETag", () => {
      expect(repeatMatched.status).toBe(304);
      expect(repeatMatched.bytes).toEqual(Buffer.alloc(0));
    });

    test("returns 200 with the WebP thumbnail when If-None-Match does not match", () => {
      expect(repeatMismatched.status).toBe(200);
      expect(repeatMismatched.contentType).toBe("image/webp");
      expect(repeatMismatched.bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(repeatMismatched.bytes.subarray(8, 12).toString("ascii")).toBe("WEBP");
      // Same bytes as the 480x240 WebP verified by "resizes an oversized wide PNG into the 480w box as WebP".
      expect(repeatMismatched.bytes).toEqual(smallBytes);
    });
  });
});

describe("catalog", () => {
  let get: (path: string) => Promise<Response>;

  beforeAll(() => {
    const hub = createHub({ root: dirname(repoFrom("spoke")) });
    get = (path: string) => hub.fetch(new Request(`http://admin.localhost${path}`));
  });

  test(
    "the hub home page links to /catalog/",
    async () => {
      const hubPage = await get("/");
      expect(hubPage.status).toBe(200);
      expect(await hubPage.text()).toMatch(/<a href="\/catalog\/"[^>]*>\s*Catalog\s*</);
    },
    testTimeout(60_000),
  );

  test(
    "GET /catalog redirects to /catalog/ with 302",
    async () => {
      const bare = await get("/catalog");
      expect([bare.status, bare.headers.get("location")]).toEqual([
        302,
        "http://admin.localhost/catalog/",
      ]);
    },
    testTimeout(60_000),
  );

  test(
    "serves the catalog home page with an immutable stylesheet",
    async () => {
      const home = await get("/catalog/");
      expect(home.status).toBe(200);
      const html = await home.text();
      expect(html).toContain("Every page and component of the admin engine");
      const sheet = html.match(/href="(\/catalog\/_astro\/[^"]+\.css)"/);
      assert(sheet, "catalog home should link its stylesheet");
      expect((await get(sheet[1]!)).headers.get("cache-control")).toContain("immutable");
    },
    testTimeout(60_000),
  );

  test(
    "serves story fixture images from /catalog/test/fixtures/spoke/",
    async () => {
      const story = await get("/catalog/stories/Items/shot/captioned");
      expect(story.status).toBe(200);
      const src = (await story.text()).match(/<img[^>]*src="([^"]+)"/);
      assert(src, "captioned shot story should render an image");
      expect(src[1]!.startsWith("/catalog/test/fixtures/spoke/")).toBe(true);
      expect((await get(src[1]!)).headers.get("content-type")).toContain("image/svg");
    },
    testTimeout(60_000),
  );

  describe("needs-graph story links", () => {
    const graphPath = "/catalog/stories/Items/needs-graph/graph/";
    const graphHrefsExpected = [
      "../../../Pages/decisions/default/#spoke:cache-folder",
      "../../../Pages/decisions/default/#spoke:check-the-copy",
      "../../../Pages/decisions/default/#spoke:name-the-command",
      "../../../Pages/decisions/default/#spoke:pick-a-variant",
      "../../../Pages/work/default/#spoke:goal",
      "../../../Pages/work/default/#spoke:work-wire-the-gate",
    ];
    let graphStatus = 0;
    let graphHrefs: string[] = [];

    beforeAll(async () => {
      const graph = await get(graphPath);
      graphStatus = graph.status;
      graphHrefs = [...(await graph.text()).matchAll(/href="([^"]+)"><g class="node"/g)].map(
        ([, href]) => href!,
      );
    }, testTimeout(60_000));

    test("renders links for all six connected items", () => {
      expect(graphStatus).toBe(200);
      expect([...graphHrefs].sort()).toEqual(graphHrefsExpected);
    });

    test.each(graphHrefsExpected)(
      "fetches rendered link %s and finds its target row",
      async (href) => {
        expect(graphHrefs).toContain(href);
        const target = new URL(href, `http://admin.localhost${graphPath}`);
        const row = await get(target.pathname);
        expect(row.status).toBe(200);
        expect(await row.text()).toContain(`id="${target.hash.slice(1)}"`);
      },
      testTimeout(60_000),
    );
  });

  test(
    "returns 404 for a missing catalog page",
    async () => {
      expect((await get("/catalog/no-such-page")).status).toBe(404);
    },
    testTimeout(60_000),
  );
});
