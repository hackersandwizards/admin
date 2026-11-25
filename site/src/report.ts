import { isPlainReportName } from "../../src/items.ts";
import { when } from "../../src/display.ts";
import { entities } from "../../src/entities.ts";
import type { Report } from "../../src/repo.ts";

export const reportKey = (repo: string, report: Report) => `#${repo}:${report.stem}`;

export function reportBody(repo: string, report: Report) {
  const key = reportKey(repo, report);
  const escape = Bun.escapeHTML;
  const headings: string[] = [];
  const commentable = isPlainReportName(report.stem);
  const active: { text: string }[] = [];
  const body = new HTMLRewriter()
    .on("h2[id], h3[id]", {
      element(el) {
        const id = entities(el.getAttribute("id")!);
        const anchor = escape(`${key.slice(1)}#${id}`);
        const field = `comment-${anchor}`;
        const h2 = el.tagName === "h2";
        const heading = { text: "" };
        active.push(heading);
        el.onEndTag((end) => {
          active.pop();
          const label = escape(entities(heading.text).replace(/\s+/g, " ").trim() || id);
          if (h2)
            headings.push(
              `<li><a class="hw-link" href="#${encodeURIComponent(id)}">${label}</a></li>`,
            );
          if (!commentable) return;
          end.after(
            `<details class="hw-disclosure not-prose text-ui" data-comment data-k="${anchor}">
              <summary>Comment <span class="mark text-accent"></span></summary>
              <div class="flex flex-col gap-2">
                <label for="${field}">Comment on ${label}</label>
                <textarea id="${field}" class="hw-field w-full"></textarea>
                <div class="flex flex-wrap items-center gap-2">
                  <button type="button" class="clear hw-button" data-variant="secondary" hidden>Reset</button>
                  <span class="saved text-micro" role="status"></span>
                </div>
              </div>
            </details>`,
            { html: true },
          );
        });
      },
      text(chunk) {
        const heading = active.at(-1);
        if (heading) heading.text += chunk.text;
      },
    })
    .transform(report.html);
  const changed = report.changed === undefined ? "" : ` data-changed="${report.changed}"`;
  const time =
    report.changed === undefined
      ? "No commit recorded"
      : `Last changed ${when(report.changed * 1000)}`;
  const contents =
    headings.length > 5
      ? `<nav class="not-prose" aria-label="Contents"><p class="hw-label">Contents</p><ul class="hw-marker-list">${headings.join("")}</ul></nav>`
      : "";
  return `<p class="text-ui text-foreground/70" data-report data-k="${escape(key)}" data-version="${report.version}"${changed}><span class="text-accent" data-updated hidden>updated</span> ${time}</p>${contents}${body}`;
}
