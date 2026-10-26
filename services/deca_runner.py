"""Compatibility runner for DECA.

DECA's released FLAME model is a chumpy pickle. The installed deca_py310
environment ships a modern NumPy, which removed aliases that chumpy imports
while unpickling. Inject those aliases before the demo loads the model so the
environment does not need to be downgraded.
"""

from __future__ import annotations

import argparse
import os
import runpy
import sys
from pathlib import Path


def install_numpy_aliases() -> None:
    import numpy as np

    aliases = {
        "bool": bool,
        "int": int,
        "float": float,
        "complex": complex,
        "object": object,
        "str": str,
        "unicode": str,
    }
    for name, value in aliases.items():
        if name not in np.__dict__:
            setattr(np, name, value)


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--project", required=True, help="Path to the DECA install")
    args, demo_args = parser.parse_known_args()

    project = Path(args.project).resolve()
    demo = project / "demos" / "demo_reconstruct.py"
    if not demo.exists():
        raise SystemExit(f"DECA demo not found at {demo}")

    install_numpy_aliases()
    os.chdir(project)
    sys.path.insert(0, str(project))
    sys.argv = [str(demo), *demo_args]
    runpy.run_path(str(demo), run_name="__main__")


if __name__ == "__main__":
    main()
