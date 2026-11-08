// Runs on every admin page as a classic script, not a module, so a page opened from disk loads it;
// a file of its own, since admin-serve's Content-Security-Policy runs no inline script.
// An answer whose row left a rebuilt page is dropped once it was copied.
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
  const picked = (a) => (a?.option ? a.option.split(",") : []);
  function mark(d, a) {
    const n = picked(a).length;
    const text =
      a &&
      (n > 1
        ? `${n} picked`
        : a.option
          ? label(d, a.option) || a.option
          : a.done
            ? "done"
            : a.note
              ? "note"
              : "");
    const m = d.querySelector(".mark");
    if (m) m.textContent = text ? `✓ ${text}` : "";
    const s = d.querySelector(".saved");
    if (s) s.textContent = a ? `saved ${hhmm(a.at)}` : "";
  }
  function load(d) {
    const a = read(d.dataset.k);
    for (const i of d.querySelectorAll("input[data-option], input[value=done]"))
      i.checked = !!a && ("option" in i.dataset ? picked(a).includes(i.value) : !!a.done);
    const t = d.querySelector("textarea");
    if (t) t.value = a ? a.note || "" : "";
    mark(d, a);
  }
  function save(d) {
    const option = [...d.querySelectorAll("input[data-option]:checked")]
      .map((i) => i.value)
      .join(",");
    const done = d.querySelector("input[value=done]:checked");
    const note = (d.querySelector("textarea")?.value || "").trim();
    // The label goes with the answer, so a page without its row still copies it.
    const name = option.includes(",") ? undefined : label(d, option);
    const a =
      option || done || note
        ? { option, label: name, done: !!done, note, at: new Date().toISOString() }
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
      // An answer saved before labels were stored takes its label from its row, where shown.
      const d = items.find((x) => x.dataset.k === k);
      const name = a.label ?? (d && picked(a).length === 1 ? label(d, a.option) : undefined);
      const choice = a.option ? `${a.option}${name ? ` (${name})` : ""}` : a.done ? "done" : "";
      return `${k}: ${[choice, (a.note || "").replace(/\s+/g, " ")].filter(Boolean).join(", ")}`;
    });
    return lines.length ? `Answers from the admin pages:\n${lines.join("\n")}` : "";
  }
  const copy = document.getElementById("copy");
  const status = document.getElementById("state");
  const idle = status?.textContent.trim();
  function state() {
    if (!copy) return;
    const n = answered().length;
    const since = localStorage.getItem(STORE + "copied") || "";
    const open = answered().filter((k) => read(k).at > since).length;
    copy.textContent = n ? `Copy ${n} answer${n === 1 ? "" : "s"}` : "Copy answers";
    // Once all is copied the button steps back, so it no longer reads as work left.
    if (n && !open) copy.dataset.variant = "secondary";
    else delete copy.dataset.variant;
    if (status)
      status.textContent = !n
        ? idle
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

  const search = document.getElementById("admin-search");
  // Only a page with the person buttons filters by person: elsewhere a stored choice would hide
  // rows unseen. The filter starts on the first person, the one with the most open questions.
  const buttons = [...document.querySelectorAll("[data-who-button]")];
  const stored = localStorage.getItem(STORE + "who");
  let who = buttons.some((b) => b.dataset.whoButton === stored)
    ? stored
    : buttons[0]?.dataset.whoButton || "all";
  const rows = () => [...document.querySelectorAll("[data-row]")];
  function apply() {
    const term = (search?.value || "").trim().toLowerCase();
    const hit = (el) => !!term && el.textContent.toLowerCase().includes(term);
    for (const r of rows()) {
      const byWho = buttons.length > 0 && who !== "all" && r.dataset.who && r.dataset.who !== who;
      r.hidden = byWho || (!!term && !hit(r));
      // Options narrow only where one matches: a row found by its title keeps all of them.
      const options = [...r.querySelectorAll("[data-option-row]")];
      const hits = options.map(hit);
      options.forEach((o, n) => (o.hidden = hits.includes(true) && !hits[n]));
    }
    for (const g of document.querySelectorAll("[data-group]")) {
      const shown = g.querySelectorAll("[data-row]:not([hidden])").length;
      g.hidden = !shown;
      const c = g.querySelector("[data-count]");
      if (c) c.textContent = shown;
      if (term && shown && g.tagName === "DETAILS") g.open = true;
    }
    for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.whoButton === who));
  }
  for (const b of buttons)
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
})();
