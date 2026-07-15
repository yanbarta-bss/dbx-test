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


def request(url: str, token: str, method="GET", body=None, timeout=180):
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
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
    """Return (final_content, usage, n_deltas, saw_final) from an SSE stream body."""
    final_content, usage, n_deltas, saw_final = None, None, 0, False
    for block in raw.replace("\r\n", "\n").split("\n\n"):
        lines = [ln[5:].strip() for ln in block.split("\n") if ln.startswith("data:")]
        if not lines:
            continue
        try:
            payload = json.loads("\n".join(lines))
        except json.JSONDecodeError:
            continue
        if payload.get("type") == "delta":
            n_deltas += 1
        elif payload.get("type") == "final":
            saw_final = True
            final_content = (payload.get("message") or {}).get("content", "")
            usage = payload.get("usage")
    return final_content, usage, n_deltas, saw_final


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", required=True, help="App base URL, no trailing slash")
    ap.add_argument("--profile", default=None, help="Databricks CLI profile for bearer token (omit for local)")
    ap.add_argument("--models", nargs="*", default=None, help="Restrict chat tests to these model names")
    ap.add_argument("--timeout", type=int, default=120)
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

        content, usage, n_deltas, saw_final = parse_sse(raw)
        out_tok = (usage or {}).get("output_tokens")
        text = (content or "").strip()
        # A model that burned many output tokens but returned little text = reasoning discarded.
        reasoning_gap = out_tok is not None and out_tok > 15 and len(text) < 8
        if not saw_final:
            verdict = "NOFIN"; failures += 1
        elif not text:
            verdict = "EMPTY"; failures += 1
        elif dt > SLOW_SECONDS:
            verdict = " SLOW"
        else:
            verdict = "  OK"
        note = f"out_tok={out_tok}" + (" REASONING-GAP" if reasoning_gap else "")
        log(verdict, f"{name:<42} {dt:6.2f}s deltas={n_deltas} len={len(text):<4} {note} :: {text[:40]!r}")

    print("-" * 78)
    log("done", f"{failures} failure(s). SLOW threshold={SLOW_SECONDS}s "
                 f"(SLOW/NOFIN/REASONING-GAP point at the synchronous-query design).")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
