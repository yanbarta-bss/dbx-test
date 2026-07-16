"""Make the test import of app.py hermetic and fast.

app.py constructs a WorkspaceClient at import time. With no ambient Databricks auth the SDK
can block on network metadata resolution, so we stub the client to raise immediately — app.py
catches that and sets ``workspace = None``, which is exactly the path the pure helpers need.
"""
import databricks.sdk


class _NoWorkspaceClient:
    def __init__(self, *args, **kwargs):
        raise RuntimeError("WorkspaceClient is unavailable in unit tests")


databricks.sdk.WorkspaceClient = _NoWorkspaceClient
