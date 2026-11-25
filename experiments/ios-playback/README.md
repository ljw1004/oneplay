# OnePlay local playback probe

From this directory, run `python3 tools/prepare.py` (macOS Core Audio and the `lame` CLI), then open `Gate1.xcodeproj` in Xcode. Select the Gate1 scheme and the listener’s iPhone. The script verifies the SHA-256 of the three original MP3s in `~/Downloads/gapless`, generates independent comparison WAVs, and makes a tagged MP3 control. Media and recordings stay local. The development bundle ID is `me.unto.oneplay.localplaybackprobe`.

## Listen on the iPhone

1. Open **OnePlay Probe** from the Home Screen, quit it from the app switcher, and reopen. On first launch the prior storage markers are null. On the next launch the storage readout should show `oneplay://app` and `gate1-v1` for the module, localStorage and IndexedDB.
2. Turn on airplane mode and switch Wi-Fi off. Keep the same speaker or headphones throughout. Start iOS Screen Recording in Control Center with the microphone off to capture app output. Record the physical output route and listening judgment separately.
3. Select **Edited WAV** and tap **[02] The Thin Ice → [03]**. Repeat with **Hard-cut WAV**, **Uncut WAV** and **PCM**, then try **[03] Another Brick → [04]**. Each shortcut plays four seconds on either side. Check the last musical sound, length of the pause and incoming attack. **PCM** schedules the original files through one AVAudioPlayerNode. **AVQueue** plays a composition for each original through AVQueuePlayer. Edited WAV includes the 2 ms splice. Hard-cut WAV uses the same trim points and joins them directly.
4. Try **Quiet WAV → [04]** and **Tagged quiet MP3 → [04]**. Both contain the same decaying three-second chord. The tagged MP3 declares 576 priming and 756 padding frames. The decoder already presents exactly 132,300 valid frames. The probe preserves its full decoded length. Its join into untagged [04] gets an overlap because [04] loses leading silence. **Tagged → tagged control** plays the chord twice with a direct join. **Play full tracks [02]–[04]** uses the selected native engine (PCM when a WAV reference is selected).
5. For the scored captures, record the edited WAV first, then three new-process PCM auditions per *Wall* join on the same route. Force-quit and reopen for each manual attempt. Stop the recording and save it to the Mac with the attempt order. **Share event log** exports the append-only monotonic trace.

For automatic cold launches, open the app once, connect the unlocked phone by USB, enable airplane mode, start a screen recording, then run `uv run --with pymobiledevice3 tools/trials.py --phone LuPhone13` from this directory. The script saves the device trace under `Evidence/`. For simulator runs, `python3 tools/trials.py --simulator UDID` uses idb to save app-output captures. Select the alternate player with `--engine AVQueue`.

## Measure the output

Run `uv run tools/compare.py 02 Evidence/take.wav` with an idb capture or an iPhone screen recording. Use `03`, `quiet` or `tagged` for the other boundaries. For a long recording, add `--start SECONDS` to place one audition in its 16-second analysis window. The tool uses FFmpeg, independently matches a waveform on each side, reports the successor’s offset relative to the edited WAV, and compares the level and shape of the outgoing and incoming edges. A capture of the edited WAV on the same route establishes the reference for comparison.

The release build stages known fixtures. Its manifest supplies tag presence and expected decoded duration. On the iPhone, Swift reads bounded PCM windows at both ends of each untagged MP3. Consecutive frames with every channel at or below −80 dBFS may be removed, up to 35 ms at the start and 150 ms at the end. When either adjoining edge was heuristically trimmed, both engines overlap the last 88 outgoing frames with the first 88 incoming frames (1.995 ms at CD rate). A linear gain falls from one to zero as its complement rises from zero to one, identically in both channels. Two untouched edges meet directly. Both engines play from the original media. The WAV generator computes its own trims from a separate decode. A valid declared delay or padding bypasses the fallback entirely.

The trace records host uptime, run, route, sample rate, file size, decoded trim, playback and completion. AVQueue also reports item readiness, transitions, clock anchors and stalls. Local playback has no network URL lookup, first network byte or renewal. The file sizes in the trace describe the source files.

To copy a trace separately:

```sh
mkdir -p Evidence
xcrun devicectl device copy from --device LuPhone13 \
  --domain-type appDataContainer --domain-identifier me.unto.oneplay.localplaybackprobe \
  --source Documents/gate1.log --destination Evidence/iphone.log
```

The deterministic stereo and metadata checks run with `swiftc -parse-as-library App/Splice.swift tools/check-audio.swift -o /tmp/oneplay-check-audio && /tmp/oneplay-check-audio`.

## Locked cellular MP3 probe

The Debug configuration includes the metered transport and the audio background mode. Build Release for the local-only probe. The temporary HTTPS origin contains the ten original Wall MP3s and a two-hour cancellation fixture. The two URLs for each recording resolve to the same file version. The private manifest lives in the app’s Documents container. To prepare a **new** temporary origin, run `python3 tools/stage-cellular.py` from this directory. The following command provisions an existing manifest over USB.

```sh
xcrun devicectl device copy to --device LuPhone13 \
  --domain-type appDataContainer --domain-identifier me.unto.oneplay.localplaybackprobe \
  --source /tmp/oneplay-gate2/cellular.json --destination Documents/cellular.json
```

“Locked cellular trials” opens the test controls. The four-trial suite plays the last 16 seconds of [02] and the first 22 seconds of [03] twice, with a 5- and a 10-second renewal. It then plays [03] → [04] with a 10-second renewal. The final control prepares only one second of [03]. The time between trials includes preparation of the next audition. The join within each trial is the measurement.

The `--cellular suite` launch argument starts the same four trials without attaching a debugger. `--cellular web` starts from a fresh bundled page, exercises a seek and a stale release, and reattaches after the next advance. Its [03] excerpt is 22 seconds. `--cellular unattended` mutes the probe’s mixer, runs the web trial, the cancellation and boundary-race controls, and then streams all ten full tracks. The speaker volume setting is preserved. The node tap records before the mixer. The full album writes only timing and transfer events.

`Documents/cellular.log` records monotonic times, occurrence, range offsets, measured body bytes and the per-transaction cellular flag. Short trials save a rendered stereo CAF in the same directory. These commands score the phone captures against the independently decoded MP3s and the phase 1 join edits.

```sh
uv run tools/score-cellular.py 02 Evidence/cellular/phone-cellular-ten.caf
uv run tools/score-cellular.py 03 Evidence/cellular/phone-cellular-join03.caf
```

The score at 13 and 18 seconds checks for a gap after the prepared prefix runs out. A matching join alone cannot establish that continuation was seamless.

Run `python3 tools/check-ranges.py` on the Mac for the byte-cap, retry, expired-location, prefix-reuse and 416 controls. This uses an isolated loopback HTTP fixture. The iOS transport requires HTTPS.
