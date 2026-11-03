// One-time conversion of a repository's legacy tracking (docs/tracking/decisions/items.js, GOAL.md or
// TODO.md, and the review folders that name its rows) into item files.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { ITEMS_DIR, serializeItem, type Item, type Option } from "./items.ts";
import { LEGACY } from "./repo.ts";

type Row = {
  id: string;
  title: string;
  area?: string;
  priority?: number;
  order?: number;
  status: string;
  context?: string;
  owner?: string;
  options?: Option[];
  recommended?: string;
  assumption?: string;
  decision?: string;
  detail?: string;
  images?: Record<string, string>;
  [k: string]: unknown;
};

// items.js is read as data, never run: the lines it may hold are the DECISION_REPOS initialiser,
// comment lines and JSON5 literals assigned to DECISION_REPOS["<key>"] or DECISION_AREAS.
export function readDecisionList(src: string) {
  const text = src
    .replace(/^window\.DECISION_REPOS = window\.DECISION_REPOS \|\| \{\};$/m, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const heads = [
    ...text.matchAll(/^window\.(?:DECISION_REPOS\[("[^"\n]+"|'[^'\n]+')\]|DECISION_AREAS)\s*=/gm),
  ];
  if (text.slice(0, heads[0]?.index ?? text.length).trim())
    throw new Error("unexpected code before the first assignment");
  const repos: Record<string, Row[]> = {};
  heads.forEach((m, i) => {
    const literal = text.slice(m.index + m[0].length, heads[i + 1]?.index ?? text.length).trim();
    const value = Bun.JSON5.parse(literal.replace(/;$/, ""));
    if (m[1]) repos[Bun.JSON5.parse(m[1]) as string] = value as Row[];
  });
  return repos;
}

const ROW_FIELDS = new Set([
  "id",
  "title",
  "area",
  "priority",
  "order",
  "status",
  "context",
  "owner",
  "options",
  "recommended",
  "assumption",
  "decision",
  "detail",
  "images",
]);

// Who decided, from the decision text: a capitalised name before a dd.mm. date, as rows write it
// ("<Name> 02.11.: ...", "... (<Name>, 02.11.)").
export const decidedBy = (text: string) =>
  text.match(/\b(\p{Lu}\p{Ll}+)[ ,]+\d{1,2}\.\d{1,2}\./u)?.[1];

export function rowToItem(row: Row, defaultOwner: string): Item {
  const options = (row.options ?? []).map(({ key, label, detail }) =>
    detail ? { key, label, detail } : { key, label },
  );
  const status = row.status as Item["status"];
  const kind = options.length >= 2 || status !== "open" ? "decision" : "review";
  const extra = Object.entries(row)
    .filter(([k]) => !ROW_FIELDS.has(k))
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  const body = [row.context, row.detail, ...extra].filter(Boolean).join("\n\n");
  return {
    id: row.id,
    kind,
    status,
    priority: row.priority,
    order: row.order,
    area: row.area,
    owner: row.owner ?? defaultOwner,
    recommended: row.recommended,
    options: options.length ? options : undefined,
    images: row.images && Object.keys(row.images).length ? row.images : undefined,
    assumption: row.assumption,
    decision: row.decision,
    by:
      status === "decided"
        ? (decidedBy(row.decision ?? "") ?? row.owner ?? defaultOwner)
        : undefined,
    title: row.title.replace(/\s+/g, " ").trim(),
    body,
  };
}

const slug = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .toLowerCase()
    .replace(/`[^`]*`/g, (m) => m.slice(1, -1))
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 7)
    .join("-") || "item";

// A one-line title: the row's first sentence, cut at a word under 140 characters.
export function titleOf(point: string) {
  const flat = point.replace(/\s+/g, " ").trim();
  const sentence = flat.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? flat;
  if (sentence.length <= 140) return sentence.replace(/[.]$/, "");
  return flat.slice(0, 140).replace(/\s+\S*$/, "") + " …";
}

// GOAL.md (or TODO.md) work rows: a table line (point | owner | evidence), a top-level "- " bullet
// with "Owner:", or an unticked "- [ ]", outside the goal, done-means and waiting sections. Every
// other line stays as the goal item's body.
export function readGoal(text: string, isGoal: boolean) {
  const work: { point: string; owner: string; evidence: string }[] = [];
  const rest: string[] = [];
  // In GOAL.md, the text before the first "## " is the goal: a row there is work only where its
  // owner carries a priority (P1 to P3), unlike a table of standing permissions.
  let skip = isGoal;
  let preamble = isGoal;
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      skip = /goal|ziel|done means|waiting/i.test(line);
      preamble = false;
    }
    let point: string, owner: string, evidence: string;
    if (!skip && line.startsWith("|")) {
      [point = "", owner = "", evidence = ""] = line
        .split(/(?<!\\)\|/)
        .slice(1, -1)
        .map((c) => c.trim());
      if (!point || /^:?-+:?$/.test(point) || /^(punkt|item|point|work)$/i.test(point)) {
        rest.push(line);
        continue;
      }
    } else if (!skip && /^- (?!\[x\])/i.test(line)) {
      const t = line.replace(/^- (\[ \] )?/, "");
      point = t.split(/ Owner: | Beleg: | Evidence: /)[0]!;
      owner = t.match(/Owner: ([^.]*)\./)?.[1] ?? "";
      evidence = t.match(/(?:Evidence|Beleg): (.*)$/)?.[1] ?? "";
    } else if (preamble && line.startsWith("|")) {
      [point = "", owner = "", evidence = ""] = line
        .split(/(?<!\\)\|/)
        .slice(1, -1)
        .map((c) => c.trim());
      if (!/^P[1-3]\b/.test(owner)) {
        rest.push(line);
        continue;
      }
    } else {
      rest.push(line);
      continue;
    }
    work.push({ point, owner, evidence });
  }
  return { work, rest: rest.join("\n") };
}

export function workToItem(
  row: { point: string; owner: string; evidence: string },
  id: string,
): Item {
  const m = row.owner.match(/^P([1-3])\b\s*(\d{4}-\d{2}-\d{2})?[\s,:]*/);
  return {
    id,
    kind: "work",
    status: "open",
    priority: m ? Number(m[1]) : 3,
    due: m?.[2],
    owner: row.owner.slice(m?.[0].length ?? 0).trim() || "not established",
    evidence: row.evidence || undefined,
    title: titleOf(row.point),
    body: row.point.trim(),
  };
}

const IMAGE = /\.(jpe?g|png|gif|webp|svg|avif)$/i;

export type Migration = {
  repo: string;
  key?: string;
  written: string[];
  removed: string[];
  pages: string[];
  notes: string[];
};

export function migrate(
  repo: string,
  opts: { defaultOwner: string; reviews?: string; dryRun?: boolean },
): Migration {
  const out: Migration = { repo, written: [], removed: [], pages: [], notes: [] };
  const items: Item[] = [];
  const listPath = join(repo, LEGACY[0]!);
  if (existsSync(listPath)) {
    const lists = readDecisionList(readFileSync(listPath, "utf8"));
    out.key = Object.keys(lists)[0];
    for (const rows of Object.values(lists))
      for (const row of rows) items.push(rowToItem(row, opts.defaultOwner));
  }
  const goalFile = ["GOAL.md", "TODO.md"].map((f) => join(repo, f)).find(existsSync);
  if (goalFile) {
    const isGoal = goalFile.endsWith("GOAL.md");
    const { work, rest } = readGoal(readFileSync(goalFile, "utf8"), isGoal);
    const taken = new Set(items.map((i) => i.id));
    const unique = (base: string) => {
      let id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
      taken.add(id);
      return id;
    };
    for (const w of work) items.push(workToItem(w, unique(`work-${slug(titleOf(w.point))}`)));
    const body = rest.replace(/^# .*\n/, "").trim();
    if (/[^\s#]/.test(body.replace(/^#+ .*$/gm, ""))) {
      items.push({
        id: unique("goal"),
        kind: "goal",
        status: "open",
        title: rest.match(/^# (.+)$/m)?.[1]?.trim() ?? "Goal",
        body,
      });
      out.notes.push(
        `${basename(goalFile)}: its goal, limits and standing permissions are now ${ITEMS_DIR}/goal.md; move standing permissions to CLAUDE.md by hand`,
      );
    }
  }

  // Review folders (review.json names repo and row, or an "id*" prefix): each item it names gets
  // the folder's images in its own folder, docs/agent-work/items/<id>/. Its HTML page stays behind:
  // the admin renders a review from the item.
  if (opts.reviews && existsSync(opts.reviews))
    for (const topic of readdirSync(opts.reviews)) {
      const dir = join(opts.reviews, topic);
      const meta = join(dir, "review.json");
      if (!existsSync(meta)) continue;
      let review: {
        repo?: string;
        row?: string;
        id?: string;
        ids?: string[];
        rows?: Record<string, unknown>;
      };
      try {
        review = JSON.parse(readFileSync(meta, "utf8"));
      } catch {
        out.notes.push(`${meta}: not JSON, skipped`);
        continue;
      }
      if (review.repo !== basename(repo) && review.repo !== out.key) continue;
      // The row names a topic folder uses: "id", "a, b", "prefix*", an ids list or a rows map.
      const names = [
        ...String(review.row ?? review.id ?? "").split(/,\s*/),
        ...(review.ids ?? []),
        ...Object.keys(review.rows ?? {}),
      ].filter(Boolean);
      const named = items.filter((i) =>
        names.some((n) => (n.endsWith("*") ? i.id.startsWith(n.slice(0, -1)) : i.id === n)),
      );
      if (!named.length) {
        out.notes.push(`${topic}: rows ${names.join(", ")} not found, folder left in place`);
        continue;
      }
      const images = readdirSync(dir).filter((f) => IMAGE.test(f));
      for (const i of named) {
        if (!opts.dryRun)
          for (const f of images) {
            const to = join(repo, ITEMS_DIR, i.id, f);
            if (existsSync(to)) continue;
            mkdirSync(dirname(to), { recursive: true });
            cpSync(join(dir, f), to);
          }
        if (images.length) i.images = images;
      }
      out.pages.push(`${topic} -> ${named.map((i) => `${ITEMS_DIR}/${i.id}/`).join(", ")}`);
    }

  if (!opts.dryRun) {
    for (const item of items) {
      const file = `${ITEMS_DIR}/${item.id}.md`;
      mkdirSync(join(repo, ITEMS_DIR), { recursive: true });
      writeFileSync(join(repo, file), serializeItem(item));
      out.written.push(file);
    }
    for (const f of [...LEGACY, "TODO.md"])
      if (existsSync(join(repo, f)) && (f !== "TODO.md" || goalFile?.endsWith("TODO.md"))) {
        unlinkSync(join(repo, f));
        out.removed.push(f);
      }
  } else out.written = items.map((i) => `${ITEMS_DIR}/${i.id}.md`);
  return out;
}
