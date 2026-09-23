"""Reviewable, journalled CCY skill updates; never invokes a skill or production API.

Default: read the manifest, GET current skills, and save a backup/plan only.
Use --apply to write, or --rollback to restore this journal's updated skills and
disable its newly created skills. Relative manifest file paths use its directory.
Manifest: {"changes": [{"action": "update", "id": "...", "file": "...md"},
                      {"action": "create", "slug": "...", "file": "...md",
                       "name": "...", "description": "...", "enabled": true}]}.
Top-level "update" / "create" arrays are also accepted. All other fields and spec
keys survive updates. Template-executing skills are rejected unless an update
explicitly sets template_policy="replace_with_document" (removes only execution
templates and replaces content_md), or disable_only=true (preserves all content).
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / 'run/h3-skill-audit-20260907/change-manifest.json'
SOURCE = 'ccy-h3-skill-audit'
UPSERT_KEYS = ('name', 'description', 'category', 'icon', 'kind', 'spec',
               'input_schema', 'output_schema', 'enabled')
SENSITIVE_KEYS = {'authorization', 'cookie', 'set_cookie', 'api_key', 'apikey',
                  'access_token', 'refresh_token', 'session_token', 'password',
                  'secret', 'session_secret', 'private_key'}


class SyncError(RuntimeError):
    pass


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(',', ':')).encode()).hexdigest()


def assert_no_credentials(value):
    if isinstance(value, dict):
        for key, child in value.items():
            if str(key).lower().replace('-', '_') in SENSITIVE_KEYS:
                raise SyncError('A target object contains credential fields; no snapshot or update was written')
            assert_no_credentials(child)
    elif isinstance(value, list):
        for child in value:
            assert_no_credentials(child)


def write_json(path, value):
    assert_no_credentials(value)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def payload(row):
    return {key: copy.deepcopy(row.get(key, {} if key.endswith('schema') or key == 'spec'
                                      else True if key == 'enabled' else '')) for key in UPSERT_KEYS}


def ensure_document(row, allow_templates=False):
    spec = row.get('spec')
    if not isinstance(spec, dict):
        raise SyncError('Skill spec must be an object')
    if not allow_templates and ('user_template' in spec or 'system_prompt' in spec):
        raise SyncError('Target contains user_template/system_prompt; explicit template migration is required')
    if row.get('kind') not in ('prompt', 'code'):
        raise SyncError('Only Markdown document skill kinds are eligible')
    assert_no_credentials(row)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise SyncError('Redirect refused; local session must remain on the configured API')


class Client:
    def __init__(self, base_url):
        parsed = urllib.parse.urlsplit(base_url)
        if (parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost', '::1')
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in ('', '/')):
            raise SyncError('Use a local HTTP API base URL, for example http://127.0.0.1:9090')
        self.base_url = base_url.rstrip('/')
        module_spec = importlib.util.spec_from_file_location(
            '_ccy_skill_sync_session', ROOT / 'scripts/run_ep01_user_seven.py')
        self.session = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(self.session)
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, method, route, body=None):
        if route != '/api/admin/skills' and not re.fullmatch(r'/api/admin/skills/[0-9a-f-]{36}', route):
            raise SyncError('This tool is restricted to admin skill endpoints')
        req = urllib.request.Request(self.base_url + route, method=method,
            headers=self.session.headers(),
            data=None if body is None else json.dumps(body, ensure_ascii=False).encode())
        try:
            with self.opener.open(req, timeout=45) as response:
                raw = response.read()
            result = json.loads(raw) if raw else {}
            return result.get('data', result) if isinstance(result, dict) else result
        except urllib.error.HTTPError as exc:
            raise SyncError(f'{method} failed: HTTP {exc.code}; inspect journal before another write') from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            raise SyncError(f'{method} outcome unavailable; inspect journal before another write') from None

    def list(self):
        result = self.request('GET', '/api/admin/skills')
        if not isinstance(result, list):
            raise SyncError('Unexpected admin skill list response')
        return result


def manifest_entries(document):
    changes = document.get('changes')
    if changes is None:
        changes = [dict(item, action=action) for action in ('update', 'create')
                   for item in document.get(action, [])]
    if not isinstance(changes, list) or not changes:
        raise SyncError('Manifest must contain a nonempty changes list')
    return changes


def find_slug(rows, slug):
    found = [row for row in rows if isinstance(row.get('spec'), dict)
             and row['spec'].get('source') == SOURCE and row['spec'].get('slug') == slug]
    if len(found) > 1:
        raise SyncError('Duplicate source/slug already exists; no automatic mutation')
    return found[0] if found else None


def make_plan(manifest, rows):
    document = json.loads(manifest.read_text(encoding='utf-8-sig'))
    items, seen = [], set()
    for change in manifest_entries(document):
        if not isinstance(change, dict) or change.get('action') not in ('update', 'create'):
            raise SyncError('Each change must have action=update or create')
        action = change['action']
        template_policy = change.get('template_policy')
        disable_only = change.get('disable_only', False)
        if not isinstance(disable_only, bool):
            raise SyncError('disable_only must be a JSON boolean')
        if template_policy not in (None, 'replace_with_document'):
            raise SyncError('Unsupported template_policy')
        if (template_policy or disable_only) and action != 'update':
            raise SyncError('Template conversion and disable_only require an existing update target')
        if template_policy and disable_only:
            raise SyncError('disable_only cannot also replace templates')
        key = change.get('id') if action == 'update' else change.get('slug')
        if not isinstance(key, str) or not key or (action, key) in seen:
            raise SyncError('Missing or duplicate target ID/slug')
        if action == 'update' and not re.fullmatch(r'[0-9a-f-]{36}', key):
            raise SyncError('Invalid skill ID')
        if action == 'create' and not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,79}', key):
            raise SyncError('Create slug must use lowercase letters, digits, hyphens or underscores')
        seen.add((action, key))
        file, content = None, None
        if not disable_only:
            file = Path(change.get('file', ''))
            if not file.is_absolute():
                file = manifest.parent / file
            file = file.resolve()
            if file.suffix.lower() != '.md' or not file.is_file():
                raise SyncError('Every content change must reference an existing Markdown file')
            content = file.read_text(encoding='utf-8-sig').strip()
            if not content:
                raise SyncError('Empty Markdown is not accepted')
        old = next((r for r in rows if r.get('id') == key), None) if action == 'update' else find_slug(rows, key)
        if action == 'update' and old is None:
            raise SyncError('Update target does not exist: ' + key)
        if old:
            ensure_document(old, allow_templates=bool(template_policy or disable_only))
        desired = payload(old) if action == 'update' else {
            'name': '', 'description': '', 'category': 'production_skills', 'icon': 'sparkles',
            'kind': 'prompt', 'spec': {'source': SOURCE, 'slug': key},
            'input_schema': {'type': 'object', 'properties': {'input': {'type': 'string'}}},
            'output_schema': {'type': 'object', 'properties': {'result': {'type': 'string'}}}, 'enabled': True}
        if disable_only:
            if change.get('enabled', False) is not False:
                raise SyncError('disable_only cannot enable a skill')
            for field in ('name', 'category', 'icon'):
                if field in change and change[field] != desired[field]:
                    raise SyncError('disable_only can change only enabled and description')
            desired['enabled'] = False
            if 'description' in change:
                desired['description'] = change['description']
        else:
            for field in ('name', 'description', 'category', 'icon', 'enabled'):
                if field in change:
                    desired[field] = change[field]
            if template_policy == 'replace_with_document':
                desired['spec'].pop('user_template', None)
                desired['spec'].pop('system_prompt', None)
                desired['kind'] = 'prompt'
            desired['spec']['content_md'] = content
        if not isinstance(desired['name'], str) or not desired['name'].strip():
            raise SyncError('Skill name must not be empty')
        if not isinstance(desired['enabled'], bool):
            raise SyncError('enabled must be a JSON boolean')
        ensure_document(desired, allow_templates=disable_only)
        if action == 'create' and old and payload(old) != desired:
            raise SyncError('Create source/slug already exists with different content; use update with its ID')
        items.append({'action': action, 'key': key, 'file': str(file) if file else None,
                      'template_policy': template_policy, 'disable_only': disable_only,
                      'id': old.get('id') if old else None,
                      'old': old, 'desired': desired, 'status': 'existing' if action == 'create' and old else 'prepared'})
    return items


def save_state(path, state, event=None):
    state['updated_at'] = time.strftime('%Y-%m-%dT%H:%M:%S%z')
    if event:
        state.setdefault('events', []).append({'at': state['updated_at'], **event})
    write_json(path, state)


def resolve_item(client, item):
    rows = client.list()
    if item['action'] == 'create':
        return find_slug(rows, item['key'])
    return next((r for r in rows if r.get('id') == item['id']), None)


def apply_items(client, path, state):
    if state.get('mode') == 'rollback':
        raise SyncError('This journal has begun rollback; use a new manifest/journal for a fresh apply')
    for item in state['items']:
        current = resolve_item(client, item)
        if item['status'] in ('applied', 'existing'):
            if current is None or payload(current) != item['desired']:
                raise SyncError('Previously synchronized skill changed; stop for review: ' + item['key'])
            continue
        if current is not None and payload(current) == item['desired']:
            item['id'] = current['id']
            item['status'] = 'applied' if item.get('write_attempted') else 'unchanged'
            save_state(path, state, {'event': 'reconciled', 'key': item['key'], 'id': item['id']})
            continue
        if item.get('write_attempted'):
            raise SyncError('Previous write is unresolved; no resubmission: ' + item['key'])
        if item['action'] == 'update':
            if current is None or payload(current) != payload(item['old']):
                raise SyncError('Target changed since backup; no overwrite: ' + item['key'])
            method, route = 'PUT', '/api/admin/skills/' + item['id']
        else:
            if current is not None:
                raise SyncError('Create slug appeared after backup; inspect it before continuing')
            method, route = 'POST', '/api/admin/skills'
        item['write_attempted'] = True
        item['status'] = 'write_unknown'
        save_state(path, state, {'event': 'before_' + method.lower(), 'key': item['key']})
        try:
            client.request(method, route, item['desired'])
        except Exception:
            # POST/PUT are never repeated. Reconcile from stored source+slug or ID.
            current = resolve_item(client, item)
            if current is None or payload(current) != item['desired']:
                raise SyncError('Write outcome unresolved; journal retained, no resubmission: ' + item['key']) from None
        else:
            current = resolve_item(client, item)
            if current is None or payload(current) != item['desired']:
                raise SyncError('Write response could not be verified; journal retained: ' + item['key'])
        item['id'], item['status'] = current['id'], 'applied'
        save_state(path, state, {'event': 'applied', 'key': item['key'], 'id': item['id']})


def rollback_items(client, path, state):
    state['mode'] = 'rollback'
    save_state(path, state, {'event': 'rollback_started'})
    for item in reversed(state['items']):
        if not item.get('write_attempted') or item.get('status') == 'rolled_back':
            continue
        current = resolve_item(client, item)
        if current is None:
            if item['action'] == 'create':
                item['status'] = 'rollback_unresolved'
                save_state(path, state, {'event': 'create_not_visible', 'key': item['key']})
                raise SyncError('Previously submitted create is not visible; cannot confirm rollback')
            raise SyncError('Updated skill is missing; cannot restore it without creating a new ID')
        restore = payload(item['old']) if item['action'] == 'update' else {**item['desired'], 'enabled': False}
        if payload(current) == restore:
            item['status'] = 'rolled_back'
            save_state(path, state, {'event': 'rollback_reconciled', 'key': item['key']})
            continue
        if payload(current) != item['desired']:
            raise SyncError('Skill changed after sync; rollback refuses to overwrite newer work: ' + item['key'])
        item['id'] = current['id']
        item['status'] = 'rollback_unknown'
        save_state(path, state, {'event': 'before_rollback', 'key': item['key']})
        try:
            client.request('PUT', '/api/admin/skills/' + item['id'], restore)
        except Exception:
            current = resolve_item(client, item)
            if current is None or payload(current) != restore:
                raise SyncError('Rollback outcome unresolved; inspect journal before retry') from None
        else:
            current = resolve_item(client, item)
            if current is None or payload(current) != restore:
                raise SyncError('Rollback could not be verified')
        item['status'] = 'rolled_back'
        save_state(path, state, {'event': 'rolled_back', 'key': item['key'], 'id': item['id']})


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument('--api', default='http://127.0.0.1:9090')
    parser.add_argument('--journal', type=Path, help='Default: sync-state.json beside the manifest')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--apply', action='store_true')
    mode.add_argument('--rollback', action='store_true')
    args = parser.parse_args(argv)
    manifest = args.manifest.resolve()
    journal = args.journal.resolve() if args.journal else manifest.parent / 'sync-state.json'
    lock = journal.with_suffix('.lock')
    journal.parent.mkdir(parents=True, exist_ok=True)
    import msvcrt
    with lock.open('a+b') as held:
        held.seek(0); held.write(b'0'); held.flush(); held.seek(0)
        msvcrt.locking(held.fileno(), msvcrt.LK_NBLCK, 1)
        client = Client(args.api)
        state = json.loads(journal.read_text(encoding='utf-8')) if journal.exists() else None
        if args.rollback:
            if not state:
                raise SyncError('Rollback requires an existing synchronization journal')
            if state['api'] != client.base_url:
                raise SyncError('Journal API differs from requested API')
            rollback_items(client, journal, state)
        else:
            items = make_plan(manifest, client.list())
            plan_id = digest([{'action': i['action'], 'key': i['key'], 'desired': i['desired']} for i in items])
            if state:
                if state['api'] != client.base_url or state['plan_id'] != plan_id:
                    raise SyncError('Manifest/API changed since backup; use a new journal after review')
            else:
                state = {'api': client.base_url, 'manifest': str(manifest), 'plan_id': plan_id,
                         'mode': 'apply', 'items': items, 'events': []}
                backup = journal.with_name(journal.stem + '-before.json')
                if backup.exists():
                    raise SyncError('Backup exists without matching journal; inspect it before continuing')
                write_json(backup, {'api': client.base_url, 'targets': [i['old'] for i in items if i['old']]})
                save_state(journal, state, {'event': 'prepared', 'backup': str(backup)})
            if args.apply:
                apply_items(client, journal, state)
        print(json.dumps({'mode': 'rollback' if args.rollback else 'apply' if args.apply else 'dry-run',
                          'journal': str(journal), 'items': [{'key': i['key'], 'id': i['id'], 'status': i['status']}
                                                          for i in state['items']]}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # Deliberately omit response bodies/tracebacks, which may contain headers.
        print('STOPPED: ' + (str(exc) if isinstance(exc, SyncError) else type(exc).__name__), file=sys.stderr)
        sys.exit(1)
