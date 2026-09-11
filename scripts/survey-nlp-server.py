#!/usr/bin/env python3
"""Loopback-only, offline HanLP tokenization service for survey statistics."""

from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable

MODEL_ID = "COARSE_ELECTRA_SMALL_ZH:20220616"
MAX_RESPONSES = 24
MAX_CHARACTERS = 12_000
# Includes worst-case JSON escaping of astral Unicode characters and envelope.
MAX_BODY_BYTES = 160_000
MAX_PENDING_INFERENCES = 8
Tokenizer = Callable[..., list[list[str]]]


class InvalidRequest(ValueError):
    pass


class ServiceBusy(RuntimeError):
    pass


def validate_payload(payload: object) -> list[str]:
    if not isinstance(payload, dict) or set(payload) != {"responses"}:
        raise InvalidRequest("INVALID_REQUEST")
    responses = payload["responses"]
    if (not isinstance(responses, list) or len(responses) > MAX_RESPONSES
            or any(not isinstance(text, str) for text in responses)):
        raise InvalidRequest("INVALID_REQUEST")
    if sum(len(text) for text in responses) > MAX_CHARACTERS:
        raise InvalidRequest("REQUEST_TOO_LARGE")
    try:
        for text in responses:
            text.encode("utf-8", errors="strict")
    except UnicodeError:
        raise InvalidRequest("INVALID_REQUEST") from None
    return responses


class TokenizerRuntime:
    def __init__(self, tokenizer: Tokenizer, model: str = MODEL_ID):
        self.tokenizer = tokenizer
        self.model = model
        self.lock = threading.Lock()
        self.pending = threading.BoundedSemaphore(MAX_PENDING_INFERENCES)

    def tokenize(self, responses: list[str]) -> list[list[str]]:
        result: list[list[str]] = [[] for _ in responses]
        nonempty = [(index, text) for index, text in enumerate(responses) if text.strip()]
        if not nonempty:
            return result
        if not self.pending.acquire(blocking=False):
            raise ServiceBusy("SERVICE_BUSY")
        try:
            # HanLP's mutable dataset transforms and CPU model share one inference lane.
            with self.lock:
                tokens = self.tokenizer([text for _, text in nonempty], batch_size=8)
            if not isinstance(tokens, list) or len(tokens) != len(nonempty):
                raise RuntimeError("INVALID_MODEL_OUTPUT")
            for (index, source), words in zip(nonempty, tokens):
                if (not isinstance(words, list) or len(words) > len(source)
                        or any(not isinstance(word, str) or not word
                               or len(word) > MAX_CHARACTERS for word in words)
                        or sum(len(word) for word in words) > MAX_CHARACTERS):
                    raise RuntimeError("INVALID_MODEL_OUTPUT")
                result[index] = words
            return result
        finally:
            self.pending.release()


class SurveyNlpServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 16

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(10)
        return connection, address


def create_server(tokenizer: Tokenizer, *, port: int = 3003,
                  model: str = MODEL_ID) -> SurveyNlpServer:
    """Create a loopback server; port=0 and an injected tokenizer support unit tests."""
    runtime = TokenizerRuntime(tokenizer, model)

    class Handler(BaseHTTPRequestHandler):
        server_version = "SurveyNLP"
        sys_version = ""

        def log_message(self, _format, *_args):
            # Responses and request paths must never be copied into access logs.
            pass

        def send_json(self, status: int, value: dict):
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
            self.send_json(200, {"status": "ok", "model": runtime.model})

        def do_POST(self):
            if self.path != "/tokenize":
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
                responses = validate_payload(json.loads(raw.decode("utf-8")))
            except (InvalidRequest, ValueError, UnicodeError, OSError, RecursionError):
                self.send_json(400, {"error": "INVALID_REQUEST"})
                return
            try:
                tokens = runtime.tokenize(responses)
                self.send_json(200, {"tokens": tokens, "model": runtime.model})
            except ServiceBusy:
                self.send_json(503, {"error": "SERVICE_BUSY"})
            except Exception:
                self.send_json(500, {"error": "TOKENIZATION_FAILED"})

    return SurveyNlpServer(("127.0.0.1", port), Handler)


def load_local_tokenizer() -> Tokenizer:
    """Fail on missing local assets; startup never downloads weights or tokenizers."""
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_DATASETS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    model_path = os.environ.get("OPENPBL_NLP_MODEL_PATH", "")
    if not model_path or not Path(model_path).is_dir():
        raise RuntimeError("LOCAL_MODEL_REQUIRED")
    model_directory = Path(model_path).resolve()
    if not (model_directory / "config.json").is_file():
        raise RuntimeError("LOCAL_MODEL_INCOMPLETE")

    import torch
    import hanlp
    import hanlp.utils.io_util

    def refuse_download(*_args, **_kwargs):
        raise RuntimeError("LOCAL_MODEL_RESOURCE_MISSING")

    # HanLP's own resource downloader is independent of Hugging Face offline mode.
    hanlp.utils.io_util.download = refuse_download
    torch.set_num_threads(2)
    torch.set_num_interop_threads(2)
    tokenizer = hanlp.load(str(model_directory), devices=-1, verbose=False)
    # Use the model's native sliding windows instead of silently truncating long answers.
    tokenizer.tokenizer_transform.truncate_long_sequences = False
    tokenizer.tokenizer_transform.max_seq_length = 512
    TokenizerRuntime(tokenizer).tokenize(["分词服务启动检查。"])
    return tokenizer


def main() -> int:
    try:
        tokenizer = load_local_tokenizer()
        server = create_server(tokenizer)
    except Exception:
        print("Survey NLP startup failed: check the configured local model and runtime.", flush=True)
        return 1
    print(f"Survey NLP ready: {MODEL_ID} on 127.0.0.1:3003", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
