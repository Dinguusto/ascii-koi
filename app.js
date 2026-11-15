/*
 * The page around the pond: the clock and the day (or your own words) in
 * character cells, the date under them, the three waters, and the controls.
 *
 *   ?theme=pond|black|light    the water (remembered when you switch)
 *   ?title=One%20Page&tag=is%20all%20you%20need   your own words instead of the clock
 *   ?ui=0                       no controls (for a wallpaper or a recording)
 *   ?engine=google|ddg|bing|brave|kagi   where the search box sends you
 *   ?city=Boston or ?lat=..&lon=..       where the weather comes from (else a rough guess from your IP)
 *   ?preview=snow|rain|drizzle|storm|fog|cloudy|partly|wind|night|clear   preview a sky;  ?weather=off  no weather
 *   keys: 1 2 3 or T for the water, space to pause, / or just start typing to search
 */
(() => {
  "use strict";
  const { createPond, AsciiMark } = window.AsciiKoi;
  const root = document.documentElement;
  const q = new URLSearchParams(location.search);
  const THEMES = ["pond", "black", "light"];
  const KEY = "ascii-koi-theme";
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const store = {
    get() { try { return localStorage.getItem(KEY); } catch (e) { return null; } },
    set(v) { try { localStorage.setItem(KEY, v); } catch (e) { /* private window: not remembered */ } }
  };

  /* the water: the URL, then a page that fixes it (light.html …), then the last one chosen, then the pond */
  const fixed = root.dataset.lock;
  const first = [q.get("theme"), fixed, store.get(), "pond"].find(v => THEMES.includes(v));
  root.dataset.theme = first;

  const pondCanvas = document.getElementById("pond");
  const box = document.getElementById("intro-box");
  const titleCanvas = document.getElementById("wordmark");
  const tagCanvas = document.getElementById("wordmark-tag");
  const srTitle = document.getElementById("sr-title");
  const dateLine = document.getElementById("intro-date");
  const ui = document.getElementById("ui");
  if (q.get("ui") === "0") ui.hidden = true;
  if (location.protocol === "chrome-extension:") document.getElementById("gh")?.remove();

  const cssVar = n => getComputedStyle(root).getPropertyValue(n).trim();
  const palette = () => ({
    water: cssVar("--pond"), ink: cssVar("--ink"), accent: cssVar("--accent"),
    koiLight: cssVar("--koi-light"), koiDark: cssVar("--koi-dark"),
    dark: cssVar("color-scheme").includes("dark")
  });

  const pond = createPond({
    canvas: pondCanvas, palette, reduce,
    /* the title's box in pond pixels: the koi fade under it, so the letters can wear their colour */
    dim: () => { const r = box.getBoundingClientRect(); return r.width ? r : null; }
  });
  pond.size(innerWidth, innerHeight);
  window.AsciiKoi.pond = pond;

  /* ── the words: the time as the title, the day under it, then the date ── */
  const own = q.get("title");
  const narrow = () => innerWidth < 720;
  const words = () => {
    const now = new Date();
    const date = now.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
    if (own) return { title: own, tag: q.get("tag") || "", date };
    const time = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
    return { title: time, tag: now.toLocaleDateString("en-GB", { weekday: "long" }), date };
  };
  let current = words();
  const serif = `"Noto Serif Display", "Iowan Old Style", Georgia, serif`;
  /* the words take on the koi colour and the water's light in the pond under them */
  const look = { tint: pond.tint, light: pond.light };
  const title = AsciiMark(titleCanvas, () => ({
    text: current.title, font: `700 ${narrow() ? 120 : own ? 170 : 230}px ${serif}`,
    cw: narrow() ? 4 : 7, ch: narrow() ? 5 : 9, maxW: Math.min(innerWidth * (narrow() ? 0.9 : 0.8), own ? 700 : 820), edge: true, glow: 1
  }), look);
  /* the day, drawn the same way as the clock, smaller and a little fainter */
  const tag = AsciiMark(tagCanvas, () => ({
    text: current.tag || " ", font: `700 ${narrow() ? 64 : 84}px ${serif}`,
    cw: narrow() ? 3 : 4, ch: narrow() ? 4 : 5, maxW: Math.min(innerWidth * (narrow() ? 0.66 : 0.42), 420), tone: 0.88, edge: !narrow(), glow: 0.7
  }), look);
  const clock = () => performance.now() / 1000;
  let weatherLabel = "";
  const showDate = () => { dateLine.textContent = current.date + (weatherLabel ? "  ·  " + weatherLabel : ""); };
  const buildWords = () => {
    showDate();
    return Promise.all([title.build(clock()), tag.build(clock() + 0.35)]);
  };
  srTitle.textContent = own ? `${current.title} ${current.tag}` : "ASCII Koi";

  let lastWords = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    /* the words redraw at about 30 fps, so the koi colours flow under them smoothly; the letters still settle like a sign */
    if (now - lastWords < 32) return;
    lastWords = now;
    const s = now / 1000;
    title.draw(s); tag.draw(s);
    if (!own) {
      const w = words();
      if (w.title !== current.title || w.tag !== current.tag || w.date !== current.date) { current = w; buildWords(); }
    }
  }

  /* ── the waters ── */
  const snap = document.getElementById("snap");
  const picks = [...document.querySelectorAll("[data-theme-pick]")];
  function mark() {
    for (const b of picks) b.setAttribute("aria-checked", String(b.dataset.themePick === root.dataset.theme));
  }
  /*
   * A new water spreads like a ripple from where you chose it: the old frame
   * (pond, words and their glow) is kept on a canvas on top, and a widening
   * hole in it shows the new water underneath.
   */
  function setTheme(name, at) {
    if (!THEMES.includes(name) || name === root.dataset.theme) return;
    const dpr = pondCanvas.width / innerWidth;
    if (!reduce) {
      snap.width = pondCanvas.width; snap.height = pondCanvas.height;
      const s = snap.getContext("2d");
      s.drawImage(pondCanvas, 0, 0);
      for (const m of [title, tag]) {
        for (const c of [m.glow, m === title ? titleCanvas : tagCanvas]) {
          const r = c && c.getBoundingClientRect();
          if (!r || !r.width || !c.width) continue;
          s.filter = c === m.glow ? `blur(${14 * dpr}px)` : "none";
          s.drawImage(c, r.left * dpr, r.top * dpr, r.width * dpr, r.height * dpr);
        }
      }
      s.filter = "none";
      const r = dateLine.getBoundingClientRect(), ds = getComputedStyle(dateLine);
      s.setTransform(dpr, 0, 0, dpr, 0, 0);
      s.font = `${ds.fontWeight} ${ds.fontSize} ${ds.fontFamily}`; s.letterSpacing = ds.letterSpacing;
      s.fillStyle = ds.color; s.globalAlpha = +ds.opacity; s.textBaseline = "middle";
      s.fillText(dateLine.textContent.toUpperCase(), r.left, r.top + r.height / 2);
      s.setTransform(1, 0, 0, 1, 0, 0); s.globalAlpha = 1;
      const x = at ? at.x : innerWidth / 2, y = at ? at.y : innerHeight / 2;
      snap.style.setProperty("--x", x + "px");
      snap.style.setProperty("--y", y + "px");
      snap.classList.remove("wipe");
      snap.classList.add("show");
      void snap.offsetWidth;
      snap.classList.add("wipe");
    }
    root.dataset.theme = name;
    if (!fixed) store.set(name);
    pond.colors();
    mark();
  }
  snap.addEventListener("transitionend", () => snap.classList.remove("show", "wipe"));
  for (const b of picks) b.addEventListener("click", e => {
    const r = b.getBoundingClientRect();
    setTheme(b.dataset.themePick, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
    e.stopPropagation();
  });
  mark();

  /* ── the hands ── */
  const onUi = e => e.target.closest && e.target.closest(".ui, .search");
  let held = null, fedAt = 0;
  const feedAt = (x, y) => { const now = performance.now(); if (now - fedAt < 500) return; fedAt = now; pond.feed(x, y); };
  addEventListener("pointerdown", e => {
    if (e.button !== 0 || onUi(e)) return;
    /* a tap is a paw, a long press is food */
    if (e.pointerType === "touch" || e.pointerType === "pen") {
      clearTimeout(held?.timer);
      held = { x: e.clientX, y: e.clientY, at: performance.now(), timer: setTimeout(() => { if (held) { feedAt(held.x, held.y); held = null; } }, 450) };
      return;
    }
    pond.ripple(e.clientX, e.clientY);
  });
  addEventListener("pointermove", e => { if (held && Math.hypot(e.clientX - held.x, e.clientY - held.y) > 14) { clearTimeout(held.timer); held = null; } });
  addEventListener("pointerup", () => { if (held) { clearTimeout(held.timer); pond.ripple(held.x, held.y); held = null; } });
  addEventListener("pointercancel", () => { if (held) clearTimeout(held.timer); held = null; });
  addEventListener("contextmenu", e => {
    if (onUi(e)) return;
    e.preventDefault();
    if (held) { clearTimeout(held.timer); held = null; }
    feedAt(e.clientX, e.clientY);
  });
  addEventListener("keydown", e => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.("input, textarea")) return;
    const n = "123".indexOf(e.key);
    if (n >= 0) setTheme(THEMES[n]);
    else if (e.key === "t" || e.key === "T") setTheme(THEMES[(THEMES.indexOf(root.dataset.theme) + 1) % 3]);
    else if (e.key === " ") { e.preventDefault(); const p = pond.pause(); document.getElementById("pause-state").textContent = p ? "paused" : ""; }
  });

  /* the controls fade out while you leave the mouse alone */
  let idle = 0;
  const wake = () => { ui.classList.remove("idle"); clearTimeout(idle); idle = setTimeout(() => ui.classList.add("idle"), 3500); };
  addEventListener("pointermove", wake);
  addEventListener("keydown", wake);
  wake();

  let resizeTimer = 0;
  addEventListener("resize", () => {
    pond.size(innerWidth, innerHeight);
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => buildWords(), 120);
  });

  /* ── the search: type and go, like the browser's own new tab ──
   *   ?engine=google|ddg|bing|brave|kagi, or your own URL with %s for the words
   *   ?search=0  no search box
   */
  const form = document.getElementById("search");
  const input = document.getElementById("q");
  const ENGINES = {
    google: "https://www.google.com/search?q=%s", ddg: "https://duckduckgo.com/?q=%s",
    bing: "https://www.bing.com/search?q=%s", brave: "https://search.brave.com/search?q=%s", kagi: "https://kagi.com/search?q=%s"
  };
  const pick = q.get("engine") || "";
  const engine = ENGINES[pick] || (pick.includes("%s") ? pick : ENGINES.google);
  if (q.get("search") === "0") form.hidden = true;
  /* a URL if it looks like one, otherwise a search */
  const asUrl = s => {
    if (/\s/.test(s)) return null;
    if (/^[a-z][\w+.-]*:\/\//i.test(s)) return s;
    if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([\/?#].*)?$/i.test(s)) return "http://" + s;
    if (/^[^\/?#@]+\.[a-z]{2,}(:\d+)?([\/?#].*)?$/i.test(s)) return "https://" + s;
    return null;
  };
  form.addEventListener("submit", e => {
    e.preventDefault();
    const s = input.value.trim();
    if (!s) return;
    location.href = asUrl(s) || engine.replace("%s", encodeURIComponent(s));
  });
  input.addEventListener("keydown", e => { if (e.key === "Escape") { input.value = ""; input.blur(); } });
  /* typing anywhere lands in the box; 1 2 3, T and space still belong to the pond when the box is not focused */
  addEventListener("keydown", e => {
    if (form.hidden || document.activeElement === input || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "/") { e.preventDefault(); input.focus(); return; }
    if (e.key.length !== 1 || /^[123tT ]$/.test(e.key)) return;
    input.focus();
  });
  if (!form.hidden) input.focus();

  /* ── the weather where you are, drawn by the pond itself (weather.js) ── */
  const weather = window.AsciiKoi.createWeather
    ? window.AsciiKoi.createWeather({ pond, onReport: w => { weatherLabel = w.label; showDate(); } })
    : null;

  pond.start();
  weather?.start();

  /* ?fps=1: a small readout of the frame rate, for checking the pond runs smoothly */
  if (q.get("fps") === "1") {
    const meter = document.createElement("div");
    meter.style.cssText = "position:fixed;left:12px;top:10px;z-index:9;font:12px/16px 'Geist Mono',monospace;color:var(--ink);opacity:.75;pointer-events:none";
    document.body.append(meter);
    let r0 = pond.stats.renders, t0 = performance.now();
    setInterval(() => {
      const s = pond.stats, now = performance.now(), fps = (s.renders - r0) * 1000 / (now - t0);
      r0 = s.renders; t0 = now;
      meter.textContent = `${Math.round(fps)} fps · screen ${Math.round(1000 / s.refresh)} Hz · frame ${s.cost.toFixed(1)} ms · ${s.gpu ? "gpu" : "2d"}`;
    }, 1000);
  }
  buildWords().then(() => { box.classList.add("go"); requestAnimationFrame(frame); });
  /* canvas text cannot trigger a webfont load; redraw once the mono face is in */
  document.fonts?.load(`600 12px "Geist Mono"`).then(() => pond.colors());
})();
