import array
import base64
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import worker


class AudioTests(unittest.TestCase):
    def test_decode_samples_reads_normalized_float32(self):
        raw = array.array("f", [0.25, -0.5]).tobytes()
        samples = worker.decode_samples(base64.b64encode(raw).decode("ascii"), 16000)
        self.assertEqual(samples.tolist(), [0.25, -0.5])

    def test_decode_samples_rejects_invalid_base64(self):
        with self.assertRaises(ValueError):
            worker.decode_samples("not-base64!", 16000)

    def test_decode_samples_preserves_normalized_float32_precision(self):
        raw = array.array("f", [0.123456, -0.765432]).tobytes()
        samples = worker.decode_samples(base64.b64encode(raw).decode("ascii"), 16000)
        self.assertEqual(samples.tolist(), array.array("f", [0.123456, -0.765432]).tolist())

    def test_resamples_supported_audio_rates_to_whisper_rate(self):
        import numpy

        samples = numpy.linspace(-0.5, 0.5, 480)
        converted = worker.resample_samples(samples, 48000)
        self.assertEqual(converted.dtype, numpy.float32)
        self.assertEqual(converted.size, 160)

    def test_resampling_rejects_alias_energy_above_whisper_nyquist(self):
        import numpy

        samples = numpy.sin(2 * numpy.pi * 12000 * numpy.arange(4800) / 48000).astype(numpy.float32)
        converted = worker.resample_samples(samples, 48000)
        self.assertLess(float(numpy.sqrt(numpy.mean(converted[100:-100] ** 2))), 0.01)

    def test_silence_produces_no_transcript(self):
        raw = array.array("f", [0.0] * 160).tobytes()
        results, metrics = worker.transcribe({
            "chunk": {"samples": base64.b64encode(raw).decode("ascii"), "sampleRate": 16000, "startMs": 0},
            "hints": [],
        })
        self.assertEqual(results, [])
        self.assertEqual(metrics["inferenceMs"], 0)


class ModelBoundaryTests(unittest.TestCase):
    def test_install_downloads_only_the_default_weight_variant(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.json"
            config.write_text('{"architectures":["WhisperForConditionalGeneration"]}')
            with patch("huggingface_hub.HfApi") as api, patch("huggingface_hub.hf_hub_download", return_value=str(config)), patch("huggingface_hub.snapshot_download", return_value=directory) as download:
                api.return_value.list_repo_files.return_value = ["config.json", "model.safetensors", "model.fp32-00001-of-00002.safetensors", "tokenizer.json"]
                worker.install("openai/whisper-large-v3", directory, True, ["openai/whisper-large-v3"])
                self.assertEqual(download.call_args.kwargs["allow_patterns"], ["config.json", "model.safetensors", "tokenizer.json"])

    def test_install_rejects_incompatible_architecture_before_weights(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.json"
            config.write_text('{"architectures":["OtherModel"]}')
            with patch("huggingface_hub.HfApi") as api, patch("huggingface_hub.hf_hub_download", return_value=str(config)), patch("huggingface_hub.snapshot_download") as download:
                api.return_value.list_repo_files.return_value = ["config.json", "model.safetensors"]
                with self.assertRaisesRegex(ValueError, "architecture"):
                    worker.install("example/not-whisper", directory, True, ["example/not-whisper"])
                download.assert_not_called()

    def test_peak_memory_converts_platform_units_to_megabytes(self):
        usage = SimpleNamespace(ru_maxrss=1024 * 1024)
        with patch.object(worker.resource, "getrusage", return_value=usage), patch.object(worker.sys, "platform", "darwin"):
            self.assertEqual(worker.peak_memory_mb(), 1)
        with patch.object(worker.resource, "getrusage", return_value=usage), patch.object(worker.sys, "platform", "linux"):
            self.assertEqual(worker.peak_memory_mb(), 1024)

    def test_auto_device_prefers_cuda_then_verified_mps_then_cpu(self):
        class Hardware:
            def __init__(self, cuda, mps):
                self.cuda = SimpleNamespace(is_available=lambda: cuda)
                self.backends = SimpleNamespace(mps=SimpleNamespace(is_available=lambda: mps))

        self.assertEqual(worker.resolve_device("auto", Hardware(True, True)), "cuda")
        self.assertEqual(worker.resolve_device("auto", Hardware(False, True)), "mps")
        self.assertEqual(worker.resolve_device("auto", Hardware(False, False)), "cpu")
        with self.assertRaisesRegex(RuntimeError, "MPS was requested but is unavailable"):
            worker.resolve_device("mps", Hardware(False, False))

    def test_rejects_unsupported_model_before_loading_modules(self):
        with self.assertRaisesRegex(ValueError, "Unsupported Whisper model"):
            worker.require_model("some/arbitrary-model", [])

    def test_preserves_decoded_text_and_hint_prompt(self):
        class DeviceTensor:
            def to(self, device, dtype=None):
                self.transfer = (device, dtype)
                return self

        feature_tensor = DeviceTensor()

        class Features:
            input_features = feature_tensor

        class FakeProcessor:
            def __call__(self, samples, **kwargs):
                return Features()

            def get_prompt_ids(self, text, **kwargs):
                self.hint_text = text
                return "hint-token-ids"

            def batch_decode(self, output, **kwargs):
                return ["ภาษาไทยตามต้นฉบับ"]

        class FakeModel:
            device = "cpu"
            dtype = "float32"

            def generate(self, features, **kwargs):
                self.generation = kwargs
                return object()

        class FakeTorch:
            class inference_mode:
                def __enter__(self):
                    return None

                def __exit__(self, *_args):
                    return False

        raw = array.array("f", [0.1] * 1600).tobytes()
        fake_processor = FakeProcessor()
        fake_processor.get_prompt_ids = lambda text, **kwargs: DeviceTensor() if text == "ชื่อบุคคล" else None
        fake_model = FakeModel()
        with patch.object(worker, "processor", fake_processor), patch.object(worker, "model", fake_model), \
                patch.object(worker, "torch", FakeTorch()), patch.object(worker, "model_config", {"language": "th"}):
            results, _metrics = worker.transcribe({
                "chunk": {"samples": base64.b64encode(raw).decode("ascii"), "sampleRate": 16000, "startMs": 50},
                "hints": ["ชื่อบุคคล"],
            })
        self.assertEqual(results, [{"startMs": 50, "endMs": 150, "text": "ภาษาไทยตามต้นฉบับ"}])
        self.assertEqual(fake_model.generation["language"], "th")
        self.assertEqual(fake_model.generation["task"], "transcribe")
        self.assertIsInstance(fake_model.generation["prompt_ids"], DeviceTensor)
        self.assertEqual(feature_tensor.transfer, ("cpu", "float32"))


if __name__ == "__main__":
    unittest.main()
