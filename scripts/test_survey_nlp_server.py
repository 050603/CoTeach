from __future__ import annotations

import concurrent.futures
import http.client
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import Mock, patch


SPEC = importlib.util.spec_from_file_location("survey_nlp_server", Path(__file__).with_name("survey-nlp-server.py"))
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SurveyNlpServerTests(unittest.TestCase):
    def setUp(self):
        self.calls = []

        def tokenize(responses, **kwargs):
            self.calls.append((responses, kwargs))
            return [[text] for text in responses]

        self.server = MODULE.create_server(tokenize, port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, method, path, payload=None, *, raw=None, headers=None):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        body = raw if raw is not None else json.dumps(payload) if payload is not None else None
        connection.request(method, path, body=body, headers=headers or {"Content-Type": "application/json"})
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def test_health_exposes_only_model_identifier(self):
        self.assertEqual(self.server.server_address[0], "127.0.0.1")
        self.assertEqual(self.request("GET", "/health/live"), (200, {"status": "ok", "model": MODULE.MODEL_ID}))
        self.assertEqual(self.calls, [])

    def test_preserves_raw_tokens_and_response_order_including_blanks(self):
        responses = ["ＡＩ Agent", "", "自然语言处理", " \n "]
        self.assertEqual(self.request("POST", "/tokenize", {"responses": responses}),
                         (200, {"tokens": [["ＡＩ Agent"], [], ["自然语言处理"], []], "model": MODULE.MODEL_ID}))
        self.assertEqual(self.calls, [(["ＡＩ Agent", "自然语言处理"], {"batch_size": 8})])

    def test_accepts_exact_limits_and_empty_batch(self):
        responses = ["字" * 500] * 24
        self.assertEqual(self.request("POST", "/tokenize", {"responses": responses})[0], 200)
        self.assertEqual(self.request("POST", "/tokenize", {"responses": []})[1]["tokens"], [])

    def test_rejects_invalid_payloads_without_echoing_text(self):
        for payload in [None, [], {}, {"responses": "secret"}, {"responses": [123]},
                        {"responses": ["x"] * 25}, {"responses": ["x" * 12001]},
                        {"responses": ["\ud800"]}, {"responses": [], "secret": "hidden"}]:
            with self.subTest(payload_type=type(payload).__name__):
                status, body = self.request("POST", "/tokenize", raw=json.dumps(payload))
                self.assertEqual((status, body), (400, {"error": "INVALID_REQUEST"}))
        self.assertEqual(self.calls, [])

    def test_rejects_invalid_json_body_size_and_content_type(self):
        for raw, headers in [("not-json", None), ("x" * 160001, None),
                             ('{"responses":[]}', {"Content-Type": "text/plain"})]:
            self.assertEqual(self.request("POST", "/tokenize", raw=raw, headers=headers)[0], 400)
        self.assertEqual(self.calls, [])

    def test_unknown_paths_do_not_echo_query_text(self):
        self.assertEqual(self.request("GET", "/not-found?secret=answer"), (404, {"error": "NOT_FOUND"}))

    def test_model_failure_does_not_expose_exception_or_answer(self):
        with patch.object(MODULE.TokenizerRuntime, "tokenize", side_effect=RuntimeError("private answer")):
            self.assertEqual(self.request("POST", "/tokenize", {"responses": ["secret"]}),
                             (500, {"error": "TOKENIZATION_FAILED"}))


class TokenizerRuntimeTests(unittest.TestCase):
    def test_serializes_concurrent_inference(self):
        active = 0
        peak = 0
        state_lock = threading.Lock()

        def tokenizer(responses, **_kwargs):
            nonlocal active, peak
            with state_lock:
                active += 1
                peak = max(peak, active)
            time.sleep(0.015)
            with state_lock:
                active -= 1
            return [[text] for text in responses]

        runtime = MODULE.TokenizerRuntime(tokenizer)
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
            results = list(executor.map(lambda _: runtime.tokenize(["人工智能"]), range(4)))
        self.assertEqual(results, [[["人工智能"]]] * 4)
        self.assertEqual(peak, 1)

    def test_validates_model_output_shape_and_bounds(self):
        for output in [[], [None], [[123]], [[""]], [["a", "b"]], [["x" * 12001]]]:
            runtime = MODULE.TokenizerRuntime(lambda *_args, **_kwargs: output)
            with self.subTest(output_type=type(output).__name__), self.assertRaises(RuntimeError):
                runtime.tokenize(["字"])

    def test_refuses_missing_model_before_importing_optional_dependencies(self):
        with patch.dict("os.environ", {"OPENPBL_NLP_MODEL_PATH": "/missing/local/model"}):
            with self.assertRaisesRegex(RuntimeError, "LOCAL_MODEL_REQUIRED"):
                MODULE.load_local_tokenizer()

    def test_startup_uses_only_local_cpu_model_with_sliding_windows_and_warmup(self):
        tokenizer = Mock(return_value=[["检查"]])
        tokenizer.tokenizer_transform = types.SimpleNamespace()
        hanlp = types.ModuleType("hanlp")
        hanlp.load = Mock(return_value=tokenizer)
        hanlp.utils = types.ModuleType("hanlp.utils")
        hanlp.utils.io_util = types.ModuleType("hanlp.utils.io_util")
        torch = types.ModuleType("torch")
        torch.set_num_threads = Mock()
        torch.set_num_interop_threads = Mock()
        modules = {"torch": torch, "hanlp": hanlp, "hanlp.utils": hanlp.utils,
                   "hanlp.utils.io_util": hanlp.utils.io_util}
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "config.json").write_text("{}")
            with patch.dict("sys.modules", modules), patch.dict("os.environ", {"OPENPBL_NLP_MODEL_PATH": directory}):
                self.assertIs(MODULE.load_local_tokenizer(), tokenizer)
                self.assertEqual(MODULE.os.environ["HF_HUB_OFFLINE"], "1")
                self.assertEqual(MODULE.os.environ["TRANSFORMERS_OFFLINE"], "1")
                hanlp.load.assert_called_once_with(str(Path(directory).resolve()), devices=-1, verbose=False)
                torch.set_num_threads.assert_called_once_with(2)
                torch.set_num_interop_threads.assert_called_once_with(2)
                self.assertFalse(tokenizer.tokenizer_transform.truncate_long_sequences)
                self.assertEqual(tokenizer.tokenizer_transform.max_seq_length, 512)
                tokenizer.assert_called_once_with(["分词服务启动检查。"], batch_size=8)
                with self.assertRaisesRegex(RuntimeError, "LOCAL_MODEL_RESOURCE_MISSING"):
                    hanlp.utils.io_util.download("https://example.com/model")

    def test_bounds_pending_inference(self):
        runtime = MODULE.TokenizerRuntime(Mock())
        for _ in range(MODULE.MAX_PENDING_INFERENCES):
            self.assertTrue(runtime.pending.acquire(blocking=False))
        with self.assertRaises(MODULE.ServiceBusy):
            runtime.tokenize(["人工智能"])
        runtime.tokenizer.assert_not_called()


if __name__ == "__main__":
    unittest.main()
