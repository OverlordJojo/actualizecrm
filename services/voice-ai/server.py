"""
ActualizeCRM local voice sidecar.

Speech-to-text and structured extraction, entirely on this machine. Nothing
leaves the laptop: no transcription API bill, no third-party exposure of what
prospects say.

Two models, because one cannot do both jobs:
  - faster-whisper (distil-small.en, int8) for speech-to-text
  - Ollama running qwen2.5:7b-instruct for structured extraction

Ollama is a language-model runner; it has no speech-to-text capability, which
is why the STT half is faster-whisper rather than something Ollama-hosted.

Run:  ./run.sh          (from services/voice-ai)
Listens on ws://localhost:8787
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Literal

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("voice-ai")

SAMPLE_RATE = 16_000
# Whisper wants at least this much audio to say anything useful; below it the
# model hallucinates filler like "Thank you." on silence.
MIN_UTTERANCE_MS = 400
MAX_UTTERANCE_MS = 15_000

Speaker = Literal["operator", "prospect"]

app = FastAPI(title="ActualizeCRM voice-ai")

_whisper = None
_vad = None


def get_whisper():
    """Loaded lazily so the process starts fast and a missing model surfaces
    as a clear error rather than an import-time crash."""
    global _whisper
    if _whisper is None:
        from faster_whisper import WhisperModel

        model_name = os.environ.get("WHISPER_MODEL", "distil-small.en")
        log.info("loading whisper model %s", model_name)
        # int8 on Apple Silicon: real-time factor well under 1x, leaving
        # headroom for the LLM to run concurrently.
        _whisper = WhisperModel(model_name, device="cpu", compute_type="int8")
        log.info("whisper ready")
    return _whisper


def get_vad():
    global _vad
    if _vad is None:
        import torch

        log.info("loading silero-vad")
        model, _ = torch.hub.load(
            repo_or_dir="snakers4/silero-vad",
            model="silero_vad",
            force_reload=False,
            onnx=False,
        )
        _vad = model
        log.info("vad ready")
    return _vad


@dataclass
class ChannelBuffer:
    """Accumulates PCM for one speaker until VAD says the utterance ended.

    Chunking on speech boundaries rather than fixed windows is what makes the
    latency tolerable — a fixed 5-second window means every transcript is up to
    5 seconds stale, and it cuts words in half.
    """

    speaker: Speaker
    pcm: list[np.ndarray] = field(default_factory=list)
    silence_ms: int = 0
    speaking: bool = False

    def duration_ms(self) -> int:
        total = sum(len(c) for c in self.pcm)
        return int(total / SAMPLE_RATE * 1000)

    def take(self) -> np.ndarray | None:
        if not self.pcm:
            return None
        audio = np.concatenate(self.pcm)
        self.pcm = []
        self.silence_ms = 0
        self.speaking = False
        return audio


def is_speech(vad, frame: np.ndarray) -> bool:
    import torch

    # silero expects float32 in [-1, 1] at 16kHz, 512-sample frames.
    if len(frame) < 512:
        return False
    with torch.no_grad():
        prob = vad(torch.from_numpy(frame[:512]), SAMPLE_RATE).item()
    return prob > 0.5


async def transcribe(audio: np.ndarray) -> str:
    """Runs Whisper off the event loop so the socket keeps reading."""
    model = get_whisper()

    def _run() -> str:
        segments, _ = model.transcribe(
            audio,
            language="en",
            beam_size=1,
            vad_filter=False,  # we already did VAD
            condition_on_previous_text=False,
        )
        return " ".join(s.text.strip() for s in segments).strip()

    return await asyncio.to_thread(_run)


@app.get("/health")
async def health():
    return JSONResponse(
        {
            "status": "ok",
            "whisper_loaded": _whisper is not None,
            "vad_loaded": _vad is not None,
            "model": os.environ.get("WHISPER_MODEL", "distil-small.en"),
        }
    )


@app.websocket("/ws")
async def ws(sock: WebSocket):
    """
    Protocol.

    Client sends binary frames: a 1-byte speaker tag (0 operator, 1 prospect)
    followed by little-endian int16 PCM at 16kHz mono.

    Client sends JSON text frames for control: {"type": "end"}.

    Server sends JSON:
      {"type":"partial"|"final","speaker":...,"text":...,"at":epoch_ms}
    """
    await sock.accept()
    log.info("client connected")

    vad = get_vad()
    buffers: dict[Speaker, ChannelBuffer] = {
        "operator": ChannelBuffer("operator"),
        "prospect": ChannelBuffer("prospect"),
    }

    async def flush(buf: ChannelBuffer):
        if buf.duration_ms() < MIN_UTTERANCE_MS:
            buf.take()
            return
        audio = buf.take()
        if audio is None:
            return
        text = await transcribe(audio)
        if not text:
            return
        await sock.send_json(
            {
                "type": "final",
                "speaker": buf.speaker,
                "text": text,
                "at": int(time.time() * 1000),
            }
        )

    try:
        while True:
            message = await sock.receive()

            if "text" in message and message["text"]:
                ctrl = json.loads(message["text"])
                if ctrl.get("type") == "end":
                    for b in buffers.values():
                        await flush(b)
                    await sock.send_json({"type": "closed"})
                    break
                continue

            if "bytes" not in message or not message["bytes"]:
                continue

            raw = message["bytes"]
            speaker: Speaker = "operator" if raw[0] == 0 else "prospect"
            pcm16 = np.frombuffer(raw[1:], dtype=np.int16)
            frame = (pcm16.astype(np.float32) / 32768.0).copy()

            buf = buffers[speaker]
            speech = is_speech(vad, frame)

            if speech:
                buf.speaking = True
                buf.silence_ms = 0
                buf.pcm.append(frame)
            elif buf.speaking:
                buf.pcm.append(frame)
                buf.silence_ms += int(len(frame) / SAMPLE_RATE * 1000)
                # ~600ms of silence ends the utterance. Shorter cuts people off
                # mid-sentence; longer makes the transcript feel laggy.
                if buf.silence_ms >= 600:
                    await flush(buf)

            if buf.duration_ms() >= MAX_UTTERANCE_MS:
                await flush(buf)

    except WebSocketDisconnect:
        log.info("client disconnected")
    except Exception:
        log.exception("socket error")
        try:
            await sock.close()
        except Exception:
            pass


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8787, log_level="info")
