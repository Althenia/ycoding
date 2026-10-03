import argparse
import json
import os
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time
import fcntl
from pathlib import Path


def sample(binary: Path, timeout: float) -> tuple[float, int]:
    with tempfile.TemporaryDirectory(prefix="ycoding-perf-frame-") as home:
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 100, 0, 0))
        env = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "TMPDIR") if key in os.environ}
        env.update({
            "HOME": home,
            "YCODING_TEST_HOME": home,
            "YCODING_DB": str(Path(home, "session.db")),
            "XDG_CONFIG_HOME": str(Path(home, "config")),
            "XDG_DATA_HOME": str(Path(home, "data")),
            "XDG_CACHE_HOME": str(Path(home, "cache")),
            "XDG_STATE_HOME": str(Path(home, "state")),
            "TERM": "xterm-256color",
        })
        started = time.monotonic_ns()
        process = subprocess.Popen(
            [str(binary), "--standalone", home],
            stdin=slave,
            stdout=slave,
            stderr=slave,
            env=env,
            start_new_session=True,
        )
        os.close(slave)
        output = bytearray()
        try:
            while (time.monotonic_ns() - started) / 1e9 < timeout and len(output) < 500_000:
                readable, _, _ = select.select([master], [], [], 0.05)
                if readable:
                    try:
                        data = os.read(master, 65536)
                    except OSError:
                        break
                    if not data:
                        break
                    output.extend(data)
                    if b"Message YCoding" in output and b"YCoding" in output:
                        elapsed = (time.monotonic_ns() - started) / 1e6
                        rss = subprocess.run(
                            ["ps", "-o", "rss=", "-p", str(process.pid)],
                            capture_output=True,
                            text=True,
                            check=True,
                            timeout=2,
                        )
                        return elapsed, int(rss.stdout.strip()) * 1024
                if process.poll() is not None:
                    break
            raise RuntimeError(f"No first composer frame after {timeout}s; exit={process.poll()}, bytes={len(output)}")
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=2)
            os.close(master)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--warmup", type=int, default=5)
    parser.add_argument("--runs", type=int, default=40)
    parser.add_argument("--timeout", type=float, default=8)
    args = parser.parse_args()
    if not args.binary.is_file() or not os.access(args.binary, os.X_OK):
        parser.error("binary must be an executable file")
    if args.warmup < 0 or args.runs < 1 or args.timeout <= 0:
        parser.error("warmup, runs, and timeout must be nonnegative with at least one run and positive timeout")
    for _ in range(args.warmup):
        sample(args.binary.resolve(), args.timeout)
    results = [sample(args.binary.resolve(), args.timeout) for _ in range(args.runs)]
    args.output.write_text(json.dumps({
        "metric": "compiled-tui-first-composer-frame",
        "binary_size_bytes": args.binary.stat().st_size,
        "terminal": {"columns": 100, "rows": 40},
        "warmup": args.warmup,
        "timeout_seconds": args.timeout,
        "elapsed_ms": [item[0] for item in results],
        "rss_at_frame_bytes": [item[1] for item in results],
    }, indent=2) + "\n")


if __name__ == "__main__":
    main()
