"""Lakebase (serverless Postgres) persistence for chat history & memory.

This module gives the app server-side, per-user conversation persistence — replacing
the previous client-only localStorage. It authenticates to Lakebase with a short-lived
OAuth credential minted from the app's Databricks identity (no static Postgres password),
which is the differentiator worth showing: managed Postgres governed by the same identity
that runs the app.

Everything degrades gracefully: if the Lakebase env vars are not set, ``enabled()`` is
False and the app skips persistence so chat still works.

Required env vars (see app.yaml / databricks.yml):
  LAKEBASE_INSTANCE_NAME  Database instance name (used to mint the credential).
  LAKEBASE_HOST           Postgres host (e.g. instance-....database.cloud.databricks.com).
  LAKEBASE_DATABASE       Database name (default: databricks_postgres).
  LAKEBASE_USER           Postgres role — the app service principal's application id.
"""
from __future__ import annotations

import os
import threading
import time
import uuid
from contextlib import contextmanager
from typing import Any, Iterator, Optional

try:  # psycopg is only needed when Lakebase is configured; keep import soft for local runs.
    import psycopg
except Exception:  # pragma: no cover - exercised only when the dep is missing
    psycopg = None  # type: ignore[assignment]

# Refresh the DB credential this many seconds before it actually expires.
_TOKEN_SKEW_SECONDS = 300
_DEFAULT_TOKEN_TTL = 3600

_lock = threading.Lock()
_cached_token: Optional[str] = None
_cached_token_expiry: float = 0.0
_schema_ready = False


def _instance_name() -> str:
    return os.getenv("LAKEBASE_INSTANCE_NAME", "").strip()


def enabled() -> bool:
    """True when Lakebase is configured and the driver is importable."""
    return bool(psycopg and _instance_name() and os.getenv("LAKEBASE_HOST") and os.getenv("LAKEBASE_USER"))


def _fresh_credential(workspace: Any) -> str:
    """Mint (and cache) a short-lived Postgres OAuth token from the Databricks identity."""
    global _cached_token, _cached_token_expiry
    with _lock:
        now = time.time()
        if _cached_token and now < _cached_token_expiry - _TOKEN_SKEW_SECONDS:
            return _cached_token
        cred = workspace.database.generate_database_credential(
            request_id=str(uuid.uuid4()),
            instance_names=[_instance_name()],
        )
        _cached_token = cred.token
        # The SDK may or may not surface an expiry; fall back to the documented 1h TTL.
        expiry = getattr(cred, "expiration_time", None)
        _cached_token_expiry = now + _DEFAULT_TOKEN_TTL if expiry is None else _parse_expiry(expiry, now)
        return _cached_token


def _parse_expiry(expiry: Any, now: float) -> float:
    # expiration_time may be an ISO string or epoch-like; be defensive and cap to 1h.
    try:
        from datetime import datetime

        if isinstance(expiry, str):
            return datetime.fromisoformat(expiry.replace("Z", "+00:00")).timestamp()
        if isinstance(expiry, (int, float)):
            return float(expiry)
    except Exception:
        pass
    return now + _DEFAULT_TOKEN_TTL


@contextmanager
def _connect(workspace: Any) -> Iterator[Any]:
    """Open a Postgres connection using a freshly-minted credential as the password."""
    if not enabled():
        raise RuntimeError("Lakebase is not configured for this app.")
    conn = psycopg.connect(  # type: ignore[union-attr]
        host=os.getenv("LAKEBASE_HOST"),
        dbname=os.getenv("LAKEBASE_DATABASE", "databricks_postgres"),
        user=os.getenv("LAKEBASE_USER"),
        password=_fresh_credential(workspace),
        sslmode=os.getenv("LAKEBASE_SSLMODE", "require"),
        port=int(os.getenv("LAKEBASE_PORT", "5432")),
        connect_timeout=15,
    )
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_schema(workspace: Any) -> None:
    """Create the conversation/message tables once (idempotent). No-op if disabled."""
    global _schema_ready
    if not enabled() or _schema_ready:
        return
    with _connect(workspace) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS conversations (
                    id           UUID PRIMARY KEY,
                    user_email   TEXT NOT NULL,
                    title        TEXT NOT NULL,
                    model        TEXT,
                    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
                    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS messages (
                    id               UUID PRIMARY KEY,
                    conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                    role             TEXT NOT NULL,
                    content          TEXT NOT NULL,
                    model            TEXT,
                    input_tokens     INT,
                    output_tokens    INT,
                    trace_id         TEXT,
                    relevance        REAL,
                    safety           REAL,
                    groundedness     REAL,
                    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
                )
                """
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS idx_conversations_user "
                "ON conversations (user_email, updated_at DESC)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS idx_messages_conversation "
                "ON messages (conversation_id, created_at)"
            )
    _schema_ready = True


def _epoch_ms(value: Any) -> int:
    try:
        return int(value.timestamp() * 1000)
    except Exception:
        return 0


def list_conversations(workspace: Any, email: str) -> list[dict[str, Any]]:
    with _connect(workspace) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT c.id, c.title, c.model, c.updated_at, COUNT(m.id) AS message_count
                FROM conversations c
                LEFT JOIN messages m ON m.conversation_id = c.id
                WHERE c.user_email = %s
                GROUP BY c.id, c.title, c.model, c.updated_at
                ORDER BY c.updated_at DESC
                """,
                (email,),
            )
            return [
                {
                    "id": str(row[0]),
                    "title": row[1],
                    "model": row[2] or "",
                    "updated_at": _epoch_ms(row[3]),
                    "message_count": int(row[4] or 0),
                }
                for row in cur.fetchall()
            ]


def get_conversation(workspace: Any, conversation_id: str, email: str) -> Optional[dict[str, Any]]:
    with _connect(workspace) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, title, model, created_at, updated_at, user_email "
                "FROM conversations WHERE id = %s",
                (conversation_id,),
            )
            head = cur.fetchone()
            if not head:
                return None
            if head[5] != email:  # owner scoping
                return None
            cur.execute(
                """
                SELECT id, role, content, input_tokens, output_tokens, trace_id,
                       relevance, safety, groundedness
                FROM messages WHERE conversation_id = %s ORDER BY created_at
                """,
                (conversation_id,),
            )
            messages = [_message_row_to_dict(row) for row in cur.fetchall()]
    return {
        "id": str(head[0]),
        "title": head[1],
        "model": head[2] or "",
        "created_at": _epoch_ms(head[3]),
        "updated_at": _epoch_ms(head[4]),
        "messages": messages,
    }


def _message_row_to_dict(row: Any) -> dict[str, Any]:
    scores = {
        key: row[idx]
        for idx, key in ((6, "relevance"), (7, "safety"), (8, "groundedness"))
        if row[idx] is not None
    }
    message: dict[str, Any] = {"id": str(row[0]), "role": row[1], "content": row[2]}
    if row[3] is not None or row[4] is not None:
        message["usage"] = {
            "input_tokens": int(row[3] or 0),
            "output_tokens": int(row[4] or 0),
            "total_tokens": int((row[3] or 0) + (row[4] or 0)),
        }
    if row[5]:
        message["trace_id"] = row[5]
    if scores:
        message["scores"] = {k: float(v) for k, v in scores.items()}
    return message


def ensure_conversation(
    workspace: Any, conversation_id: Optional[str], email: str, title: str, model: str
) -> str:
    """Return an owned conversation id, creating the row if needed."""
    with _connect(workspace) as conn:
        with conn.cursor() as cur:
            if conversation_id:
                cur.execute(
                    "SELECT user_email FROM conversations WHERE id = %s", (conversation_id,)
                )
                found = cur.fetchone()
                if found and found[0] == email:
                    cur.execute(
                        "UPDATE conversations SET updated_at = now() WHERE id = %s",
                        (conversation_id,),
                    )
                    return conversation_id
            new_id = str(uuid.uuid4())
            cur.execute(
                "INSERT INTO conversations (id, user_email, title, model) VALUES (%s, %s, %s, %s)",
                (new_id, email, title[:200], model),
            )
            return new_id


def append_message(
    workspace: Any,
    conversation_id: str,
    role: str,
    content: str,
    model: Optional[str] = None,
    usage: Optional[dict[str, int]] = None,
    trace_id: Optional[str] = None,
    scores: Optional[dict[str, float]] = None,
) -> None:
    usage = usage or {}
    scores = scores or {}
    with _connect(workspace) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO messages
                    (id, conversation_id, role, content, model,
                     input_tokens, output_tokens, trace_id, relevance, safety, groundedness)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    str(uuid.uuid4()),
                    conversation_id,
                    role,
                    content,
                    model,
                    usage.get("input_tokens"),
                    usage.get("output_tokens"),
                    trace_id,
                    scores.get("relevance"),
                    scores.get("safety"),
                    scores.get("groundedness"),
                ),
            )
            cur.execute(
                "UPDATE conversations SET updated_at = now() WHERE id = %s", (conversation_id,)
            )


def eval_summary(workspace: Any, days: int) -> Optional[dict[str, Any]]:
    """Average LLM-judge scores across recently persisted assistant messages."""
    if not enabled():
        return None
    with _connect(workspace) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT AVG(relevance), AVG(safety), AVG(groundedness),
                       COUNT(*) FILTER (WHERE relevance IS NOT NULL)
                FROM messages
                WHERE role = 'assistant'
                  AND created_at >= now() - make_interval(days => %s)
                """,
                (days,),
            )
            row = cur.fetchone()
    if not row or not row[3]:
        return None
    return {
        "avg_relevance": float(row[0] or 0),
        "avg_safety": float(row[1] or 0),
        "avg_groundedness": float(row[2] or 0),
        "sample_count": int(row[3] or 0),
    }
