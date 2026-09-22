#!/usr/bin/env python3
"""Loopback-only Qwen3 forced-alignment service for classroom narration."""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Iterable
import unicodedata


MODEL_ID = "Qwen/Qwen3-ForcedAligner-0.6B"
MODEL_REVISION = "c7cbfc2048c462b0d63a45797104fc9db3ad62b7"
ALIGNMENT_VERSION = f"qwen3-forced-aligner-0.6b:{MODEL_REVISION}:fp32:v1"
SAMPLE_RATE = 16_000
MAX_AUDIO_SECONDS = 300
MAX_AUDIO_BYTES = 256 * 1024 * 1024
MAX_TEXT_CHARACTERS = 20_000
MAX_PATH_CHARACTERS = 4_096
MAX_BODY_BYTES = 96_000
SUPPORTED_LANGUAGES = {
    "Chinese", "Cantonese", "English", "German", "Spanish", "French",
    "Italian", "Portuguese", "Russian", "Korean", "Japanese",
}

Decoder = Callable[[Path], tuple[Any, int, float]]
Aligner = Callable[[tuple[Any, int], str, str], Iterable[Any]]


class InvalidRequest(ValueError):
    pass


class InvalidAlignment(RuntimeError):
    pass


class ServiceBusy(RuntimeError):
    pass


def utf16_offset(text: str, character_offset: int) -> int:
    return len(text[:character_offset].encode("utf-16-le")) // 2


def _is_alignment_character(character: str) -> bool:
    return character == "'" or unicodedata.category(character).startswith(("L", "N"))


def _searchable_units(text: str) -> list[tuple[str, int, int]]:
    units: list[tuple[str, int, int]] = []
    for index, character in enumerate(text):
        if not _is_alignment_character(character):
            continue
        normalized = unicodedata.normalize("NFKC", character).casefold()
        units.extend((part, index, index + 1) for part in normalized if _is_alignment_character(part))
    return units


def _token_key(text: str) -> str:
    normalized = unicodedata.normalize("NFKC", text).casefold()
    return "".join(character for character in normalized if _is_alignment_character(character))


def map_tokens_to_source(text: str, tokens: Iterable[dict[str, Any]], duration_ms: int) -> list[dict[str, Any]]:
    """Map the aligner's punctuation-free tokens back to exact source offsets."""
    units = _searchable_units(text)
    unit_cursor = 0
    previous_start_ms = 0
    spans: list[dict[str, Any]] = []

    for raw in tokens:
        token_text = raw.get("text")
        start_seconds = raw.get("start_time")
        end_seconds = raw.get("end_time")
        if (not isinstance(token_text, str) or not token_text
                or isinstance(start_seconds, bool) or not isinstance(start_seconds, (int, float))
                or isinstance(end_seconds, bool) or not isinstance(end_seconds, (int, float))
                or not math.isfinite(start_seconds) or not math.isfinite(end_seconds)):
            raise InvalidAlignment("INVALID_MODEL_OUTPUT")

        key = _token_key(token_text)
        if not key:
            raise InvalidAlignment("UNMAPPABLE_TOKEN")
        key_characters = list(key)
        match_index = -1
        last_candidate = len(units) - len(key_characters)
        for candidate in range(unit_cursor, last_candidate + 1):
            if [unit[0] for unit in units[candidate:candidate + len(key_characters)]] == key_characters:
                match_index = candidate
                break
        if match_index < 0:
            raise InvalidAlignment("UNMAPPABLE_TOKEN")

        matched = units[match_index:match_index + len(key_characters)]
        source_start = matched[0][1]
        source_end = matched[-1][2]
        unit_cursor = match_index + len(key_characters)
        start_ms = round(float(start_seconds) * 1000)
        end_ms = round(float(end_seconds) * 1000)
        if (start_ms < previous_start_ms or end_ms < start_ms or start_ms < 0
                or end_ms > duration_ms + 1_000):
            raise InvalidAlignment("INVALID_TIMESTAMPS")
        previous_start_ms = start_ms
        spans.append({
            "text": token_text,
            "startChar": utf16_offset(text, source_start),
            "endChar": utf16_offset(text, source_end),
            "startMs": start_ms,
            "endMs": end_ms,
        })

    if not spans:
        raise InvalidAlignment("EMPTY_ALIGNMENT")
    return spans


def validate_payload(payload: object) -> tuple[Path, str, str]:
    if not isinstance(payload, dict) or set(payload) != {"audioPath", "text", "language"}:
        raise InvalidRequest("INVALID_REQUEST")
    audio_path = payload["audioPath"]
    text = payload["text"]
    language = payload["language"]
    if (not isinstance(audio_path, str) or not 0 < len(audio_path) <= MAX_PATH_CHARACTERS
            or not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_CHARACTERS
            or not isinstance(language, str) or language not in SUPPORTED_LANGUAGES):
        raise InvalidRequest("INVALID_REQUEST")
    try:
        text.encode("utf-8", errors="strict")
        candidate = Path(audio_path)
        if not candidate.is_absolute():
            raise InvalidRequest("INVALID_REQUEST")
        resolved = candidate.resolve(strict=True)
        info = resolved.stat()
    except (OSError, UnicodeError, RuntimeError):
        raise InvalidRequest("INVALID_AUDIO") from None
    if not info.st_size or info.st_size > MAX_AUDIO_BYTES or not resolved.is_file():
        raise InvalidRequest("INVALID_AUDIO")
    return resolved, text, language


class AlignmentRuntime:
    def __init__(self, aligner: Aligner, decoder: Decoder, *, device: str):
        self.aligner = aligner
        self.decoder = decoder
        self.device = device
        self.inference_lane = threading.BoundedSemaphore(1)

    def align(self, audio_path: Path, text: str, language: str) -> tuple[int, list[dict[str, Any]]]:
        if not self.inference_lane.acquire(blocking=False):
            raise ServiceBusy("SERVICE_BUSY")
        try:
            waveform, sample_rate, duration_seconds = self.decoder(audio_path)
            if (sample_rate != SAMPLE_RATE or not math.isfinite(duration_seconds)
                    or duration_seconds <= 0 or duration_seconds > MAX_AUDIO_SECONDS):
                raise InvalidRequest("UNSUPPORTED_AUDIO_DURATION")
            duration_ms = round(duration_seconds * 1000)
            raw_tokens = []
            for item in self.aligner((waveform, sample_rate), text, language):
                if isinstance(item, dict):
                    raw_tokens.append(item)
                else:
                    raw_tokens.append({
                        "text": getattr(item, "text", None),
                        "start_time": getattr(item, "start_time", None),
                        "end_time": getattr(item, "end_time", None),
                    })
            return duration_ms, map_tokens_to_source(text, raw_tokens, duration_ms)
        finally:
            self.inference_lane.release()


class SpeechAlignmentServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 8

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(15)
        return connection, address


def create_server(aligner: Aligner, decoder: Decoder, *, device: str = "cpu", port: int = 3004) -> SpeechAlignmentServer:
    """Create the loopback server; injected functions and port=0 support tests."""
    runtime = AlignmentRuntime(aligner, decoder, device=device)

    class Handler(BaseHTTPRequestHandler):
        server_version = "SpeechAlignment"
        sys_version = ""

        def log_message(self, _format, *_args):
            # Paths and narration text must never appear in access logs.
            pass

        def send_json(self, status: int, value: dict[str, Any]):
            body = json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode("ascii")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            try:
                self.wfile.write(body)
            except (OSError, socket.timeout):
                pass

        def send_error(self, code, message=None, explain=None):
            self.send_json(code, {"error": "INVALID_REQUEST"})

        def do_GET(self):
            if self.path != "/health/live":
                self.send_json(404, {"error": "NOT_FOUND"})
                return
            self.send_json(200, {
                "status": "ok",
                "model": MODEL_ID,
                "revision": MODEL_REVISION,
                "version": ALIGNMENT_VERSION,
                "device": runtime.device,
            })

        def do_POST(self):
            if self.path != "/align":
                self.send_json(404, {"error": "NOT_FOUND"})
                return
            try:
                lengths = self.headers.get_all("Content-Length") or []
                if (len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit()
                        or self.headers.get("Transfer-Encoding")
                        or self.headers.get_content_type() != "application/json"):
                    raise InvalidRequest("INVALID_REQUEST")
                length = int(lengths[0])
                if not 0 < length <= MAX_BODY_BYTES:
                    raise InvalidRequest("REQUEST_TOO_LARGE")
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise InvalidRequest("INVALID_REQUEST")
                audio_path, text, language = validate_payload(json.loads(raw.decode("utf-8")))
                duration_ms, spans = runtime.align(audio_path, text, language)
            except InvalidRequest as error:
                self.send_json(400, {"error": str(error)})
                return
            except (ValueError, UnicodeError, OSError, RecursionError):
                self.send_json(400, {"error": "INVALID_REQUEST"})
                return
            except ServiceBusy:
                self.send_json(503, {"error": "SERVICE_BUSY"})
                return
            except InvalidAlignment as error:
                self.send_json(422, {"error": str(error)})
                return
            except Exception:
                self.send_json(500, {"error": "ALIGNMENT_FAILED"})
                return
            self.send_json(200, {
                "model": MODEL_ID,
                "revision": MODEL_REVISION,
                "version": ALIGNMENT_VERSION,
                "device": runtime.device,
                "durationMs": duration_ms,
                "spans": spans,
            })

    return SpeechAlignmentServer(("127.0.0.1", port), Handler)


def select_torch_device(torch) -> str:
    """Use CUDA only when the wheel supports the GPU and a real FP32 kernel runs."""
    if os.environ.get("OPENPBL_ALIGNMENT_FORCE_CPU") == "1" or not torch.cuda.is_available():
        return "cpu"
    try:
        major, minor = torch.cuda.get_device_capability(0)
        architecture = f"sm_{major}{minor}"
        available_architectures = set(torch.cuda.get_arch_list())
        # PyTorch's cu118 wheel lists sm_60 rather than sm_61, while NVIDIA's
        # Pascal minor-version compatibility lets that cubin run on TITAN Xp.
        pascal_compatible = architecture == "sm_61" and "sm_60" in available_architectures
        if architecture not in available_architectures and not pascal_compatible:
            return "cpu"
        # A real FP32 kernel catches wheel/driver mismatches before model loading.
        value = torch.ones(1, dtype=torch.float32, device="cuda:0") * 2
        if float(value.cpu().item()) != 2.0:
            return "cpu"
        return "cuda:0"
    except Exception:
        return "cpu"


def load_local_runtime() -> tuple[Aligner, Decoder, str]:
    """Load the pinned local model in FP32, falling back to CPU on GPU failure."""
    os.environ.update({
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "HF_DATASETS_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "TOKENIZERS_PARALLELISM": "false",
    })
    model_path = os.environ.get("OPENPBL_ALIGNMENT_MODEL_PATH", "")
    if not model_path or not Path(model_path).is_dir():
        raise RuntimeError("LOCAL_MODEL_REQUIRED")
    model_directory = Path(model_path).resolve()
    if not all((model_directory / name).is_file() for name in ("config.json", "model.safetensors")):
        raise RuntimeError("LOCAL_MODEL_INCOMPLETE")

    import librosa
    import numpy
    import torch
    from qwen_asr import Qwen3ForcedAligner

    device = select_torch_device(torch)

    def load(device_name: str):
        return Qwen3ForcedAligner.from_pretrained(
            str(model_directory),
            dtype=torch.float32,
            device_map=device_name,
            attn_implementation="eager",
            local_files_only=True,
        )

    try:
        model = load(device)
    except Exception:
        if device == "cpu":
            raise
        torch.cuda.empty_cache()
        device = "cpu"
        model = load(device)

    def decode(audio_path: Path) -> tuple[Any, int, float]:
        waveform, sample_rate = librosa.load(str(audio_path), sr=SAMPLE_RATE, mono=True)
        if (sample_rate != SAMPLE_RATE or waveform.ndim != 1 or not waveform.size
                or waveform.size > SAMPLE_RATE * MAX_AUDIO_SECONDS
                or not numpy.isfinite(waveform).all()):
            raise InvalidRequest("INVALID_AUDIO")
        waveform = numpy.asarray(waveform, dtype=numpy.float32)
        return waveform, sample_rate, waveform.size / sample_rate

    def align(audio: tuple[Any, int], text: str, language: str) -> Iterable[Any]:
        results = model.align(audio=audio, text=text, language=language)
        if not isinstance(results, list) or len(results) != 1:
            raise InvalidAlignment("INVALID_MODEL_OUTPUT")
        return results[0]

    return align, decode, device


def main() -> int:
    try:
        aligner, decoder, device = load_local_runtime()
        port = int(os.environ.get("OPENPBL_ALIGNMENT_PORT", "3004"))
        if not 1 <= port <= 65535:
            raise ValueError("INVALID_PORT")
        server = create_server(aligner, decoder, device=device, port=port)
    except Exception as error:
        print(f"Speech alignment startup failed: {type(error).__name__}", flush=True)
        return 1
    print(f"Speech alignment ready: {ALIGNMENT_VERSION} on 127.0.0.1:{port} ({device})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
