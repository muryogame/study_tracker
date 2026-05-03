from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import sqlite3
from datetime import datetime
import os

app = FastAPI(title="StudyFlow")

# ローカルは ./study.db、Railway は DB_PATH 環境変数で /data/study.db を指定
DB_PATH    = os.environ.get("DB_PATH", os.path.join(os.path.dirname(os.path.abspath(__file__)), "study.db"))
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = get_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            start_time       TEXT    NOT NULL,
            end_time         TEXT,
            duration_minutes REAL
        )
    """)
    conn.commit()
    conn.close()


init_db()


@app.get("/api/active")
def get_active():
    conn    = get_db()
    session = conn.execute(
        "SELECT * FROM sessions WHERE end_time IS NULL ORDER BY start_time DESC LIMIT 1"
    ).fetchone()
    conn.close()
    return {"active": bool(session), "session": dict(session) if session else None}


@app.post("/api/start")
def start_session():
    conn = get_db()
    if conn.execute("SELECT id FROM sessions WHERE end_time IS NULL").fetchone():
        conn.close()
        raise HTTPException(400, "既にセッションが進行中です")
    now = datetime.now().isoformat()
    cur = conn.execute("INSERT INTO sessions (start_time) VALUES (?)", (now,))
    conn.commit()
    sid = cur.lastrowid
    conn.close()
    return {"session_id": sid, "start_time": now}


@app.post("/api/stop")
def stop_session():
    conn   = get_db()
    active = conn.execute(
        "SELECT * FROM sessions WHERE end_time IS NULL ORDER BY start_time DESC LIMIT 1"
    ).fetchone()
    if not active:
        conn.close()
        raise HTTPException(400, "進行中のセッションがありません")
    now      = datetime.now()
    start    = datetime.fromisoformat(active["start_time"])
    duration = (now - start).total_seconds() / 60
    conn.execute(
        "UPDATE sessions SET end_time=?, duration_minutes=? WHERE id=?",
        (now.isoformat(), round(duration, 2), active["id"])
    )
    conn.commit()
    conn.close()
    return {"session_id": active["id"], "end_time": now.isoformat(), "duration_minutes": round(duration, 2)}


@app.get("/api/calendar/{year}/{month}")
def get_calendar(year: int, month: int):
    conn = get_db()
    rows = conn.execute(
        """SELECT date(start_time) as day,
                  SUM(COALESCE(duration_minutes,0)) as total_minutes,
                  COUNT(*) as session_count
           FROM sessions
           WHERE strftime('%Y',start_time)=? AND strftime('%m',start_time)=?
             AND end_time IS NOT NULL
           GROUP BY date(start_time)""",
        (str(year), f"{month:02d}")
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.get("/api/stats")
def get_stats():
    conn = get_db()

    monthly = conn.execute(
        "SELECT COALESCE(SUM(duration_minutes),0) as t FROM sessions "
        "WHERE strftime('%Y-%m',start_time)=strftime('%Y-%m','now','localtime') AND end_time IS NOT NULL"
    ).fetchone()

    weekly = conn.execute(
        "SELECT COALESCE(SUM(duration_minutes),0) as t FROM sessions "
        "WHERE date(start_time,'localtime')>=date('now','localtime','weekday 1','-7 days') AND end_time IS NOT NULL"
    ).fetchone()

    today = conn.execute(
        "SELECT COALESCE(SUM(duration_minutes),0) as t, COUNT(*) as c FROM sessions "
        "WHERE date(start_time,'localtime')=date('now','localtime') AND end_time IS NOT NULL"
    ).fetchone()

    by_dow = conn.execute(
        """SELECT CAST(strftime('%w',start_time) AS INTEGER) as dow,
                  COALESCE(SUM(duration_minutes),0) as total_minutes,
                  COUNT(DISTINCT date(start_time)) as days
           FROM sessions WHERE end_time IS NOT NULL
           GROUP BY dow ORDER BY dow"""
    ).fetchall()

    streak = conn.execute(
        "SELECT COUNT(DISTINCT date(start_time,'localtime')) as d FROM sessions "
        "WHERE date(start_time,'localtime')>=date('now','localtime','-30 days') AND end_time IS NOT NULL"
    ).fetchone()

    conn.close()
    return {
        "monthly_minutes": round(monthly["t"], 1),
        "weekly_minutes":  round(weekly["t"],  1),
        "today_minutes":   round(today["t"],   1),
        "today_sessions":  today["c"],
        "by_day_of_week":  [dict(d) for d in by_dow],
        "active_days_30":  streak["d"],
    }


@app.get("/api/history")
def get_history(limit: int = 20, offset: int = 0):
    conn  = get_db()
    rows  = conn.execute(
        "SELECT id,start_time,end_time,duration_minutes FROM sessions "
        "WHERE end_time IS NOT NULL ORDER BY start_time DESC LIMIT ? OFFSET ?",
        (limit, offset)
    ).fetchall()
    total = conn.execute(
        "SELECT COUNT(*) as c FROM sessions WHERE end_time IS NOT NULL"
    ).fetchone()
    conn.close()
    return {"sessions": [dict(r) for r in rows], "total": total["c"]}


@app.delete("/api/sessions/{session_id}")
def delete_session(session_id: int):
    conn = get_db()
    conn.execute("DELETE FROM sessions WHERE id=?", (session_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def root():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))
