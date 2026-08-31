#!/usr/bin/env python3
"""Tap Tap România — public map + admin + live SSE."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import queue
import secrets
import threading
import time
import re
from collections import deque
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(ROOT, "public")
DATA_FILE = os.path.join(ROOT, "data.json")
PORT = int(os.environ.get("PORT", "8080"))
ADMIN_USER = os.environ.get("ADMIN_USER", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin123")
SECRET = os.environ.get("SECRET_KEY", "schimba-cheia-in-productie")
COOKIE_NAME = "ttr_session"
SESSION_TTL = 60 * 60 * 24 * 7
TAP_COOLDOWN_SECONDS = 0.040

# TikTok LIVE integration
TIKTOK_USERNAME = os.environ.get("TIKTOK_USERNAME", "").strip()
TIKTOK_AUTOSTART = os.environ.get("TIKTOK_AUTOSTART", "true").lower() in {"1", "true", "yes", "on"}
TIKTOK_USER_COOLDOWN = float(os.environ.get("TIKTOK_USER_COOLDOWN", "1.0"))
TIKTOK_ENABLED = bool(TIKTOK_USERNAME) and TIKTOK_AUTOSTART

COUNTY_IDS = {
    "RO-AB", "RO-AR", "RO-AG", "RO-BC", "RO-BH", "RO-BN", "RO-BT", "RO-BV",
    "RO-BR", "RO-B", "RO-BZ", "RO-CL", "RO-CS", "RO-CJ", "RO-CT", "RO-CV",
    "RO-DB", "RO-DJ", "RO-GL", "RO-GR", "RO-GJ", "RO-HR", "RO-HD", "RO-IL",
    "RO-IS", "RO-IF", "RO-MM", "RO-MH", "RO-MS", "RO-NT", "RO-OT", "RO-PH",
    "RO-SM", "RO-SJ", "RO-SB", "RO-SV", "RO-TR", "RO-TM", "RO-TL", "RO-VL",
    "RO-VS", "RO-VN",
}
OLD_TO_NEW = {k.lower(): k for k in COUNTY_IDS}
OLD_TO_NEW["ro-bi"] = "RO-B"

COUNTY_CODE_TO_ID = {cid.replace("RO-", ""): cid for cid in COUNTY_IDS}
COUNTY_CODE_TO_ID["B"] = "RO-B"

tiktok_lock = threading.Lock()
tiktok_recent = deque(maxlen=30)
tiktok_user_last: dict[str, float] = {}
tiktok_status = {
    "configured": bool(TIKTOK_USERNAME),
    "enabled": TIKTOK_ENABLED,
    "connected": False,
    "username": TIKTOK_USERNAME,
    "message": "Neconfigurat" if not TIKTOK_USERNAME else "Se conectează..." if TIKTOK_ENABLED else "Oprit din admin",
    "last_event": None,
}

state_lock = threading.Lock()
subscribers_lock = threading.Lock()
subscribers: list[queue.Queue] = []
last_tap_by_ip: dict[str, float] = {}
last_tap_lock = threading.Lock()


def empty_state() -> dict:
    return {"scores": {cid: 0 for cid in COUNTY_IDS}, "total": 0, "updated": int(time.time())}


def load_state() -> dict:
    if not os.path.exists(DATA_FILE):
        return empty_state()
    try:
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        raw = data.get("scores", {})
        scores = {cid: 0 for cid in COUNTY_IDS}
        for key, val in raw.items():
            dest = key if key in COUNTY_IDS else OLD_TO_NEW.get(str(key).lower())
            if dest:
                scores[dest] += max(0, int(val))
        return {"scores": scores, "total": sum(scores.values()), "updated": int(time.time())}
    except Exception:
        return empty_state()


state = load_state()


def save_state() -> None:
    tmp = DATA_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False)
    os.replace(tmp, DATA_FILE)


def tiktok_snapshot() -> dict:
    with tiktok_lock:
        data = dict(tiktok_status)
        data["recent"] = list(tiktok_recent)
        return data

def snapshot() -> dict:
    with state_lock:
        current = {
            "scores": dict(state["scores"]),
            "total": int(state["total"]),
            "updated": int(state["updated"]),
        }
    current["tiktok"] = tiktok_snapshot()
    return current


def publish(payload: dict | None = None) -> None:
    if payload is None:
        payload = snapshot()
    encoded = json.dumps(payload, ensure_ascii=False)
    dead = []
    with subscribers_lock:
        current = list(subscribers)
    for q in current:
        try:
            q.put_nowait(encoded)
        except Exception:
            dead.append(q)
    if dead:
        with subscribers_lock:
            for q in dead:
                if q in subscribers:
                    subscribers.remove(q)


def add_points(county: str, points: int) -> dict:
    if county not in COUNTY_IDS:
        raise ValueError("Județ invalid")
    with state_lock:
        state["scores"][county] = max(0, int(state["scores"].get(county, 0)) + int(points))
        state["total"] = sum(state["scores"].values())
        state["updated"] = int(time.time())
        save_state()
        current = {
            "scores": dict(state["scores"]),
            "total": int(state["total"]),
            "updated": int(state["updated"]),
        }
    current["tiktok"] = tiktok_snapshot()
    publish(current)
    return current


def reset_state() -> dict:
    global state
    with state_lock:
        state = empty_state()
        save_state()
        current = {
            "scores": dict(state["scores"]),
            "total": 0,
            "updated": int(state["updated"]),
        }
        current["tiktok"] = tiktok_snapshot()
    with last_tap_lock:
        last_tap_by_ip.clear()
    publish(current)
    return current



def normalize_tiktok_comment(text: str) -> str | None:
    """Accept only an exact county abbreviation, e.g. CJ, BV, B."""
    code = re.sub(r"[^A-Za-z]", "", str(text or "")).upper()
    original = str(text or "").strip()
    if not original or len(original) > 8:
        return None
    if code != re.sub(r"\s+", "", original).upper():
        return None
    return COUNTY_CODE_TO_ID.get(code)

def record_tiktok_event(user: str, nickname: str, comment: str, county: str) -> None:
    event = {
        "id": f"{int(time.time() * 1000)}-{secrets.token_hex(3)}",
        "user": user,
        "nickname": nickname,
        "comment": comment,
        "county": county,
        "code": county.replace("RO-", ""),
        "ts": int(time.time()),
    }
    with tiktok_lock:
        tiktok_recent.appendleft(event)
        tiktok_status["last_event"] = event

def handle_tiktok_comment(user: str, nickname: str, comment: str) -> bool:
    with tiktok_lock:
        enabled = bool(tiktok_status["enabled"])
    if not enabled:
        return False

    county = normalize_tiktok_comment(comment)
    if not county:
        return False

    user_key = (user or nickname or "anon").lower()
    now = time.monotonic()
    with tiktok_lock:
        last = tiktok_user_last.get(user_key, 0.0)
        if now - last < TIKTOK_USER_COOLDOWN:
            return False
        tiktok_user_last[user_key] = now

    record_tiktok_event(user, nickname, comment, county)
    add_points(county, 1)
    return True

def set_tiktok_enabled(enabled: bool) -> dict:
    with tiktok_lock:
        if not tiktok_status["configured"]:
            tiktok_status["enabled"] = False
            tiktok_status["message"] = "Adaugă TIKTOK_USERNAME în Render."
        else:
            tiktok_status["enabled"] = bool(enabled)
            if enabled:
                tiktok_status["message"] = "Activ — așteaptă comentarii"
            else:
                tiktok_status["message"] = "Oprit din admin"
    publish()
    return snapshot()

def run_tiktok_client() -> None:
    if not TIKTOK_USERNAME:
        return
    try:
        from TikTokLive import TikTokLiveClient
        from TikTokLive.events import ConnectEvent, DisconnectEvent, CommentEvent
    except Exception as exc:
        with tiktok_lock:
            tiktok_status["connected"] = False
            tiktok_status["message"] = f"TikTokLive indisponibil: {exc}"
        publish()
        return

    while True:
        try:
            client = TikTokLiveClient(unique_id=TIKTOK_USERNAME)

            @client.on(ConnectEvent)
            async def _on_connect(event):
                with tiktok_lock:
                    tiktok_status["connected"] = True
                    tiktok_status["message"] = "Conectat la TikTok LIVE"
                publish()

            @client.on(DisconnectEvent)
            async def _on_disconnect(event):
                with tiktok_lock:
                    tiktok_status["connected"] = False
                    tiktok_status["message"] = "Deconectat — reconectare automată..."
                publish()

            @client.on(CommentEvent)
            async def _on_comment(event):
                try:
                    user_obj = getattr(event, "user", None)
                    unique_id = str(getattr(user_obj, "unique_id", "") or "")
                    nickname = str(getattr(user_obj, "nickname", "") or unique_id)
                    comment = str(getattr(event, "comment", "") or "")
                    handle_tiktok_comment(unique_id, nickname, comment)
                except Exception as exc:
                    print(f"[TikTok] Eroare comentariu: {exc}", flush=True)

            with tiktok_lock:
                tiktok_status["message"] = "Conectare la TikTok LIVE..."
            publish()
            client.run()
        except Exception as exc:
            with tiktok_lock:
                tiktok_status["connected"] = False
                tiktok_status["message"] = f"Reconectare: {type(exc).__name__}"
            publish()
            print(f"[TikTok] {exc}", flush=True)
            time.sleep(5)

def start_tiktok_thread() -> None:
    if not TIKTOK_USERNAME:
        print("[TikTok] TIKTOK_USERNAME nu este setat.", flush=True)
        return
    thread = threading.Thread(target=run_tiktok_client, name="tiktok-live", daemon=True)
    thread.start()

def sign(payload: str) -> str:
    return hmac.new(SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()


def make_session() -> str:
    exp = str(int(time.time()) + SESSION_TTL)
    nonce = secrets.token_hex(8)
    raw = f"{ADMIN_USER}|{exp}|{nonce}"
    return f"{raw}|{sign(raw)}"


def valid_session(value: str | None) -> bool:
    if not value:
        return False
    parts = value.split("|")
    if len(parts) != 4:
        return False
    user, exp, nonce, sig = parts
    raw = f"{user}|{exp}|{nonce}"
    if not hmac.compare_digest(sig, sign(raw)):
        return False
    try:
        if int(exp) < time.time():
            return False
    except ValueError:
        return False
    return user == ADMIN_USER


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC, **kwargs)

    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.log_date_time_string(), fmt % args), flush=True)

    def cookie_value(self) -> str | None:
        raw = self.headers.get("Cookie", "")
        if not raw:
            return None
        jar = SimpleCookie()
        try:
            jar.load(raw)
        except Exception:
            return None
        morsel = jar.get(COOKIE_NAME)
        return morsel.value if morsel else None

    def is_admin(self) -> bool:
        return valid_session(self.cookie_value())

    def set_session_cookie(self, value: str | None, max_age: int):
        flags = f"{COOKIE_NAME}={value or ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}"
        if os.environ.get("COOKIE_SECURE", "").lower() in {"1", "true", "yes"}:
            flags += "; Secure"
        self.send_header("Set-Cookie", flags)

    def _json(self, code: int, payload: dict, cookie: tuple[str | None, int] | None = None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if cookie:
            self.set_session_cookie(*cookie)
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            return {}

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            self._json(200, {"ok": True})
            return
        if path == "/admin":
            self.path = "/admin.html"
            return super().do_GET()
        if path == "/api/state":
            self._json(200, snapshot())
            return
        if path == "/api/admin/me":
            self._json(200, {"ok": True, "user": ADMIN_USER}) if self.is_admin() else self._json(401, {"ok": False})
            return
        if path == "/api/admin/tiktok":
            if not self.is_admin():
                self._json(401, {"error": "Trebuie să fii autentificat."})
                return
            self._json(200, tiktok_snapshot())
            return
        if path == "/api/stream":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            q: queue.Queue = queue.Queue(maxsize=50)
            with subscribers_lock:
                subscribers.append(q)
            try:
                first = json.dumps(snapshot(), ensure_ascii=False)
                self.wfile.write(f"data: {first}\n\n".encode("utf-8"))
                self.wfile.flush()
                while True:
                    try:
                        payload = q.get(timeout=20)
                        self.wfile.write(f"data: {payload}\n\n".encode("utf-8"))
                    except queue.Empty:
                        self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                with subscribers_lock:
                    if q in subscribers:
                        subscribers.remove(q)
            return
        super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        body = self._read_json()

        if path == "/api/tap":
            county = str(body.get("county", ""))
            ip = self.client_address[0]
            now = time.monotonic()
            with last_tap_lock:
                last = last_tap_by_ip.get(ip, 0.0)
                if now - last < TAP_COOLDOWN_SECONDS:
                    self._json(429, {"error": "Prea rapid."})
                    return
                last_tap_by_ip[ip] = now
            try:
                self._json(200, add_points(county, 1))
            except ValueError as e:
                self._json(400, {"error": str(e)})
            return

        if path == "/api/admin/login":
            user = str(body.get("username", ""))
            password = str(body.get("password", ""))
            if secrets.compare_digest(user, ADMIN_USER) and secrets.compare_digest(password, ADMIN_PASSWORD):
                self._json(200, {"ok": True}, cookie=(make_session(), SESSION_TTL))
                return
            time.sleep(0.3)
            self._json(401, {"error": "Utilizator sau parolă greșită."})
            return

        if path == "/api/admin/logout":
            self._json(200, {"ok": True}, cookie=("", 0))
            return

        if path == "/api/admin/add":
            if not self.is_admin():
                self._json(401, {"error": "Trebuie să fii autentificat."})
                return
            county = str(body.get("county", ""))
            try:
                points = int(body.get("points", 0))
            except (TypeError, ValueError):
                self._json(400, {"error": "Puncte invalide."})
                return
            if abs(points) > 1_000_000:
                self._json(400, {"error": "Valoare prea mare."})
                return
            try:
                self._json(200, add_points(county, points))
            except ValueError as e:
                self._json(400, {"error": str(e)})
            return

        if path == "/api/admin/reset":
            if not self.is_admin():
                self._json(401, {"error": "Trebuie să fii autentificat."})
                return
            self._json(200, reset_state())
            return
        if path == "/api/admin/tiktok/toggle":
            if not self.is_admin():
                self._json(401, {"error": "Trebuie să fii autentificat."})
                return
            enabled = bool(body.get("enabled"))
            self._json(200, set_tiktok_enabled(enabled))
            return

        self._json(404, {"error": "Not found"})


def main():
    start_tiktok_thread()
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Tap Tap România pe http://0.0.0.0:{PORT}", flush=True)
    print(f"Public: /   Admin: /admin   user={ADMIN_USER}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
