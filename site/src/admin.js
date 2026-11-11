// Runs on every admin page. src/build.ts bundles it with brand's element script into one classic
// script, not a module, so a page opened from disk loads it; a file of its own, since admin-serve's
// Content-Security-Policy runs no inline script.
import { enhance } from "@hackersandwizards/brand/elements/behaviour.ts";

enhance();

const STORE =
  "adminCatalog" in document.documentElement.dataset ? "admin-catalog:" : "admin-answers:";
const read = (k) => {
  try {
    return JSON.parse(localStorage.getItem(STORE + k)) || null;
  } catch {
    return null;
  }
};
const write = (k, v) => {
  try {
    if (v) localStorage.setItem(STORE + k, JSON.stringify(v));
    else localStorage.removeItem(STORE + k);
    return true;
  } catch {
    return false;
  }
};
// Keys of this browser's own state beside the answers.
const OWN = new Set(["copied", "who", "seen", "visit", "versions", "before"].map((k) => STORE + k));
const isAnswer = (k) => !!k && k.startsWith(STORE) && !OWN.has(k);
const items = [...document.querySelectorAll("details.item[data-k]")];
// A page that names every item of its repositories knows which answers lost their item.
const live = new Set(document.body.dataset.answers?.split(" ").filter(Boolean));
const liveRepos = new Set([...live].map((k) => k.split(":")[0]));
const copied = localStorage.getItem(STORE + "copied") || "";
for (let i = localStorage.length - 1; i >= 0; i--) {
  const k = localStorage.key(i);
  if (!isAnswer(k)) continue;
  const id = k.slice(STORE.length);
  const a = read(id);
  if (liveRepos.has(id.split(":")[0]) && !live.has(id))
    if (!a || !a.at || a.at <= copied) localStorage.removeItem(k);
}
// A visit is a run of page views under an hour apart: an item whose file changed since the one
// before says so on its row, and what changed: its question or options, or the rest of its file.
// A row this browser showed then compares the file's text, since a change fetched later carries
// its older commit time; any other row compares that time. A new visit starts the person filter
// on the hub's user again.
const MARKS = {
  asked: "question or options changed since your last visit",
  edited: "edited since your last visit",
};
let updatedSince = 0;
try {
  const now = Date.now();
  const seen = Number(localStorage.getItem(STORE + "seen")) || 0;
  const versions = JSON.parse(localStorage.getItem(STORE + "versions") || "{}");
  if (now - seen > 36e5) {
    localStorage.setItem(STORE + "visit", String(seen));
    localStorage.setItem(STORE + "before", JSON.stringify(versions));
    localStorage.removeItem(STORE + "who");
    // A question put off is asked again: its row keeps only a note written beside it.
    for (const k of Object.keys(localStorage)) {
      const a = isAnswer(k) && read(k.slice(STORE.length));
      if (a?.later)
        if (a.note)
          localStorage.setItem(
            k,
            JSON.stringify({ ...a, later: false, at: new Date(now).toISOString() }),
          );
        else localStorage.removeItem(k);
    }
  }
  localStorage.setItem(STORE + "seen", String(now));
  const since = Number(localStorage.getItem(STORE + "visit")) || 0;
  const before = JSON.parse(localStorage.getItem(STORE + "before") || "{}");
  for (const r of document.querySelectorAll("[data-k][data-version]")) {
    // A version stored before v1.24.0 holds the file's hash alone.
    const [file, asked] = (before[r.dataset.k] || "").split(" ");
    const mark = r.querySelector("[data-updated]");
    if (since && (file ? file !== r.dataset.version : Number(r.dataset.changed) * 1000 > since)) {
      if (mark) {
        mark.hidden = false;
        if (file)
          mark.textContent = `${MARKS[asked && asked !== r.dataset.asked ? "asked" : "edited"]} ·`;
      }
      updatedSince = since;
    }
    versions[r.dataset.k] = `${r.dataset.version} ${r.dataset.asked || ""}`;
  }
  for (const k of Object.keys(versions))
    if (liveRepos.has(k.split(":")[0]) && !live.has(k)) delete versions[k];
  localStorage.setItem(STORE + "versions", JSON.stringify(versions));
} catch {
  /* storage blocked: no row says what changed */
}
const hhmm = (iso) =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const moment = (iso) =>
  new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
const copiedAt = () => localStorage.getItem(STORE + "copied") || "";
const label = (d, key) =>
  d?.querySelector(`input[data-option][value="${CSS.escape(key)}"]`)?.dataset.label;
const picked = (a) => (a?.option ? a.option.split(",") : []);
const rowOf = (k) => items.find((x) => x.dataset.k === k);
// The labels as answered, one per pick: a single text in an answer stored before v1.24.0.
const labelsOf = (a) => [a.label ?? []].flat();
// An answer given before its item's question or options changed: by the question it stored, or,
// stored before answers carried one, by the label it copied.
function stale(k, a) {
  if (!a) return false;
  const shown = document.querySelector(`[data-k="${CSS.escape(k)}"][data-asked]`);
  if (!shown) return false;
  if (a.asked) return a.asked !== shown.dataset.asked;
  const d = rowOf(k);
  return (
    !!d && picked(a).length === 1 && typeof a.label === "string" && label(d, a.option) !== a.label
  );
}
const choiceOf = (k, a) => {
  const names = labelsOf(a);
  return picked(a)
    .map((key, n) => {
      const name = names[n] ?? label(rowOf(k), key);
      return name ? `${key} (${name})` : key;
    })
    .join(", ");
};
function mark(d, a) {
  const old = stale(d.dataset.k, a);
  const n = picked(a).length;
  const text = !a
    ? ""
    : a.later
      ? "later"
      : old
        ? "! answered before the question changed"
        : `✓ ${
            [
              a.stance,
              n > 1 ? `${n} picked` : a.option ? label(d, a.option) || a.option : "",
              a.done ? "done" : "",
            ]
              .filter(Boolean)
              .join(", ") || "note"
          }`;
  const sent = !!a && !old && !a.later && a.at <= copiedAt();
  const m = d.querySelector(".mark");
  if (m) {
    m.textContent = text + (sent ? " · copied" : "");
    m.classList.toggle("text-error", old);
  }
  const s = d.querySelector(".saved");
  if (s)
    s.textContent = a ? `saved ${hhmm(a.at)}${sent ? `, copied ${hhmm(copiedAt())}` : ""}` : "";
  const notice = d.querySelector("[data-stale]");
  if (notice) {
    notice.hidden = !old;
    const what = a?.option
      ? `You picked ${
          labelsOf(a)
            .map((l) => `“${l}”`)
            .join(", ") || a.option
        }`
      : a?.stance
        ? `You chose “${a.stance}”`
        : a?.done
          ? "You marked this done"
          : "You wrote your note";
    notice.textContent = old
      ? `${what} on ${moment(a.at)}. The question or its options changed since: read them again and answer again.`
      : "";
  }
}
// The inputs an answer sets, beside read-only boxes an item's own text may hold. The done and later
// boxes go by attribute, since an option's value is its key, which may be either word.
const ANSWER = "input[data-option], input[data-stance], input[data-done], input[data-later]";
function load(d) {
  const a = read(d.dataset.k);
  const old = stale(d.dataset.k, a);
  for (const i of d.querySelectorAll(ANSWER))
    i.checked =
      !!a &&
      !old &&
      ("option" in i.dataset
        ? picked(a).includes(i.value)
        : "stance" in i.dataset
          ? a.stance === i.value
          : !!a["done" in i.dataset ? "done" : "later"]);
  const t = d.querySelector("textarea");
  if (t) t.value = a ? a.note || "" : "";
  mark(d, a);
}
function save(d) {
  const keys = [...d.querySelectorAll("input[data-option]:checked")].map((i) => i.value);
  const done = d.querySelector("input[data-done]:checked");
  const later = !!d.querySelector("input[data-later]:checked");
  const stance = d.querySelector("input[data-stance]:checked")?.value || "";
  const note = (d.querySelector("textarea")?.value || "").trim();
  // The labels and the question go with the answer, so a page without its row still copies it as
  // given, and a changed question shows.
  const a =
    keys.length || done || later || stance || note
      ? {
          later,
          stance,
          option: keys.join(","),
          label: keys.map((k) => label(d, k)),
          asked: d.dataset.asked,
          done: !!done,
          note,
          at: new Date().toISOString(),
        }
      : null;
  if (write(d.dataset.k, a)) mark(d, a);
  state();
}
const answered = () => {
  const order = [...new Set([...document.querySelectorAll("[data-k]")].map((r) => r.dataset.k))];
  const at = (k) => (order.includes(k) ? order.indexOf(k) : order.length);
  return Object.keys(localStorage)
    .filter(isAnswer)
    .map((k) => k.slice(STORE.length))
    .filter((k) => read(k) && !read(k).later)
    .sort((a, b) => at(a) - at(b));
};
function line(k) {
  const a = read(k);
  const said = [
    a.stance,
    choiceOf(k, a) || (a.done ? "done" : ""),
    (a.note || "").replace(/\s+/g, " "),
  ];
  const old = stale(k, a)
    ? `; answered ${moment(a.at)}, before the question or its options changed`
    : "";
  return `${k}: ${said.filter(Boolean).join(", ")}${old}`;
}
const block = (keys) =>
  keys.length ? `Answers from the admin pages:\n${keys.map(line).join("\n")}` : "";
const copy = document.getElementById("copy");
const status = document.getElementById("state");
const idle = status?.textContent.trim();
// brand's copy button (enhance(), data-hw-copy) copies the block and says on itself how it went:
// a copy passes relabel false, so that label stays.
function state(relabel = true) {
  if (!copy) return;
  const keys = answered();
  const since = copiedAt();
  const old = keys.filter((k) => stale(k, read(k)));
  const fresh = keys.filter((k) => read(k).at > since && !old.includes(k));
  const send =
    fresh.length || old.length ? keys.filter((k) => fresh.includes(k) || old.includes(k)) : keys;
  copy.dataset.hwCopy = block(send);
  copy.disabled = !keys.length;
  const s = (n) => (n === 1 ? "" : "s");
  if (relabel)
    copy.textContent = !keys.length
      ? "Copy answers"
      : send === keys && !fresh.length && !old.length
        ? `Copy ${keys.length} answer${s(keys.length)} again`
        : `Copy ${send.length} answer${s(send.length)}`;
  // Once all is copied the button steps back, so it no longer reads as work left.
  if (keys.length && !fresh.length && !old.length) copy.dataset.variant = "secondary";
  else delete copy.dataset.variant;
  if (status)
    status.textContent = !keys.length
      ? idle
      : fresh.length || old.length
        ? [
            fresh.length ? `${fresh.length} not copied yet` : "",
            old.length
              ? `${old.length} given before ${old.length === 1 ? "its question" : "their questions"} changed`
              : "",
          ]
            .filter(Boolean)
            .join(", ") + "."
        : `All ${keys.length} copied at ${hhmm(since)}.`;
}
for (const d of items) {
  load(d);
  // A question put off holds no answer, and an answer takes it up again.
  d.addEventListener("change", (e) => {
    const later = "later" in e.target.dataset;
    if (e.target.checked)
      for (const i of d.querySelectorAll(ANSWER))
        if (later !== "later" in i.dataset) i.checked = false;
    save(d);
  });
  d.querySelector("textarea")?.addEventListener("input", () => {
    const off = d.querySelector("input[data-later]");
    if (off) off.checked = false;
    save(d);
  });
  const pick = d.querySelector(".pick");
  pick?.addEventListener("click", () => {
    const off = d.querySelector("input[data-later]");
    if (off) off.checked = false;
    for (const v of pick.dataset.v.split(" ")) {
      const r = d.querySelector(`input[data-option][value="${CSS.escape(v)}"]`);
      if (r) r.checked = true;
    }
    save(d);
  });
  d.querySelector(".clear")?.addEventListener("click", () => {
    write(d.dataset.k, null);
    load(d);
    state();
  });
}
// brand's button reads its text on the press and reports each press as hw-copy, detail { ok }, once
// the write ends. The copy time is the first press since none was pending, which no copied text is
// older than, so an answer saved during a write or a failed press stays not copied.
let pending = 0;
let pressedAt = "";
copy?.addEventListener("click", () => {
  if (!pending++) pressedAt = new Date().toISOString();
});
copy?.addEventListener("hw-copy", (e) => {
  pending = Math.max(0, pending - 1);
  if (!e.detail?.ok) return;
  try {
    if (pressedAt > copiedAt()) localStorage.setItem(STORE + "copied", pressedAt);
  } catch {
    /* storage blocked: the copy still happened */
  }
  for (const d of items) mark(d, read(d.dataset.k));
  state(false);
});

const search = document.getElementById("admin-search");
// Only a page with the person buttons filters by person: elsewhere a stored choice would hide
// rows unseen. The filter starts on the first person, the hub's user where they answer a question.
const buttons = [...document.querySelectorAll("[data-who-button]")];
const kinds = [...document.querySelectorAll("[data-kind-button]")];
const stored = localStorage.getItem(STORE + "who");
let who = buttons.some((b) => b.dataset.whoButton === stored)
  ? stored
  : buttons[0]?.dataset.whoButton || "all";
let kind = "all";
// A link to an item opens it and shows it whatever person the filter is on.
const named = () => {
  try {
    return decodeURIComponent(location.hash.slice(1));
  } catch {
    return ""; // a malformed hash names no item
  }
};
const whoFor = (t) =>
  buttons.some((b) => b.dataset.whoButton === t.dataset.who) ? t.dataset.who : "all";
let target = document.getElementById(named());
if (target?.dataset.who && buttons.length) who = whoFor(target);
const rows = () => [...document.querySelectorAll("[data-row]")];
// What a row says, without the marks this script writes or shows on it.
const said = new Map();
const textOf = (r) => {
  if (!said.has(r)) {
    const copy = r.cloneNode(true);
    for (const x of copy.querySelectorAll("[data-updated], .mark, .saved, [data-stale]"))
      x.remove();
    said.set(r, copy.textContent.toLowerCase());
  }
  return said.get(r);
};
const shown = (el) => !el.closest("[hidden]");
const scope = buttons[0]?.closest("section, main");
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function apply(picked = false) {
  const term = (search?.value || "").trim().toLowerCase();
  const filtered = buttons.length > 0 && who !== "all";
  const mine = (r) => !filtered || !r.dataset.who || r.dataset.who === who;
  let elsewhere = 0;
  for (const r of rows()) {
    const hit = !term || textOf(r).includes(term);
    const ofKind = kind === "all" || !r.dataset.kind || r.dataset.kind === kind;
    r.hidden = !mine(r) || !ofKind || !hit;
    if (term && hit && ofKind && !mine(r)) elsewhere++;
    // Options narrow only where one matches: a row found by its title keeps all of them.
    const options = [...r.querySelectorAll("[data-option-row]")];
    const hits = options.map((o) => !!term && o.textContent.toLowerCase().includes(term));
    options.forEach((o, n) => (o.hidden = hits.includes(true) && !hits[n]));
  }
  for (const g of document.querySelectorAll("[data-group]")) {
    const n = g.querySelectorAll("[data-row]:not([hidden])").length;
    // The selected person's own rows stand under "Needs you", not again under "Waiting on others".
    g.hidden = !n || (filtered && g.dataset.whoGroup === who);
    const c = g.querySelector(":scope > summary [data-count]");
    if (c) c.textContent = n;
    if (term && n) g.open = true;
  }
  // A section left without a row to show steps aside, but the one holding the filters.
  for (const sec of document.querySelectorAll("main section"))
    if (sec.querySelector("[data-row]") && !sec.contains(buttons[0] ?? null))
      sec.hidden = ![...sec.querySelectorAll("[data-row]")].some(
        (r) => !r.hidden && !r.closest("[data-group]")?.hidden,
      );
  // After a choice of person or kind, the first group with rows opens where none is open.
  if (picked && scope) {
    const groups = [...scope.querySelectorAll("details[data-group]")].filter(shown);
    if (groups.length && !groups.some((g) => g.open)) groups[0].open = true;
  }
  for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.whoButton === who));
  for (const b of kinds) b.setAttribute("aria-pressed", String(b.dataset.kindButton === kind));
  const open = [...document.querySelectorAll("details.item[data-status=open]")].filter(mine);
  for (const b of kinds) {
    const n = open.filter(
      (r) => b.dataset.kindButton === "all" || r.dataset.kind === b.dataset.kindButton,
    ).length;
    b.querySelector("[data-kind-count]").textContent = n;
    b.hidden = !n && b.dataset.kindButton !== "all" && b.dataset.kindButton !== kind;
  }
  const veto = document.querySelector("[data-assumed]");
  if (veto) {
    const n = [...document.querySelectorAll("[data-row][data-status=assumed]")].filter(mine).length;
    veto.hidden = !n;
    veto.querySelector("[data-assumed-count]").textContent =
      `${plural(n, "assumption")} agents made`;
  }
  const none = document.getElementById("admin-nohit");
  if (none) {
    const empty = !!term && !rows().some((r) => !r.hidden && shown(r));
    none.hidden = !empty;
    none.textContent = empty
      ? `No row ${filtered ? `for ${who} ` : ""}on this page matches “${term}”${
          elsewhere
            ? `; ${plural(elsewhere, "row")} of other people ${elsewhere === 1 ? "does" : "do"}: choose All to see ${elsewhere === 1 ? "it" : "them"}`
            : ""
        }.`
      : "";
  }
}
for (const b of buttons)
  b.addEventListener("click", () => {
    who = b.dataset.whoButton;
    try {
      localStorage.setItem(STORE + "who", who);
    } catch {
      /* storage blocked: the filter still applies on this page */
    }
    apply(true);
  });
for (const b of kinds)
  b.addEventListener("click", () => {
    kind = b.dataset.kindButton;
    apply(true);
  });
search?.addEventListener("input", () => apply());
addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement?.tagName !== "INPUT" && !e.metaKey) {
    if (document.activeElement?.tagName === "TEXTAREA") return;
    e.preventDefault();
    search?.focus();
  }
});
addEventListener("storage", () => {
  for (const d of items) load(d);
  state();
});
for (const g of document.querySelectorAll("details[data-group]")) {
  const n = g.querySelectorAll("[data-updated]:not([hidden])").length;
  const c = g.querySelector(":scope > summary [data-updated-count]");
  if (c && n) {
    c.hidden = false;
    c.textContent = `· ${n} updated`;
  }
}
const since = document.getElementById("admin-since");
const marked = new Set(
  [...document.querySelectorAll("[data-updated]:not([hidden])")].map(
    (m) => m.closest("[data-k]").dataset.k,
  ),
).size;
if (since && marked) {
  since.hidden = false;
  since.textContent = `${plural(marked, "item")} on this page changed since your last visit, ${moment(updatedSince)}.`;
}
apply();
state();
function reveal() {
  target = document.getElementById(named());
  // A link followed on the page shows its row whatever the filters hid.
  if (target?.closest("[hidden]")) {
    if (target.dataset.who && buttons.length) who = whoFor(target);
    kind = "all";
    if (search) search.value = "";
    apply();
  }
  for (let e = target; e; e = e.parentElement?.closest("details")) e.open = true;
  target?.scrollIntoView();
  const gone = document.getElementById("admin-gone");
  const [repo, id] = named().split(":");
  if (gone) {
    gone.hidden = !!target || !id;
    gone.textContent =
      target || !id
        ? ""
        : `${repo}:${id} is no longer open: it was settled or finished, and its file is gone. Its history: git log --all -- docs/agent-work/items/${id}.md in ${repo}.`;
  }
}
reveal();
addEventListener("hashchange", reveal);
// A page left open says once it is over an hour old, since it shows the state it was loaded in.
const loaded = Date.now();
const age = document.getElementById("admin-age");
const aged = () => {
  if (!age || Date.now() - loaded < 36e5) return;
  age.hidden = false;
  age.textContent = `This page shows the state of ${moment(new Date(loaded).toISOString())}. Reload it before you answer: items may have changed or closed since.`;
};
setInterval(aged, 6e4);
addEventListener("visibilitychange", aged);
// A catalog link opens only while its dev server runs: an opaque no-cors request answers
// when the server listens and fails when nothing does.
for (const p of document.querySelectorAll("[data-dev]")) {
  const out = p.querySelector("[data-dev-state]");
  const port = new URL(p.dataset.dev).port;
  fetch(p.dataset.dev, { mode: "no-cors", cache: "no-store" }).then(
    () => (out.textContent = `A server answers on port ${port} now.`),
    () => (out.textContent = `Nothing answers on port ${port} now.`),
  );
}
