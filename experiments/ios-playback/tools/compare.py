# /// script
# dependencies = ["numpy", "scipy"]
# ///
"""Align one captured audition against its PCM edit. Run with uv run tools/compare.py."""
import argparse
from pathlib import Path
import subprocess

import numpy as np
from scipy.signal import correlate

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("track", choices=["02", "03", "quiet", "tagged", "tagged-pair"])
parser.add_argument("capture", type=Path, help="Recording of one audition, including both sides")
parser.add_argument("--start", type=float, default=0, help="Start time if a movie contains several auditions")
args = parser.parse_args()
rate = 44100
boundary = (3 if args.track in ("quiet", "tagged", "tagged-pair") else 4) * rate
media = Path(__file__).resolve().parents[1] / "Media"
reference = media / (args.track + "-trimmed.wav")


def decode(path, start=0):
    """Decode the same mono channel mix for both recordings, preserving relative time."""
    raw = subprocess.check_output(["ffmpeg", "-v", "error", "-ss", str(start), "-i", path, "-t", "16",
                                   "-map", "0:a:0", "-ar", str(rate), "-ac", "1", "-f", "f32le", "-"])
    return np.frombuffer(raw, dtype="<f4").astype(float)


ref, observed = decode(reference), decode(args.capture, args.start)


def locate(lo, hi, earliest=False, after=None):
    """Find the strongest normalized match, allowing the capture to start before playback."""
    template = ref[boundary+lo:boundary+hi]
    if len(observed) < len(template):
        raise ValueError("Capture is too short for this anchor")
    dots = correlate(observed, template, mode="valid", method="fft")
    cumulative = np.r_[0., np.cumsum(observed ** 2)]
    energy = cumulative[len(template):] - cumulative[:-len(template)]
    scores = dots / np.sqrt(np.maximum(energy, 1e-16) * (template @ template))
    if after is not None:
        scores[:max(0, after + lo)] = -1
    index = int(np.argmax(scores))
    if earliest:
        # A tagged-pair recording plays the identical chord twice. Choose the
        # first good onset, then refine the match within that occurrence.
        first = int(np.argmax(scores >= max(.8, scores[index]-.02)))
        index = first + int(np.argmax(scores[first:first+rate//2]))
    gain = dots[index] / (template @ template)
    return index - lo, scores[index], gain


# Use short windows close to each join so a seek offset or recording lead-in cancels.
# The sustained quiet chord is periodic; its onset gives an unambiguous control anchor.
left_range = (-boundary, -boundary + rate) if args.track in ("quiet", "tagged", "tagged-pair") else (-rate // 2, -rate // 50)
left, lscore, lgain = locate(*left_range, earliest=args.track == "tagged-pair")
right, rscore, rgain = locate(0 if args.track == "tagged-pair" else rate // 50, rate // 2, after=left-rate//2 if args.track == "tagged-pair" else None)
if args.track in ("quiet", "tagged", "tagged-pair") and not (.85 < lgain/rgain < 1.15):
    raise SystemExit("Quiet chord onset has a different gain from the successor; repeat the capture with the recorder running before Play.")
if min(lscore, rscore) < .8:
    raise SystemExit(f"Unscorable match, correlations {lscore:.3f}, {rscore:.3f}")
print(f"Capture boundary at {args.start + left/rate:.4f} s; incoming offset from edit "
      f"{right-left:+d} frames ({(right-left)*1000/rate:+.2f} ms); correlations {lscore:.4f}/{rscore:.4f}")

# Check the music immediately adjacent to each cut independently of the scheduling offset.
for label, offset, gain, lo, hi in [("last outgoing 20 ms", left, lgain, -rate//50, 0),
                                    ("splice window (88 frames)", left, lgain, -88, 0),
                                    ("first incoming 60 ms", right, rgain, 0, 3*rate//50)]:
    if offset+lo < 0 or offset+hi > len(observed):
        raise SystemExit("Incomplete edge in capture")
    a, b = ref[boundary+lo:boundary+hi], observed[offset+lo:offset+hi]
    if np.max(np.abs(a)) < 1e-10:
        peak = max(1e-12, np.max(np.abs(b)))
        print(f"{label}: silent reference; captured peak {20*np.log10(peak):.1f} dBFS")
        continue
    similarity = (a @ b) / max(1e-20, np.linalg.norm(a) * np.linalg.norm(b))
    level = np.linalg.norm(b) / max(1e-20, gain * np.linalg.norm(a))
    print(f"{label}: waveform correlation {similarity:.4f}, relative level {level:.4f}")
