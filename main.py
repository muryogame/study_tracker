from fastapi import FastAPI, HTTPException, Depends
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy import create_engine, text
from sqlalchemy.pool import StaticPool
from contextlib import contextmanager
from datetime import datetime
from pydantic import BaseModel
from typing import Optional
import hashlib
import os
import threading
import time
import urllib.request

app = FastAPI(title="学録")


# ── Keep-alive（Renderのスリープ防止） ────────────────────────
def _keepalive_worker():
    base_url = os.environ.get("RENDER_EXTERNAL_URL", "").rstrip("/")
    if not base_url:
        return
    ping_url = f"{base_url}/api/ping"
    time.sleep(30)
    while True:
        try:
            urllib.request.urlopen(ping_url, timeout=15)
        except Exception:
            pass
        time.sleep(300)

@app.on_event("startup")
async def start_keepalive():
    threading.Thread(target=_keepalive_worker, daemon=True).start()

@app.get("/api/ping")
def ping():
    with get_db() as conn:
        conn.execute(text("SELECT 1"))
    return JSONResponse({"ok": True}, headers={"Cache-Control": "no-store, no-cache"})

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

# ── Database ──────────────────────────────────────────────────
_db_url = os.environ.get("DATABASE_URL", "")
if _db_url.startswith("postgres://"):
    _db_url = _db_url.replace("postgres://", "postgresql://", 1)
if _db_url and "sslmode" not in _db_url:
    sep = "&" if "?" in _db_url else "?"
    _db_url = f"{_db_url}{sep}sslmode=require"

IS_PG = bool(_db_url)

if IS_PG:
    engine = create_engine(_db_url, pool_pre_ping=True)
else:
    _sqlite_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "study.db")
    engine = create_engine(
        f"sqlite:///{_sqlite_path}",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )


@contextmanager
def get_db():
    conn = engine.connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# ── SQL 方言ヘルパー ──────────────────────────────────────────
if IS_PG:
    def _ym(col):   return f"to_char({col}::timestamp, 'YYYY-MM')"
    def _date(col): return f"({col}::timestamp AT TIME ZONE 'Asia/Tokyo')::date"
    def _dow(col):  return f"EXTRACT(DOW FROM {col}::timestamp)::integer"
    def _yr(col):   return f"to_char({col}::timestamp, 'YYYY')"
    def _mo(col):   return f"to_char({col}::timestamp, 'MM')"
    NOW_YM   = "to_char(NOW() AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM')"
    TODAY    = "(NOW() AT TIME ZONE 'Asia/Tokyo')::date"
    WEEK_AGO = "(NOW() AT TIME ZONE 'Asia/Tokyo')::date - INTERVAL '7 days'"
    D30_AGO  = "(NOW() AT TIME ZONE 'Asia/Tokyo')::date - INTERVAL '30 days'"
    SERIAL   = "SERIAL PRIMARY KEY"
else:
    def _ym(col):   return f"strftime('%Y-%m', {col})"
    def _date(col): return f"date({col}, 'localtime')"
    def _dow(col):  return f"CAST(strftime('%w', {col}) AS INTEGER)"
    def _yr(col):   return f"strftime('%Y', {col})"
    def _mo(col):   return f"strftime('%m', {col})"
    NOW_YM   = "strftime('%Y-%m', 'now', 'localtime')"
    TODAY    = "date('now', 'localtime')"
    WEEK_AGO = "date('now', 'localtime', '-7 days')"
    D30_AGO  = "date('now', 'localtime', '-30 days')"
    SERIAL   = "INTEGER PRIMARY KEY AUTOINCREMENT"


def init_db():
    with get_db() as conn:
        conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS sessions (
                id               {SERIAL},
                user_id          INTEGER,
                start_time       TEXT NOT NULL,
                end_time         TEXT,
                duration_minutes REAL
            )
        """))
        conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS todos (
                id           {SERIAL},
                user_id      INTEGER,
                title        TEXT NOT NULL,
                target_hours REAL DEFAULT 1.0,
                done_hours   REAL DEFAULT 0.0,
                completed    INTEGER DEFAULT 0,
                created_at   TEXT NOT NULL
            )
        """))

init_db()


# ── デバイストークン認証（ログイン不要） ──────────────────────
# ブラウザが自動生成したUUIDをBearer tokenとして受け取り、
# SHA-256ハッシュからuser_idを導出する。デバイスごとに独立した記録を保持。

_bearer = HTTPBearer(auto_error=False)

def get_user_id(
    creds: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> int:
    if not creds or len(creds.credentials) < 16:
        return 0
    h = hashlib.sha256(creds.credentials.encode()).digest()
    return (int.from_bytes(h[:8], "big") % (2**31 - 1)) + 1


# ── API ───────────────────────────────────────────────────────
@app.get("/api/active")
def get_active(uid: int = Depends(get_user_id)):
    with get_db() as conn:
        row = conn.execute(text(
            "SELECT * FROM sessions WHERE end_time IS NULL AND user_id=:u ORDER BY start_time DESC LIMIT 1"
        ), {"u": uid}).mappings().fetchone()
    return {"active": bool(row), "session": dict(row) if row else None}


@app.post("/api/start")
def start_session(uid: int = Depends(get_user_id)):
    with get_db() as conn:
        if conn.execute(text(
            "SELECT id FROM sessions WHERE end_time IS NULL AND user_id=:u"
        ), {"u": uid}).fetchone():
            raise HTTPException(400, "既にセッションが進行中です")
        now = datetime.now().isoformat()
        if IS_PG:
            row = conn.execute(
                text("INSERT INTO sessions (user_id, start_time) VALUES (:u,:t) RETURNING id"),
                {"u": uid, "t": now},
            ).fetchone()
            sid = row[0]
        else:
            result = conn.execute(
                text("INSERT INTO sessions (user_id, start_time) VALUES (:u,:t)"),
                {"u": uid, "t": now},
            )
            sid = result.lastrowid
    return {"session_id": sid, "start_time": now}


@app.post("/api/stop")
def stop_session(uid: int = Depends(get_user_id)):
    with get_db() as conn:
        active = conn.execute(text(
            "SELECT * FROM sessions WHERE end_time IS NULL AND user_id=:u ORDER BY start_time DESC LIMIT 1"
        ), {"u": uid}).mappings().fetchone()
        if not active:
            raise HTTPException(400, "進行中のセッションがありません")
        now      = datetime.now()
        duration = (now - datetime.fromisoformat(active["start_time"])).total_seconds() / 60
        conn.execute(text(
            "UPDATE sessions SET end_time=:e, duration_minutes=:d WHERE id=:id AND user_id=:u"
        ), {"e": now.isoformat(), "d": round(duration, 2), "id": active["id"], "u": uid})
    return {"session_id": active["id"], "end_time": now.isoformat(), "duration_minutes": round(duration, 2)}


@app.get("/api/calendar/{year}/{month}")
def get_calendar(year: int, month: int, uid: int = Depends(get_user_id)):
    with get_db() as conn:
        rows = conn.execute(text(f"""
            SELECT {_date('start_time')} AS day,
                   COALESCE(SUM(duration_minutes), 0) AS total_minutes,
                   COUNT(*) AS session_count
            FROM sessions
            WHERE {_yr('start_time')} = :y
              AND {_mo('start_time')} = :m
              AND end_time IS NOT NULL
              AND user_id = :u
            GROUP BY {_date('start_time')}
        """), {"y": str(year), "m": f"{month:02d}", "u": uid}).mappings().fetchall()
    return [dict(r) for r in rows]


@app.get("/api/stats")
def get_stats(uid: int = Depends(get_user_id)):
    with get_db() as conn:
        monthly = conn.execute(text(f"""
            SELECT COALESCE(SUM(duration_minutes), 0) AS t FROM sessions
            WHERE {_ym('start_time')} = {NOW_YM} AND end_time IS NOT NULL AND user_id=:u
        """), {"u": uid}).fetchone()

        weekly = conn.execute(text(f"""
            SELECT COALESCE(SUM(duration_minutes), 0) AS t FROM sessions
            WHERE {_date('start_time')} >= {WEEK_AGO} AND end_time IS NOT NULL AND user_id=:u
        """), {"u": uid}).fetchone()

        today = conn.execute(text(f"""
            SELECT COALESCE(SUM(duration_minutes), 0) AS t, COUNT(*) AS c FROM sessions
            WHERE {_date('start_time')} = {TODAY} AND end_time IS NOT NULL AND user_id=:u
        """), {"u": uid}).fetchone()

        by_dow = conn.execute(text(f"""
            SELECT {_dow('start_time')} AS dow,
                   COALESCE(SUM(duration_minutes), 0) AS total_minutes,
                   COUNT(DISTINCT {_date('start_time')}) AS days
            FROM sessions WHERE end_time IS NOT NULL AND user_id=:u
            GROUP BY {_dow('start_time')}
            ORDER BY {_dow('start_time')}
        """), {"u": uid}).mappings().fetchall()

        streak = conn.execute(text(f"""
            SELECT COUNT(DISTINCT {_date('start_time')}) AS d FROM sessions
            WHERE {_date('start_time')} >= {D30_AGO} AND end_time IS NOT NULL AND user_id=:u
        """), {"u": uid}).fetchone()

    return {
        "monthly_minutes": round(monthly[0], 1),
        "weekly_minutes":  round(weekly[0],  1),
        "today_minutes":   round(today[0],   1),
        "today_sessions":  today[1],
        "by_day_of_week":  [dict(r) for r in by_dow],
        "active_days_30":  streak[0],
    }


@app.get("/api/history")
def get_history(limit: int = 20, offset: int = 0, uid: int = Depends(get_user_id)):
    with get_db() as conn:
        rows = conn.execute(text(
            "SELECT id, start_time, end_time, duration_minutes FROM sessions "
            "WHERE end_time IS NOT NULL AND user_id=:u ORDER BY start_time DESC LIMIT :l OFFSET :o"
        ), {"u": uid, "l": limit, "o": offset}).mappings().fetchall()
        total = conn.execute(text(
            "SELECT COUNT(*) FROM sessions WHERE end_time IS NOT NULL AND user_id=:u"
        ), {"u": uid}).fetchone()[0]
    return {"sessions": [dict(r) for r in rows], "total": total}


@app.delete("/api/sessions/{session_id}")
def delete_session(session_id: int, uid: int = Depends(get_user_id)):
    with get_db() as conn:
        conn.execute(text(
            "DELETE FROM sessions WHERE id=:id AND user_id=:u"
        ), {"id": session_id, "u": uid})
    return {"ok": True}


@app.get("/api/total-hours")
def get_total_hours(uid: int = Depends(get_user_id)):
    with get_db() as conn:
        result = conn.execute(text(
            "SELECT COALESCE(SUM(duration_minutes), 0) / 60.0 AS h FROM sessions "
            "WHERE end_time IS NOT NULL AND user_id=:u"
        ), {"u": uid}).fetchone()
    return {"total_hours": round(result[0], 1)}


# ── ToDo API ──────────────────────────────────────────────────
class TodoBody(BaseModel):
    title: str
    target_hours: float = 1.0

class TodoUpdateBody(BaseModel):
    done_hours: Optional[float] = None
    completed: Optional[bool] = None


@app.get("/api/todos")
def get_todos(uid: int = Depends(get_user_id)):
    with get_db() as conn:
        rows = conn.execute(text(
            "SELECT id, title, target_hours, done_hours, completed, created_at FROM todos "
            "WHERE user_id=:u ORDER BY completed ASC, created_at DESC"
        ), {"u": uid}).mappings().fetchall()
    return [dict(r) for r in rows]


@app.post("/api/todos")
def create_todo(body: TodoBody, uid: int = Depends(get_user_id)):
    with get_db() as conn:
        now = datetime.now().isoformat()
        if IS_PG:
            row = conn.execute(text(
                "INSERT INTO todos (user_id, title, target_hours, done_hours, completed, created_at) "
                "VALUES (:u,:t,:th,0,false,:n) RETURNING id"
            ), {"u": uid, "t": body.title, "th": body.target_hours, "n": now}).fetchone()
            tid = row[0]
        else:
            result = conn.execute(text(
                "INSERT INTO todos (user_id, title, target_hours, done_hours, completed, created_at) "
                "VALUES (:u,:t,:th,0,0,:n)"
            ), {"u": uid, "t": body.title, "th": body.target_hours, "n": now})
            tid = result.lastrowid
    return {"id": tid, "title": body.title, "target_hours": body.target_hours,
            "done_hours": 0, "completed": False}


@app.put("/api/todos/{todo_id}")
def update_todo(todo_id: int, body: TodoUpdateBody, uid: int = Depends(get_user_id)):
    with get_db() as conn:
        if body.done_hours is not None:
            conn.execute(text(
                "UPDATE todos SET done_hours=:d WHERE id=:id AND user_id=:u"
            ), {"d": body.done_hours, "id": todo_id, "u": uid})
        if body.completed is not None:
            conn.execute(text(
                "UPDATE todos SET completed=:c WHERE id=:id AND user_id=:u"
            ), {"c": 1 if body.completed else 0, "id": todo_id, "u": uid})
    return {"ok": True}


@app.delete("/api/todos/{todo_id}")
def delete_todo(todo_id: int, uid: int = Depends(get_user_id)):
    with get_db() as conn:
        conn.execute(text(
            "DELETE FROM todos WHERE id=:id AND user_id=:u"
        ), {"id": todo_id, "u": uid})
    return {"ok": True}


@app.get("/api/site-config")
def site_config():
    return {
        "bmc_username":  os.environ.get("BMC_USERNAME",  ""),
        "kofi_username": os.environ.get("KOFI_USERNAME", ""),
        "adsense_id":    os.environ.get("ADSENSE_ID",    ""),
        "amazon_tag":    os.environ.get("AMAZON_TAG",    ""),
        "stripe_link":   os.environ.get("STRIPE_LINK",   ""),
    }


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

@app.get("/")
def root():
    return FileResponse(
        os.path.join(STATIC_DIR, "index.html"),
        headers={"Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache"},
    )
