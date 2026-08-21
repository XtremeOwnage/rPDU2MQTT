#!/usr/bin/env python3
"""Clear the long-term statistics Home Assistant recorded for this bridge's energy sensors.

Why this exists
---------------
Until the fix in #402, a tier's `energy` field was published as 0 whenever nothing determined it. Those
sensors are declared `state_class: total_increasing`, and Home Assistant reads a drop to zero as a meter
reset — so the next real reading was recorded as a delta from zero and a whole lifetime counter landed on
one day. The result is an Energy dashboard showing megawatt-hours a day against a house using tens of
kilowatt-hours.

Fixing the publisher stops new corruption. It cannot repair what the recorder already stored: those sums
live in Home Assistant's database. This clears them for the affected entities so the dashboard starts
again from the counters as they are now.

This DELETES statistics history for the entities it names. It cannot be undone. Run it with --dry-run
first, and run it only AFTER a build containing the fix is live, or the corruption simply resumes.

Usage
-----
    pip install websockets
    export HA_URL=http://homeassistant.local:8123
    export HA_TOKEN=<long-lived access token>

    python3 ha-clear-energyflow-statistics.py --dry-run
    python3 ha-clear-energyflow-statistics.py --yes

By default it touches only sensors whose id starts with `sensor.energyflow_` — the ones this bridge
publishes. --prefix narrows or widens that; nothing else in Home Assistant is read or changed.
"""
import argparse
import asyncio
import json
import os
import sys

async def talk(url: str, token: str, prefix: str, apply: bool) -> int:
    # Imported here so --help works on a machine that has not installed it yet.
    try:
        import websockets
    except ImportError:  # pragma: no cover - a setup message, not logic
        sys.exit("This needs the websockets package: pip install websockets")

    ws_url = url.rstrip("/").replace("https://", "wss://").replace("http://", "ws://") + "/api/websocket"
    async with websockets.connect(ws_url, max_size=32 * 1024 * 1024) as ws:
        hello = json.loads(await ws.recv())
        if hello.get("type") != "auth_required":
            sys.exit(f"Unexpected greeting from {ws_url}: {hello}")
        await ws.send(json.dumps({"type": "auth", "access_token": token}))
        auth = json.loads(await ws.recv())
        if auth.get("type") != "auth_ok":
            sys.exit(f"Authentication failed: {auth.get('message', auth)}")

        msg_id = 1

        async def call(payload: dict) -> dict:
            nonlocal msg_id
            payload["id"] = msg_id
            msg_id += 1
            await ws.send(json.dumps(payload))
            while True:
                reply = json.loads(await ws.recv())
                if reply.get("id") == payload["id"] and reply.get("type") == "result":
                    if not reply.get("success", False):
                        sys.exit(f"{payload['type']} failed: {reply.get('error')}")
                    return reply

        listed = await call({"type": "recorder/list_statistic_ids", "statistic_type": "sum"})
        ids = sorted(s["statistic_id"] for s in listed.get("result", [])
                     if str(s.get("statistic_id", "")).startswith(prefix))

        if not ids:
            print(f"No summed statistics found starting with {prefix!r}. Nothing to do.")
            return 0

        print(f"{len(ids)} statistic id(s) starting with {prefix!r}:")
        for sid in ids:
            print(f"  {sid}")

        if not apply:
            print("\nDry run — nothing was changed. Re-run with --yes to clear these.")
            return 0

        await call({"type": "recorder/clear_statistics", "statistic_ids": ids})
        print(f"\nCleared {len(ids)} statistic id(s). The Energy dashboard rebuilds from the counters as "
              "they are read from now on; the days already recorded are gone.")
        return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default=os.environ.get("HA_URL"), help="Home Assistant base URL (env HA_URL)")
    ap.add_argument("--token", default=os.environ.get("HA_TOKEN"), help="Long-lived access token (env HA_TOKEN)")
    ap.add_argument("--prefix", default="sensor.energyflow_", help="Only statistics whose id starts with this")
    ap.add_argument("--dry-run", action="store_true", help="List what would be cleared and stop")
    ap.add_argument("--yes", action="store_true", help="Actually clear them")
    args = ap.parse_args()

    if not args.url or not args.token:
        return ap.error("--url/--token (or HA_URL/HA_TOKEN) are required")
    if args.dry_run == args.yes:
        return ap.error("choose exactly one of --dry-run or --yes")

    return asyncio.run(talk(args.url, args.token, args.prefix, args.yes))


if __name__ == "__main__":
    raise SystemExit(main())
