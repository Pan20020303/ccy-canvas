import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def bundle(self, name, kind=None):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w:gz') as archive:
            member = tarfile.TarInfo(name)
            if kind is not None:
                member.type = kind
                member.linkname = '/etc/passwd'
            else:
                member.size = 4
            archive.addfile(member, io.BytesIO(b'data') if kind is None else None)
        return output.getvalue()

    def test_bad_checksum_never_extracts(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(RuntimeError, 'checksum'):
                release.unpack(io.BytesIO(self.bundle('dist/index.html')), Path(temporary), '0' * 64)
            self.assertEqual(list(Path(temporary).iterdir()), [])

    def test_archive_rejects_traversal_and_links(self):
        for name, kind in [('../escape', None), ('/etc/passwd', None), ('link', tarfile.SYMTYPE)]:
            data = self.bundle(name, kind)
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                with self.assertRaisesRegex(RuntimeError, 'Unsafe'):
                    release.unpack(io.BytesIO(data), Path(temporary), hashlib.sha256(data).hexdigest())
                self.assertEqual(list(Path(temporary).iterdir()), [])

    def test_packaged_binary_retains_execute_permission(self):
        data = self.bundle('./bin/ccy-canvas-api')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            release.unpack(io.BytesIO(data), root, hashlib.sha256(data).hexdigest())
            self.assertEqual((root / 'bin/ccy-canvas-api').stat().st_mode & 0o777, 0o755)

    def test_nginx_changes_only_canvas_upstreams(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary) / 'nginx.conf'
            config.write_text('upstream ccy_canvas_backend {\n server 127.0.0.1:9090 max_fails=2;\n server 127.0.0.1:9091 max_fails=2;\n}\nlocation /api/ { proxy_pass http://127.0.0.1:8080; }\n')
            with patch.object(release, 'run'):
                release.route({'nginx_file': str(config)}, primary=False, secondary=True)
                text = config.read_text()
                self.assertIn('9090 max_fails=2 down;', text)
                self.assertNotIn('9091 max_fails=2 down;', text)
                self.assertIn('proxy_pass http://127.0.0.1:8080;', text)

    def test_failed_candidate_runs_complete_rollback(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old, new = root / 'releases/old', root / 'releases/new'
            old.mkdir(parents=True)
            new.mkdir(parents=True)
            (root / 'current').symlink_to(old)
            with patch.object(release, 'roll', side_effect=[RuntimeError('bad health'), None]) as roll:
                with self.assertRaisesRegex(RuntimeError, 'bad health'):
                    release.activate({'root': str(root)}, new)
                self.assertEqual(roll.call_args_list[0].args[1], new)
                self.assertEqual(roll.call_args_list[1].args[1], old)
                self.assertFalse((root / 'previous').exists())

    def test_unapproved_migration_is_not_executed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'migrations').mkdir()
            (root / 'migrations/057_new.sql').write_text('ALTER TABLE users ADD COLUMN example text;')
            (root / 'migration-policy.json').write_text('{"backward_compatible":{}}')
            with patch.object(release, 'sql', return_value='{}') as query:
                with self.assertRaisesRegex(RuntimeError, 'checksum approval'):
                    release.migrations({}, root)
                self.assertEqual(query.call_count, 1)


if __name__ == '__main__':
    unittest.main()
