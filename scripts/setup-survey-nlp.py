#!/usr/bin/env python3
"""Install and verify the offline survey tokenizer without starting a server.

Run with the Python interpreter intended for the service. HTTPS_PROXY and other
standard proxy environment variables are honored; no proxy is configured here.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

PROJECT_ROOT = Path(__file__).resolve().parent.parent
RUNTIME_ROOT = PROJECT_ROOT / ".openpbl-runtime"
VENV_ROOT = RUNTIME_ROOT / "nlp-venv"
MODELS_ROOT = RUNTIME_ROOT / "nlp-models"
MODEL_DIRECTORY = "coarse_electra_small_20220616_012050"
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_UNPACKED_BYTES = 1024 * 1024 * 1024

RESOURCES = (
    {
        "url": "https://ftp.hankcs.com/hanlp/tok/coarse_electra_small_20220616_012050.zip",
        "sha256": "8486bf395e650a66d07b664ade7828ad4f0ab26eb48399152c6ae5f7b64780e1",
        "destination": "",
        "required": tuple(f"{MODEL_DIRECTORY}/{name}" for name in ("config.json", "model.pt", "vocabs.json")),
    },
    {
        "url": "https://ftp.hankcs.com/hanlp/utils/char_table_20210602_202632.json.zip",
        "sha256": "1576a870ee9e43056485677edf82f615e68df66fb1afc6f06964cd6ac35f52d6",
        "destination": "utils",
        "required": ("char_table_20210602_202632.json",),
    },
    {
        "url": "https://ftp.hankcs.com/hanlp/transformers/electra_zh_small_20210706_125427.zip",
        "sha256": "0ba4fef7aaa3354986fe7a6865c85875e4dad6dd5b2de32f94a4c9553dc7c617",
        "destination": "transformers",
        "required": tuple(f"electra_zh_small_20210706_125427/{name}" for name in
                          ("config.json", "tokenizer_config.json", "vocab.txt")),
    },
)


def required_files_exist(directory: Path, names: tuple[str, ...]) -> bool:
    return all((directory / name).is_file() and (directory / name).stat().st_size > 0 for name in names)


def download_verified(url: str, expected_sha256: str, destination: Path) -> None:
    digest = hashlib.sha256()
    downloaded = 0
    request = urllib.request.Request(url, headers={"User-Agent": "CoTeach-survey-nlp-setup"})
    with urllib.request.urlopen(request, timeout=60) as response, destination.open("wb") as output:
        if not response.url.startswith("https://"):
            raise RuntimeError("Resource download redirected to an insecure URL.")
        while chunk := response.read(1024 * 1024):
            downloaded += len(chunk)
            if downloaded > MAX_ARCHIVE_BYTES:
                raise RuntimeError("Resource archive exceeds the size limit.")
            digest.update(chunk)
            output.write(chunk)
    if digest.hexdigest() != expected_sha256:
        raise RuntimeError("Resource SHA256 verification failed.")


def safe_target(directory: Path, member_name: str) -> Path:
    relative = PurePosixPath(member_name)
    if (not member_name or "\\" in member_name or "\x00" in member_name
            or relative.is_absolute() or ".." in relative.parts
            or (relative.parts and ":" in relative.parts[0])):
        raise RuntimeError("Unsafe archive path.")
    root = directory.resolve()
    target = directory.joinpath(*relative.parts)
    if not target.resolve().is_relative_to(root):
        raise RuntimeError("Archive path escapes its destination.")
    current = target
    while current != directory:
        if current.is_symlink():
            raise RuntimeError("Archive destination contains a symbolic link.")
        current = current.parent
    return target


def safe_extract(archive: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as bundle:
        members = bundle.infolist()
        if len(members) > 10_000 or sum(member.file_size for member in members) > MAX_UNPACKED_BYTES:
            raise RuntimeError("Resource archive exceeds unpacked limits.")
        # Validate all paths and modes before writing the first member.
        for member in members:
            safe_target(destination, member.filename)
            mode = member.external_attr >> 16
            file_type = stat.S_IFMT(mode)
            if file_type not in (0, stat.S_IFREG, stat.S_IFDIR):
                raise RuntimeError("Archive contains a link or special file.")
        for member in members:
            target = safe_target(destination, member.filename)
            if member.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(member) as source, target.open("wb") as output:
                shutil.copyfileobj(source, output, length=1024 * 1024)


def install_resource(resource: dict) -> None:
    destination = MODELS_ROOT / resource["destination"]
    if required_files_exist(destination, resource["required"]):
        print(f"Reusing local resource: {resource['required'][0]}", flush=True)
        return
    MODELS_ROOT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".nlp-download-", dir=MODELS_ROOT) as temporary:
        archive = Path(temporary) / "resource.zip"
        print(f"Downloading verified resource: {resource['required'][0]}", flush=True)
        download_verified(resource["url"], resource["sha256"], archive)
        safe_extract(archive, destination)
    if not required_files_exist(destination, resource["required"]):
        raise RuntimeError("The verified archive did not provide the required resource files.")


def install_runtime() -> Path:
    RUNTIME_ROOT.mkdir(parents=True, exist_ok=True)
    subprocess.run([sys.executable, "-m", "venv", "--system-site-packages", str(VENV_ROOT)], check=True)
    python = VENV_ROOT / "bin" / "python"
    installed_torch = subprocess.run([
        str(python), "-c",
        "import importlib.metadata, sys; "
        "sys.exit(importlib.metadata.version('torch').split('+')[0] != '2.9.1')",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    if installed_torch.returncode:
        # Do not let PyPI pull CUDA dependencies when the host has no matching torch.
        subprocess.run([
            str(python), "-m", "pip", "install", "--disable-pip-version-check",
            "--index-url", "https://download.pytorch.org/whl/cpu", "torch==2.9.1",
        ], check=True)
    subprocess.run([
        str(python), "-m", "pip", "install", "--disable-pip-version-check",
        "-r", str(PROJECT_ROOT / "deploy" / "survey-nlp-requirements.txt"),
    ], check=True)
    return python


def verify_offline(python: Path) -> None:
    environment = os.environ.copy()
    environment.update({
        "HANLP_HOME": str(MODELS_ROOT),
        "OPENPBL_NLP_MODEL_PATH": str(MODELS_ROOT / MODEL_DIRECTORY),
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
    })
    verification = """
import importlib.util
import sys
spec = importlib.util.spec_from_file_location('survey_nlp_server', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.load_local_tokenizer()
print('Offline model verification passed: ' + module.MODEL_ID)
"""
    subprocess.run([
        str(python), "-c", verification, str(PROJECT_ROOT / "scripts" / "survey-nlp-server.py"),
    ], env=environment, check=True, timeout=180)


def main() -> int:
    python = install_runtime()
    for resource in RESOURCES:
        install_resource(resource)
    verify_offline(python)
    print(f"Survey NLP installation ready: {VENV_ROOT}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
