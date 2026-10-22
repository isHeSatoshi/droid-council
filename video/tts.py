"""Sarvam Bulbul v4 Flash text-to-speech -> a wav file in assets/voice/.

Reads SARVAM_API_KEY from the repo root .env. One call per narration line, so a
line can be regenerated without touching the others.

    python tts.py --list-voices
    python tts.py --out assets/voice/l1.wav --speaker shubh_enhi_ads --text "..."
"""

import argparse
import base64
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request
import wave

ENDPOINT = "https://api.sarvam.ai/text-to-speech"
ROOT = pathlib.Path(__file__).resolve().parent.parent


def api_key() -> str:
    key = os.environ.get("SARVAM_API_KEY")
    if key:
        return key.strip()
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.startswith("SARVAM_API_KEY="):
                return line.split("=", 1)[1].strip()
    sys.exit("SARVAM_API_KEY not found in environment or .env")


def speak(text, out, speaker, pace=1.0, sample_rate=24000, model="bulbul:v4-flash"):
    body = json.dumps(
        {
            "text": text,
            "language_code": "en-IN",
            "speaker": speaker,
            "model": model,
            "pace": pace,
            "speech_sample_rate": sample_rate,
            "output_audio_codec": "wav",
        }
    ).encode()
    req = urllib.request.Request(
        ENDPOINT,
        data=body,
        headers={"api-subscription-key": api_key(), "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            payload = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code}: {e.read().decode()[:600]}")

    wav = base64.b64decode("".join(payload["audios"]))
    out = pathlib.Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(wav)
    with wave.open(str(out)) as w:
        secs = w.getnframes() / w.getframerate()
        print(f"{out}  {secs:.2f}s  {w.getframerate()}Hz  {w.getnchannels()}ch  {len(wav)//1024}KB")
    return secs


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--text")
    p.add_argument("--out")
    p.add_argument("--speaker", default="shubh_enhi_ads")
    p.add_argument("--pace", type=float, default=1.0)
    p.add_argument("--sample-rate", type=int, default=24000)
    p.add_argument("--list-voices", action="store_true")
    a = p.parse_args()

    if a.list_voices:
        print(
            "v4-flash personas are named <name>_<lang>_<use>, e.g. shubh_enhi_ads.\n"
            "Known good: shubh_enhi_ads (default), simran_en_customer, priya, roopa, rahul, amit"
        )
    elif a.text and a.out:
        speak(a.text, a.out, a.speaker, a.pace, a.sample_rate)
    else:
        p.error("need --text and --out (or --list-voices)")
