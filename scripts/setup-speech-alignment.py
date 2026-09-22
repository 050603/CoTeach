#!/usr/bin/env python3
"""Install the pinned Qwen3 forced-aligner runtime and model snapshot."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys


PROJECT_ROOT = Path(__file__).resolve().parent.parent
RUNTIME_ROOT = PROJECT_ROOT / ".openpbl-runtime"
VENV_ROOT = RUNTIME_ROOT / "speech-alignment-venv"
MODEL_ROOT = RUNTIME_ROOT / "speech-alignment-models" / "Qwen3-ForcedAligner-0.6B"
MODEL_ID = "Qwen/Qwen3-ForcedAligner-0.6B"
MODEL_REVISION = "c7cbfc2048c462b0d63a45797104fc9db3ad62b7"
QWEN_ASR_VERSION = "0.0.6"
REVISION_FILE = ".openpbl-model-revision"
REQUIRED_MODEL_FILES = (
    "config.json",
    "model.safetensors",
    "preprocessor_config.json",
    "tokenizer_config.json",
)


def required_model_files_exist() -> bool:
    try:
        return all((MODEL_ROOT / name).is_file() and (MODEL_ROOT / name).stat().st_size > 0
                   for name in REQUIRED_MODEL_FILES) and (
            MODEL_ROOT / REVISION_FILE
        ).read_text(encoding="ascii").strip() == MODEL_REVISION
    except (OSError, UnicodeError):
        return False


def install_runtime() -> Path:
    RUNTIME_ROOT.mkdir(parents=True, exist_ok=True)
    if not (VENV_ROOT / "bin" / "python").is_file():
        subprocess.run([sys.executable, "-m", "venv", str(VENV_ROOT)], check=True)
    python = VENV_ROOT / "bin" / "python"
    subprocess.run([
        str(python), "-m", "pip", "install", "--disable-pip-version-check",
        "-r", str(PROJECT_ROOT / "deploy" / "speech-alignment-requirements.txt"),
    ], check=True)
    # qwen-asr's declared dependencies include its optional Gradio/Flask demos.
    # The forced-aligner imports are covered by the pinned runtime above.
    subprocess.run([
        str(python), "-m", "pip", "install", "--disable-pip-version-check",
        "--no-deps", f"qwen-asr=={QWEN_ASR_VERSION}",
    ], check=True)
    return python


def install_model(python: Path) -> None:
    if required_model_files_exist():
        print(f"Reusing pinned speech alignment model: {MODEL_REVISION}", flush=True)
        return
    MODEL_ROOT.mkdir(parents=True, exist_ok=True)
    download = """
from huggingface_hub import snapshot_download
import sys
snapshot_download(
    repo_id=sys.argv[1],
    revision=sys.argv[2],
    local_dir=sys.argv[3],
)
"""
    subprocess.run([
        str(python), "-c", download, MODEL_ID, MODEL_REVISION, str(MODEL_ROOT),
    ], check=True, timeout=1800)
    (MODEL_ROOT / REVISION_FILE).write_text(f"{MODEL_REVISION}\n", encoding="ascii")
    if not required_model_files_exist():
        raise RuntimeError("Pinned model snapshot is incomplete.")


def verify_runtime(python: Path) -> None:
    environment = os.environ.copy()
    environment.update({
        "OPENPBL_ALIGNMENT_MODEL_PATH": str(MODEL_ROOT),
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "HF_DATASETS_OFFLINE": "1",
    })
    verification = """
import importlib.util
import sys
spec = importlib.util.spec_from_file_location('speech_alignment_server', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
_align, _decode, device = module.load_local_runtime()
print('Speech alignment runtime verification passed: ' + module.ALIGNMENT_VERSION + ' (' + device + ')')
"""
    subprocess.run([
        str(python), "-c", verification,
        str(PROJECT_ROOT / "scripts" / "speech-alignment-server.py"),
    ], env=environment, check=True, timeout=600)


def main() -> int:
    python = install_runtime()
    install_model(python)
    verify_runtime(python)
    print(f"Speech alignment installation ready: {VENV_ROOT}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
