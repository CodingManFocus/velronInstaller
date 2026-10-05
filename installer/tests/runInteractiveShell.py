"""Drive the real piped installer through a controlling terminal for shell tests."""
import errno
import json
import os
import pty
import select
import signal
import sys
import termios
import time

shell, installer, steps_json = sys.argv[1:]
steps = json.loads(steps_json)
pid, terminal = pty.fork()
if pid == 0:
    # Keep the terminal's session leader alive while both pipeline processes
    # finish, as a user's interactive shell does when Ctrl+C interrupts a job.
    reader, writer = os.pipe()
    installer_pid = os.fork()
    if installer_pid == 0:
        os.setpgid(0, 0)
        os.dup2(reader, 0)
        os.close(reader)
        os.close(writer)
        os.execv(shell, [shell])
    os.setpgid(installer_pid, installer_pid)
    os.tcsetpgrp(0, installer_pid)
    source_pid = os.fork()
    if source_pid == 0:
        os.setpgid(0, installer_pid)
        os.dup2(writer, 1)
        os.close(reader)
        os.close(writer)
        os.execv('/bin/cat', ['cat', installer])
    os.close(reader)
    os.close(writer)
    os.waitpid(source_pid, 0)
    _, installer_status = os.waitpid(installer_pid, 0)
    # Command-substitution children can still be handling the same signal.
    # The terminal shell would remain alive while that cleanup finishes.
    cleanup_deadline = time.monotonic() + 2
    while time.monotonic() < cleanup_deadline:
        try:
            os.killpg(installer_pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.01)
    installer_exit = os.waitstatus_to_exitcode(installer_status)
    os._exit(installer_exit if installer_exit >= 0 else 128 - installer_exit)

output = bytearray()
initial_echo = termios.tcgetattr(terminal)[3] & termios.ECHO
cursor = 0
step_index = 0
deadline = time.monotonic() + 25
status = None
try:
    while time.monotonic() < deadline:
        while step_index < len(steps):
            step = steps[step_index]
            prompt = step["prompt"].encode()
            found = output.find(prompt, cursor)
            if found < 0:
                break
            if step.get('waitForHiddenInput') and termios.tcgetattr(terminal)[3] & termios.ECHO:
                break
            cursor = found + len(prompt)
            answer = step["answer"]
            os.write(terminal, b"\x04" if answer is None else (answer + "\n").encode())
            step_index += 1
        if select.select([terminal], [], [], 0.1)[0]:
            try:
                chunk = os.read(terminal, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                break
            if not chunk:
                break
            output.extend(chunk)
        if status is None:
            exited_pid, exit_status = os.waitpid(pid, os.WNOHANG)
            if exited_pid:
                status = exit_status
        # The pipeline shell may exit before its children finish signal cleanup.
        # Keep reading until they also close the terminal.
    else:
        sys.stdout.buffer.write(output)
        raise TimeoutError("Interactive installer did not exit within 25 seconds.")
    if status is None:
        _, status = os.waitpid(pid, 0)
    sys.stdout.buffer.write(output)
    if (termios.tcgetattr(terminal)[3] & termios.ECHO) != initial_echo:
        raise RuntimeError('Installer left terminal echo disabled.')
    if step_index != len(steps):
        raise RuntimeError(f"Installer exited before prompt {steps[step_index]['prompt']!r}.")
    exit_code = os.waitstatus_to_exitcode(status)
    sys.exit(exit_code if exit_code >= 0 else 128 - exit_code)
finally:
    os.close(terminal)
    if status is None:
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
