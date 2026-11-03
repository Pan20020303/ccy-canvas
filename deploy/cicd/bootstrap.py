#!/usr/bin/python3
"""One-time root bootstrap for the existing two-instance CCY server."""
import difflib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import sys

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
SOURCE = Path('/opt/ccy-canvas')
ADMIN = Path('/root/ccy-cicd-admin')
CONFIG = {
    'root': '/opt/ccy-canvas-runtime',
    'backup_root': '/var/backups/ccy-cicd',
    'postgres_container': 'ccy-canvas-postgres',
    'nginx_file': '/etc/nginx/conf.d/ccy-canvas.conf',
    'base_url': 'http://127.0.0.1/',
    'minimum_free_bytes': 1800 * 1024 * 1024,
}


def database(arguments, **kwargs):
    return subprocess.run(['docker', 'exec', *arguments], check=True, capture_output=True, timeout=180, **kwargs)


def verify_baseline():
    container = CONFIG['postgres_container']
    scratch = 'ccy_cicd_schema_' + str(os.getpid())
    database([container, 'createdb', '-U', 'postgres', scratch])
    try:
        for path in sorted((SOURCE / 'backend/db/migrations').glob('*.sql')):
            database(['-i', container, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', scratch], input=path.read_bytes())
        def schema(name):
            raw = database([container, 'pg_dump', '-U', 'postgres', '-d', name, '--schema-only', '--no-owner', '--no-privileges', '--schema=public']).stdout.decode()
            # Older PostgreSQL versions deparse varchar-array -> text-array
            # coercions per element; current versions cast the complete array.
            # Canonicalize only this equivalent literal-array representation.
            raw = re.sub(r"\('([^']*)'::character varying\)::text", r"'\1'::text", raw)
            raw = re.sub(r"\(ARRAY\[([^\]]+)\]\)::text\[\]",
                         lambda match: 'ARRAY[' + match[1].replace('::character varying', '::text') + ']', raw)
            return [line for line in raw.splitlines() if line and not line.startswith(('--', '\\restrict', '\\unrestrict', 'COMMENT ON SCHEMA public IS '))]
        difference = '\n'.join(difflib.unified_diff(schema(scratch), schema('ccy_canvas'), fromfile='migration-schema', tofile='production-schema'))
        (ADMIN / 'schema-diff.txt').write_text(difference)
        if difference:
            raise RuntimeError('Production schema differs from its migration baseline; inspect schema-diff.txt')
        release.event('schema_baseline_verified')
    finally:
        database([container, 'dropdb', '-U', 'postgres', scratch])


def main():
    if os.geteuid() != 0:
        raise SystemExit('Run the one-time bootstrap as root')
    ADMIN.mkdir(mode=0o700, exist_ok=True)
    verify_baseline()
    if '--check' in sys.argv:
        return
    if Path(CONFIG['root']).exists() or Path('/etc/ccy-cicd.json').exists():
        raise RuntimeError('A runtime already exists; do not bootstrap over it')
    snapshot = release.backup(CONFIG)
    root = Path(CONFIG['root'])
    baseline = root / 'releases/baseline'
    (baseline / 'bin').mkdir(parents=True)
    shutil.copy2(SOURCE / 'bin/ccy-canvas-api', baseline / 'bin/ccy-canvas-api')
    (baseline / 'bin/ccy-canvas-api').chmod(0o755)
    shutil.copytree(SOURCE / 'dist', baseline / 'dist')
    shutil.copytree(SOURCE / 'backend/db/migrations', baseline / 'migrations')
    shutil.copytree(SOURCE / 'backend/scripts', baseline / 'backend/scripts')
    shutil.copytree(SOURCE / 'node_modules/typescript', baseline / 'node_modules/typescript')
    shutil.copytree(SOURCE / 'dist/assets', root / 'assets')
    metadata = {'commit': 'legacy', 'source_commit': (SOURCE / 'RELEASE_COMMIT').read_text().strip()}
    release.atomic_json(baseline / 'release.json', metadata)
    release.atomic_json(baseline / 'dist/release.json', metadata)
    release.atomic_json(baseline / 'migration-policy.json', {'backward_compatible': {}})
    release.symlink(root / 'current', baseline)
    release.symlink(root / 'web', baseline)
    release.atomic_json(Path('/etc/ccy-cicd.json'), CONFIG)
    shutil.copy2(Path(__file__).with_name('release.py'), '/usr/local/sbin/ccy-deploy')
    Path('/usr/local/sbin/ccy-deploy').chmod(0o755)

    statements = ['BEGIN;', 'CREATE TABLE public.ccy_deploy_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());']
    for path in sorted((baseline / 'migrations').glob('*.sql')):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        statements.append(f"INSERT INTO public.ccy_deploy_migrations(name,sha256) VALUES ('{path.name}','{digest}');")
    statements += ['COMMIT;']
    release.sql(CONFIG, '\n'.join(statements))

    nginx = Path(CONFIG['nginx_file'])
    original = nginx.read_text()
    if original.count('root /opt/ccy-canvas/dist;') != 1 or original.count('location /assets/ {') != 1:
        raise RuntimeError('Unexpected existing Nginx layout')
    updated = original.replace('root /opt/ccy-canvas/dist;', 'root /opt/ccy-canvas-runtime/web/dist;')
    updated = updated.replace('location /assets/ {', 'location /assets/ {\n        root /opt/ccy-canvas-runtime;')
    dropins = []
    for service in ('ccy-canvas.service', 'ccy-canvas-secondary.service'):
        dropin = Path('/etc/systemd/system') / (service + '.d/cicd.conf')
        dropin.parent.mkdir(exist_ok=True)
        if dropin.exists():
            raise RuntimeError('Existing CI/CD drop-in must be inspected first')
        dropin.write_text('[Service]\nExecStart=\nExecStart=/opt/ccy-canvas-runtime/current/bin/ccy-canvas-api\nTimeoutStopSec=2400\nEnvironment=PROVIDER_TS_RUNNER_PATH=/opt/ccy-canvas-runtime/current/backend/scripts/provider_ts_runner.mjs\n')
        dropins.append(dropin)
    try:
        nginx.write_text(updated)
        release.run(['nginx', '-t'], capture_output=True)
        release.run(['systemctl', 'daemon-reload'])
        release.roll(CONFIG, baseline)
    except BaseException:
        nginx.write_text(original)
        for path in dropins:
            path.unlink(missing_ok=True)
        release.run(['systemctl', 'daemon-reload'])
        release.run(['systemctl', 'restart', 'ccy-canvas-secondary', 'ccy-canvas'])
        release.run(['systemctl', 'reload', 'nginx'])
        raise

    try:
        account = pwd.getpwnam('ccy-deploy')
    except KeyError:
        release.run(['useradd', '--create-home', '--shell', '/bin/sh', 'ccy-deploy'])
        account = pwd.getpwnam('ccy-deploy')
    entry = Path('/usr/local/bin/ccy-deploy-entry')
    entry.write_text('#!/bin/sh\nexec /usr/bin/sudo -n /usr/local/sbin/ccy-deploy "${SSH_ORIGINAL_COMMAND:-}"\n')
    entry.chmod(0o755)
    sudo = Path('/etc/sudoers.d/ccy-cicd')
    sudo.write_text('ccy-deploy ALL=(root) NOPASSWD: /usr/local/sbin/ccy-deploy *\n')
    sudo.chmod(0o440)
    release.run(['visudo', '-cf', str(sudo)], capture_output=True)
    key = ADMIN / 'deploy-key'
    if not key.exists():
        release.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'ccy-github-actions', '-f', str(key)])
    ssh = Path(account.pw_dir) / '.ssh'
    ssh.mkdir(mode=0o700, exist_ok=True)
    authorized = ssh / 'authorized_keys'
    authorized.write_text('restrict,command="/usr/local/bin/ccy-deploy-entry" ' + key.with_suffix('.pub').read_text())
    authorized.chmod(0o600)
    os.chown(ssh, account.pw_uid, account.pw_gid)
    os.chown(authorized, account.pw_uid, account.pw_gid)
    (ADMIN / 'known_hosts').write_text('152.136.110.180 ' + Path('/etc/ssh/ssh_host_ed25519_key.pub').read_text())
    release.atomic_json(root / 'state.json', {'current': baseline.name, 'commit': 'legacy', 'backup': str(snapshot)})
    release.event('bootstrap_passed', backup=str(snapshot))


if __name__ == '__main__':
    main()
