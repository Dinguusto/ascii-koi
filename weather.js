/*
 * ASCII Koi: the sky over the pond, from the weather where you are.
 *
 *   snow        ASCII flakes ( . + * ) drift down and melt into tiny rings
 *   rain        quick slanted streaks that land as rings on the water
 *   storm       heavier rain and the odd flash of lightning
 *   wind        the light net drifts downwind, gust lines (~ -) skim the water
 *   clouds      soft shadows drift across the pond, the water darkens
 *   fog         a pale haze
 *   night       the pond goes darker
 *
 * Weather comes from Open-Meteo (free, no key). Where you are comes from
 * ?lat=..&lon=.., or ?city=Boston, or else a rough lookup from your IP.
 * Both are cached in localStorage so a new tab does not wait on the network.
 *
 *   ?weather=snow|rain|storm|drizzle|fog|cloudy|wind|clear|night   preview one (no network)
 *   ?weather=off                                                    no weather at all
 *   ?units=c|f                                                      temperature units
 */
(global => {
  "use strict";

  const WMO = {
    0: ["clear", 0, "clear"], 1: ["clear", 0, "mostly clear"], 2: ["cloudy", 0, "partly cloudy"], 3: ["cloudy", 0, "overcast"],
    45: ["fog", 0, "fog"], 48: ["fog", 0, "freezing fog"],
    51: ["drizzle", 0.25, "light drizzle"], 53: ["drizzle", 0.4, "drizzle"], 55: ["drizzle", 0.55, "heavy drizzle"],
    56: ["drizzle", 0.35, "freezing drizzle"], 57: ["drizzle", 0.55, "freezing drizzle"],
    61: ["rain", 0.4, "light rain"], 63: ["rain", 0.65, "rain"], 65: ["rain", 0.95, "heavy rain"],
    66: ["rain", 0.45, "freezing rain"], 67: ["rain", 0.8, "freezing rain"],
    71: ["snow", 0.35, "light snow"], 73: ["snow", 0.6, "snow"], 75: ["snow", 0.95, "heavy snow"], 77: ["snow", 0.3, "snow grains"],
    80: ["rain", 0.5, "showers"], 81: ["rain", 0.75, "showers"], 82: ["rain", 1, "heavy showers"],
    85: ["snow", 0.6, "snow showers"], 86: ["snow", 0.95, "heavy snow showers"],
    95: ["storm", 0.85, "thunderstorm"], 96: ["storm", 1, "thunderstorm, hail"], 99: ["storm", 1, "thunderstorm, hail"]
  };

  /* made-up weather for ?weather=… previews */
  const PREVIEW = {
    clear: { code: 0, cloud: 5, wind: 4, dir: 250, day: 1, temp: 64 },
    cloudy: { code: 3, cloud: 95, wind: 9, dir: 250, day: 1, temp: 52 },
    fog: { code: 45, cloud: 100, wind: 2, dir: 200, day: 1, temp: 48 },
    drizzle: { code: 53, cloud: 90, wind: 8, dir: 240, day: 1, temp: 50 },
    rain: { code: 63, cloud: 100, wind: 12, dir: 250, day: 1, temp: 47 },
    storm: { code: 95, cloud: 100, wind: 24, dir: 260, day: 1, temp: 70 },
    snow: { code: 73, cloud: 100, wind: 9, dir: 300, day: 1, temp: 29 },
    wind: { code: 2, cloud: 40, wind: 28, dir: 270, day: 1, temp: 55 },
    night: { code: 1, cloud: 20, wind: 5, dir: 250, day: 0, temp: 41 }
  };

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private window */ } }
  };
  const rand = (a, b) => a + Math.random() * (b - a);

  function createWeather({ canvas, pond, reduce = false, onReport = () => {} }) {
    const q = new URLSearchParams(location.search);
    const mode = (q.get("weather") || "").toLowerCase();
    const fahrenheit = q.get("units") ? q.get("units").toLowerCase() !== "c" : (navigator.language || "en-US") === "en-US";
    const ctx = canvas.getContext("2d");
    let vw = 0, vh = 0, dpr = 1;
    let W = null;            /* the weather now: kind, amount, cloud, wind, dir, day, temp, label */
    let flakes = [], drops = [], gusts = [], clouds = [];
    let flash = 0, nextFlash = 0, last = 0, running = false, ink = [235, 230, 220], darkTheme = true, inkAt = 0;

    function size(w, h) {
      vw = w; vh = h; dpr = Math.min(3, global.devicePixelRatio || 1);
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }

    function readInk() {
      const cs = getComputedStyle(document.documentElement);
      const m = cs.getPropertyValue("--ink").trim().match(/^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
      if (m) ink = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
      darkTheme = cs.getPropertyValue("color-scheme").includes("dark");
    }

    /* ── the weather, as a few numbers the pond can use ── */
    function apply(raw) {
      const [kind, amount, words] = WMO[raw.code] || ["clear", 0, "clear"];
      const temp = fahrenheit ? raw.temp : (raw.temp - 32) * 5 / 9;
      W = {
        kind, amount, cloud: Math.min(1, (raw.cloud || 0) / 100), wind: raw.wind || 0, dir: raw.dir || 0, day: raw.day !== 0,
        label: `${Math.round(temp)}°${fahrenheit ? "F" : "C"} · ${words}${raw.wind >= 15 ? ` · wind ${Math.round(raw.wind)} mph` : ""}`
      };
      /* wind blows toward dir + 180°, with north up the screen */
      const to = (W.dir + 180) * Math.PI / 180, speed = Math.min(70, W.wind * 1.6);
      W.vx = Math.sin(to) * speed; W.vy = -Math.cos(to) * speed * 0.6;
      if (!reduce) pond.wind(W.vx, W.vy, 1 + Math.min(1.6, W.wind / 18));
      seed();
      onReport(W);
    }

    function seed() {
      const area = vw * vh / (1440 * 900);
      const snow = W.kind === "snow" ? W.amount : 0;
      const rain = W.kind === "rain" || W.kind === "storm" || W.kind === "drizzle" ? W.amount : 0;
      flakes = Array.from({ length: Math.round(snow * 260 * area) }, () => newFlake(true));
      drops = Array.from({ length: Math.round(rain * (W.kind === "drizzle" ? 70 : 140) * area) }, () => newDrop(true));
      const g = Math.max(0, W.wind - 9);
      gusts = Array.from({ length: Math.round(Math.min(34, g * 1.4) * Math.sqrt(area)) }, () => newGust(true));
      const nc = W.cloud > 0.12 ? Math.round(2 + W.cloud * 5) : 0;
      clouds = Array.from({ length: nc }, () => ({ x: rand(-0.2, 1.2) * vw, y: rand(-0.2, 1.2) * vh, r: rand(0.22, 0.42) * Math.max(vw, vh), a: rand(0.6, 1) }));
      nextFlash = performance.now() / 1000 + rand(4, 12);
    }

    function newFlake(anywhere) {
      const z = Math.random();               /* 0 far … 1 near */
      return {
        x: rand(-40, vw + 40), y: anywhere ? rand(-20, vh) : rand(-60, -10), z,
        land: rand(vh * 0.15, vh + 30), fall: 22 + 46 * z, sway: rand(0, 6.28), swayK: rand(0.6, 1.4),
        g: z > 0.72 ? "*" : z > 0.35 ? "+" : "."
      };
    }
    function newDrop(anywhere) {
      return { x: rand(0, vw), y: rand(0, vh), born: performance.now() / 1000 - (anywhere ? rand(0, 0.6) : 0), life: rand(0.16, 0.26), len: rand(70, 140), landed: false };
    }
    function newGust(anywhere) {
      const n = 3 + Math.floor(Math.random() * 7);
      let s = ""; for (let i = 0; i < n; i++) s += Math.random() < 0.55 ? "~" : Math.random() < 0.6 ? "-" : " ";
      return { x: rand(-0.1, 1.1) * vw, y: rand(0, vh), s, born: performance.now() / 1000 - (anywhere ? rand(0, 4) : 0), life: rand(2.2, 4.5), sp: rand(0.8, 1.4) };
    }

    /* ── one frame of sky ── */
    function frame(now) {
      if (!running) return;
      requestAnimationFrame(frame);
      const s = now / 1000, dt = Math.min(0.05, s - last || 0); last = s;
      if (!W) return;
      if (s - inkAt > 1) { readInk(); inkAt = s; }
      const paused = pond.paused;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, vw, vh);
      const inkC = a => `rgba(${ink[0]},${ink[1]},${ink[2]},${a})`;
      const shadow = a => darkTheme ? `rgba(2,6,10,${a})` : `rgba(30,34,40,${a * 0.55})`;

      /* darker water: night, clouds, rain */
      const wet = W.kind === "rain" || W.kind === "storm" ? 0.08 * W.amount : 0;
      const dark = (W.day ? 0 : 0.3) + 0.1 * W.cloud + wet;
      if (dark > 0.01) { ctx.fillStyle = shadow(dark); ctx.fillRect(0, 0, vw, vh); }

      /* cloud shadows drifting downwind */
      const cvx = (W.vx || 0) * 0.35 + 4, cvy = (W.vy || 0) * 0.35;
      for (const c of clouds) {
        if (!paused && !reduce) { c.x += cvx * dt; c.y += cvy * dt; }
        if (c.x - c.r > vw) c.x = -c.r; if (c.x + c.r < 0) c.x = vw + c.r;
        if (c.y - c.r > vh) c.y = -c.r; if (c.y + c.r < 0) c.y = vh + c.r;
        const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.r);
        const a = 0.16 * W.cloud * c.a;
        g.addColorStop(0, shadow(a)); g.addColorStop(0.6, shadow(a * 0.6)); g.addColorStop(1, shadow(0));
        ctx.fillStyle = g; ctx.fillRect(c.x - c.r, c.y - c.r, c.r * 2, c.r * 2);
      }

      /* fog: a pale haze that breathes */
      if (W.kind === "fog") {
        ctx.fillStyle = inkC(darkTheme ? 0.1 + 0.03 * Math.sin(s * 0.3) : 0.16);
        ctx.fillRect(0, 0, vw, vh);
      }

      ctx.textAlign = "center"; ctx.textBaseline = "middle";

      /* gust lines skimming the water, along the wind */
      if (gusts.length) {
        const ang = Math.atan2(W.vy, W.vx), sp = Math.hypot(W.vx, W.vy) * 2.2;
        ctx.font = `600 15px "Geist Mono", ui-monospace, monospace`;
        for (let i = 0; i < gusts.length; i++) {
          const g = gusts[i], age = s - g.born;
          if (age > g.life) { gusts[i] = newGust(false); continue; }
          if (!paused && !reduce) { g.x += Math.cos(ang) * sp * g.sp * dt; g.y += Math.sin(ang) * sp * g.sp * dt; }
          const u = age / g.life, a = Math.sin(u * Math.PI) * 0.46;
          ctx.save(); ctx.translate(g.x, g.y); ctx.rotate(ang);
          ctx.fillStyle = inkC(a); ctx.fillText(g.s, 0, 0); ctx.restore();
          if (g.x < -200 || g.x > vw + 200 || g.y < -100 || g.y > vh + 100) gusts[i] = newGust(false);
        }
      }

      /* rain: a quick slanted streak, then a ring on the water */
      if (drops.length) {
        const slant = Math.max(-0.7, Math.min(0.7, (W.vx || 0) / 60));
        ctx.font = `500 14px "Geist Mono", ui-monospace, monospace`;
        const glyph = slant > 0.2 ? "\\" : slant < -0.2 ? "/" : "|";
        for (let i = 0; i < drops.length; i++) {
          const d = drops[i], u = (s - d.born) / d.life;
          if (u >= 1) {
            if (!d.landed) { d.landed = true; if (Math.random() < 0.7) pond.drop(d.x, d.y, 0.7 + 0.6 * W.amount); }
            if (!paused && !reduce) drops[i] = newDrop(false);
            continue;
          }
          if (u < 0) continue;
          /* the streak falls toward its landing point from up and to the side */
          const k = 1 - u, sx = d.x - slant * d.len * k, sy = d.y - d.len * k;
          const a = (0.18 + 0.32 * W.amount) * Math.min(1, u * 3);
          ctx.fillStyle = inkC(a);
          ctx.fillText(glyph, sx, sy);
          ctx.fillStyle = inkC(a * 0.5);
          ctx.fillText(glyph, sx - slant * 12, sy - 12);
        }
      }

      /* snow: flakes drift down, sway, and melt into the water */
      if (flakes.length) {
        for (let i = 0; i < flakes.length; i++) {
          const f = flakes[i];
          if (!paused && !reduce) {
            f.sway += dt * f.swayK;
            f.y += f.fall * dt;
            f.x += ((W.vx || 0) * (0.4 + 0.6 * f.z) + Math.sin(f.sway) * 10) * dt;
          }
          if (f.y >= f.land) {
            if (Math.random() < 0.35) pond.drop(f.x, f.y, 0.5);
            flakes[i] = newFlake(false); continue;
          }
          if (f.x < -60) f.x += vw + 100; else if (f.x > vw + 60) f.x -= vw + 100;
          const fade = Math.min(1, (f.land - f.y) / 40);
          ctx.font = `600 ${Math.round(9 + f.z * 9)}px "Geist Mono", ui-monospace, monospace`;
          ctx.fillStyle = darkTheme ? `rgba(240,244,248,${(0.35 + 0.55 * f.z) * fade})` : `rgba(70,80,92,${(0.3 + 0.5 * f.z) * fade})`;
          ctx.fillText(f.g, f.x, f.y);
        }
      }

      /* lightning: a double flash now and then */
      if (W.kind === "storm" && !reduce) {
        if (s > nextFlash && !paused) { flash = 1; nextFlash = s + rand(6, 16); setTimeout(() => { flash = Math.max(flash, 0.7); }, 140); }
        if (flash > 0.01) { ctx.fillStyle = darkTheme ? `rgba(225,232,255,${flash * 0.32})` : `rgba(255,255,255,${flash * 0.5})`; ctx.fillRect(0, 0, vw, vh); flash *= Math.exp(-dt * 9); }
      }
    }

    /* ── where you are, and the weather there ── */
    async function place() {
      const lat = parseFloat(q.get("lat")), lon = parseFloat(q.get("lon"));
      if (isFinite(lat) && isFinite(lon)) return { lat, lon };
      const city = q.get("city");
      const key = city ? "city:" + city.toLowerCase() : "ip";
      const cached = store.get("ascii-koi-place");
      if (cached && cached.key === key && Date.now() - cached.at < 864e5) return cached;
      let got = null;
      if (city) {
        const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`).then(r => r.json());
        if (r.results && r.results[0]) got = { lat: r.results[0].latitude, lon: r.results[0].longitude };
      } else {
        const r = await fetch("https://get.geojs.io/v1/ip/geo.json").then(r => r.json());
        got = { lat: parseFloat(r.latitude), lon: parseFloat(r.longitude) };
      }
      if (!got || !isFinite(got.lat)) return null;
      const p = { ...got, key, at: Date.now() };
      store.set("ascii-koi-place", p);
      return p;
    }

    async function refresh() {
      try {
        const cached = store.get("ascii-koi-weather");
        const p = await place();
        if (!p) return;
        const where = `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`;
        if (cached && cached.where === where && Date.now() - cached.at < 6e5) { apply(cached.raw); return; }
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}` +
          `&current=temperature_2m,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,is_day&temperature_unit=fahrenheit&wind_speed_unit=mph`;
        const c = (await fetch(url).then(r => r.json())).current;
        const raw = { code: c.weather_code, cloud: c.cloud_cover, wind: c.wind_speed_10m, dir: c.wind_direction_10m, day: c.is_day, temp: c.temperature_2m };
        store.set("ascii-koi-weather", { where, at: Date.now(), raw });
        apply(raw);
      } catch (e) { /* offline: no weather, the pond still swims */ }
    }

    return {
      size,
      start() {
        if (mode === "off") return;
        readInk();
        running = true;
        requestAnimationFrame(now => { last = now / 1000; frame(now); });
        if (PREVIEW[mode]) { apply(PREVIEW[mode]); return; }
        /* the last weather straight away, then fresh weather */
        const cached = store.get("ascii-koi-weather");
        if (cached && cached.raw) apply(cached.raw);
        refresh();
        setInterval(refresh, 6e5);
      },
      colors() { readInk(); },
      get now() { return W; }
    };
  }

  (global.AsciiKoi = global.AsciiKoi || {}).createWeather = createWeather;
})(typeof window !== "undefined" ? window : globalThis);
