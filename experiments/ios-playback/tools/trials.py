"""Record the reference and three cold live auditions of each join (USB phone or simulator)."""
import argparse
import asyncio
import json
from pathlib import Path
import signal
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
device = parser.add_mutually_exclusive_group(required=True)
device.add_argument("--phone", metavar="NAME", help="Connect by USB and start iOS Screen Recording")
device.add_argument("--simulator", metavar="UDID", help="Uses idb's simulator audio recording")
parser.add_argument("--engine", choices=["PCM", "AVQueue"], default="PCM")
args = parser.parse_args()
bundle = "me.unto.oneplay.localplaybackprobe"
evidence = Path(__file__).resolve().parents[1] / "Evidence" / time.strftime("%Y%m%d-%H%M%S")
evidence.mkdir(parents=True)


def command(*args):
    """Bound transport failures and surface the actual device error."""
    return subprocess.check_output(args, text=True, timeout=120).strip()


async def run_trials(read_log):
    """Start a fresh process for each take and wait for the run's terminal trace."""
    for track in ["02", "03", "quiet", "tagged", "tagged-pair"]:
        modes = ["Edited WAV"] + ([args.engine] * (3 if track in ["02", "03"] else 1))
        for take, mode in enumerate(modes):
            print(track, mode, take, flush=True)
            prior = await read_log()
            recorder = None
            try:
                if args.phone:
                    command("xcrun", "devicectl", "device", "process", "launch", "--terminate-existing",
                            "--device", args.phone, bundle, "--", "--trial", track, mode)
                else:
                    subprocess.run(["xcrun", "simctl", "terminate", args.simulator, bundle], capture_output=True)
                    video = evidence / f"{track}-{take}.mp4"
                    recorder = subprocess.Popen(["idb", "record", "video", "--udid", args.simulator, "--audio",
                                                 "--fps", "10", "--scale-factor", "0.5", str(video)])
                    command("idb", "launch", "--udid", args.simulator, bundle, "--trial", track, mode)
                deadline = time.monotonic() + 75
                while True:
                    data = await read_log()
                    assert data.startswith(prior), "Trace changed during the run"
                    trial = data[len(prior):]
                    if "queue finished" in trial and "webkit " in trial:
                        break
                    if " error " in trial or time.monotonic() >= deadline:
                        raise RuntimeError(trial or "No events from launched app")
                    await asyncio.sleep(0.7)
            finally:
                if recorder:
                    recorder.send_signal(signal.SIGINT)
                    if recorder.wait(timeout=40):
                        raise RuntimeError("Simulator audio recording failed")
                (evidence / "gate1.log").write_text(await read_log())

async def main():
    if args.phone:
        from pymobiledevice3.lockdown import create_using_usbmux
        from pymobiledevice3.services.house_arrest import HouseArrestService

        details = command("xcrun", "devicectl", "-t", "10", "-q", "device", "info", "details", "--device", args.phone, "-j", "-")
        udid = json.loads(details)["result"]["hardwareProperties"]["udid"]
        # A single paired container session stays responsive across cold app launches.
        async with await create_using_usbmux(serial=udid, autopair=False) as link:
            async with await HouseArrestService.create(link, bundle) as files:
                async def read_phone_log():
                    return (await asyncio.wait_for(files.get_file_contents("Documents/gate1.log"), 10)).decode()
                await run_trials(read_phone_log)
    else:
        container = Path(command("xcrun", "simctl", "get_app_container", args.simulator, bundle, "data"))
        async def read_sim_log():
            return (container / "Documents/gate1.log").read_text()
        await run_trials(read_sim_log)


asyncio.run(main())
print(evidence)
