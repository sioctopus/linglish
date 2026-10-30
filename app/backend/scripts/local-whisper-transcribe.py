#!/usr/bin/env python3
"""Local faster-whisper transcription for Linglish subtitle fallback."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import wave


def find_ffmpeg() -> str:
    env = os.environ.get('FFMPEG_PATH') or os.environ.get('FFMPEG_BIN')
    if env and os.path.exists(env):
        return env
    # Prefer the Node package binary used by the backend.
    here = os.path.dirname(os.path.abspath(__file__))
    candidate = os.path.normpath(os.path.join(
        here, '..', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe'
    ))
    if os.path.exists(candidate):
        return candidate
    return 'ffmpeg'


def to_wav_16k_mono(src: str, dst: str) -> None:
    ffmpeg = find_ffmpeg()
    cmd = [
        ffmpeg, '-y', '-i', src,
        '-ac', '1', '-ar', '16000', '-f', 'wav', dst,
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0 or not os.path.exists(dst):
        err = (proc.stderr or proc.stdout or b'ffmpeg failed').decode('utf-8', errors='ignore')
        raise RuntimeError(err.strip()[:400] or 'ffmpeg failed')


def load_wav_f32(path: str):
    import numpy as np
    with wave.open(path, 'rb') as wf:
        channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        rate = wf.getframerate()
        frames = wf.readframes(wf.getnframes())
    if sampwidth != 2:
        raise RuntimeError(f'expected 16-bit wav, got sampwidth={sampwidth}')
    audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    if rate != 16000:
        # ffmpeg already forces 16k; keep a hard check.
        raise RuntimeError(f'expected 16k wav, got {rate}')
    return audio


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--file', required=True)
    parser.add_argument('--language', default='en')
    parser.add_argument('--model', default='tiny')
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except Exception as err:  # pragma: no cover
        print(json.dumps({'ok': False, 'error': f'faster-whisper missing: {err}'}))
        return 2

    language = None if args.language in ('', 'auto') else args.language
    model_name = args.model or 'tiny'
    wav_path = ''
    try:
        fd, wav_path = tempfile.mkstemp(prefix='linglish-whisper-', suffix='.wav')
        os.close(fd)
        to_wav_16k_mono(args.file, wav_path)
        audio = load_wav_f32(wav_path)
        model = WhisperModel(model_name, device='cpu', compute_type='int8')
        segments_iter, info = model.transcribe(
            audio,
            language=language,
            vad_filter=True,
            beam_size=1,
        )
        segments = []
        texts = []
        for seg in segments_iter:
            text = (seg.text or '').strip()
            if not text:
                continue
            segments.append({
                'start': float(seg.start or 0),
                'end': float(seg.end or seg.start or 0),
                'text': text,
            })
            texts.append(text)
        payload = {
            'ok': True,
            'text': ' '.join(texts).strip(),
            'segments': segments,
            'language': getattr(info, 'language', language or 'en'),
            'duration': float(getattr(info, 'duration', 0) or len(audio) / 16000.0),
            'provider': 'local-whisper',
            'model': model_name,
        }
        print(json.dumps(payload, ensure_ascii=False))
        return 0
    except Exception as err:  # pragma: no cover
        print(json.dumps({'ok': False, 'error': str(err)}))
        return 1
    finally:
        if wav_path:
            try:
                os.unlink(wav_path)
            except OSError:
                pass


if __name__ == '__main__':
    sys.exit(main())
