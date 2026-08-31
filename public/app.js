let svgRoot = null;
let state = { scores: {}, total: 0 };
let lastTapAt = 0;
let lastTikTokEventId = null;
const TAP_COOLDOWN_MS = 40;

function rankList() {
  return Object.keys(COUNTY_NAMES)
    .map((id) => ({ id, name: COUNTY_NAMES[id], score: Number(state.scores?.[id] || 0) }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "ro"));
}

function colorFor(score, max) {
  if (!max || !score) return "#edf4ff";
  const t = Math.min(1, score / max);
  const light = Math.round(93 - t * 35);
  const sat = Math.round(68 + t * 20);
  return `hsl(216 ${sat}% ${light}%)`;
}

function countyPaths() {
  if (!svgRoot) return [];
  return [...svgRoot.querySelectorAll("path[id]")].filter((path) => COUNTY_NAMES[path.id]);
}

function paintMap() {
  if (!svgRoot) return;
  const max = Math.max(0, ...Object.values(state.scores || {}).map(Number));
  countyPaths().forEach((path) => {
    const score = Number(state.scores?.[path.id] || 0);
    path.style.fill = colorFor(score, max);
    path.dataset.score = String(score);
  });
  const b = document.getElementById("bucharestScore");
  if (b) b.textContent = Number(state.scores?.["RO-B"] || 0).toLocaleString("ro-RO");
}

function renderSidebar() {
  const ranked = rankList();
  document.getElementById("totalTaps").textContent = Number(state.total || 0).toLocaleString("ro-RO");
  document.getElementById("liveCounties").textContent = ranked.filter((x) => x.score > 0).length;
  document.getElementById("list").innerHTML = ranked.map((item, i) => {
    const medal = i === 0 ? "gold" : i === 1 ? "silver" : i === 2 ? "bronze" : "";
    return `<div class="rank-row" data-id="${item.id}">
      <div class="rank-number ${medal}">${i + 1}</div>
      <div class="rank-county"><strong>${item.name}</strong><span>${item.id.replace("RO-", "")}</span></div>
      <div class="rank-score">${item.score.toLocaleString("ro-RO")}</div>
    </div>`;
  }).join("");
}


function showTikTokVote(tiktok) {
  const ev = tiktok?.last_event;
  if (!ev?.id || ev.id === lastTikTokEventId) return;
  lastTikTokEventId = ev.id;
  pulseCounty(ev.county);

  const path = svgRoot?.querySelector(`path[id="${CSS.escape(ev.county)}"]`);
  if (path) {
    const r = path.getBoundingClientRect();
    flagBurst(r.left + r.width / 2, r.top + r.height / 2);
  }

  const old = document.querySelector(".tiktok-vote-pop");
  old?.remove();
  const pop = document.createElement("div");
  pop.className = "tiktok-vote-pop";
  pop.innerHTML = `<span>🇷🇴 TikTok LIVE</span><strong>@${String(ev.user || ev.nickname || "user").replace(/[<>&]/g, "")}</strong><b>susține ${ev.code} +1</b>`;
  document.body.appendChild(pop);
  setTimeout(() => pop.classList.add("show"), 10);
  setTimeout(() => pop.classList.remove("show"), 1800);
  setTimeout(() => pop.remove(), 2200);
}

function applyState(next) {
  state = next || state;
  paintMap();
  renderSidebar();
  showTikTokVote(next?.tiktok);
}

function flagBurst(x, y) {
  const fx = document.createElement("div");
  fx.className = "mini-flag-burst";
  fx.style.left = `${x}px`;
  fx.style.top = `${y}px`;
  fx.innerHTML = `<div class="mini-flag"><span></span><span></span><span></span></div><i></i>`;
  document.getElementById("tapEffects").appendChild(fx);
  setTimeout(() => fx.remove(), 700);
}

function pulseCounty(id) {
  const path = svgRoot?.querySelector(`path[id="${CSS.escape(id)}"]`);
  if (!path) return;
  path.classList.remove("tap-pulse");
  void path.getBoundingClientRect();
  path.classList.add("tap-pulse");
  setTimeout(() => path.classList.remove("tap-pulse"), 360);
}

async function tapCounty(id, point) {
  if (!COUNTY_NAMES[id]) return;
  const now = performance.now();
  if (now - lastTapAt < TAP_COOLDOWN_MS) return;
  lastTapAt = now;

  if (point) flagBurst(point.x, point.y);
  pulseCounty(id);

  try {
    const res = await fetch("/api/tap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ county: id }),
    });
    const data = await res.json();
    if (!res.ok) return;
    applyState(data);
  } catch (err) {
    console.error("Eroare la tap:", err);
  }
}

function addCountyLabels() {
  if (!svgRoot) return;
  svgRoot.querySelector(".county-labels")?.remove();
  const NS = "http://www.w3.org/2000/svg";
  const group = document.createElementNS(NS, "g");
  group.setAttribute("class", "county-labels");
  group.setAttribute("aria-hidden", "true");

  countyPaths().forEach((path) => {
    const box = path.getBBox();
    const text = document.createElementNS(NS, "text");
    let x = box.x + box.width / 2;
    let y = box.y + box.height / 2;
    if (path.id === "RO-B") { x += 4; y += 5; }
    if (path.id === "RO-IF") { x -= 7; y -= 5; }
    const minSide = Math.min(box.width, box.height);
    const size = minSide < 14 ? 6.5 : minSide < 22 ? 7.6 : 9.5;
    text.setAttribute("x", x.toFixed(2));
    text.setAttribute("y", y.toFixed(2));
    text.setAttribute("font-size", String(size));
    text.setAttribute("class", "county-code");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "middle");
    text.textContent = path.id.replace("RO-", "");
    group.appendChild(text);
  });
  svgRoot.appendChild(group);
}

function wireCountyTaps() {
  countyPaths().forEach((path) => {
    path.setAttribute("tabindex", "0");
    path.setAttribute("role", "button");
    path.setAttribute("aria-label", `${COUNTY_NAMES[path.id]} - adaugă un tap`);
    path.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.preventDefault();
      tapCounty(path.id, { x: e.clientX, y: e.clientY });
    });
    path.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const r = path.getBoundingClientRect();
        tapCounty(path.id, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
      }
    });
  });
}

async function loadMap() {
  const res = await fetch("/romania.svg", { cache: "no-store" });
  if (!res.ok) throw new Error(`Nu pot încărca harta (${res.status})`);
  document.getElementById("map").innerHTML = await res.text();
  svgRoot = document.querySelector("#map svg");
  if (!svgRoot) throw new Error("SVG invalid");
  svgRoot.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svgRoot.removeAttribute("width");
  svgRoot.removeAttribute("height");
  svgRoot.setAttribute("role", "img");
  svgRoot.setAttribute("aria-label", "Harta județelor României");
  wireCountyTaps();
  addCountyLabels();
}

function connectStream() {
  const es = new EventSource("/api/stream");
  es.onmessage = (ev) => {
    try { applyState(JSON.parse(ev.data)); } catch (_) {}
  };
  es.onerror = () => {
    es.close();
    setTimeout(connectStream, 2000);
  };
}

function showWelcome() {
  const w = document.getElementById("welcome");
  requestAnimationFrame(() => w.classList.add("show"));
  setTimeout(() => w.classList.add("leave"), 1900);
  setTimeout(() => w.remove(), 2550);
}

async function boot() {
  showWelcome();
  const b = document.getElementById("bucharestTap");
  b.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    const r = b.getBoundingClientRect();
    tapCounty("RO-B", { x: r.left + r.width / 2, y: r.top + r.height / 2 });
  });

  try {
    await loadMap();
    applyState(await fetch("/api/state", { cache: "no-store" }).then((r) => r.json()));
    connectStream();
  } catch (err) {
    console.error(err);
    document.getElementById("map").innerHTML = `<div class="map-error">Harta nu s-a putut încărca.</div>`;
  }
}

boot();
