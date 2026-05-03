from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from sqlalchemy import create_engine, text
from sqlalchemy.pool import StaticPool
from contextlib import contextmanager
from datetime import datetime
import os

app = FastAPI(title="StudyFlow")

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

# ── Database ──────────────────────────────────────────────────
# 本番: DATABASE_URL 環境変数 (PostgreSQL)
# ローカル: SQLite
_db_url = os.environ.get("DATABASE_URL", "")
if _db_url.startswith("postgres://"):          # Render は postgres:// で来るので修正
    _db_url = _db_url.replace("postgres://", "postgresql://", 1)

IS_PG = bool(_db_url)

if IS_PG:
    # Supabase は SSL 必須
    engine = create_engine(
        _db_url,
        connect_args={"sslmode": "require"},
    )
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
    def _ym(col):      return f"to_char({col}::timestamp, 'YYYY-MM')"
    def _date(col):    return f"({col}::timestamp AT TIME ZONE 'Asia/Tokyo')::date"
    def _dow(col):     return f"EXTRACT(DOW FROM {col}::timestamp)::integer"
    def _yr(col):      return f"to_char({col}::timestamp, 'YYYY')"
    def _mo(col):      return f"to_char({col}::timestamp, 'MM')"
    NOW_YM   = "to_char(NOW() AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM')"
    TODAY    = "(NOW() AT TIME ZONE 'Asia/Tokyo')::date"
    WEEK_AGO = "(NOW() AT TIME ZONE 'Asia/Tokyo')::date - INTERVAL '7 days'"
    D30_AGO  = "(NOW() AT TIME ZONE 'Asia/Tokyo')::date - INTERVAL '30 days'"
    SERIAL   = "SERIAL PRIMARY KEY"
else:
    def _ym(col):      return f"strftime('%Y-%m', {col})"
    def _date(col):    return f"date({col}, 'localtime')"
    def _dow(col):     return f"CAST(strftime('%w', {col}) AS INTEGER)"
    def _yr(col):      return f"strftime('%Y', {col})"
    def _mo(col):      return f"strftime('%m', {col})"
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
                start_time       TEXT NOT NULL,
                end_time         TEXT,
                duration_minutes REAL
            )
        """))

init_db()


# ── API ───────────────────────────────────────────────────────
@app.get("/api/active")
def get_active():
    with get_db() as conn:
        row = conn.execute(text(
            "SELECT * FROM sessions WHERE end_time IS NULL ORDER BY start_time DESC LIMIT 1"
        )).mappings().fetchone()
    return {"active": bool(row), "session": dict(row) if row else None}


@app.post("/api/start")
def start_session():
    with get_db() as conn:
        if conn.execute(text("SELECT id FROM sessions WHERE end_time IS NULL")).fetchone():
            raise HTTPException(400, "既にセッションが進行中です")
        now = datetime.now().isoformat()
        if IS_PG:
            row = conn.execute(
                text("INSERT INTO sessions (start_time) VALUES (:t) RETURNING id"),
                {"t": now}
            ).fetchone()
            sid = row[0]
        else:
            result = conn.execute(text("INSERT INTO sessions (start_time) VALUES (:t)"), {"t": now})
            sid = result.lastrowid
    return {"session_id": sid, "start_time": now}


@app.post("/api/stop")
def stop_session():
    with get_db() as conn:
        active = conn.execute(text(
            "SELECT * FROM sessions WHERE end_time IS NULL ORDER BY start_time DESC LIMIT 1"
        )).mappings().fetchone()
        if not active:
            raise HTTPException(400, "進行中のセッションがありません")
        now      = datetime.now()
        duration = (now - datetime.fromisoformat(active["start_time"])).total_seconds() / 60
        conn.execute(text(
            "UPDATE sessions SET end_time=:e, duration_minutes=:d WHERE id=:id"
        ), {"e": now.isoformat(), "d": round(duration, 2), "id": active["id"]})
    return {"session_id": active["id"], "end_time": now.isoformat(), "duration_minutes": round(duration, 2)}


@app.get("/api/calendar/{year}/{month}")
def get_calendar(year: int, month: int):
    with get_db() as conn:
        rows = conn.execute(text(f"""
            SELECT {_date('start_time')} AS day,
                   COALESCE(SUM(duration_minutes), 0) AS total_minutes,
                   COUNT(*) AS session_count
            FROM sessions
            WHERE {_yr('start_time')} = :y
              AND {_mo('start_time')} = :m
              AND end_time IS NOT NULL
            GROUP BY {_date('start_time')}
        """), {"y": str(year), "m": f"{month:02d}"}).mappings().fetchall()
    return [dict(r) for r in rows]


@app.get("/api/stats")
def get_stats():
    with get_db() as conn:
        monthly = conn.execute(text(f"""
            SELECT COALESCE(SUM(duration_minutes), 0) AS t FROM sessions
            WHERE {_ym('start_time')} = {NOW_YM} AND end_time IS NOT NULL
        """)).fetchone()

        weekly = conn.execute(text(f"""
            SELECT COALESCE(SUM(duration_minutes), 0) AS t FROM sessions
            WHERE {_date('start_time')} >= {WEEK_AGO} AND end_time IS NOT NULL
        """)).fetchone()

        today = conn.execute(text(f"""
            SELECT COALESCE(SUM(duration_minutes), 0) AS t, COUNT(*) AS c FROM sessions
            WHERE {_date('start_time')} = {TODAY} AND end_time IS NOT NULL
        """)).fetchone()

        by_dow = conn.execute(text(f"""
            SELECT {_dow('start_time')} AS dow,
                   COALESCE(SUM(duration_minutes), 0) AS total_minutes,
                   COUNT(DISTINCT {_date('start_time')}) AS days
            FROM sessions WHERE end_time IS NOT NULL
            GROUP BY {_dow('start_time')}
            ORDER BY {_dow('start_time')}
        """)).mappings().fetchall()

        streak = conn.execute(text(f"""
            SELECT COUNT(DISTINCT {_date('start_time')}) AS d FROM sessions
            WHERE {_date('start_time')} >= {D30_AGO} AND end_time IS NOT NULL
        """)).fetchone()

    return {
        "monthly_minutes": round(monthly[0], 1),
        "weekly_minutes":  round(weekly[0],  1),
        "today_minutes":   round(today[0],   1),
        "today_sessions":  today[1],
        "by_day_of_week":  [dict(r) for r in by_dow],
        "active_days_30":  streak[0],
    }


@app.get("/api/history")
def get_history(limit: int = 20, offset: int = 0):
    with get_db() as conn:
        rows = conn.execute(text(
            "SELECT id, start_time, end_time, duration_minutes FROM sessions "
            "WHERE end_time IS NOT NULL ORDER BY start_time DESC LIMIT :l OFFSET :o"
        ), {"l": limit, "o": offset}).mappings().fetchall()
        total = conn.execute(text(
            "SELECT COUNT(*) FROM sessions WHERE end_time IS NOT NULL"
        )).fetchone()[0]
    return {"sessions": [dict(r) for r in rows], "total": total}


@app.delete("/api/sessions/{session_id}")
def delete_session(session_id: int):
    with get_db() as conn:
        conn.execute(text("DELETE FROM sessions WHERE id=:id"), {"id": session_id})
    return {"ok": True}


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

@app.get("/")
def root():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))
