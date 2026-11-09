"""Stop the entire media process group when the API closes its control pipe.

This also works through WSL: killing wsl.exe alone can leave FFmpeg running.
The child inherits stdout/stderr; stdin is reserved for the cancellation lease.
"""
import os
import signal
import subprocess
import sys
import select

child = subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL, start_new_session=True)


def stop_group():
    try:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass
        # Descendants can outlive the main process, including children that
        # ignore SIGTERM. The entire owned group must stop on cancellation.
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


try:
    while child.poll() is None:
        readable, _, _ = select.select([0], [], [], 0.05)
        if readable and not os.read(0, 4096):
            stop_group()
            break
    sys.exit(child.wait())
finally:
    stop_group()
