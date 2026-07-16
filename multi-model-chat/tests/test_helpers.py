"""Unit tests for the pure helpers in app.py (no Databricks workspace required).

app.py builds its WorkspaceClient defensively (None when there is no ambient auth), so the
module imports cleanly here and we can exercise the parsing/formatting logic directly.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import app  # noqa: E402


class FakeRequest:
    def __init__(self, headers):
        self._headers = headers

    @property
    def headers(self):
        class _H:
            def __init__(self, h):
                self._h = h

            def get(self, key, default=""):
                return self._h.get(key, default)

        return _H(self._headers)


def test_extract_text_content_variants():
    assert app._extract_text_content("hello") == "hello"
    assert app._extract_text_content([{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]) == "ab"
    assert app._extract_text_content({"content": "nested"}) == "nested"
    assert app._extract_text_content(None) == ""


def test_extract_response_text_prefers_choices():
    result = {"choices": [{"message": {"content": "answer"}}]}
    assert app._extract_response_text(result) == "answer"


def test_extract_response_text_falls_back_to_json():
    assert app._extract_response_text({"weird": 1}) == '{"weird": 1}'


def test_extract_usage_normalizes_keys():
    assert app._extract_usage({"usage": {"prompt_tokens": 3, "completion_tokens": 5}}) == {
        "input_tokens": 3,
        "output_tokens": 5,
        "total_tokens": 8,
    }
    # total defaults to sum when absent
    assert app._extract_usage({"usage": {"input_tokens": 2, "output_tokens": 2}})["total_tokens"] == 4


def test_is_llm_endpoint_matches_chat_indicators():
    assert app._is_llm_endpoint({"name": "databricks-gpt-oss", "endpoint_type": "CHAT"}) is True
    assert app._is_llm_endpoint({"name": "bge-embeddings", "endpoint_type": "EMBEDDING"}) is False


def test_format_model_titlecases_label():
    formatted = app._format_model({"name": "my_endpoint", "config": {}})
    assert formatted["name"] == "my_endpoint"
    assert formatted["label"] == "My Endpoint"


def test_chunk_text_splits_and_never_empty():
    assert app._chunk_text("abcdef", 2) == ["ab", "cd", "ef"]
    assert app._chunk_text("") == [""]


def test_user_from_request_admin_via_group():
    user = app._user_from_request(
        FakeRequest({"x-forwarded-email": "a@b.com", "x-forwarded-groups": "users, admins"})
    )
    assert user["isAdmin"] is True
    assert user["email"] == "a@b.com"


def test_user_from_request_non_admin():
    user = app._user_from_request(FakeRequest({"x-forwarded-email": "a@b.com", "x-forwarded-groups": "users"}))
    assert user["isAdmin"] is False


def test_looks_like_guardrail_detects_safety_block():
    guardrail = app._looks_like_guardrail("Request blocked by safety guardrail: PII detected")
    assert guardrail is not None
    assert guardrail["blocked"] is True
    assert app._looks_like_guardrail("connection timeout") is None


def test_detect_fallback_uses_primary_env(monkeypatch):
    monkeypatch.setenv("AI_GATEWAY_PRIMARY_ENTITY", "primary-model")
    assert app._detect_fallback({"model": "primary-model"}) is None
    fallback = app._detect_fallback({"model": "secondary-model"})
    assert fallback == {"used": True, "requested_model": "primary-model", "served_model": "secondary-model"}
