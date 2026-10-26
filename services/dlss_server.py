from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the DLSS 5 Visual Enhancer Gradio UI as an embedded Gendo service.")
    parser.add_argument("--project", required=True, help="Path to the DLSS 5 Visual Enhancer install")
    parser.add_argument("--port", required=True, type=int, help="Local port to bind")
    args = parser.parse_args()

    project = Path(args.project).resolve()
    app_path = project / "app.py"
    if not app_path.exists():
        raise SystemExit(f"DLSS app.py not found at {app_path}")

    os.chdir(project)
    sys.path.insert(0, str(project))

    os.environ.setdefault("GRADIO_ANALYTICS_ENABLED", "False")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    os.environ.setdefault("PYTHONNOUSERSITE", "1")
    os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")

    import gradio as gr
    import app as dlss_app
    from src.core.paths import OUTPUTS

    demo = dlss_app.build_app()
    demo.queue(default_concurrency_limit=1).launch(
        css=dlss_app.APP_CSS,
        theme=gr.themes.Ocean(),
        server_name="127.0.0.1",
        server_port=args.port,
        inbrowser=False,
        share=False,
        allowed_paths=[str(OUTPUTS.resolve())],
        show_error=True,
        quiet=True,
    )


if __name__ == "__main__":
    main()
