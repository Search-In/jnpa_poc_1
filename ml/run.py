#!/usr/bin/env python
"""
JNPA UC-1 Vessel Traffic Management — single entry point.

    python run.py models              run all eight UC-1 models over the sample input
    python run.py models -m m3        run one model
    python run.py predict             M3 only (TAT / ETB / ETD), detailed report
    python run.py train               retrain the M3 TAT artifact
    python run.py input               validate an input spreadsheet
    python run.py dsr                 re-extract berth stays from the DSR corpus
    python run.py serve               start the UC-1 FastAPI service on :8000
                                      (the web app runs it on :8100 — JNPA_PORT)

UC-2 (cargo handling) is NOT part of this repository. This is the UC-1 vessel
traffic PoC, and the only models it serves are the eight in src/uc1_models/. The
UC-2 models, their corpus readers and their :8200 service live in the WS2 model
delivery; nothing here imports them.

Everything after the sub-command is passed through unchanged, so the flags
documented in docs/RUNBOOK.md still apply:

    python run.py models -i data/input/Vessel_Training_Input_Sample.xlsx -o out

This file exists so the source tree can live in src/ without every caller
having to set PYTHONPATH.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "src", "pipeline"))

import jnpa_paths  # noqa: E402

jnpa_paths.ensure_on_syspath()

COMMANDS = {
    "models": ("run_model", "run all eight UC-1 models"),
    "predict": ("predict", "M3 turnaround-time prediction only"),
    "train": ("train_tat_model", "retrain the M3 TAT artifact"),
    "input": ("jnpa_input", "validate / inspect an input spreadsheet"),
    "dsr": ("dsr_extract", "extract berth stays from the DSR corpus"),
}

# sub-command -> (uvicorn target, default port)
SERVERS = {
    "serve": ("api:app", 8000, "UC-1 vessel traffic"),
}


def _usage() -> int:
    print(__doc__.strip())
    print("\nsub-commands:")
    for name, (_, help_text) in COMMANDS.items():
        print(f"  {name:<11}{help_text}")
    for name, (_, port, label) in SERVERS.items():
        print(f"  {name:<11}start the {label} FastAPI service on :{port}")
    return 2


def main(argv: list) -> int:
    if not argv or argv[0] in ("-h", "--help", "help"):
        return _usage()

    cmd, rest = argv[0], argv[1:]

    if cmd in SERVERS:
        import uvicorn  # imported here so the other commands do not need FastAPI

        target, default_port, _label = SERVERS[cmd]
        host = os.environ.get("JNPA_HOST", "127.0.0.1")
        # JNPA_PORT overrides whichever service is being started; the two
        # services have different defaults so the env var is read per command.
        port = int(os.environ.get("JNPA_PORT", str(default_port)))
        uvicorn.run(target, host=host, port=port, reload="--reload" in rest)
        return 0

    if cmd not in COMMANDS:
        print(f"unknown sub-command {cmd!r}\n")
        return _usage()

    module_name = COMMANDS[cmd][0]
    module = __import__(module_name)
    return int(module.main(rest) or 0)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
