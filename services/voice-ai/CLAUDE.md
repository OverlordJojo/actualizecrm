# services/voice-ai

Local speech-to-text and structured extraction for live calls. Runs on the
operator's MacBook, never in the cloud.

## What this module does

1. Receives two separate audio channels over WebSocket — the operator's mic and
   the prospect's inbound stream — from the browser
2. Uses `silero-vad` to chunk on speech boundaries
3. Transcribes each channel with `faster-whisper`
4. Streams speaker-tagged transcript segments back to the browser
5. Extracts structured facts (email, name, company, booking, stage) with a
   local LLM via Ollama, and verifies proposed bookings with a second pass

Nothing leaves the machine. No transcription API bill, no third-party exposure
of what prospects say on the phone.

## Why two models

Ollama runs language models; **it cannot do speech-to-text**. The original plan
assumed one tool could do both. It cannot, so the stack is:

| Job | Tool | Why |
| --- | --- | --- |
| Speech-to-text | `faster-whisper`, `distil-small.en`, `int8` | MIT licensed, free, real-time factor well under 1× on Apple Silicon |
| Reasoning | Ollama + `qwen2.5:7b-instruct` | Strongest structured-JSON adherence in its size class |
| Speech boundaries | `silero-vad` | Chunking on speech rather than fixed windows is what makes latency tolerable |

## Hardware requirement

**Apple Silicon with 16 GB unified memory minimum. 24 GB is comfortable.**

On 8 GB, the 7B model plus Whisper plus Chrome will swap and latency collapses
to the point of uselessness. This is a hard floor, not a recommendation.

**Load rule:** only the single *connected* call gets the Whisper + LLM
pipeline. Held and ringing legs get answering-machine detection only. Never run
three concurrent LLM streams — see `apps/web` multi-line dialing.

## Env vars this folder owns

| Key | Default | What it is |
| --- | --- | --- |
| `WHISPER_MODEL` | `distil-small.en` | faster-whisper model name |
| `OLLAMA_URL` | `http://localhost:11434` | Local Ollama endpoint |
| `OLLAMA_MODEL` | `qwen2.5:7b-instruct` | Extraction model |

No API keys. Nothing here talks to the internet except to download models the
first time.

## Setup — click by click

### 1. Install Ollama and the model

```bash
brew install ollama
ollama serve            # leave running, or install as a background service
ollama pull qwen2.5:7b-instruct
```

Verify: `curl http://localhost:11434/api/tags` lists the model.

### 2. Start the sidecar

```bash
npm run voice-ai
```

First run creates a virtualenv and installs dependencies, which takes several
minutes because PyTorch is large. Subsequent starts are seconds.

The Whisper model downloads on first transcription, not at boot, so the first
call of a fresh install has a few seconds of extra latency.

### 3. Confirm it is up

```bash
curl http://localhost:8787/health
```

## Design decisions worth not re-litigating

**Speaker attribution is structural, not inferred.** The browser captures the
operator's mic track and the remote track as separate channels and tags each
frame before sending. Asking the model to guess who was speaking is
unnecessary and it gets it wrong on crosstalk — which is exactly when it
matters, because "the operator read the email back" versus "the prospect gave
the email" is the difference between a correct extraction and a wrong one.

**The extraction gate is a cheap regex, not the model.** Most turns contain
nothing extractable. Running a 7B model on every segment burns compute and adds
latency for no benefit, so `worth_extracting()` filters first. One
unconditional pass runs at call end over the full transcript as a safety net.

**Bookings get two passes.** Booking errors are the expensive kind — a
mis-parsed timezone puts a meeting in the wrong hour and the prospect is gone.
Pass one proposes; pass two verifies agreement, arithmetic, and that the date
is in the future and within 90 days. The 90-day and past-date checks are
enforced in Python rather than trusted to the model, because date arithmetic is
what it is worst at.

**Suggest, never silently write.** Confidence above 0.85 renders an accept/
dismiss chip. Nothing auto-applies unless the operator explicitly opts in per
field type, and bookings never auto-write to Google Calendar by default. A
wrong auto-write to a lead's email costs a deal; a chip costs one click.

## Testing end to end

**1. Health**
`curl localhost:8787/health` → `{"status":"ok"}`.

**2. Transcription accuracy on your own voice**
Place a call to your own phone, say a few sentences, and watch the transcript
pane. Words should appear within roughly a second of you finishing a sentence.

**3. Speaker separation**
Talk over yourself deliberately — speak into the mic while the far end is
talking. Both should appear, correctly attributed. If they merge, the browser
is sending one mixed channel rather than two.

**4. The 20-call evaluation** ← required before trusting it live
Run 20 scripted calls to your own phone covering:
- spelled-out email addresses ("j-o-s-h at gmail dot com")
- timezone-crossing bookings (prospect in a different zone)
- ambiguous times ("let's say twelve" / "seven")
- explicit rejections
- a gatekeeper, a voicemail greeting, and an IVR menu

Record precision and recall **per field type** in a table. Do not mark this
feature done on the basis of it working once — the whole risk of extraction is
that it is right 90% of the time, and the 10% is silent.
