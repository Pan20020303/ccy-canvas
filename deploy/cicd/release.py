#!/usr/bin/python3
"""Root-owned, restricted deployment gateway for the existing CCY systemd pair."""
import fcntl
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile

CONFIG = Path('/etc/ccy-cicd.json')
REVISION = re.compile(r'[0-9a-f]{40}')
DIGEST = re.compile(r'[0-9a-f]{64}')


def run(arguments, **kwargs):
    return subprocess.run(arguments, check=True, timeout=2400, **kwargs)


def event(name, **values):
    try:
        print(json.dumps({'time': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                          'event': name, **values}), flush=True)
    except BrokenPipeError:
        # Complete a safe activation/rollback even if its SSH observer leaves.
        sys.stdout = open(os.devnull, 'w')


def read(path):
    return json.loads(path.read_text())


def file_digest(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def atomic_json(path, value):
    temporary = path.with_suffix('.next')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    os.replace(temporary, path)


def symlink(path, target):
    temporary = path.with_name(path.name + '.next')
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(target)
    os.replace(temporary, path)


def fetch(url):
    with urllib.request.urlopen(url, timeout=5) as response:
        if response.status != 200:
            raise RuntimeError(f'HTTP {response.status}: {url}')
        return response.read()


def probe_instance(port, revision, attempts=40):
    last = None
    for _ in range(attempts):
        try:
            data = json.loads(fetch(f'http://127.0.0.1:{port}/api/health'))['data']
            if data.get('status') != 'ok' or (revision != 'legacy' and data.get('version') != revision):
                raise RuntimeError(f'Unexpected API revision on port {port}')
            return
        except (OSError, ValueError, KeyError, RuntimeError) as error:
            last = error
            time.sleep(1)
    raise RuntimeError(f'Instance on {port} is unhealthy: {last}')


class Assets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = []

    def handle_starttag(self, tag, attributes):
        values = dict(attributes)
        if tag == 'script' and values.get('src'):
            self.paths.append(values['src'])
        if tag == 'link' and values.get('rel') in ('stylesheet', 'modulepreload'):
            self.paths.append(values.get('href', ''))


def public_probe(config, revision):
    base = config['base_url']
    deployed = json.loads(fetch(urllib.parse.urljoin(base, 'release.json')))
    if deployed['commit'] != revision:
        raise RuntimeError('Frontend release does not match backend')
    parser = Assets()
    parser.feed(fetch(base).decode())
    if not parser.paths:
        raise RuntimeError('Frontend has no entry assets')
    for item in parser.paths:
        url = urllib.parse.urljoin(base, item)
        if urllib.parse.urlparse(url).netloc == urllib.parse.urlparse(base).netloc:
            fetch(url)


def route(config, primary=True, secondary=True):
    """Change only the two existing CCY upstream entries, preserving other sites."""
    path = Path(config['nginx_file'])
    before = path.read_text()
    text = before
    for port, enabled in [(9090, primary), (9091, secondary)]:
        pattern = rf'(server\s+127\.0\.0\.1:{port}\b)([^;]*);'
        def replacement(match):
            options = re.sub(r'\s+down\b', '', match[2])
            return match[1] + options + ('' if enabled else ' down') + ';'
        text, count = re.subn(pattern, replacement, text)
        if count != 1:
            raise RuntimeError(f'Expected one CCY upstream on {port}')
    path.write_text(text)
    try:
        run(['nginx', '-t'], capture_output=True)
        run(['systemctl', 'reload', 'nginx'])
    except BaseException:
        path.write_text(before)
        raise


def restart(config, service):
    # TSTP stops queue intake but preserves active tasks and HTTP. SIGTERM then
    # waits for the worker's graceful drain; systemd must allow at least 40 min.
    result = subprocess.run(['systemctl', 'kill', '--kill-whom=main', '--signal=TSTP', service],
                            capture_output=True, timeout=15)
    if result.returncode:
        event('quiesce_unavailable', service=service)
    run(['systemctl', 'restart', service])


def roll(config, target):
    root = Path(config['root'])
    symlink(root / 'current', target)
    revision = read(target / 'release.json')['commit']
    route(config, primary=True, secondary=False)
    restart(config, 'ccy-canvas-secondary.service')
    probe_instance(9091, revision)
    route(config, primary=False, secondary=True)
    restart(config, 'ccy-canvas.service')
    probe_instance(9090, revision)
    route(config)
    symlink(root / 'web', target)
    public_probe(config, revision)


def activate(config, target):
    root = Path(config['root'])
    old = (root / 'current').resolve(strict=True)
    if target == old:
        for port in (9090, 9091):
            probe_instance(port, read(target / 'release.json')['commit'])
        public_probe(config, read(target / 'release.json')['commit'])
        event('already_active', release=target.name)
        return
    try:
        roll(config, target)
    except BaseException:
        roll(config, old)
        event('automatic_rollback_passed', release=old.name)
        raise
    symlink(root / 'previous', old)
    atomic_json(root / 'state.json', {'current': target.name, 'previous': old.name,
                                     'commit': read(target / 'release.json')['commit']})
    event('activation_passed', release=target.name, previous=old.name)


def sql(config, query):
    response = run(['docker', 'exec', '-i', config['postgres_container'], 'psql', '-X', '-q', '-A', '-t',
                    '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'ccy_canvas'],
                   input=query, text=True, capture_output=True)
    return response.stdout.strip()


def backup(config):
    root = Path(config['backup_root'])
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    existing = sorted([p for p in root.iterdir() if p.is_dir() and (p / 'backup.json').is_file()], reverse=True)
    required = config.get('minimum_free_bytes', 1800 * 1024 * 1024)
    if existing:
        required = max(required, int((existing[0] / 'database.dump').stat().st_size * 1.15) + 250 * 1024 * 1024)
    # Rotate only our verified snapshots, always preserving the latest verified
    # backup while a replacement is created. Unrelated backups are untouched.
    while shutil.disk_usage(root).free < required and len(existing) >= 2:
        oldest = existing.pop()
        if oldest.parent.resolve() == root.resolve():
            shutil.rmtree(oldest)
    if shutil.disk_usage(root).free < required:
        raise RuntimeError('Insufficient free space for a verified database backup')
    destination = root / time.strftime('%Y%m%dT%H%M%S', time.gmtime())
    destination.mkdir(mode=0o700)
    dump = destination / 'database.dump'
    with dump.open('wb') as output:
        run(['docker', 'exec', config['postgres_container'], 'pg_dump', '-U', 'postgres', '-d', 'ccy_canvas', '-Fc'], stdout=output)
    with dump.open('rb') as source:
        run(['docker', 'exec', '-i', config['postgres_container'], 'pg_restore', '--list'],
            stdin=source, stdout=subprocess.DEVNULL)
    for name in ('.env', '.env.secondary'):
        shutil.copy2(Path('/opt/ccy-canvas') / name, destination / name)
    for name in ('ccy-canvas.service', 'ccy-canvas-secondary.service'):
        shutil.copy2(Path('/etc/systemd/system') / name, destination / name)
    shutil.copy2(config['nginx_file'], destination / 'nginx.conf')
    atomic_json(destination / 'backup.json', {'sha256': file_digest(dump)})
    event('backup_verified', directory=str(destination), bytes=dump.stat().st_size)
    return destination


def migrations(config, target):
    applied = json.loads(sql(config, "SELECT COALESCE(json_object_agg(name,sha256),'{}'::json) FROM public.ccy_deploy_migrations;"))
    files = {p.name: p for p in sorted((target / 'migrations').glob('*.sql'))}
    hashes = {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in files.items()}
    for name, digest in applied.items():
        if hashes.get(name) != digest:
            raise RuntimeError(f'Applied migration was changed or removed: {name}')
    pending = [name for name in files if name not in applied]
    if not pending:
        return
    policy = read(target / 'migration-policy.json')['backward_compatible']
    statements = ['BEGIN;', 'SELECT pg_advisory_xact_lock(2081719112);',
                  "SET LOCAL lock_timeout='10s';", "SET LOCAL statement_timeout='120s';"]
    for name in pending:
        if not re.fullmatch(r'\d{3}_[a-z0-9_]+\.sql', name) or policy.get(name) != hashes[name]:
            raise RuntimeError(f'Pending migration needs explicit backward-compatible checksum approval: {name}')
        statements += [files[name].read_text(),
                       f"INSERT INTO public.ccy_deploy_migrations(name,sha256) VALUES ('{name}','{hashes[name]}');"]
    statements += ['COMMIT;']
    sql(config, '\n'.join(statements))
    event('migrations_applied', names=pending)


def unpack(stream, destination, digest):
    with tempfile.TemporaryFile() as archive:
        hasher = hashlib.sha256()
        total = 0
        while block := stream.read(1024 * 1024):
            total += len(block)
            if total > 200 * 1024 * 1024:
                raise RuntimeError('Release exceeds 200 MiB')
            hasher.update(block)
            archive.write(block)
        if hasher.hexdigest() != digest:
            raise RuntimeError('Release checksum mismatch')
        archive.seek(0)
        with tarfile.open(fileobj=archive, mode='r:gz') as bundle:
            members = bundle.getmembers()
            if len(members) > 12000 or sum(x.size for x in members) > 500 * 1024 * 1024:
                raise RuntimeError('Release extraction limits exceeded')
            names = set()
            for member in members:
                name = Path(member.name)
                if name.is_absolute() or '..' in name.parts or not (member.isdir() or member.isfile()):
                    raise RuntimeError('Unsafe archive member')
                if name.as_posix() in names:
                    raise RuntimeError('Duplicate archive member')
                names.add(name.as_posix())
            for member in members:
                path = destination / member.name
                if member.isdir():
                    path.mkdir(parents=True, exist_ok=True)
                else:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    with bundle.extractfile(member) as source, path.open('wb') as output:
                        shutil.copyfileobj(source, output)
                    path.chmod(0o755 if Path(member.name).as_posix() == 'bin/ccy-canvas-api' else 0o644)


def validate_artifact_url(url):
    parsed = urllib.parse.urlparse(url)
    host = (parsed.hostname or '').lower()
    allowed = host.endswith('.blob.core.windows.net') or host.endswith('.actions.githubusercontent.com')
    if parsed.scheme != 'https' or not allowed or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise RuntimeError('Artifact URL must be a signed GitHub Actions storage URL')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def download_artifact(url, destination):
    """Bounded range downloads avoid the slow single SSH data connection."""
    validate_artifact_url(url)
    deadline = time.monotonic() + 900
    def open_range(start, end):
        request = urllib.request.Request(url, headers={'Range': f'bytes={start}-{end}'})
        return urllib.request.build_opener(NoRedirect()).open(request, timeout=30)
    with open_range(0, 0) as response:
        header = response.headers.get('Content-Range', '')
        match = re.fullmatch(r'bytes 0-0/(\d+)', header)
        if response.status != 206 or not match:
            raise RuntimeError('Artifact storage did not honor the range request')
        size = int(match[1])
    if not 0 < size <= 220 * 1024 * 1024:
        raise RuntimeError('Artifact download exceeds its size limit')
    os.ftruncate(destination.fileno(), size)
    chunk_size = 1024 * 1024
    def download(start):
        end = min(start + chunk_size, size) - 1
        with open_range(start, end) as response:
            if response.status != 206 or response.headers.get('Content-Range') != f'bytes {start}-{end}/{size}':
                raise RuntimeError('Artifact range response does not match the requested bytes')
            data = bytearray()
            while block := response.read(min(65536, end - start + 2 - len(data))):
                data.extend(block)
                if len(data) > end - start + 1 or time.monotonic() > deadline:
                    raise RuntimeError('Artifact range exceeded its size or time limit')
        if len(data) != end - start + 1:
            raise RuntimeError('Incomplete artifact range')
        os.pwrite(destination.fileno(), data, start)
        return len(data)
    received = 0
    with ThreadPoolExecutor(max_workers=8) as workers:
        for completed in as_completed([workers.submit(download, offset) for offset in range(0, size, chunk_size)]):
            received += completed.result()
            event('artifact_download_progress', received=received, total=size)
    destination.seek(0)


def pull(config, revision, digest, url):
    with tempfile.TemporaryFile() as archive:
        download_artifact(url, archive)
        with zipfile.ZipFile(archive) as bundle:
            required = {'release.tar.gz', 'release.tar.gz.sha256'}
            if len(bundle.infolist()) != 2 or set(bundle.namelist()) != required:
                raise RuntimeError('Unexpected artifact ZIP contents')
            if bundle.getinfo('release.tar.gz').file_size > 200 * 1024 * 1024 or bundle.getinfo('release.tar.gz.sha256').file_size > 1024:
                raise RuntimeError('Artifact ZIP extraction limits exceeded')
            checksum = bundle.read('release.tar.gz.sha256').decode().split()
            if len(checksum) != 2 or checksum != [digest, 'release.tar.gz']:
                raise RuntimeError('Artifact checksum metadata does not match the release')
            with bundle.open('release.tar.gz') as source:
                deploy(config, revision, digest, source)


def deploy(config, revision, digest, stream):
    root = Path(config['root'])
    release = root / 'releases' / revision
    temporary = Path(tempfile.mkdtemp(prefix='.incoming-', dir=root / 'releases'))
    try:
        unpack(stream, temporary, digest)
        if read(temporary / 'release.json')['commit'] != revision or read(temporary / 'dist/release.json')['commit'] != revision:
            raise RuntimeError('Artifact revision mismatch')
        if (temporary / 'bin/ccy-canvas-api').read_bytes()[:4] != b'\x7fELF':
            raise RuntimeError('Backend is not a Linux ELF binary')
        if not (temporary / 'dist/index.html').is_file():
            raise RuntimeError('Frontend entry is missing')
        if release.exists():
            if (release / '.sha256').read_text().strip() != digest:
                raise RuntimeError('Immutable release already exists with different contents')
        else:
            (temporary / '.sha256').write_text(digest + '\n')
            temporary.rename(release)
        snapshot = backup(config)
        migrations(config, release)
        # Keep immutable hashed assets from previous releases available to open tabs.
        shutil.copytree(release / 'dist/assets', root / 'assets', dirs_exist_ok=True)
        activate(config, release)
        event('deployment_passed', commit=revision, backup=str(snapshot))
        prune(config)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def prune(config):
    root = Path(config['root'])
    keep = {(root / name).resolve() for name in ('current', 'previous') if (root / name).exists()}
    releases = sorted([p for p in (root / 'releases').iterdir() if p.is_dir() and not p.is_symlink() and not p.name.startswith('.')],
                      key=lambda p: p.stat().st_mtime, reverse=True)
    keep.update(releases[:5])
    for path in releases:
        if path not in keep and path.parent.resolve() == (root / 'releases').resolve():
            shutil.rmtree(path)
    backups = sorted([p for p in Path(config['backup_root']).iterdir() if p.is_dir() and not p.is_symlink()], reverse=True)
    for path in backups[2:]:
        if path.parent.resolve() == Path(config['backup_root']).resolve():
            shutil.rmtree(path)


def main():
    if os.geteuid() != 0 or len(sys.argv) != 2:
        raise SystemExit('Use the restricted deployment entrypoint')
    os.umask(0o022)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    config = read(CONFIG)
    command = sys.argv[1].split()
    root = Path(config['root'])
    with open('/run/lock/ccy-cicd.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if len(command) == 3 and command[0] == 'deploy' and REVISION.fullmatch(command[1]) and DIGEST.fullmatch(command[2]):
            deploy(config, command[1], command[2], sys.stdin.buffer)
        elif len(command) == 3 and command[0] == 'pull' and REVISION.fullmatch(command[1]) and DIGEST.fullmatch(command[2]):
            payload = sys.stdin.buffer.read(16385)
            if len(payload) > 16384:
                raise RuntimeError('Artifact request metadata is too large')
            pull(config, command[1], command[2], json.loads(payload)['url'])
        elif command == ['status']:
            target = (root / 'current').resolve(strict=True)
            revision = read(target / 'release.json')['commit']
            for port in (9090, 9091):
                probe_instance(port, revision, attempts=1)
            public_probe(config, revision)
            event('healthy', commit=revision, release=target.name)
        elif len(command) == 2 and command[0] == 'rollback' and (command[1] == 'previous' or REVISION.fullmatch(command[1])):
            target = ((root / 'previous').resolve(strict=True) if command[1] == 'previous' else root / 'releases' / command[1])
            if target.parent != root / 'releases' or not target.is_dir():
                raise RuntimeError('Rollback release is not retained')
            activate(config, target)
            event('rollback_passed', release=target.name)
        else:
            raise SystemExit('Allowed: status | deploy/pull <commit> <sha256> | rollback <previous|commit>')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        event('operation_failed', error=str(error))
        raise SystemExit(1)
