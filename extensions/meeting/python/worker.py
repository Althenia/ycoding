from __future__ import annotations

import base64
import json
import re
import resource
import sys
import time
from pathlib import Path
from typing import Any

model: Any = None
processor: Any = None
torch: Any = None
model_config: dict[str, Any] = {}
metrics: dict[str, Any] = {}
WHISPER_SAMPLE_RATE = 16000


def response(request_id: str, *, ok: bool = True, **values: Any) -> None:
    sys.stdout.write(json.dumps({"id": request_id, "ok": ok, **values}, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def require_model(model_id: str, allowed_models: list[str]) -> None:
    if not isinstance(model_id, str) or model_id not in allowed_models or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*", model_id):
        raise ValueError("Unsupported Whisper model")


def resolve_device(requested: str, torch_module: Any) -> str:
    cuda_available = torch_module.cuda.is_available()
    mps = getattr(getattr(torch_module, "backends", None), "mps", None)
    mps_available = bool(mps and mps.is_available())
    if requested == "auto":
        if cuda_available:
            return "cuda"
        if mps_available:
            return "mps"
        return "cpu"
    if requested == "cuda" and not cuda_available:
        raise RuntimeError("CUDA was requested but is unavailable")
    if requested == "mps" and not mps_available:
        raise RuntimeError("MPS was requested but is unavailable")
    return requested


def install(model_id: str, cache_dir: str, authorized: bool, allowed_models: list[str]) -> dict[str, Any]:
    require_model(model_id, allowed_models)
    if authorized is not True:
        raise ValueError("Model installation requires explicit authorization")
    from huggingface_hub import HfApi, hf_hub_download, snapshot_download

    repo_files = HfApi().list_repo_files(model_id, repo_type="model")
    config_path = hf_hub_download(repo_id=model_id, filename="config.json", cache_dir=cache_dir)
    if Path(config_path).stat().st_size > 2 * 1024 * 1024:
        raise ValueError("Model configuration exceeds the limit")
    metadata = json.loads(Path(config_path).read_text(encoding="utf-8"))
    if "WhisperForConditionalGeneration" not in metadata.get("architectures", []):
        raise ValueError("Unsupported model architecture")
    weights = {"model.safetensors"}
    if "model.safetensors" not in repo_files:
        if "model.safetensors.index.json" not in repo_files:
            raise ValueError("Model repository has no default safetensors weights")
        index_path = hf_hub_download(repo_id=model_id, filename="model.safetensors.index.json", cache_dir=cache_dir)
        if Path(index_path).stat().st_size > 2 * 1024 * 1024:
            raise ValueError("Model weight index exceeds the limit")
        index = json.loads(Path(index_path).read_text(encoding="utf-8"))
        weights = set(index["weight_map"].values())
        if not weights or any(not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9._-]+\.safetensors", name) or name not in repo_files for name in weights):
            raise ValueError("Model weight index contains unsupported files")
        weights.add("model.safetensors.index.json")
    allowed = [
        name
        for name in repo_files
        if not name.startswith(("/", ".."))
        and "/../" not in name
        and (name in weights or name in {
            "config.json", "generation_config.json", "preprocessor_config.json", "tokenizer.json",
            "tokenizer_config.json", "special_tokens_map.json", "normalizer.json", "added_tokens.json",
            "vocab.json", "merges.txt",
        })
    ]
    if not allowed:
        raise ValueError("Model repository contains no supported model files")
    path = snapshot_download(
        repo_id=model_id,
        repo_type="model",
        cache_dir=cache_dir,
        allow_patterns=allowed,
        ignore_patterns=["*.py", "*.bin", "*.pt", "*.ckpt", "*.onnx", "*.tflite"],
    )
    return {"path": path, "files": len(allowed)}


def initialize(config: dict[str, Any]) -> dict[str, Any]:
    global model, processor, torch, model_config, metrics
    model_id = config.get("model")
    require_model(model_id, config.get("models", []))
    cache_dir = config["cacheDir"]

    from huggingface_hub import try_to_load_from_cache

    config_path = try_to_load_from_cache(model_id, "config.json", cache_dir=cache_dir)
    if not isinstance(config_path, str):
        raise FileNotFoundError(f"Model {model_id} is not present in the local Hugging Face cache")
    with open(config_path, encoding="utf-8") as source:
        metadata = json.load(source)
    if "WhisperForConditionalGeneration" not in metadata.get("architectures", []):
        raise ValueError("Unsupported model architecture; expected WhisperForConditionalGeneration")

    import torch as torch_module

    torch = torch_module
    from transformers import AutoProcessor, WhisperForConditionalGeneration

    start = time.perf_counter()
    device = resolve_device(config["device"], torch)
    try:
        processor = AutoProcessor.from_pretrained(
            model_id, cache_dir=cache_dir, local_files_only=True, trust_remote_code=False
        )
        loaded = WhisperForConditionalGeneration.from_pretrained(
            model_id,
            cache_dir=cache_dir,
            local_files_only=True,
            trust_remote_code=False,
            use_safetensors=True,
        )
    except OSError as error:
        raise FileNotFoundError(f"Model {model_id} has incomplete local model files") from error
    architecture = getattr(loaded.config, "architectures", None) or []
    if "WhisperForConditionalGeneration" not in architecture:
        raise ValueError("Unsupported model architecture; expected WhisperForConditionalGeneration")
    model = loaded.float() if device == "cpu" else loaded
    model = model.to(device).eval()
    model_config = config
    elapsed_ms = (time.perf_counter() - start) * 1000
    metrics = {
        "initializationMs": elapsed_ms,
        "device": device,
    }
    peak = peak_memory_mb()
    if peak is not None:
        metrics["peakMemoryMb"] = peak
    if device == "cpu":
        metrics["warning"] = "CPU inference selected; expect slower transcription"
    return metrics


def inventory(model_ids: list[str], cache_dir: str) -> list[dict[str, Any]]:
    from huggingface_hub import try_to_load_from_cache

    values = []
    for model_id in model_ids:
        if not isinstance(model_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*", model_id):
            continue
        config_path = try_to_load_from_cache(model_id, "config.json", cache_dir=cache_dir)
        if not isinstance(config_path, str):
            values.append({"id": model_id, "installed": False, "reason": "Model configuration is not cached"})
            continue
        try:
            with open(config_path, encoding="utf-8") as source:
                model_config = json.load(source)
            architectures = model_config.get("architectures", [])
            has_weights = any(
                isinstance(try_to_load_from_cache(model_id, filename, cache_dir=cache_dir), str)
                for filename in ("model.safetensors", "model.safetensors.index.json")
            )
            architecture = architectures[0] if architectures else None
            supported = architecture == "WhisperForConditionalGeneration"
            item = {
                "id": model_id,
                "installed": has_weights and supported,
            }
            if architecture:
                item["architecture"] = architecture
            if not has_weights or not supported:
                item["reason"] = "Model weights are incomplete or architecture is unsupported"
            values.append(item)
        except (OSError, json.JSONDecodeError, AttributeError):
            values.append({"id": model_id, "installed": False, "reason": "Cached model metadata is invalid"})
    return values


def decode_samples(encoded: str, sample_rate: int) -> Any:
    import numpy

    raw = base64.b64decode(encoded, validate=True)
    if len(raw) % 4:
        raise ValueError("Audio sample payload is invalid")
    samples = numpy.frombuffer(raw, dtype="<f4")
    if not numpy.isfinite(samples).all():
        raise ValueError("Audio samples must be finite")
    if numpy.any(numpy.abs(samples) > 1):
        raise ValueError("Audio samples must be normalized between -1 and 1")
    if not isinstance(sample_rate, int) or not 8000 <= sample_rate <= 192000:
        raise ValueError("Audio sample rate must be between 8000 and 192000 Hz")
    return samples.astype(numpy.float32, copy=False)


def resample_samples(samples: Any, sample_rate: int) -> Any:
    import numpy

    if sample_rate == WHISPER_SAMPLE_RATE:
        return samples
    output_size = round(samples.size * WHISPER_SAMPLE_RATE / sample_rate)
    if not output_size:
        return numpy.empty(0, dtype=numpy.float32)
    positions = numpy.arange(output_size, dtype=numpy.float64) * sample_rate / WHISPER_SAMPLE_RATE
    cutoff = min(1, WHISPER_SAMPLE_RATE / sample_rate) * 0.9
    radius = int(numpy.ceil(24 / cutoff))
    base = numpy.floor(positions).astype(numpy.int64)
    output = numpy.zeros(output_size, dtype=numpy.float64)
    weights = numpy.zeros(output_size, dtype=numpy.float64)
    for offset in range(-radius, radius + 1):
        indices = base + offset
        distance = positions - indices
        weight = cutoff * numpy.sinc(cutoff * distance) * (1 + numpy.cos(numpy.pi * distance / radius)) / 2
        weight[numpy.abs(distance) > radius] = 0
        output += samples[numpy.clip(indices, 0, samples.size - 1)] * weight
        weights += weight
    return numpy.clip(output / weights, -1, 1).astype(numpy.float32)


def transcribe(request: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    chunk = request["chunk"]
    sample_rate = chunk["sampleRate"]
    samples = decode_samples(chunk["samples"], sample_rate)
    if samples.size == 0 or float((samples * samples).mean()) ** 0.5 < 0.001:
        peak = peak_memory_mb()
        return [], {"inferenceMs": 0, "realTimeFactor": 0, **({"peakMemoryMb": peak} if peak is not None else {})}
    duration_ms = samples.size * 1000 / sample_rate
    samples = resample_samples(samples, sample_rate)
    inputs = processor(samples, sampling_rate=WHISPER_SAMPLE_RATE, return_tensors="pt")
    features = inputs.input_features.to(device=model.device, dtype=model.dtype)
    hints = [hint.strip() for hint in request.get("hints", []) if isinstance(hint, str) and hint.strip()]
    generation: dict[str, Any] = {"language": model_config["language"], "task": "transcribe"}
    if hints:
        generation["prompt_ids"] = processor.get_prompt_ids("; ".join(hints), return_tensors="pt").to(model.device)
    start = time.perf_counter()
    with torch.inference_mode():
        output = model.generate(features, **generation)
    elapsed_ms = (time.perf_counter() - start) * 1000
    text = processor.batch_decode(output, skip_special_tokens=True)[0].strip()
    results = [] if not text else [{
        "startMs": chunk["startMs"],
        "endMs": chunk["startMs"] + duration_ms,
        "text": text,
    }]
    inference_metrics = {
        "inferenceMs": elapsed_ms,
        "realTimeFactor": elapsed_ms / duration_ms if duration_ms else 0,
    }
    peak = peak_memory_mb()
    if peak is not None:
        inference_metrics["peakMemoryMb"] = peak
    return results, inference_metrics


def peak_memory_mb() -> float | None:
    try:
        value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return value / (1024 * 1024 if sys.platform == "darwin" else 1024)
    except (AttributeError, OSError):
        return None


def handle(request: dict[str, Any]) -> None:
    request_id = request.get("id")
    if not isinstance(request_id, str):
        response("", ok=False, error="Invalid request id")
        return
    try:
        operation = request.get("op")
        if operation == "install":
            response(request_id, installation=install(request["model"], request["cacheDir"], request.get("authorized") is True, request.get("models", [])))
        elif operation == "initialize":
            response(request_id, metrics=initialize(request))
        elif operation == "inventory":
            response(request_id, inventory=inventory(request.get("models", []), request["cacheDir"]))
        elif operation == "transcribe":
            if model is None:
                raise RuntimeError("Transcription model is not initialized")
            results, inference_metrics = transcribe(request)
            metrics.update(inference_metrics)
            response(request_id, results=results, metrics=inference_metrics)
        elif operation == "health":
            response(request_id, healthy=model is not None, metrics=metrics)
        else:
            raise ValueError("Unsupported worker operation")
    except (KeyError, TypeError, ValueError, OSError, RuntimeError, ImportError) as error:
        detail = str(error)
        if "not present in the local Hugging Face cache" in detail:
            message = detail
        elif "Unsupported" in detail or "unavailable" in detail or "requires explicit authorization" in detail:
            message = detail
        else:
            message = f"Transcription worker operation failed ({type(error).__name__})"
        response(request_id, ok=False, error=message)


def main() -> None:
    for line in sys.stdin:
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("Expected a JSON object")
            handle(request)
        except (json.JSONDecodeError, ValueError) as error:
            response("", ok=False, error=f"Invalid worker request: {error}")


if __name__ == "__main__":
    main()
