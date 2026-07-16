import asyncio
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Optional

from databricks.sdk import WorkspaceClient
from databricks.sdk.service.serving import ChatMessage as ServingChatMessage
from databricks.sdk.service.serving import ChatMessageRole
from databricks.sdk.service.sql import StatementState
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

import db
import tracing

try:
    workspace = WorkspaceClient()
except Exception:
    # No ambient Databricks auth (e.g. unit tests / CI). Routes that need the client fail
    # gracefully; pure helpers remain importable and testable.
    workspace = None  # type: ignore[assignment]
frontend_dist = Path(__file__).parent / "frontend" / "dist"
default_dbu_price = float(os.getenv("MODEL_SERVING_DBU_PRICE", "0.07"))
admin_users = {user.strip().lower() for user in os.getenv("ADMIN_USERS", "").split(",") if user.strip()}
# When set, /api/models only lists endpoints whose name contains one of these substrings.
# Use it to hide endpoints that are disabled/unavailable on the workspace (e.g. keep only
# "llama,gpt-oss"). Empty = fall back to the heuristic LLM filter.
model_allowlist = [token.strip().lower() for token in os.getenv("MODEL_ALLOWLIST", "").split(",") if token.strip()]
_gateway_governed_cache: Optional[bool] = None


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    # Best-effort startup: MLflow tracing target and the Lakebase schema. Neither is
    # required for chat to work, so failures are swallowed (feature just stays off).
    try:
        tracing.init()
    except Exception:
        pass
    try:
        await asyncio.to_thread(db.init_schema, workspace)
    except Exception:
        pass
    yield


app = FastAPI(title="Multi Model Chat", lifespan=lifespan)


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    model: str
    messages: list[ChatMessage] = Field(default_factory=list)
    conversation_id: Optional[str] = None


def _safe_as_dict(value: Any) -> Any:
    if hasattr(value, "as_dict"):
        return value.as_dict()
    return value


def _user_from_request(request: Request) -> dict[str, Any]:
    email = request.headers.get("x-forwarded-email", "")
    groups_raw = request.headers.get("x-forwarded-groups", "")
    groups = [group.strip() for group in groups_raw.split(",") if group.strip()]
    lowered = {group.lower() for group in groups}
    preferred_name = request.headers.get("x-forwarded-preferred-username") or email.split("@")[0]
    is_admin = (
        "admin" in lowered
        or "admins" in lowered
        or email.lower() in admin_users
        or preferred_name.lower() in admin_users
    )
    return {
        "email": email,
        "name": preferred_name,
        "groups": groups,
        "isAdmin": is_admin,
    }


def _extract_text_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                if item.get("type") == "text":
                    parts.append(str(item.get("text", "")))
                elif "content" in item:
                    parts.append(_extract_text_content(item.get("content")))
        return "".join(parts)
    if isinstance(content, dict):
        return _extract_text_content(content.get("text") or content.get("content") or "")
    return ""


def _extract_response_text(result: dict[str, Any]) -> str:
    choices = result.get("choices") or []
    if choices:
        message = choices[0].get("message") or {}
        text = _extract_text_content(message.get("content"))
        if text:
            return text
    predictions = result.get("predictions") or []
    if predictions:
        first = predictions[0]
        if isinstance(first, dict):
            for key in ("content", "text", "prediction"):
                text = _extract_text_content(first.get(key))
                if text:
                    return text
    candidates = result.get("candidates") or []
    if candidates:
        text = _extract_text_content(candidates[0].get("content") or candidates[0].get("text"))
        if text:
            return text
    return json.dumps(result)


def _extract_usage(result: dict[str, Any]) -> dict[str, int]:
    usage = result.get("usage") or result.get("metadata", {}).get("usage") or {}
    input_tokens = int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0)
    output_tokens = int(usage.get("completion_tokens") or usage.get("output_tokens") or 0)
    total_tokens = int(usage.get("total_tokens") or (input_tokens + output_tokens))
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
    }


def _is_llm_endpoint(endpoint: Any) -> bool:
    payload = _safe_as_dict(endpoint)
    endpoint_type = str(payload.get("endpoint_type") or "").lower()
    config_blob = json.dumps(payload.get("config") or {}, default=str).lower()
    name = str(payload.get("name") or "").lower()
    if model_allowlist:
        return any(token in name for token in model_allowlist)
    direct_indicators = [
        "external_model",
        "foundation_model_api",
        "chat",
        "llm",
        "gpt",
        "claude",
        "llama",
        "mistral",
        "gemini",
        "instruct",
    ]
    return any(token in endpoint_type for token in direct_indicators) or any(
        token in config_blob or token in name for token in direct_indicators
    )


def _format_model(endpoint: Any) -> dict[str, str]:
    payload = _safe_as_dict(endpoint)
    name = str(payload.get("name"))
    config = payload.get("config") or {}
    served_entities = config.get("served_entities") or []
    label = name
    if served_entities:
        first_entity = served_entities[0] or {}
        label = (
            first_entity.get("name")
            or first_entity.get("external_model", {}).get("name")
            or name
        )
    return {"name": name, "label": label.replace("_", " ").title()}


def _usage_client(user_access_token: Optional[str] = None) -> WorkspaceClient:
    # Prefer the forwarded end-user token (on-behalf-of-user) so system.* tables are
    # read with the admin's account-admin access; the app service principal cannot be
    # granted access to the Databricks-owned system catalog on Free Edition.
    if user_access_token:
        # Force PAT-only auth: the Apps runtime also exposes service-principal OAuth env
        # vars, and the SDK errors if it detects both a token and OAuth credentials.
        return WorkspaceClient(
            host=workspace.config.host,
            token=user_access_token,
            auth_type="pat",
        )
    return workspace


def _gateway_governed() -> bool:
    """Best-effort: is the chat endpoint fronted by Unity AI Gateway? Cached per process."""
    global _gateway_governed_cache
    if _gateway_governed_cache is not None:
        return _gateway_governed_cache
    result = False
    try:
        configured = os.getenv("AI_GATEWAY_ENDPOINT", "").strip()
        if configured:
            endpoint = workspace.serving_endpoints.get(configured)
            result = getattr(endpoint, "ai_gateway", None) is not None
        else:
            for endpoint in workspace.serving_endpoints.list():
                if getattr(endpoint, "ai_gateway", None) is not None:
                    result = True
                    break
    except Exception:
        result = False
    _gateway_governed_cache = result
    return result


def _usage_envelope(
    rows: list[dict[str, Any]], message: Optional[str], days: int
) -> dict[str, Any]:
    try:
        eval_summary = db.eval_summary(workspace, days)
    except Exception:
        eval_summary = None
    return {
        "rows": rows,
        "message": message,
        "dbu_price": default_dbu_price,
        "governed_by_gateway": _gateway_governed(),
        "eval_summary": eval_summary,
    }


def _build_usage_rows(days: int, user_access_token: Optional[str] = None) -> dict[str, Any]:
    warehouse_id = os.getenv("DATABRICKS_SQL_WAREHOUSE_ID", "").strip()
    if not warehouse_id:
        raise RuntimeError("DATABRICKS_SQL_WAREHOUSE_ID is not configured.")

    # system.billing.usage is empty on Databricks Free Edition (no billable DBUs),
    # so we report real per-user/per-model token usage from the serving system tables.
    # Queries run over the Statement Execution REST API (the Thrift SQL connector cannot
    # open a session from the Databricks Apps runtime).
    query = f"""
        SELECT
          u.requester AS user,
          COALESCE(e.endpoint_name, u.served_entity_id) AS model,
          COUNT(*) AS request_count,
          SUM(u.input_token_count) AS input_tokens,
          SUM(u.output_token_count) AS output_tokens,
          SUM(u.input_token_count + u.output_token_count) AS total_tokens
        FROM system.serving.endpoint_usage u
        LEFT JOIN system.serving.served_entities e USING (served_entity_id)
        WHERE u.request_time >= current_timestamp() - INTERVAL {days} DAYS
        GROUP BY 1, 2
        ORDER BY total_tokens DESC
    """

    client = _usage_client(user_access_token)
    response = client.statement_execution.execute_statement(
        warehouse_id=warehouse_id,
        statement=query,
        wait_timeout="50s",
    )
    if response.status.state != StatementState.SUCCEEDED:
        error = response.status.error
        raise RuntimeError(error.message if error else f"Statement {response.status.state}")

    rows = (response.result.data_array if response.result else None) or []
    data = []
    for row in rows:
        total_tokens = int(row[5] or 0)
        # system.serving.endpoint_usage has no DBU column and system.billing.usage is empty
        # on Free Edition, so we surface a transparent token-derived estimate (1 DBU / 1k
        # tokens) priced at MODEL_SERVING_DBU_PRICE. Swap in the billing join on a paid workspace.
        estimated_dbus = total_tokens / 1000.0
        data.append(
            {
                "user": row[0],
                "model": row[1],
                "request_count": int(row[2] or 0),
                "input_tokens": int(row[3] or 0),
                "output_tokens": int(row[4] or 0),
                "total_tokens": total_tokens,
                "total_dbus": round(estimated_dbus, 4),
                "estimated_cost": round(estimated_dbus * default_dbu_price, 4),
            }
        )
    return _usage_envelope(data, None, days)


def _chunk_text(text: str, chunk_size: int = 48) -> list[str]:
    return [text[index : index + chunk_size] for index in range(0, len(text), chunk_size)] or [""]


def _sse(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload)}\n\n"


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/me")
def get_me(request: Request) -> dict[str, Any]:
    user = _user_from_request(request)
    return {
        "email": user["email"],
        "name": user["name"],
        "isAdmin": user["isAdmin"],
    }


@app.get("/api/models")
def get_models() -> dict[str, Any]:
    try:
        endpoints = list(workspace.serving_endpoints.list())
        models = [_format_model(endpoint) for endpoint in endpoints if _is_llm_endpoint(endpoint)]
        models.sort(key=lambda model: model["label"].lower())
        return {"models": models}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Unable to load serving endpoints: {exc}") from exc


def _looks_like_guardrail(message: str) -> Optional[dict[str, Any]]:
    """Translate a guardrail/safety rejection into a renderable 'blocked' result."""
    lowered = message.lower()
    markers = ("guardrail", "safety", "content filter", "flagged", "blocked", "policy", "pii")
    if any(marker in lowered for marker in markers):
        return {"blocked": True, "action": "blocked", "reason": message[:300]}
    return None


def _detect_fallback(result: dict[str, Any]) -> Optional[dict[str, Any]]:
    # Reliable fallback attribution needs the AI Gateway payload table; for a live demo set
    # AI_GATEWAY_PRIMARY_ENTITY so we flag when a different entity served the reply.
    primary = os.getenv("AI_GATEWAY_PRIMARY_ENTITY", "").strip()
    served = str(result.get("model") or "").strip()
    if primary and served and served != primary:
        return {"used": True, "requested_model": primary, "served_model": served}
    return None


@app.post("/api/chat")
async def chat(request: Request, payload: ChatRequest) -> StreamingResponse:
    if not payload.model:
        raise HTTPException(status_code=400, detail="A model name is required.")
    if not payload.messages:
        raise HTTPException(status_code=400, detail="At least one message is required.")

    user = _user_from_request(request)
    email = user["email"]
    question = next(
        (message.content for message in reversed(payload.messages) if message.role == "user"),
        payload.messages[-1].content,
    )

    def _run_query() -> Any:
        return workspace.serving_endpoints.query(
            name=payload.model,
            messages=[
                ServingChatMessage(role=ChatMessageRole(message.role), content=message.content)
                for message in payload.messages
            ],
        )

    guardrail: Optional[dict[str, Any]] = None
    fallback: Optional[dict[str, Any]] = None
    trace_id: Optional[str] = None
    scores: Optional[dict[str, float]] = None
    text = ""
    usage: dict[str, int] = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}

    try:
        # MLflow tracing wraps the call; a guardrail rejection surfaces as an exception we
        # convert into a rendered 'blocked' reply rather than an opaque 500.
        response, trace_id = await asyncio.to_thread(
            tracing.run_traced, _run_query, payload.model, question
        )
        result = _safe_as_dict(response)
        text = _extract_response_text(result)
        usage = _extract_usage(result)
        fallback = _detect_fallback(result)
    except Exception as exc:
        guardrail = _looks_like_guardrail(str(exc))
        if guardrail is None:
            raise HTTPException(status_code=500, detail=f"Model query failed: {exc}") from exc
        text = "This response was blocked by an AI Gateway guardrail."

    if guardrail is None:
        def _judge(prompt: str) -> str:
            judge_model = os.getenv("JUDGE_MODEL", "").strip() or payload.model
            judged = workspace.serving_endpoints.query(
                name=judge_model,
                messages=[ServingChatMessage(role=ChatMessageRole("user"), content=prompt)],
            )
            return _extract_response_text(_safe_as_dict(judged))

        try:
            scores = await asyncio.to_thread(tracing.score, _judge, question, text, trace_id)
        except Exception:
            scores = None

    # Persist to Lakebase (best-effort). Establish the conversation up front so its id can
    # ride the meta event and the client can re-target the same row on the next turn.
    conversation_id = payload.conversation_id
    if db.enabled() and email:
        try:
            title = question.strip()[:80] or "New conversation"
            conversation_id = await asyncio.to_thread(
                db.ensure_conversation, workspace, payload.conversation_id, email, title, payload.model
            )
            await asyncio.to_thread(
                db.append_message, workspace, conversation_id, "user", question, payload.model
            )
            if guardrail is None:
                await asyncio.to_thread(
                    db.append_message,
                    workspace,
                    conversation_id,
                    "assistant",
                    text,
                    payload.model,
                    usage,
                    trace_id,
                    scores,
                )
        except Exception:
            pass

    governed = _gateway_governed()

    async def event_stream() -> AsyncIterator[str]:
        meta: dict[str, Any] = {"type": "meta", "model": payload.model, "governed": governed}
        if conversation_id:
            meta["conversation_id"] = conversation_id
        if fallback:
            meta["fallback"] = fallback
        yield _sse(meta)

        for chunk in _chunk_text(text):
            yield _sse({"type": "delta", "delta": chunk})
            await asyncio.sleep(0.01)

        final: dict[str, Any] = {
            "type": "final",
            "model": payload.model,
            "message": {"role": "assistant", "content": text},
            "usage": usage,
        }
        if conversation_id:
            final["conversation_id"] = conversation_id
        if scores:
            final["scores"] = scores
        if trace_id:
            final["trace_id"] = trace_id
        if guardrail:
            final["guardrail"] = guardrail
        yield _sse(final)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/conversations")
def list_conversations(request: Request) -> dict[str, Any]:
    user = _user_from_request(request)
    if not user["email"] or not db.enabled():
        return {"conversations": []}
    try:
        return {"conversations": db.list_conversations(workspace, user["email"])}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to list conversations: {exc}") from exc


@app.get("/api/conversations/{conversation_id}")
def get_conversation(conversation_id: str, request: Request) -> dict[str, Any]:
    user = _user_from_request(request)
    if not db.enabled():
        raise HTTPException(status_code=404, detail="Conversation persistence is not enabled.")
    try:
        conversation = db.get_conversation(workspace, conversation_id, user["email"])
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to load conversation: {exc}") from exc
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    return conversation


@app.get("/api/admin/usage")
def admin_usage(request: Request, days: int = Query(default=30, ge=7, le=365)) -> dict[str, Any]:
    user = _user_from_request(request)
    if not user["isAdmin"]:
        raise HTTPException(status_code=403, detail="Admin access is required.")

    forwarded_token = request.headers.get("x-forwarded-access-token")
    try:
        return _build_usage_rows(days, user_access_token=forwarded_token)
    except Exception as exc:
        message = str(exc).lower()
        scope_or_consent = "invalid scope" in message or "403" in message or "forbidden" in message
        known_unavailable = (
            "table_or_view_not_found",
            "permission_denied",
            "not configured",
            "unauthorized",
        )
        if scope_or_consent:
            return _usage_envelope(
                [],
                "Usage data is unavailable. Open the app in a browser and approve the authorization prompt for the 'sql' scope so your token can query the usage tables.",
                days,
            )
        if any(token in message for token in known_unavailable):
            return _usage_envelope(
                [],
                "Usage data is unavailable. Ensure DATABRICKS_SQL_WAREHOUSE_ID is set and the signed-in admin has access to the system.serving tables.",
                days,
            )
        raise HTTPException(status_code=500, detail=f"Failed to load usage data: {exc}") from exc


@app.get("/{full_path:path}", include_in_schema=False)
async def serve_spa(full_path: str) -> Any:
    requested_path = (frontend_dist / full_path).resolve()
    dist_root = frontend_dist.resolve()

    if full_path and requested_path.is_file() and dist_root in requested_path.parents:
        return FileResponse(requested_path)

    index_file = frontend_dist / "index.html"
    if index_file.exists():
        return FileResponse(index_file)

    return JSONResponse(
        status_code=503,
        content={
            "message": "Frontend build is missing. Run `npm run build` inside the frontend directory before starting the app."
        },
    )
