# /// script
# dependencies = ["numpy", "scipy"]
# ///
"""Score a rendered MP3 join and the continuation beyond its prepared prefix."""
import argparse
from pathlib import Path
import subprocess
import tempfile

import numpy as np
from scipy.signal import correlate

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("track", choices=["02", "03"])
parser.add_argument("capture", type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1] / "Media"
rate = 44100


def mono(file):
    """Use the same channel weighting and time base for every correlation."""
    raw = subprocess.check_output(["ffmpeg", "-v", "error", "-i", file, "-ar", str(rate),
                                   "-ac", "1", "-f", "f32le", "-"])
    return np.frombuffer(raw, "<f4").astype(float)


def locate(audio, pattern):
    """Normalize over each possible position to avoid selecting a louder, unrelated passage."""
    dots = correlate(audio, pattern, mode="valid", method="fft")
    accum = np.r_[0., np.cumsum(audio ** 2)]
    norm = np.sqrt(np.maximum(1e-16, accum[len(pattern):] - accum[:-len(pattern)]) * (pattern @ pattern))
    scores = dots / norm
    i = int(np.argmax(scores))
    if scores[i] < .85:
        raise RuntimeError(f"Unscorable anchor, correlation {scores[i]:.4f}")
    return i, float(scores[i])


observed = mono(args.capture)
reference = mono(root / f"{args.track}-trimmed.wav")
# The independent edit has four seconds of outgoing PCM, ending with the splice.
start = 4*rate
left, ls = locate(observed, reference[start-rate:start-rate//2])
right, rs = locate(observed, reference[start+rate//4:start+rate//2])
join = left + rate
print(f"join at {join/rate:.5f}s, incoming offset {right-rate//4-join:+d} frames, correlations {ls:.5f}/{rs:.5f}")

with tempfile.TemporaryDirectory() as temp:
    wav = Path(temp) / "successor.wav"
    subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16", root / f"{int(args.track)+1:02}.mp3", wav], check=True)
    successor = mono(wav)
# Get the exact mapping of successor source frames to the independent edit, including trim/overlap.
marker, _ = locate(successor[:2*rate], reference[start+rate//4:start+rate//2])
source_at_join = marker-rate//4
for second in (0.5, 13, 18):
    t = int(second*rate)
    position, score = locate(observed, successor[source_at_join+t:source_at_join+t+rate//3])
    print(f"at +{second:g}s, offset {position-join-t:+d} frames, correlation {score:.5f}")
