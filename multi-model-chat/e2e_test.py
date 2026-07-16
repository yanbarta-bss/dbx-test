#!/usr/bin/env python3
"""End-to-end smoke test for the Multi Model Chat app.

Exercises every API endpoint and every chat model, then prints a compact
diagnostic log so failures are obvious at a glance.

Usage:
    # Against the deployed Databricks App (fetches a bearer token from a CLI profile):
    python e2e_test.py --base-url https://<app>.databricksapps.com --profile free

    # Against a locally running server (no auth needed):
    python e2e_test.py --base-url http://127.0.0.1:8000

    # Limit chat tests to a couple of models:
    python e2e_test.py --base-url ... --profile free --models databricks-gpt-oss-20b

Only the standard library is used, so it runs anywhere Python 3.8+ exists.
"""
import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request

# Models that are embeddings, not chat — /api/chat will fail on these.
EMBEDDING_HINTS = ("embedding", "bge-", "gte-")
CHAT_PROMPT = "Reply with exactly the word: pong"
SLOW_SECONDS = 10.0  # flag anything slower than this


def log(tag: str, msg: str) -> None:
    print(f"[{tag:>5}] {msg}", flush=True)


def get_token(profile: str) -> str:
    out = subprocess.run(
        ["databricks", "auth", "token", "--profile", profile],
        capture_output=True, text=True, check=True,
    ).stdout
    return json.loads(out)["access_token"]


def request(url: str, token: str, method="GET", body=None, timeout=180, extra_headers=None):
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if extra_headers:
        headers.update(extra_headers)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    start = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", "replace")
    return resp.status, raw, time.time() - start


def parse_sse(raw: str):
    """Return a dict of everything the SSE stream surfaced (meta + final fields)."""
    out = {
        "content": None,
        "usage": None,
        "n_deltas": 0,
        "saw_final": False,
        "conversation_id": None,
        "governed": None,
        "fallback": None,
        "guardrail": None,
        "scores": None,
        "trace_id": None,
    }
    for block in raw.replace("\r\n", "\n").split("\n\n"):
        lines = [ln[5:].strip() for ln in block.split("\n") if ln.startswith("data:")]
        if not lines:
            continue
        try:
            payload = json.loads("\n".join(lines))
        except json.JSONDecodeError:
            continue
        ptype = payload.get("type")
        if ptype == "delta":
            out["n_deltas"] += 1
        elif ptype == "meta":
            out["governed"] = payload.get("governed")
            out["fallback"] = payload.get("fallback")
            out["conversation_id"] = payload.get("conversation_id") or out["conversation_id"]
        elif ptype == "final":
            out["saw_final"] = True
            out["content"] = (payload.get("message") or {}).get("content", "")
            out["usage"] = payload.get("usage")
            out["guardrail"] = payload.get("guardrail")
            out["scores"] = payload.get("scores")
            out["trace_id"] = payload.get("trace_id")
            out["conversation_id"] = payload.get("conversation_id") or out["conversation_id"]
    return out


# Dev identity headers so admin gating + the OBO usage query work when hitting a local server
# that isn't behind the Databricks Apps OAuth proxy. Override the email with --admin-email.
def admin_headers(email: str):
    return {
        "x-forwarded-email": email,
        "x-forwarded-preferred-username": email.split("@")[0],
        "x-forwarded-groups": "admins",
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", required=True, help="App base URL, no trailing slash")
    ap.add_argument("--profile", default=None, help="Databricks CLI profile for bearer token (omit for local)")
    ap.add_argument("--models", nargs="*", default=None, help="Restrict chat tests to these model names")
    ap.add_argument("--timeout", type=int, default=120)
    ap.add_argument("--admin-email", default="yan.barta@blindspot.ai",
                    help="Email to stub as admin when hitting a local server (ignored behind the proxy)")
    args = ap.parse_args()
    base = args.base_url.rstrip("/")

    token = ""
    if args.profile:
        try:
            token = get_token(args.profile)
            log("auth", f"got bearer token from profile '{args.profile}'")
        except Exception as exc:  # noqa: BLE001
            log("FAIL", f"could not get token: {exc}")
            return 2

    failures = 0

    # ---- 1. health -------------------------------------------------------
    try:
        status, raw, dt = request(f"{base}/api/health", token)
        ok = status == 200 and json.loads(raw).get("status") == "ok"
        log("PASS" if ok else "FAIL", f"GET /api/health -> {status} {raw.strip()} ({dt:.2f}s)")
        failures += 0 if ok else 1
    except Exception as exc:  # noqa: BLE001
        log("FAIL", f"GET /api/health raised {exc}")
        return 2  # nothing else will work

    # ---- 2. me -----------------------------------------------------------
    try:
        status, raw, dt = request(f"{base}/api/me", token)
        me = json.loads(raw)
        log("info", f"GET /api/me -> {status} email={me.get('email')!r} name={me.get('name')!r} admin={me.get('isAdmin')}")
        if not me.get("email"):
            log(" warn", "identity is blank (expected when not behind the Apps OAuth proxy)")
    except Exception as exc:  # noqa: BLE001
        log("FAIL", f"GET /api/me raised {exc}"); failures += 1

    # ---- 3. models -------------------------------------------------------
    models = []
    try:
        status, raw, dt = request(f"{base}/api/models", token)
        models = [m["name"] for m in json.loads(raw).get("models", [])]
        log("PASS" if status == 200 and models else "FAIL",
            f"GET /api/models -> {status} {len(models)} models ({dt:.2f}s)")
        embeds = [m for m in models if any(h in m for h in EMBEDDING_HINTS)]
        if embeds:
            log(" warn", f"{len(embeds)} embedding endpoints listed as chat models (filter too loose): {embeds}")
    except Exception as exc:  # noqa: BLE001
        log("FAIL", f"GET /api/models raised {exc}"); failures += 1

    # ---- 4. chat per model ----------------------------------------------
    targets = args.models if args.models else [m for m in models if not any(h in m for h in EMBEDDING_HINTS)]
    log("info", f"testing /api/chat on {len(targets)} model(s), prompt={CHAT_PROMPT!r}")
    print("-" * 78)
    for name in targets:
        body = {"model": name, "messages": [{"role": "user", "content": CHAT_PROMPT}]}
        try:
            status, raw, dt = request(f"{base}/api/chat", token, method="POST", body=body, timeout=args.timeout)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            verdict = "GATED" if "rate limit of 0" in detail else "ERROR"
            log(verdict, f"{name:<42} HTTP {exc.code} :: {detail[:90]}")
            failures += 0 if verdict == "GATED" else 1
            continue
        except Exception as exc:  # noqa: BLE001
            log("ERROR", f"{name:<42} {type(exc).__name__}: {exc}"); failures += 1
            continue

        sse = parse_sse(raw)
        usage = sse["usage"]
        out_tok = (usage or {}).get("output_tokens")
        text = (sse["content"] or "").strip()
        # A model that burned many output tokens but returned little text = reasoning discarded.
        reasoning_gap = out_tok is not None and out_tok > 15 and len(text) < 8
        if not sse["saw_final"]:
            verdict = "NOFIN"; failures += 1
        elif not text:
            verdict = "EMPTY"; failures += 1
        elif dt > SLOW_SECONDS:
            verdict = " SLOW"
        else:
            verdict = "  OK"
        extras = []
        if sse["governed"] is not None:
            extras.append(f"governed={sse['governed']}")
        if sse["conversation_id"]:
            extras.append("persisted")
        if sse["scores"]:
            extras.append("scored")
        if sse["fallback"]:
            extras.append("FALLBACK")
        note = f"out_tok={out_tok}" + (" REASONING-GAP" if reasoning_gap else "")
        if extras:
            note += " " + " ".join(extras)
        log(verdict, f"{name:<42} {dt:6.2f}s deltas={sse['n_deltas']} len={len(text):<4} {note} :: {text[:40]!r}")

    print("-" * 78)

    hdrs = admin_headers(args.admin_email) if not args.profile else None

    # ---- 5. admin usage + AI Gateway governance --------------------------
    try:
        status, raw, dt = request(f"{base}/api/admin/usage?days=30", token, extra_headers=hdrs)
        data = json.loads(raw)
        has_cost_fields = "dbu_price" in data and "governed_by_gateway" in data
        rows_ok = all(("total_dbus" in r and "estimated_cost" in r) for r in data.get("rows", []))
        ok = status == 200 and has_cost_fields and rows_ok
        log("PASS" if ok else "FAIL",
            f"GET /api/admin/usage -> {status} rows={len(data.get('rows', []))} "
            f"governed={data.get('governed_by_gateway')} dbu_price={data.get('dbu_price')} "
            f"eval_summary={'yes' if data.get('eval_summary') else 'no'} ({dt:.2f}s)")
        if data.get("message"):
            log(" warn", f"usage message: {data['message']}")
        failures += 0 if ok else 1
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        verdict = "info" if exc.code == 403 else "FAIL"
        log(verdict, f"GET /api/admin/usage -> HTTP {exc.code} :: {detail[:90]}")
        failures += 0 if exc.code == 403 else 1
    except Exception as exc:  # noqa: BLE001
        log("FAIL", f"GET /api/admin/usage raised {exc}"); failures += 1

    # ---- 6. Lakebase conversation persistence round-trip -----------------
    try:
        status, raw, dt = request(f"{base}/api/conversations", token, extra_headers=hdrs)
        conv = json.loads(raw)
        before = len(conv.get("conversations", []))
        log("info", f"GET /api/conversations -> {status} {before} conversation(s)")
        chat_model = (args.models or [m for m in models if not any(h in m for h in EMBEDDING_HINTS)])[:1]
        if chat_model:
            body = {"model": chat_model[0], "messages": [{"role": "user", "content": CHAT_PROMPT}]}
            _, craw, _ = request(f"{base}/api/chat", token, method="POST", body=body,
                                  timeout=args.timeout, extra_headers=hdrs)
            cid = parse_sse(craw)["conversation_id"]
            if not cid:
                log("info", "chat returned no conversation_id (Lakebase persistence disabled) — skipping round-trip")
            else:
                status, raw, _ = request(f"{base}/api/conversations/{cid}", token, extra_headers=hdrs)
                fetched = json.loads(raw)
                ok = status == 200 and any(m.get("role") == "user" for m in fetched.get("messages", []))
                log("PASS" if ok else "FAIL",
                    f"conversation round-trip {cid[:8]}… -> {status} messages={len(fetched.get('messages', []))}")
                failures += 0 if ok else 1
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        log("FAIL", f"conversations check -> HTTP {exc.code} :: {detail[:90]}"); failures += 1
    except Exception as exc:  # noqa: BLE001
        log("FAIL", f"conversations check raised {exc}"); failures += 1

    print("-" * 78)
    log("done", f"{failures} failure(s). SLOW threshold={SLOW_SECONDS}s "
                 f"(SLOW/NOFIN/REASONING-GAP point at the synchronous-query design).")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
