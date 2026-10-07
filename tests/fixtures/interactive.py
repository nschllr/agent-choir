"""Offline PTY regression; no provider login or model calls."""
import errno
import fcntl
import os
import pty
import json
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
child = subprocess.Popen([sys.argv[1], sys.argv[2], *json.loads(sys.argv[3])],
                         stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
buffer = bytearray()

def receive(duration):
    deadline = time.monotonic() + duration
    while time.monotonic() < deadline:
        if select.select([master], [], [], min(0.05, max(0, deadline - time.monotonic())))[0]:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            buffer.extend(data)

def expect(text, clear=True):
    deadline = time.monotonic() + 10
    while text.encode() not in buffer:
        receive(0.05)
        if text.encode() in buffer:
            break
        if child.poll() is not None or time.monotonic() > deadline:
            raise AssertionError("Missing PTY output: " + text + "; tail: " + "\n".join(line for line in buffer.decode(errors="replace").splitlines() if re.search("[A-Za-z]", line))[-6000:])
    if clear:
        del buffer[:buffer.index(text.encode()) + len(text.encode())]

def send(text):
    os.write(master, text.encode())
    receive(0.15)

try:
    if sys.argv[4] == "headless":
        expect('"status": "complete"')
        assert child.wait(timeout=3) == 0
        print("headless exited normally")
    else:
        expect("\x1b[?1000h", clear=False)
        expect("Start a conversation with Codex.")
        receive(0.3)
        assert b"What should the two agents work on?" not in buffer
        assert child.poll() is None
        if sys.argv[4] == "interactive":
            send("\x07")  # Choose initial agent, then switch back.
            expect("Choose agent")
            send("\x1b[B")
            send("\r")
            expect("Start a conversation with Claude.")
            send("\x07")
            send("\r")
            expect("Start a conversation with Codex.")
            send("Explore collaboration")
            send("\r")
            expect("turns 1/30")
            receive(0.3)
        send("\x0e")  # Ctrl+N opens a provider picker without running it.
        expect("Choose agent")
        send("\x1b")
        receive(0.2)
        buffer.clear()
        send("\x0e")
        expect("Choose agent")
        send("\r")
        expect("Codex 1", clear=False)
        expect("Codex 2", clear=False)
        if sys.argv[4] == "interactive":
            expect("turns 1/30")
            receive(0.5)
            assert b"turns 2/30" not in buffer, "Opening a pane must not call an agent"
            assert child.poll() is None
        buffer.clear()
        send("\t")
        expect("To both")
        send("\t")
        expect("To Codex 1")
        if sys.argv[4] == "interactive":
            send("hi")
            send("\r")
            expect("turns 2/30")
            receive(0.5)
            assert b"turns 3/30" not in buffer, "Directed greeting must not wake the peer"
        send("\t")
        expect("To Codex 2")
        if sys.argv[4] == "interactive":
            send("Compare two simple timer interfaces together")
            send("\x02")  # Ctrl+B selects collaboration without submitting the draft.
            expect("collaboration ON")
            receive(0.4)
            assert b"turns 3/30" not in buffer, "Changing mode must not submit the draft"
            send("\r")  # Enter submits in the selected mode.
            expect("Round complete")
        if sys.argv[4] in ("empty", "read-only"):
            send("\x1b[<0;10;6M")  # Click first pane; release must not type into the draft.
            send("\x1b[<0;10;6m")
            expect("To Codex 1")
            send("BEGIN " + "wrapped words " * 35 + "END")
            expect("END▏")
            send("\x1b[<64;")  # Deliberately split a mouse packet across reads.
            send("90;6M")
            send("\x01")
            expect("› ▏BEGIN")
            send("\x15")
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 60, 0, 0))
            child.send_signal(signal.SIGWINCH)
            receive(0.3)
            send("\x1b[<0;10;21M")  # Second pane now stacks underneath the first.
            expect("To Codex 2")
        send("/quit")
        send("\r")
        assert child.wait(timeout=3) == 0
        receive(0.1)
        assert b"\x1b[?1000l" in buffer, "Mouse tracking must be disabled on exit"
        assert b"\x1b[?1049l" in buffer, "Shell screen must be restored on exit"
        print("single chat, split picker and named routing exited normally")
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)
