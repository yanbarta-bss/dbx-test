import asyncio
import json
import os
from pathlib import Path
from typing import Any, AsyncIterator
from urllib.parse import urlparse

from databricks import sql
from databricks.sdk import WorkspaceClient
from databricks.sdk.core import Config, oauth_service_principal
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

app = FastAPI(title="Multi Model Chat")
workspace = WorkspaceClient()
frontend_dist = Path(__file__).parent / "frontend" / "dist"
default_dbu_price = float(os.getenv("MODEL_SERVING_DBU_PRICE", "0.07"))


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    model: str
    messages: list[ChatMessage] = Field(default_factory=list)


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
    return {
        "email": email,
        "name": preferred_name,
        "groups": groups,
        "isAdmin": "admin" in lowered or "admins" in lowered,
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


def _workspace_hostname() -> str:
    server_hostname = os.getenv("DATABRICKS_SERVER_HOSTNAME")
    if server_hostname:
        return server_hostname
    parsed = urlparse(workspace.config.host)
    return parsed.hostname or workspace.config.host.replace("https://", "")


def _sql_connection():
    warehouse_id = os.getenv("DATABRICKS_SQL_WAREHOUSE_ID", "").strip()
    if not warehouse_id:
        raise RuntimeError("DATABRICKS_SQL_WAREHOUSE_ID is not configured.")

    server_hostname = _workspace_hostname()
    http_path = os.getenv("DATABRICKS_SQL_HTTP_PATH", f"/sql/1.0/warehouses/{warehouse_id}")
    access_token = os.getenv("DATABRICKS_TOKEN")
    client_id = os.getenv("DATABRICKS_CLIENT_ID")
    client_secret = os.getenv("DATABRICKS_CLIENT_SECRET")

    if access_token:
        return sql.connect(
            server_hostname=server_hostname,
            http_path=http_path,
            access_token=access_token,
        )

    if client_id and client_secret:
        def credential_provider():
            config = Config(
                host=f"https://{server_hostname}",
                client_id=client_id,
                client_secret=client_secret,
            )
            return oauth_service_principal(config)

        return sql.connect(
            server_hostname=server_hostname,
            http_path=http_path,
            credentials_provider=credential_provider,
        )

    raise RuntimeError(
        "Databricks SQL authentication is not configured for this app. Set DATABRICKS_CLIENT_ID and DATABRICKS_CLIENT_SECRET, or provide DATABRICKS_TOKEN."
    )


def _build_usage_rows(days: int) -> dict[str, Any]:
    query = f"""
        SELECT
          identity_metadata.run_by AS user,
          COALESCE(usage_metadata.ai_gateway.destination_model, usage_metadata.ai_gateway.endpoint_name, 'unknown') AS model,
          SUM(usage_quantity) AS total_dbus,
          COUNT(*) AS request_count
        FROM system.billing.usage
        WHERE billing_origin_product = 'MODEL_SERVING'
          AND usage_metadata.ai_gateway.endpoint_name IS NOT NULL
          AND usage_date >= current_date() - INTERVAL {days} DAYS
        GROUP BY 1, 2
        ORDER BY total_dbus DESC
    """

    with _sql_connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute(query)
            rows = cursor.fetchall()

    data = [
        {
            "user": row[0],
            "model": row[1],
            "total_dbus": float(row[2] or 0),
            "request_count": int(row[3] or 0),
            "estimated_cost": round(float(row[2] or 0) * default_dbu_price, 4),
        }
        for row in rows
    ]
    return {"rows": data, "message": None, "dbuUnitPrice": default_dbu_price}


def _chunk_text(text: str, chunk_size: int = 48) -> list[str]:
    return [text[index : index + chunk_size] for index in range(0, len(text), chunk_size)] or [""]


def _sse(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload)}\\n\\n"


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


@app.post("/api/chat")
async def chat(payload: ChatRequest) -> StreamingResponse:
    if not payload.model:
        raise HTTPException(status_code=400, detail="A model name is required.")
    if not payload.messages:
        raise HTTPException(status_code=400, detail="At least one message is required.")

    try:
        response = await asyncio.to_thread(
            workspace.serving_endpoints.query,
            name=payload.model,
            messages=[message.model_dump() for message in payload.messages],
        )
        result = _safe_as_dict(response)
        text = _extract_response_text(result)
        usage = _extract_usage(result)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Model query failed: {exc}") from exc

    async def event_stream() -> AsyncIterator[str]:
        yield _sse({"type": "meta", "model": payload.model})
        for chunk in _chunk_text(text):
            yield _sse({"type": "delta", "delta": chunk})
            await asyncio.sleep(0.01)
        yield _sse(
            {
                "type": "final",
                "model": payload.model,
                "message": {"role": "assistant", "content": text},
                "usage": usage,
            }
        )

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/admin/usage")
def admin_usage(request: Request, days: int = Query(default=30, ge=7, le=365)) -> dict[str, Any]:
    user = _user_from_request(request)
    if not user["isAdmin"]:
        raise HTTPException(status_code=403, detail="Admin access is required.")

    try:
        return _build_usage_rows(days)
    except Exception as exc:
        message = str(exc)
        known_unavailable = (
            "system.billing.usage",
            "TABLE_OR_VIEW_NOT_FOUND",
            "PERMISSION_DENIED",
            "not configured",
            "Unauthorized",
        )
        if any(token.lower() in message.lower() for token in known_unavailable):
            return {
                "rows": [],
                "message": "Usage data is unavailable. Enable billing system tables and configure the SQL warehouse resource or environment variables for this app.",
                "dbuUnitPrice": default_dbu_price,
            }
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
