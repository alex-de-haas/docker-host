import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('native_update', HERE / 'check-platform-native-update.py')
native_update = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(native_update)

DESCENDANT = """
import os
from pathlib import Path
import sys
import time
root = Path(sys.argv[1])
(root / 'ready').write_text(str(os.getpid()))
deadline = time.monotonic() + 20
while not (root / 'release').exists() and time.monotonic() < deadline:
    time.sleep(.02)
os.close(1)
os.close(2)
(root / 'closed').write_text('done')
os._exit(0)
"""

PARENT = f"""
from pathlib import Path
import subprocess
import sys
import time
root = Path(sys.argv[1])
subprocess.Popen([sys.executable, '-c', {DESCENDANT!r}, str(root)])
deadline = time.monotonic() + 5
while not (root / 'ready').exists() and time.monotonic() < deadline:
    time.sleep(.02)
assert (root / 'ready').exists(), 'Descendant did not start'
print('parent-output', flush=True)
print('parent-error', file=sys.stderr, flush=True)
if sys.argv[2] == 'timeout':
    time.sleep(60)
"""


class NativeUpdateProcessTests(unittest.TestCase):
    def stop_descendant(self, root):
        # Release the descendant even when the runner or timing assertion fails. Its own
        # deadline is a final guard if this test process is interrupted unexpectedly.
        (root / 'release').touch()
        deadline = time.monotonic() + 5
        while not (root / 'closed').exists() and time.monotonic() < deadline:
            time.sleep(.02)
        if not (root / 'closed').exists() and (root / 'ready').exists():
            pid = int((root / 'ready').read_text())
            if os.name == 'nt':
                subprocess.run(['taskkill', '/pid', str(pid), '/f'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
            else:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            self.fail('The test descendant did not acknowledge cleanup')

    def test_direct_exit_does_not_wait_for_descendant_output_handles(self):
        with tempfile.TemporaryDirectory(prefix='hosty-output-test-') as directory:
            root = Path(directory)
            try:
                started = time.monotonic()
                output = native_update.run_process([sys.executable, '-c', PARENT, root, 'exit'], timeout=5)
                self.assertLess(time.monotonic() - started, 5)
                self.assertEqual('parent-output\n', output.replace('\r\n', '\n'))
                self.assertTrue((root / 'ready').exists())
                self.assertFalse((root / 'closed').exists(), 'Descendant must still hold the output handles')
            finally:
                self.stop_descendant(root)

    def test_timeout_remains_bounded_with_descendant_output_handles(self):
        with tempfile.TemporaryDirectory(prefix='hosty-timeout-test-') as directory:
            root = Path(directory)
            try:
                started = time.monotonic()
                with self.assertRaisesRegex(RuntimeError, 'timed out after 2 seconds') as failure:
                    native_update.run_process([sys.executable, '-c', PARENT, root, 'timeout'], timeout=2)
                self.assertLess(time.monotonic() - started, 6)
                self.assertIn('parent-output', str(failure.exception))
                self.assertIn('parent-error', str(failure.exception))
                self.assertFalse((root / 'closed').exists(), 'Timeout must not depend on descendant exit')
            finally:
                self.stop_descendant(root)

    def test_failure_diagnostics_keep_only_output_tails(self):
        program = "import sys; print('x' * 20000 + 'stdout-tail'); print('y' * 20000 + 'stderr-tail', file=sys.stderr); sys.exit(7)"
        with self.assertRaisesRegex(RuntimeError, 'exited 7, expected 0') as failure:
            native_update.run_process([sys.executable, '-c', program], timeout=5)
        message = str(failure.exception)
        self.assertIn('stdout-tail', message)
        self.assertIn('stderr-tail', message)
        self.assertLess(len(message), 13000)


if __name__ == '__main__':
    unittest.main()
