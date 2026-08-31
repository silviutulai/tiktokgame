let adminState = { scores: {}, total: 0 };
let adminSvg = null;

function toast(msg, type = "ok") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.dataset.type = type;
  el.classList.add("show");
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function rankList(state) {
  return Object.keys(COUNTY_NAMES)
    .map((id) => ({ id, name: COUNTY_NAMES[id], score: Number(state.scores?.[id] || 0) }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "ro"));
}

function colorFor(score, max) {
  if (!max || !score) return "#edf4ff";
  const t = Math.min(1, score / max);
  return `hsl(216 ${Math.round(68 + t * 20)}% ${Math.round(93 - t * 35)}%)`;
}


function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}
function renderTikTok(tiktok = {}) {
  const badge = document.getElementById("tiktokBadge");
  if (!badge) return;
  const configured = !!tiktok.configured;
  const enabled = !!tiktok.enabled;
  const connected = !!tiktok.connected;

  badge.className = `tiktok-badge ${connected ? "online" : enabled ? "waiting" : "offline"}`;
  badge.textContent = connected ? "LIVE" : enabled ? "WAIT" : "OFF";
  document.getElementById("tiktokUsername").textContent = tiktok.username || "neconfigurat";
  document.getElementById("tiktokConnection").textContent = tiktok.message || (configured ? "—" : "Lipsește TIKTOK_USERNAME");

  const btn = document.getElementById("tiktokToggle");
  btn.textContent = enabled ? "Oprește voturile TikTok" : "Pornește voturile TikTok";
  btn.dataset.enabled = enabled ? "1" : "0";
  btn.disabled = !configured;

  const recent = Array.isArray(tiktok.recent) ? tiktok.recent : [];
  document.getElementById("tiktokFeed").innerHTML = recent.length ? recent.map((ev) => `
    <div class="tiktok-feed-row">
      <div><strong>@${escapeHtml(ev.user || ev.nickname || "user")}</strong><span>${escapeHtml(ev.nickname || "")}</span></div>
      <b>${escapeHtml(ev.code || "")} +1</b>
    </div>`).join("") : `<div class="tiktok-empty">Încă nu există comentarii acceptate.</div>`;
}

function renderAdmin(state) {
  adminState = state;
  const ranked = rankList(state);
  document.getElementById("totalTaps").textContent = Number(state.total || 0).toLocaleString("ro-RO");
  document.getElementById("liveCounties").textContent = ranked.filter((x) => x.score > 0).length;
  document.getElementById("adminBucharestScore").textContent = Number(state.scores?.["RO-B"] || 0).toLocaleString("ro-RO");
  document.getElementById("list").innerHTML = ranked.map((item, i) => {
    const medal = i === 0 ? "gold" : i === 1 ? "silver" : i === 2 ? "bronze" : "";
    return `<div class="rank-row" data-id="${item.id}"><div class="rank-number ${medal}">${i + 1}</div><div class="rank-county"><strong>${item.name}</strong><span>${item.id.replace("RO-", "")}</span></div><div class="rank-score">${item.score.toLocaleString("ro-RO")}</div></div>`;
  }).join("");
  document.querySelectorAll("#list .rank-row").forEach((row) => row.addEventListener("click", () => selectCounty(row.dataset.id)));
  paintAdminMap();
  renderTikTok(state.tiktok || {});
}

function paintAdminMap() {
  if (!adminSvg) return;
  const max = Math.max(0, ...Object.values(adminState.scores || {}).map(Number));
  adminSvg.querySelectorAll("path[id]").forEach((path) => {
    if (!COUNTY_NAMES[path.id]) return;
    path.style.fill = colorFor(Number(adminState.scores?.[path.id] || 0), max);
    path.classList.toggle("admin-selected", document.getElementById("adminCounty")?.value === path.id);
  });
}

function selectCounty(id) {
  const select = document.getElementById("adminCounty");
  if (!COUNTY_NAMES[id] || !select) return;
  select.value = id;
  paintAdminMap();
}

function addLabels() {
  const NS = "http://www.w3.org/2000/svg";
  const group = document.createElementNS(NS, "g");
  group.setAttribute("class", "county-labels");
  adminSvg.querySelectorAll("path[id]").forEach((path) => {
    if (!COUNTY_NAMES[path.id]) return;
    const box = path.getBBox();
    let x = box.x + box.width / 2, y = box.y + box.height / 2;
    if (path.id === "RO-B") { x += 4; y += 5; }
    if (path.id === "RO-IF") { x -= 7; y -= 5; }
    const minSide = Math.min(box.width, box.height);
    const text = document.createElementNS(NS, "text");
    text.setAttribute("x", x.toFixed(2)); text.setAttribute("y", y.toFixed(2));
    text.setAttribute("font-size", String(minSide < 14 ? 6.5 : minSide < 22 ? 7.6 : 9.5));
    text.setAttribute("class", "county-code"); text.setAttribute("text-anchor", "middle"); text.setAttribute("dominant-baseline", "middle");
    text.textContent = path.id.replace("RO-", ""); group.appendChild(text);
  });
  adminSvg.appendChild(group);
}

async function loadAdminMap() {
  const res = await fetch("/romania.svg", { cache: "no-store" });
  document.getElementById("adminMap").innerHTML = await res.text();
  adminSvg = document.querySelector("#adminMap svg");
  if (!adminSvg) return;
  adminSvg.removeAttribute("width"); adminSvg.removeAttribute("height");
  adminSvg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  adminSvg.querySelectorAll("path[id]").forEach((path) => {
    if (!COUNTY_NAMES[path.id]) return;
    path.addEventListener("click", () => selectCounty(path.id));
  });
  addLabels();
  paintAdminMap();
}

function showAdmin() { document.getElementById("loginCard").hidden = true; document.getElementById("adminApp").hidden = false; }
function showLogin() { document.getElementById("loginCard").hidden = false; document.getElementById("adminApp").hidden = true; }

async function me() { return (await fetch("/api/admin/me", { credentials: "same-origin" })).ok; }

async function login() {
  const res = await fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ username: document.getElementById("user").value.trim(), password: document.getElementById("pass").value }) });
  const data = await res.json();
  if (!res.ok) return toast(data.error || "Login eșuat", "bad");
  showAdmin();
  if (!adminSvg) await loadAdminMap();
  toast("Autentificare reușită.");
}

async function logout() { await fetch("/api/admin/logout", { method: "POST", credentials: "same-origin" }); showLogin(); }

async function addPoints(points) {
  const county = document.getElementById("adminCounty").value;
  const res = await fetch("/api/admin/add", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ county, points }) });
  const data = await res.json();
  if (res.status === 401) { showLogin(); return toast("Sesiunea a expirat.", "bad"); }
  if (!res.ok) return toast(data.error || "Operațiunea a eșuat.", "bad");
  renderAdmin(data); toast("Scor actualizat.");
}

async function resetAll() {
  const btn = document.getElementById("confirmReset");
  btn.disabled = true;
  const res = await fetch("/api/admin/reset", { method: "POST", credentials: "same-origin" });
  const data = await res.json();
  btn.disabled = false;
  document.getElementById("resetModal").hidden = true;
  if (res.status === 401) { showLogin(); return toast("Sesiunea a expirat.", "bad"); }
  if (!res.ok) return toast(data.error || "Resetarea a eșuat.", "bad");
  renderAdmin(data); toast("Jocul a fost resetat la 0.");
}


async function toggleTikTok() {
  const btn = document.getElementById("tiktokToggle");
  const next = btn.dataset.enabled !== "1";
  btn.disabled = true;
  const res = await fetch("/api/admin/tiktok/toggle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ enabled: next }),
  });
  const data = await res.json();
  if (res.status === 401) { showLogin(); return toast("Sesiunea a expirat.", "bad"); }
  if (!res.ok) { btn.disabled = false; return toast(data.error || "Nu pot schimba TikTok.", "bad"); }
  renderAdmin(data);
  toast(next ? "Voturile TikTok sunt active." : "Voturile TikTok sunt oprite.");
}

function connectStream() {
  const es = new EventSource("/api/stream");
  es.onmessage = (ev) => { try { renderAdmin(JSON.parse(ev.data)); } catch (_) {} };
  es.onerror = () => { es.close(); setTimeout(connectStream, 2000); };
}

async function boot() {
  const select = document.getElementById("adminCounty");
  select.innerHTML = Object.entries(COUNTY_NAMES).sort((a,b) => a[1].localeCompare(b[1], "ro")).map(([id,name]) => `<option value="${id}">${name} (${id.replace("RO-", "")})</option>`).join("");
  select.addEventListener("change", paintAdminMap);
  document.getElementById("loginBtn").addEventListener("click", login);
  document.getElementById("pass").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
  document.getElementById("logoutBtn").addEventListener("click", logout);
  document.getElementById("addPoints").addEventListener("click", () => addPoints(Number(document.getElementById("adminPoints").value || 0)));
  document.querySelectorAll(".quick-grid button").forEach((btn) => btn.addEventListener("click", () => addPoints(Number(btn.dataset.pts))));
  document.getElementById("adminBucharest").addEventListener("click", () => selectCounty("RO-B"));
  document.getElementById("tiktokToggle").addEventListener("click", toggleTikTok);
  document.getElementById("resetBtn").addEventListener("click", () => document.getElementById("resetModal").hidden = false);
  document.getElementById("cancelReset").addEventListener("click", () => document.getElementById("resetModal").hidden = true);
  document.getElementById("confirmReset").addEventListener("click", resetAll);
  document.getElementById("resetModal").addEventListener("click", (e) => { if (e.target.id === "resetModal") e.currentTarget.hidden = true; });

  const initial = await fetch("/api/state", { cache: "no-store" }).then((r) => r.json());
  renderAdmin(initial);
  if (await me()) { showAdmin(); await loadAdminMap(); }
  connectStream();
}

boot();
