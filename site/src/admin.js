// Runs on every admin page, inline, so a page opened from disk needs no module loading.
// Search filters the page's rows; the person buttons filter rows by who answers; answers stay in
// this browser (localStorage) until "Copy answers" puts them on the clipboard as one block for the
// chat, one "repo:id: choice, note" line each. An answer whose row left a rebuilt page is dropped
// once it was copied.
(() => {
  const STORE = "admin-answers:";
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
  const items = [...document.querySelectorAll("details.item[data-k]")];
  const known = new Set(items.map((d) => d.dataset.k));
  const repos = new Set(items.map((d) => d.dataset.k.split(":")[0]));
  const copiedAt = localStorage.getItem(STORE + "copied") || "";
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(STORE) || k === STORE + "copied" || k === STORE + "who") continue;
    const id = k.slice(STORE.length);
    const a = read(id);
    if (document.body.dataset.answers === "all" && repos.has(id.split(":")[0]) && !known.has(id))
      if (!a || !a.at || a.at <= copiedAt) localStorage.removeItem(k);
  }
  const hhmm = (iso) =>
    new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const label = (d, key) => d.querySelector(`input[value="${CSS.escape(key)}"]`)?.dataset.label;
  function mark(d, a) {
    const text =
      a && (a.option ? label(d, a.option) || a.option : a.done ? "done" : a.note ? "note" : "");
    const m = d.querySelector(".mark");
    if (m) m.textContent = text ? `✓ ${text}` : "";
    const s = d.querySelector(".saved");
    if (s) s.textContent = a ? `saved ${hhmm(a.at)}` : "";
  }
  function load(d) {
    const a = read(d.dataset.k);
    for (const i of d.querySelectorAll("input"))
      i.checked = !!a && (i.type === "radio" ? a.option === i.value : !!a.done);
    const t = d.querySelector("textarea");
    if (t) t.value = a ? a.note || "" : "";
    mark(d, a);
  }
  function save(d) {
    const opt = d.querySelector("input[type=radio]:checked");
    const done = d.querySelector("input[type=checkbox]:checked");
    const note = (d.querySelector("textarea")?.value || "").trim();
    const a =
      opt || done || note
        ? { option: opt ? opt.value : "", done: !!done, note, at: new Date().toISOString() }
        : null;
    if (write(d.dataset.k, a)) mark(d, a);
    state();
  }
  const answered = () =>
    Object.keys(localStorage)
      .filter((k) => k.startsWith(STORE) && k !== STORE + "copied" && k !== STORE + "who")
      .map((k) => k.slice(STORE.length))
      .filter((k) => read(k));
  function block() {
    const lines = answered().map((k) => {
      const a = read(k);
      const d = items.find((x) => x.dataset.k === k);
      const choice = a.option
        ? `${a.option}${d && label(d, a.option) ? ` (${label(d, a.option)})` : ""}`
        : a.done
          ? "done"
          : "";
      return `${k}: ${[choice, (a.note || "").replace(/\s+/g, " ")].filter(Boolean).join(", ")}`;
    });
    return lines.length ? `Answers from the admin pages:\n${lines.join("\n")}` : "";
  }
  const copy = document.getElementById("copy");
  const status = document.getElementById("state");
  function state() {
    if (!copy) return;
    const n = answered().length;
    const since = localStorage.getItem(STORE + "copied") || "";
    const open = answered().filter((k) => read(k).at > since).length;
    copy.textContent = n ? `Copy ${n} answer${n === 1 ? "" : "s"}` : "Copy answers";
    if (status)
      status.textContent = !n
        ? "Answers stay in this browser."
        : open
          ? `${open} not copied yet.`
          : `All copied at ${hhmm(since)}.`;
  }
  for (const d of items) {
    load(d);
    d.addEventListener("change", () => save(d));
    d.querySelector("textarea")?.addEventListener("input", () => save(d));
    const pick = d.querySelector(".pick");
    pick?.addEventListener("click", () => {
      const r = d.querySelector(`input[value="${CSS.escape(pick.dataset.v)}"]`);
      if (r) r.checked = true;
      save(d);
    });
    d.querySelector(".clear")?.addEventListener("click", () => {
      write(d.dataset.k, null);
      load(d);
      state();
    });
  }
  copy?.addEventListener("click", async () => {
    const text = block();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const t = document.createElement("textarea");
      t.value = text;
      document.body.append(t);
      t.select();
      document.execCommand("copy");
      t.remove();
    }
    try {
      localStorage.setItem(STORE + "copied", new Date().toISOString());
    } catch {
      /* storage blocked: the copy still happened */
    }
    state();
  });
  addEventListener("beforeunload", (e) => {
    const since = localStorage.getItem(STORE + "copied") || "";
    if (answered().some((k) => read(k).at > since)) e.preventDefault();
  });

  // Filters: search over every row and card, and who answers.
  const search = document.getElementById("admin-search");
  // The filter starts on the first person, the one with the most open questions.
  let who =
    localStorage.getItem(STORE + "who") ||
    document.querySelector("[data-who-button]")?.dataset.whoButton ||
    "all";
  const rows = () => [...document.querySelectorAll("[data-row]")];
  function apply() {
    const term = (search?.value || "").trim().toLowerCase();
    for (const r of rows()) {
      const byWho = who !== "all" && r.dataset.who && r.dataset.who !== who;
      r.hidden = byWho || (!!term && !r.textContent.toLowerCase().includes(term));
    }
    for (const g of document.querySelectorAll("[data-group]")) {
      const shown = g.querySelectorAll("[data-row]:not([hidden])").length;
      g.hidden = !shown;
      const c = g.querySelector("[data-count]");
      if (c) c.textContent = shown;
      if (term && shown && g.tagName === "DETAILS") g.open = true;
    }
    for (const b of document.querySelectorAll("[data-who-button]"))
      b.setAttribute("aria-pressed", String(b.dataset.whoButton === who));
  }
  for (const b of document.querySelectorAll("[data-who-button]"))
    b.addEventListener("click", () => {
      who = b.dataset.whoButton;
      try {
        localStorage.setItem(STORE + "who", who);
      } catch {
        /* storage blocked: the filter still applies on this page */
      }
      apply();
    });
  search?.addEventListener("input", apply);
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
  apply();
  state();
})();
