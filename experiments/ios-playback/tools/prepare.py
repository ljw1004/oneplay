"""Verify the original rips, then build independent Core Audio reference edits."""
from pathlib import Path
import array
import hashlib
import json
import math
import re
import shutil
import subprocess
import tempfile
import wave

ROOT = Path(__file__).resolve().parents[1]
MEDIA = ROOT / "Media"
RATE = 44100
FIXTURES = {
    "02": "c95cb8cdca8adc26852d5e4efd41afc36bc2c8f8aebbdb33e94ca288da611718",
    "03": "6ed3aef080805688f5e688e4269c7001949267a9bcf282afcd515b6cd163fa6c",
    "04": "5b495270ecf2cd35522445d84fa9bbc1f9fb228a3a1a10c9204e1b372e0b4029",
}


def write_wav(path, pcm):
    """Write stereo CD-rate PCM with no processing at the join."""
    with wave.open(str(path), "wb") as out:
        out.setparams((2, 2, RATE, 0, "NONE", ""))
        out.writeframes(pcm)


def prepare():
    """Only fixture identity and declared metadata cross into the app; it measures its own PCM."""
    MEDIA.mkdir(exist_ok=True)
    for track, digest in FIXTURES.items():
        source, = (Path.home() / "Downloads/gapless").glob(f"Pink Floyd*The Wall*[[]{track}]*.mp3")
        if hashlib.sha256(source.read_bytes()).hexdigest() != digest:
            raise ValueError(f"Unexpected rip for [{track}]")
        shutil.copyfile(source, MEDIA / f"{track}.mp3")

    decoded, bounds, manifest = {}, {}, {}
    with tempfile.TemporaryDirectory() as scratch:
        temp = Path(scratch)
        quiet = array.array("h")
        for frame in range(3 * RATE):
            t = frame / RATE
            envelope = min(1, t * 100) * min(1, (3-t) * 15) * 0.18 * math.exp(-2.2*t)
            value = round(32767 * envelope * (math.sin(2*math.pi*330*t) + 0.5*math.sin(2*math.pi*495*t)))
            quiet.extend((value, value))
        write_wav(MEDIA / "quiet.wav", quiet.tobytes())
        subprocess.run(["lame", "--silent", "-V2", MEDIA / "quiet.wav", MEDIA / "tagged.mp3"], check=True)
        for track in [*FIXTURES, "quiet", "tagged"]:
            src = MEDIA / (track + (".wav" if track == "quiet" else ".mp3"))
            wav = temp / f"{track}.wav"
            subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16", src, wav], check=True)
            with wave.open(str(wav), "rb") as f:
                assert (f.getnchannels(), f.getframerate(), f.getsampwidth()) == (2, RATE, 2)
                n = f.getnframes()
                decoded[track] = f.readframes(n)
            manifest[track] = {"frames": n}
            start, end = 0, n
            if track in FIXTURES:
                # These SHA-verified 3.87 rips carry a version-only Xing extension.
                s = memoryview(decoded[track]).cast("h")
                def quiet_frame(i):
                    return max(abs(s[2*i]), abs(s[2*i+1])) <= 32768 * 10**(-80/20)
                while start < int(.035*RATE) and quiet_frame(start):
                    start += 1
                while n-end < int(.150*RATE) and quiet_frame(end-1):
                    end -= 1
            elif track == "tagged":
                stats = subprocess.check_output(["afinfo", src], text=True)
                valid, delay, pad = map(int, re.search(r"(\d+) valid frames \+ (\d+) priming \+ (\d+) remainder", stats).groups())
                assert valid == n == len(quiet)//2 and delay > 0 and pad > 0
                manifest[track].update(delay=delay, padding=pad)
            bounds[track] = (start, end)
            print(track, "start trim", start, "end trim", n-end, "frames", manifest[track])

    for track, successor in [("02","03"), ("03","04"), ("quiet","04"), ("tagged","04"), ("tagged","tagged")]:
        start, end = bounds[track]
        first_frame = max(start, end - 4*RATE)
        control = "tagged-pair" if successor == track else track
        for label in ["trimmed", "hard", "untrimmed"]:
            stop = end if label != "untrimmed" else manifest[track]["frames"]
            head = bounds[successor][0] if label != "untrimmed" else 0
            left = decoded[track][4*first_frame:4*stop]
            right = decoded[successor][4*head:4*(head+4*RATE)]
            pcm = left + right
            if label == "trimmed" and (stop < manifest[track]["frames"] or head > 0):
                frames = round(.002*RATE)
                a = memoryview(left)[-frames*4:].cast("h")
                b = memoryview(right)[:frames*4].cast("h")
                mix = array.array("h")
                for i in range(frames):
                    weight = i/(frames-1)
                    for ch in range(2):
                        j = 2*i + ch
                        mix.append(round(a[j]*(1-weight) + b[j]*weight))
                pcm = left[:-frames*4] + mix.tobytes() + right[frames*4:]
            write_wav(MEDIA / f"{control}-{label}.wav", pcm)
    (MEDIA / "frames.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    prepare()
