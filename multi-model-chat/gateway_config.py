"""Idempotent Unity AI Gateway setup for the chat serving endpoint.

Run this once per environment (manually, or as a bundle post-deploy step) to turn on the
governance features the app surfaces:

  * Guardrails       — PII masking + safety filtering on inputs and outputs.
  * Rate limits      — per-user request cap (protects cost / SLA).
  * Usage tracking   — populates system.serving.endpoint_usage (the dashboard's source).
  * Inference table  — payload logging to a UC table (optional; needs a catalog/schema).
  * Fallback         — round-robins to a second served entity on 5xx (the resilience demo).

Every feature is applied best-effort and independently: on a workspace where a feature is
gated (e.g. Free Edition), that one is skipped with a logged warning rather than aborting.

Usage:
    python gateway_config.py --endpoint <serving-endpoint-name> \
        [--rate-limit 60] [--payload-catalog main --payload-schema default] \
        [--secondary-entity <served_model_name>]
"""
from __future__ import annotations

import argparse
import sys

from databricks.sdk import WorkspaceClient
from databricks.sdk.service.serving import (
    AiGatewayGuardrailParameters,
    AiGatewayGuardrailPiiBehavior,
    AiGatewayGuardrailPiiBehaviorBehavior,
    AiGatewayGuardrails,
    AiGatewayInferenceTableConfig,
    AiGatewayRateLimit,
    AiGatewayRateLimitKey,
    AiGatewayRateLimitRenewalPeriod,
    AiGatewayUsageTrackingConfig,
    FallbackConfig,
)


def configure(
    endpoint: str,
    rate_limit: int,
    payload_catalog: str | None,
    payload_schema: str | None,
) -> None:
    w = WorkspaceClient()

    guardrail_params = AiGatewayGuardrailParameters(
        pii=AiGatewayGuardrailPiiBehavior(behavior=AiGatewayGuardrailPiiBehaviorBehavior.MASK),
        safety=True,
    )
    kwargs: dict = {
        "guardrails": AiGatewayGuardrails(input=guardrail_params, output=guardrail_params),
        "rate_limits": [
            AiGatewayRateLimit(
                calls=rate_limit,
                key=AiGatewayRateLimitKey.USER,
                renewal_period=AiGatewayRateLimitRenewalPeriod.MINUTE,
            )
        ],
        "usage_tracking_config": AiGatewayUsageTrackingConfig(enabled=True),
        "fallback_config": FallbackConfig(enabled=True),
    }
    if payload_catalog and payload_schema:
        kwargs["inference_table_config"] = AiGatewayInferenceTableConfig(
            catalog_name=payload_catalog,
            schema_name=payload_schema,
            table_name_prefix="mmc_payload",
            enabled=True,
        )

    # Peel one feature at a time (most-likely-gated first) so a single unsupported feature
    # doesn't sink the ones the workspace does allow.
    peel_order = ["fallback_config", "inference_table_config", "guardrails", "rate_limits"]
    while True:
        try:
            w.serving_endpoints.put_ai_gateway(name=endpoint, **kwargs)
            applied = sorted(k for k in kwargs if kwargs[k] is not None)
            print(f"[ok] AI Gateway configured on '{endpoint}'. Features applied: {applied}")
            return
        except Exception as exc:  # noqa: BLE001
            dropped = next((k for k in peel_order if k in kwargs), None)
            print(f"[warn] put_ai_gateway failed: {exc}")
            if dropped is None:
                print(f"[error] Could not configure AI Gateway on '{endpoint}'.", file=sys.stderr)
                sys.exit(1)
            kwargs.pop(dropped, None)
            print(f"[info] retrying without '{dropped}'…")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--endpoint", required=True, help="Serving endpoint name")
    ap.add_argument("--rate-limit", type=int, default=60, help="Calls/minute per user")
    ap.add_argument("--payload-catalog", default=None)
    ap.add_argument("--payload-schema", default=None)
    ap.add_argument(
        "--secondary-entity",
        default=None,
        help="If set, print the update_config snippet needed to enable a fallback target.",
    )
    args = ap.parse_args()

    configure(args.endpoint, args.rate_limit, args.payload_catalog, args.payload_schema)

    if args.secondary_entity:
        print(
            "\nFallback demo: add a second served entity and 0%%-traffic route so the endpoint\n"
            "has a target to fail over to, e.g.:\n\n"
            "    from databricks.sdk.service.serving import TrafficConfig, Route\n"
            "    w.serving_endpoints.update_config(\n"
            f"        name='{args.endpoint}',\n"
            "        served_entities=[<primary>, <secondary>],\n"
            "        traffic_config=TrafficConfig(routes=[\n"
            "            Route(served_model_name=<primary>, traffic_percentage=100),\n"
            f"            Route(served_model_name='{args.secondary_entity}', traffic_percentage=0),\n"
            "        ]),\n"
            "    )\n"
            "Then break/rate-limit the primary to see the fallback serve the reply.\n"
        )


if __name__ == "__main__":
    main()
