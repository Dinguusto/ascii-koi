/*
 * ASCII Koi: the weather where you are, for the pond (pond.weather draws it).
 *
 * Accuracy first:
 *   1. In the US, the latest reading from the nearest weather station (api.weather.gov): what is
 *      actually falling, the cloud layers, wind and temperature, as measured. Used while it is under
 *      90 minutes old.
 *   2. Otherwise Open-Meteo's current conditions (a weather model, updated every 15 minutes). Rain or
 *      snow is only shown when the model also has something falling right now.
 *   Day or night comes from Open-Meteo for your place.
 *
 * Where you are: ?lat=..&lon=.., or ?city=Boston, or a rough guess from your IP. Cached for a day.
 * The weather is cached for ten minutes, so a new tab shows it at once, and it is checked again
 * every ten minutes while the tab is open.
 *
 *   ?preview=snow|rain|drizzle|storm|fog|cloudy|partly|wind|night|clear   preview a sky (labelled "preview")
 *   ?weather=off                                                         no weather
 *   (anything else in ?weather= is ignored, so an old preview link shows the real weather)
 *   ?units=c|f
 */
(global => {
  "use strict";

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private window */ } }
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const getJSON = async (url, ms = 8000) => {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { Accept: "application/geo+json, application/json" } });
      if (!r.ok) throw new Error(r.status);
      return await r.json();
    } finally { clearTimeout(timer); }
  };

  /* made-up skies for ?weather= previews */
  const PREVIEW = {
    clear: { sky: {}, temp: 64, text: "clear" },
    partly: { sky: { cloud: 0.45, wind: 8 }, temp: 60, text: "partly cloudy" },
    cloudy: { sky: { cloud: 1, wind: 9 }, temp: 52, text: "overcast" },
    fog: { sky: { cloud: 1, fog: 0.9, wind: 2 }, temp: 48, text: "fog" },
    drizzle: { sky: { cloud: 1, drizzle: 0.5, wind: 7 }, temp: 50, text: "drizzle" },
    rain: { sky: { cloud: 1, rain: 0.65, wind: 12 }, temp: 47, text: "rain" },
    storm: { sky: { cloud: 1, rain: 1, storm: 1, wind: 24 }, temp: 70, text: "thunderstorm" },
    snow: { sky: { cloud: 1, snow: 0.6, wind: 8, windFrom: 300 }, temp: 29, text: "snow" },
    wind: { sky: { cloud: 0.3, wind: 28 }, temp: 55, text: "windy" },
    night: { sky: { night: 1, wind: 4 }, temp: 41, text: "clear" }
  };

  /* WMO weather codes (Open-Meteo): what is falling and how much */
  const WMO = {
    0: ["clear"], 1: ["mostly clear"], 2: ["partly cloudy"], 3: ["overcast"], 45: ["fog", "fog", 1], 48: ["freezing fog", "fog", 1],
    51: ["light drizzle", "drizzle", 0.3], 53: ["drizzle", "drizzle", 0.5], 55: ["heavy drizzle", "drizzle", 0.7], 56: ["freezing drizzle", "drizzle", 0.4], 57: ["freezing drizzle", "drizzle", 0.6],
    61: ["light rain", "rain", 0.4], 63: ["rain", "rain", 0.65], 65: ["heavy rain", "rain", 0.95], 66: ["freezing rain", "rain", 0.45], 67: ["freezing rain", "rain", 0.8],
    71: ["light snow", "snow", 0.35], 73: ["snow", "snow", 0.6], 75: ["heavy snow", "snow", 0.95], 77: ["snow grains", "snow", 0.3],
    80: ["showers", "rain", 0.5], 81: ["showers", "rain", 0.75], 82: ["heavy showers", "rain", 1], 85: ["snow showers", "snow", 0.6], 86: ["heavy snow showers", "snow", 0.95],
    95: ["thunderstorm", "storm", 0.85], 96: ["thunderstorm, hail", "storm", 1], 99: ["thunderstorm, hail", "storm", 1]
  };
  const COVER = { CLR: 0, SKC: 0, FEW: 0.2, SCT: 0.45, BKN: 0.75, OVC: 1, VV: 1 };

  /* A station reading (api.weather.gov) into the pond's sky. Everything here was measured. */
  function fromStation(o) {
    const text = String(o.textDescription || "").toLowerCase();
    const sky = {};
    const strength = s => /heavy/.test(s) ? 1 : /light/.test(s) ? 0.4 : 0.65;
    for (const p of o.presentWeather || []) {
      const w = String(p.weather || ""), a = p.intensity === "heavy" ? 1 : p.intensity === "light" ? 0.4 : 0.65;
      if (/thunder/.test(w)) { sky.storm = 1; sky.rain = Math.max(sky.rain || 0, a); }
      else if (/snow|ice_pellets|ice_crystals/.test(w)) sky.snow = Math.max(sky.snow || 0, a);
      else if (/drizzle/.test(w)) sky.drizzle = Math.max(sky.drizzle || 0, a);
      else if (/rain|showers/.test(w)) sky.rain = Math.max(sky.rain || 0, a);
      else if (/fog|mist|haze|smoke/.test(w)) sky.fog = Math.max(sky.fog || 0, /fog/.test(w) ? 0.9 : 0.4);
    }
    /* the summary text as well, in case presentWeather is empty */
    if (/thunder/.test(text)) { sky.storm = 1; sky.rain = Math.max(sky.rain || 0, 0.8); }
    if (/snow|flurr|sleet|ice pellets/.test(text)) sky.snow = Math.max(sky.snow || 0, strength(text));
    if (/drizzle/.test(text)) sky.drizzle = Math.max(sky.drizzle || 0, strength(text));
    if (/rain|shower/.test(text)) sky.rain = Math.max(sky.rain || 0, strength(text));
    if (/fog/.test(text)) sky.fog = Math.max(sky.fog || 0, 0.9);
    else if (/mist|haze|smoke/.test(text)) sky.fog = Math.max(sky.fog || 0, 0.4);
    const vis = o.visibility && o.visibility.value;
    if (sky.fog && vis != null) sky.fog = clamp((sky.fog + clamp((3000 - vis) / 2500, 0, 1)) / 2, 0.2, 1);
    let cloud = null;
    for (const l of o.cloudLayers || []) if (l.amount in COVER) cloud = Math.max(cloud || 0, COVER[l.amount]);
    if (cloud == null) cloud = /overcast|^cloudy/.test(text) ? 1 : /mostly cloudy/.test(text) ? 0.75 : /partly/.test(text) ? 0.45 : /mostly clear|mostly sunny/.test(text) ? 0.2 : 0;
    if (sky.rain || sky.snow || sky.drizzle || sky.storm) cloud = Math.max(cloud, 0.85);
    sky.cloud = cloud;
    const kmh = o.windSpeed && o.windSpeed.value;
    sky.wind = kmh != null ? kmh * 0.621 : 0;
    if (o.windDirection && o.windDirection.value != null) sky.windFrom = o.windDirection.value;
    const c = o.temperature && o.temperature.value;
    return { sky, tempF: c != null ? c * 9 / 5 + 32 : null, text: text || null };
  }

  /* Open-Meteo's current conditions into the pond's sky. Rain and snow only when something is falling now. */
  function fromModel(c) {
    const [words, kind, amount] = WMO[c.weather_code] || ["clear"];
    const sky = { cloud: clamp((c.cloud_cover || 0) / 100, 0, 1), wind: c.wind_speed_10m || 0, windFrom: c.wind_direction_10m || 270 };
    const falling = (c.precipitation || 0) > 0 || (c.rain || 0) > 0 || (c.showers || 0) > 0 || (c.snowfall || 0) > 0;
    let text = words;
    if (kind === "fog") sky.fog = 0.9;
    else if (kind && falling) {
      if (kind === "storm") { sky.storm = 1; sky.rain = amount; }
      else sky[kind] = amount;
      sky.cloud = Math.max(sky.cloud, 0.85);
    } else if (kind) text = sky.cloud > 0.8 ? "overcast" : sky.cloud > 0.35 ? "partly cloudy" : "mostly clear";
    if (!sky.fog && c.visibility != null && c.visibility < 1000) sky.fog = 0.7;
    return { sky, tempF: c.temperature_2m, text };
  }

  function createWeather({ pond, onReport = () => {} }) {
    const q = new URLSearchParams(location.search);
    const mode = (q.get("preview") || "").toLowerCase(), off = (q.get("weather") || "").toLowerCase() === "off";
    const fahrenheit = q.get("units") ? q.get("units").toLowerCase() !== "c" : (navigator.language || "en-US") === "en-US";
    let first = true;

    function show(r, preview) {
      const t = r.tempF == null ? "" : `${Math.round(fahrenheit ? r.tempF : (r.tempF - 32) * 5 / 9)}°${fahrenheit ? "F" : "C"} · `;
      const wind = r.sky.wind >= 15 ? ` · wind ${Math.round(r.sky.wind)} mph` : "";
      pond.weather(r.sky, first);
      first = false;
      onReport({ ...r, label: (preview ? "preview · " : "") + t + (r.text || "clear") + wind });
    }

    async function place() {
      const lat = parseFloat(q.get("lat")), lon = parseFloat(q.get("lon"));
      if (isFinite(lat) && isFinite(lon)) return { lat, lon, key: `${lat},${lon}` };
      const city = q.get("city"), key = city ? "city:" + city.toLowerCase() : "ip";
      const cached = store.get("ascii-koi-place");
      if (cached && cached.key === key && Date.now() - cached.at < 864e5) return cached;
      let got = null;
      if (city) {
        const r = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`);
        if (r.results && r.results[0]) got = { lat: r.results[0].latitude, lon: r.results[0].longitude };
      } else {
        const r = await getJSON("https://get.geojs.io/v1/ip/geo.json");
        got = { lat: parseFloat(r.latitude), lon: parseFloat(r.longitude) };
      }
      if (!got || !isFinite(got.lat)) return null;
      const p = { ...got, key, at: Date.now() };
      store.set("ascii-koi-place", p);
      return p;
    }

    /* the nearest station for a place (US only), cached for a day; null where there is none */
    async function station(p) {
      const k = `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`, cached = store.get("ascii-koi-station");
      if (cached && cached.k === k && Date.now() - cached.at < 864e5) return cached.id;
      let id = null;
      try {
        const pt = await getJSON(`https://api.weather.gov/points/${p.lat.toFixed(4)},${p.lon.toFixed(4)}`);
        const st = await getJSON(pt.properties.observationStations);
        id = st.features && st.features[0] ? st.features[0].properties.stationIdentifier : null;
      } catch (e) { id = null; }
      store.set("ascii-koi-station", { k, id, at: Date.now() });
      return id;
    }

    async function refresh(force) {
      try {
        const p = await place();
        if (!p) return;
        const where = `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`, cached = store.get("ascii-koi-sky");
        if (!force && cached && cached.where === where && Date.now() - cached.at < 6e5) { show(cached.r); return; }
        const model = getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}` +
          "&current=temperature_2m,weather_code,precipitation,rain,showers,snowfall,cloud_cover,wind_speed_10m,wind_direction_10m,is_day,visibility" +
          "&temperature_unit=fahrenheit&wind_speed_unit=mph").then(r => r.current).catch(() => null);
        const obs = station(p).then(id => id ? getJSON(`https://api.weather.gov/stations/${id}/observations/latest`) : null)
          .then(r => r && r.properties).catch(() => null);
        const [m, o] = await Promise.all([model, obs]);
        const fresh = o && o.timestamp && Date.now() - Date.parse(o.timestamp) < 90 * 60e3;
        let r = fresh ? fromStation(o) : m ? fromModel(m) : null;
        if (!r) return;
        if (r.tempF == null && m) r.tempF = m.temperature_2m;
        r.source = fresh ? "station" : "model";
        /* day or night for this place */
        const night = m ? (m.is_day === 0 ? 1 : 0) : ((h => h < 6 || h >= 18)(new Date().getHours()) ? 1 : 0);
        r.sky = { ...r.sky, night };
        store.set("ascii-koi-sky", { where, at: Date.now(), r });
        show(r);
      } catch (e) { /* offline: no weather, the pond still swims */ }
    }

    return {
      start() {
        if (off) return;
        if (PREVIEW[mode]) { const pv = PREVIEW[mode]; show({ sky: pv.sky, tempF: pv.temp, text: pv.text }, true); return; }
        const cached = store.get("ascii-koi-sky");
        if (cached && cached.r && Date.now() - cached.at < 3 * 36e5) show(cached.r);
        refresh();
        setInterval(() => refresh(true), 6e5);
      }
    };
  }

  (global.AsciiKoi = global.AsciiKoi || {}).createWeather = createWeather;
})(typeof window !== "undefined" ? window : globalThis);
