#!/usr/bin/env python3
"""Deterministic audio quality gate for short H3 video segments."""

from __future__ import annotations

import argparse
import difflib
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import wave
from pathlib import Path


def normalize_text(value: str) -> str:
    return "".join(re.findall(r"[\u3400-\u9fffA-Za-z0-9]", value or "")).lower()


def wav_stats(path: Path) -> tuple[float, float, float]:
    with wave.open(str(path), "rb") as stream:
        frames = stream.readframes(stream.getnframes())
        width = stream.getsampwidth()
        rate = stream.getframerate()
        count = stream.getnframes()
    if width != 2 or not frames:
        return -120.0, 0.0, 0.0
    import array

    samples = array.array("h")
    samples.frombytes(frames)
    if sys.byteorder != "little":
        samples.byteswap()
    squares = sum(float(sample) * float(sample) for sample in samples)
    rms = math.sqrt(squares / max(1, len(samples))) / 32768.0
    peak = max(abs(sample) for sample in samples) / 32768.0
    rms_db = 20.0 * math.log10(max(rms, 1e-6))
    duration = count / max(1, rate)
    return rms_db, peak, duration


def transcribe(wav_path: Path, model_name: str) -> tuple[str, float]:
    import whisper

    model = whisper.load_model(model_name, device="cpu", download_root=str(Path.home() / ".cache" / "whisper"))
    result = model.transcribe(
        str(wav_path),
        language="zh",
        task="transcribe",
        fp16=False,
        temperature=0,
        condition_on_previous_text=False,
        verbose=False,
    )
    segments = result.get("segments") or []
    probabilities = [float(item.get("no_speech_prob", 1.0)) for item in segments]
    average_no_speech = sum(probabilities) / len(probabilities) if probabilities else 1.0
    return str(result.get("text") or "").strip(), average_no_speech


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--expected-dialogue", default="")
    parser.add_argument("--ffmpeg", required=True)
    parser.add_argument("--model", default="base")
    parser.add_argument("--similarity-threshold", type=float, default=0.40)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--report-file", default="")
    args = parser.parse_args()
    os.environ["PATH"] = str(Path(args.ffmpeg).resolve().parent) + os.pathsep + os.environ.get("PATH", "")

    video = Path(args.video).resolve()
    expected = normalize_text(args.expected_dialogue)
    report: dict[str, object] = {
        "passed": False,
        "video": str(video),
        "expected_dialogue": args.expected_dialogue,
        "mode": "dialogue" if expected else "no_dialogue",
    }
    try:
        if not video.is_file():
            raise FileNotFoundError(video)
        with tempfile.TemporaryDirectory(prefix="ccy-audio-qa-") as tmp:
            wav_path = Path(tmp) / "audio.wav"
            command = [
                args.ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(video),
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-c:a",
                "pcm_s16le",
                str(wav_path),
            ]
            completed = subprocess.run(command, capture_output=True, text=True, timeout=90)
            if completed.returncode != 0 or not wav_path.is_file():
                report["reason"] = "audio_decode_failed"
                report["detail"] = completed.stderr[-500:]
                serialized = json.dumps(report, ensure_ascii=False)
                if args.report_file:
                    Path(args.report_file).write_text(serialized, encoding="utf-8")
                print(serialized)
                return 2

            rms_db, peak, duration = wav_stats(wav_path)
            transcript, no_speech_probability = transcribe(wav_path, args.model)
            normalized_transcript = normalize_text(transcript)
            similarity = (
                difflib.SequenceMatcher(None, expected, normalized_transcript).ratio()
                if expected and normalized_transcript
                else 0.0
            )
            credible_speech = bool(normalized_transcript) and no_speech_probability < 0.72
            clipped = peak >= 0.9999
            report.update(
                {
                    "duration_seconds": round(duration, 3),
                    "rms_db": round(rms_db, 2),
                    "peak": round(peak, 5),
                    "transcript": transcript,
                    "normalized_transcript": normalized_transcript,
                    "no_speech_probability": round(no_speech_probability, 4),
                    "similarity": round(similarity, 4),
                    "credible_speech": credible_speech,
                    "clipped": clipped,
                }
            )

            if clipped:
                report["reason"] = "audio_clipping"
            elif expected:
                if not credible_speech:
                    report["reason"] = "expected_dialogue_missing"
                elif similarity < args.similarity_threshold:
                    report["reason"] = "dialogue_mismatch"
                else:
                    report["passed"] = True
                    report["reason"] = "dialogue_matched"
            elif credible_speech:
                # A single short interjection such as “哦” is a tolerable model
                # imperfection for this production. Continuous or garbled speech
                # still fails and is regenerated.
                # Whisper also maps short environmental transients to arbitrary
                # one-character Chinese syllables. Treat any isolated syllable
                # as minor; two or more recognized characters remain a failure.
                if len(normalized_transcript) <= 1:
                    report["passed"] = True
                    report["reason"] = "minor_interjection_tolerated"
                else:
                    report["reason"] = "unexpected_speech"
            else:
                report["passed"] = True
                report["reason"] = "no_unexpected_speech"
    except Exception as exc:  # checker failure is not a media pass
        report["reason"] = "checker_error"
        report["detail"] = f"{type(exc).__name__}: {exc}"
        serialized = json.dumps(report, ensure_ascii=False)
        if args.report_file:
            Path(args.report_file).write_text(serialized, encoding="utf-8")
        print(serialized)
        return 3

    serialized = json.dumps(report, ensure_ascii=False)
    if args.report_file:
        Path(args.report_file).write_text(serialized, encoding="utf-8")
    print(serialized)
    return 0 if report["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
