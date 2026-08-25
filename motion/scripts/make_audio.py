#!/usr/bin/env python3
"""Generate the deterministic 20-second music and sound-design bed for the ad."""

from __future__ import annotations

import argparse
import math
import wave
from pathlib import Path

import numpy as np


SR = 48_000
DURATION = 20.0
N = int(SR * DURATION)
DEFAULT_OUT = Path(__file__).resolve().parents[1] / "public" / "assets" / "soundtrack.wav"
PARSER = argparse.ArgumentParser(description=__doc__)
PARSER.add_argument("--output", type=Path, default=DEFAULT_OUT)
OUT = PARSER.parse_args().output.expanduser().resolve()
RNG = np.random.default_rng(3187)


def stereo(signal: np.ndarray, pan: float = 0.0) -> np.ndarray:
    pan = float(np.clip(pan, -1.0, 1.0))
    left = math.cos((pan + 1.0) * math.pi / 4.0)
    right = math.sin((pan + 1.0) * math.pi / 4.0)
    return np.column_stack((signal * left, signal * right))


mix = np.zeros((N, 2), dtype=np.float64)


def add(start: float, signal: np.ndarray, pan: float = 0.0) -> None:
    i = max(0, int(round(start * SR)))
    if i >= N:
        return
    if signal.ndim == 1:
        signal = stereo(signal, pan)
    length = min(len(signal), N - i)
    mix[i : i + length] += signal[:length]


def smooth_envelope(length: int, attack: float, release: float) -> np.ndarray:
    x = np.ones(length, dtype=np.float64)
    a = min(length, max(1, int(attack * SR)))
    r = min(length, max(1, int(release * SR)))
    x[:a] = np.sin(np.linspace(0, math.pi / 2, a, endpoint=True)) ** 2
    x[-r:] *= np.sin(np.linspace(math.pi / 2, 0, r, endpoint=True)) ** 2
    return x


def pad(start: float, duration: float, freqs: tuple[float, ...], amp: float = 0.06) -> None:
    length = int(duration * SR)
    t = np.arange(length) / SR
    env = smooth_envelope(length, 0.42, 0.68)
    left = np.zeros(length)
    right = np.zeros(length)
    for index, freq in enumerate(freqs):
        phase = index * 0.73
        core_l = np.sin(2 * math.pi * freq * 0.9985 * t + phase)
        core_r = np.sin(2 * math.pi * freq * 1.0015 * t + phase + 0.09)
        shimmer_l = 0.18 * np.sin(2 * math.pi * freq * 2.002 * t + phase * 1.7)
        shimmer_r = 0.18 * np.sin(2 * math.pi * freq * 1.998 * t + phase * 1.7 + 0.13)
        left += core_l + shimmer_l
        right += core_r + shimmer_r
    signal = np.column_stack((left, right)) * env[:, None] * (amp / len(freqs))
    add(start, signal)


def low_pulse(start: float, amp: float = 0.24, duration: float = 0.46) -> None:
    length = int(duration * SR)
    t = np.arange(length) / SR
    phase = 2 * math.pi * (62 * t + (88 - 62) * (1 - np.exp(-t * 10)) / 10)
    body = np.sin(phase) * np.exp(-t * 9.5)
    click = RNG.normal(0, 1, length) * np.exp(-t * 70) * 0.07
    add(start, (body + click) * amp)


def tick(start: float, amp: float = 0.06, pan: float = 0.0, tone: float = 2500.0) -> None:
    duration = 0.085
    length = int(duration * SR)
    t = np.arange(length) / SR
    noise = RNG.normal(0, 1, length)
    kernel = np.ones(5) / 5
    softened = np.convolve(noise, kernel, mode="same")
    signal = (0.65 * np.sin(2 * math.pi * tone * t) + 0.35 * softened) * np.exp(-t * 46) * amp
    add(start, signal, pan)


def chime(start: float, freqs: tuple[float, ...], amp: float = 0.11, duration: float = 1.3) -> None:
    length = int(duration * SR)
    t = np.arange(length) / SR
    signal = np.zeros((length, 2))
    for index, freq in enumerate(freqs):
        env = np.exp(-t * (2.5 + index * 0.22))
        fundamental = np.sin(2 * math.pi * freq * t + index * 0.45)
        overtone = 0.28 * np.sin(2 * math.pi * freq * 2.01 * t + 0.8)
        mono = (fundamental + overtone) * env * amp / max(1, len(freqs) ** 0.65)
        signal += stereo(mono, -0.42 + index * 0.84 / max(1, len(freqs) - 1))
    add(start, signal)


def whoosh(start: float, duration: float = 0.55, amp: float = 0.095, direction: float = 1.0) -> None:
    length = int(duration * SR)
    t = np.arange(length) / SR
    noise = RNG.normal(0, 1, length)
    low = np.convolve(noise, np.ones(34) / 34, mode="same")
    air = noise - np.convolve(noise, np.ones(9) / 9, mode="same")
    env = np.sin(np.linspace(0, math.pi, length)) ** 1.7
    sweep = 0.58 * low + (0.14 + 0.5 * t / duration) * air
    mono = sweep * env * amp
    left_gain = np.linspace(0.95 if direction > 0 else 0.45, 0.45 if direction > 0 else 0.95, length)
    right_gain = left_gain[::-1]
    add(start, np.column_stack((mono * left_gain, mono * right_gain)))


# Harmonic bed: warm, restrained, and slightly optimistic.
pad(0.0, 2.25, (146.83, 220.00, 329.63), 0.054)
pad(1.8, 2.75, (123.47, 185.00, 293.66), 0.057)
pad(4.1, 2.75, (98.00, 146.83, 220.00), 0.061)
pad(6.2, 2.75, (110.00, 164.81, 246.94), 0.064)
pad(8.35, 2.25, (146.83, 220.00, 369.99), 0.061)
pad(9.95, 2.75, (146.83, 220.00, 293.66, 369.99), 0.068)
pad(12.25, 2.65, (123.47, 185.00, 293.66), 0.061)
pad(14.55, 2.65, (110.00, 164.81, 246.94), 0.064)
pad(16.85, 3.15, (146.83, 220.00, 293.66, 369.99), 0.075)

# Structural impacts and motion sweeps.
for moment, level in (
    (0.03, 0.16),
    (1.73, 0.26),
    (2.20, 0.18),
    (4.13, 0.22),
    (6.30, 0.23),
    (8.34, 0.25),
    (10.03, 0.24),
    (11.72, 0.23),
    (14.70, 0.25),
    (17.48, 0.29),
):
    low_pulse(moment, level)

for moment, duration, direction in (
    (0.72, 0.78, 1),
    (1.43, 0.48, 1),
    (2.02, 0.48, -1),
    (3.88, 0.55, 1),
    (6.02, 0.57, -1),
    (8.06, 0.58, 1),
    (9.78, 0.62, -1),
    (11.45, 0.58, 1),
    (14.40, 0.62, -1),
    (17.18, 0.72, 1),
):
    whoosh(moment, duration, direction=direction)

# Fine interface ticks and autofill cascade.
for n in range(18):
    tick(0.22 + n * 0.53, 0.018 if n % 2 else 0.026, pan=(-0.35 if n % 2 else 0.35), tone=1800 + (n % 3) * 420)

tick(1.48, 0.12, pan=0.12, tone=3150)
chime(1.72, (440.00, 659.25), 0.08, 0.85)

for n, moment in enumerate((4.82, 4.98, 5.14, 5.30)):
    tick(moment, 0.075 - n * 0.006, pan=-0.35 + n * 0.23, tone=1600 + n * 260)
chime(5.02, (587.33, 739.99), 0.065, 0.9)

for n, moment in enumerate((6.86, 7.02, 7.18, 7.34, 7.50)):
    tick(moment, 0.082, pan=-0.5 + n * 0.25, tone=1450 + n * 230)
chime(7.52, (493.88, 659.25, 880.00), 0.064, 0.85)

tick(8.70, 0.085, pan=-0.35, tone=2100)
tick(8.98, 0.085, pan=0.35, tone=2460)
chime(10.20, (293.66, 369.99, 440.00, 587.33), 0.13, 1.75)
tick(11.98, 0.078, pan=-0.28, tone=1920)
tick(12.20, 0.078, pan=0.28, tone=2280)
chime(14.95, (493.88, 659.25, 880.00), 0.075, 1.05)
chime(17.75, (293.66, 369.99, 440.00, 587.33), 0.13, 1.95)

# Gentle master compression and a short output fade.
mix = np.tanh(mix * 1.45) / np.tanh(1.45)
fade = int(0.22 * SR)
mix[-fade:] *= np.linspace(1, 0, fade)[:, None]
peak = float(np.max(np.abs(mix)))
if peak > 0:
    mix *= 0.86 / peak

pcm = np.clip(mix * 32767, -32768, 32767).astype('<i2')
OUT.parent.mkdir(parents=True, exist_ok=True)
with wave.open(str(OUT), 'wb') as wav:
    wav.setnchannels(2)
    wav.setsampwidth(2)
    wav.setframerate(SR)
    wav.writeframes(pcm.tobytes())

print(f"Wrote {OUT} ({DURATION:.1f}s, peak={peak:.4f})")
