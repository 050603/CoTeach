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
from unittest.mock import Mock


SPEC = importlib.util.spec_from_file_location(
    "speech_alignment_server",
    Path(__file__).with_name("speech-alignment-server.py"),
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SpeechAlignmentServerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.audio_path = Path(self.temporary.name, "narration.wav")
        self.audio_path.write_bytes(b"RIFF-test-audio")
        self.calls = []

        def align(audio, text, language):
            self.calls.append((audio, text, language))
            return [
                {"text": "ＡＩ", "start_time": 0.12, "end_time": 0.4},
                {"text": "Agent", "start_time": 0.45, "end_time": 0.91},
                {"text": "能", "start_time": 0.92, "end_time": 1.1},
            ]

        self.decoder = Mock(return_value=("waveform", MODULE.SAMPLE_RATE, 1.2))
        self.server = MODULE.create_server(align, self.decoder, device="cuda:0", port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temporary.cleanup()

    def request(self, method, path, payload=None, *, raw=None, headers=None):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        body = raw if raw is not None else json.dumps(payload) if payload is not None else None
        connection.request(method, path, body=body, headers=headers or {"Content-Type": "application/json"})
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def valid_payload(self, **changes):
        return {
            "audioPath": str(self.audio_path),
            "text": "😀 ＡＩ，Agent 能做什么？",
            "language": "Chinese",
            **changes,
        }

    def test_health_reports_pinned_engine_and_selected_device(self):
        self.assertEqual(self.server.server_address[0], "127.0.0.1")
        status, body = self.request("GET", "/health/live")
        self.assertEqual(status, 200)
        self.assertEqual(body, {
            "status": "ok",
            "model": MODULE.MODEL_ID,
            "revision": MODULE.MODEL_REVISION,
            "version": MODULE.ALIGNMENT_VERSION,
            "device": "cuda:0",
        })

    def test_align_returns_milliseconds_and_utf16_source_ranges(self):
        status, body = self.request("POST", "/align", self.valid_payload())
        self.assertEqual(status, 200)
        self.assertEqual(body["durationMs"], 1200)
        self.assertEqual(body["spans"], [
            {"text": "ＡＩ", "startChar": 3, "endChar": 5, "startMs": 120, "endMs": 400},
            {"text": "Agent", "startChar": 6, "endChar": 11, "startMs": 450, "endMs": 910},
            {"text": "能", "startChar": 12, "endChar": 13, "startMs": 920, "endMs": 1100},
        ])
        self.decoder.assert_called_once_with(self.audio_path.resolve())
        self.assertEqual(self.calls, [(('waveform', MODULE.SAMPLE_RATE), self.valid_payload()["text"], "Chinese")])

    def test_rejects_invalid_payload_without_echoing_private_values(self):
        invalid = [
            None,
            {},
            {"audioPath": str(self.audio_path), "text": "内容", "language": "Thai"},
            self.valid_payload(audioPath="relative.wav"),
            self.valid_payload(audioPath=str(Path(self.temporary.name, "missing.wav"))),
            self.valid_payload(text=""),
            {**self.valid_payload(), "extra": "secret"},
        ]
        for payload in invalid:
            with self.subTest(payload=payload):
                status, body = self.request("POST", "/align", payload)
                self.assertEqual(status, 400)
                self.assertNotIn("secret", json.dumps(body))
        self.assertEqual(self.calls, [])

    def test_rejects_invalid_body_and_unknown_path(self):
        self.assertEqual(self.request("POST", "/align", raw="not-json")[0], 400)
        self.assertEqual(self.request("POST", "/align", raw="x" * (MODULE.MAX_BODY_BYTES + 1))[0], 400)
        self.assertEqual(self.request(
            "POST", "/align", raw=json.dumps(self.valid_payload()), headers={"Content-Type": "text/plain"},
        )[0], 400)
        self.assertEqual(self.request("GET", "/missing?text=private"), (404, {"error": "NOT_FOUND"}))

    def test_rejects_duration_and_bad_model_timestamps(self):
        self.decoder.return_value = ("waveform", MODULE.SAMPLE_RATE, MODULE.MAX_AUDIO_SECONDS + 1)
        self.assertEqual(
            self.request("POST", "/align", self.valid_payload()),
            (400, {"error": "UNSUPPORTED_AUDIO_DURATION"}),
        )
        self.decoder.return_value = ("waveform", MODULE.SAMPLE_RATE, 1.2)
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.server = MODULE.create_server(
            lambda *_args: [{"text": "ＡＩ", "start_time": 1.0, "end_time": 0.2}],
            self.decoder,
            port=0,
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.assertEqual(
            self.request("POST", "/align", self.valid_payload()),
            (422, {"error": "INVALID_TIMESTAMPS"}),
        )


class AlignmentRuntimeTests(unittest.TestCase):
    def test_single_inference_lane_rejects_concurrent_request(self):
        entered = threading.Event()
        release = threading.Event()

        def align(*_args):
            entered.set()
            release.wait(timeout=2)
            return [{"text": "字", "start_time": 0, "end_time": 0.1}]

        runtime = MODULE.AlignmentRuntime(
            align,
            lambda _path: ("waveform", MODULE.SAMPLE_RATE, 0.2),
            device="cpu",
        )
        with tempfile.NamedTemporaryFile() as audio, concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(runtime.align, Path(audio.name), "字", "Chinese")
            self.assertTrue(entered.wait(timeout=1))
            second = executor.submit(runtime.align, Path(audio.name), "字", "Chinese")
            with self.assertRaises(MODULE.ServiceBusy):
                second.result(timeout=1)
            release.set()
            self.assertEqual(first.result(timeout=1)[1][0]["text"], "字")

    def test_token_mapping_handles_repeated_words_and_source_gaps(self):
        result = MODULE.map_tokens_to_source("Go, go！", [
            {"text": "Go", "start_time": 0.0, "end_time": 0.2},
            {"text": "go", "start_time": 0.3, "end_time": 0.5},
        ], 600)
        self.assertEqual([(span["startChar"], span["endChar"]) for span in result], [(0, 2), (4, 6)])

    def test_device_probe_requires_matching_cuda_architecture_and_fp32_kernel(self):
        unavailable = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: False))
        self.assertEqual(MODULE.select_torch_device(unavailable), "cpu")

        cuda = Mock()
        cuda.is_available.return_value = True
        cuda.get_device_capability.return_value = (6, 1)
        cuda.get_arch_list.return_value = ["sm_70", "sm_80"]
        torch = types.SimpleNamespace(cuda=cuda)
        self.assertEqual(MODULE.select_torch_device(torch), "cpu")
        cuda.get_arch_list.return_value = ["sm_61", "sm_70"]
        tensor = Mock()
        tensor.__mul__ = Mock(return_value=tensor)
        tensor.cpu.return_value.item.return_value = 2.0
        torch.ones = Mock(return_value=tensor)
        torch.float32 = "fp32"
        self.assertEqual(MODULE.select_torch_device(torch), "cuda:0")
        torch.ones.assert_called_once_with(1, dtype="fp32", device="cuda:0")
        cuda.get_arch_list.return_value = ["sm_60", "sm_70"]
        torch.ones.reset_mock()
        self.assertEqual(MODULE.select_torch_device(torch), "cuda:0")
        torch.ones.assert_called_once_with(1, dtype="fp32", device="cuda:0")


if __name__ == "__main__":
    unittest.main()
