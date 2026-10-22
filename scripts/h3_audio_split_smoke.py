"""Two serial CCY API smoke jobs, persisted on a dedicated comparison canvas.

Uses the existing local application session helper; secrets never enter artifacts.
Interrupted/ambiguous submissions are never repeated automatically.
"""
import json
from pathlib import Path
import time
import uuid

import run_ep01_user_seven as api

api.API = 'http://127.0.0.1:9093'
RUN = api.ROOT / 'run/h3-audio-split-20260907'
STATE = RUN / 'smoke-state.json'


def save(state):
    api.journal(STATE, state)


def canvas(state, updates=None, nodes=None, edges=None):
    path = '/api/app/projects/' + state['project_id'] + '/canvas'
    doc = api.app('GET', path)['data']
    if updates:
        for node in doc['nodes']:
            if node['id'] in updates:
                node['data'].update(updates[node['id']])
    api.app('PUT', path, dict(nodes=doc['nodes'] if nodes is None else nodes,
        edges=doc['edges'] if edges is None else edges, groups=doc.get('groups', []),
        expected_version=doc['version']))


def prepare():
    if STATE.exists():
        return json.loads(STATE.read_text(encoding='utf-8'))
    prompt = json.loads((RUN/'audio-first.json').read_text(encoding='utf-8'))['15']['inputs']['prompt']
    state = dict(status='creating_project', parts=[], prompt=prompt)
    save(state)
    project = api.app('POST', '/api/app/projects', {'name': 'H3音画分采｜5秒对白对照测试'})['data']
    state['project_id'] = project['id']
    save(state)
    nodes = [dict(id='audio-split-note', type='textNode', position=dict(x=0, y=-400), data=dict(
        customTitle='H3 音画分采验证', textMode='editor', boxWidth=980, boxHeight=300,
        content='<h2>5秒对白 · 相同提示词与 seed</h2><p>左：官方8步联合采样。右：音频20步，锁音轨后画面8步。480p、9:16。</p><p>唯一对白：别着急，我马上就来。保留微风与树叶声；无配乐、无字幕。新方案实际听感与口型待验收。</p>'))]
    edges = []
    for number, (label, quality) in enumerate([('旧版对照', '官方8步'), ('音画分采', '音画分采8步')], 1):
        node_id = 'audio-split-' + str(number)
        state['parts'].append(dict(number=number, label=label, quality=quality,
            node_id=node_id, status='ready', seed=20260907, prompt=prompt,
            reference_images=[], expected_dialogue=['别着急，我马上就来。']))
        nodes.append(dict(id=node_id, type='videoNode', position=dict(x=(number-1)*650, y=0), data=dict(
            customTitle=label+'｜待生成', status='idle', sourceKind='generated', model=api.MODEL,
            prompt=prompt, promptDraft=prompt, referenceMode='text-to-video', mediaWidth=480, mediaHeight=864,
            mediaDuration=5, generationParams=dict(model=api.MODEL, vendor='ComfyUI', quality=quality,
                durationSeconds=5, resolution='480p', aspectRatio='9:16', seed=20260907))))
        edges.append(dict(id='edge-'+node_id, type='flow', source='audio-split-note', target=node_id))
    canvas(state, nodes=nodes, edges=edges)
    state['status'] = 'ready'
    save(state)
    print('PROJECT http://192.168.1.125/app/project/'+state['project_id'], flush=True)
    return state


def main():
    state = prepare()
    if not state.get('project_id') or not state['parts']:
        raise RuntimeError('Incomplete project preparation; inspect state, do not recreate automatically')
    for part in state['parts']:
        if part['status'] == 'complete':
            continue
        if part['status'] in ('submission_unknown', 'failed'):
            raise RuntimeError('Inspect existing '+part['status']+' task before retry')
        if not part.get('task_id'):
            part.update(status='submission_unknown', request_id=str(uuid.uuid4()))
            state['status'] = 'running'
            save(state)
            request = dict(node_id=part['node_id'], project_id=state['project_id'], provider_config_id=api.PROVIDER,
                service_type='video', model=api.MODEL, prompt=part['prompt'], duration=5, aspect_ratio='9:16',
                resolution='480p', reference_mode='text-to-video', seed=part['seed'], quality=part['quality'],
                request_id=part['request_id'])
            api.journal(RUN/(part['node_id']+'-request.json'), request)
            result = api.app('POST', '/api/app/generate', request)
            part['task_id'] = result.get('data', {}).get('task_id')
            if not part['task_id']:
                raise RuntimeError('No task id returned; retain request journal')
            part.update(status='queued', submitted_at=time.strftime('%Y-%m-%d %H:%M:%S'))
            save(state)
            canvas(state, {part['node_id']: dict(taskId=part['task_id'], status='running', progress=1,
                assetStatus='processing', customTitle=part['label']+'｜生成中')})
            print(part['label']+' QUEUED '+part['task_id'], flush=True)
        deadline = time.monotonic()+3600
        while time.monotonic() < deadline:
            task = api.app('GET', '/api/app/tasks/'+part['task_id'])['data']
            api.journal(RUN/(part['node_id']+'-task.json'), task)
            if task['status'] in ('success', 'failed', 'error', 'cancelled'):
                break
            time.sleep(10)
        else:
            raise TimeoutError('Existing task retained; no resubmission')
        if task['status'] != 'success':
            part.update(status='failed', error=task.get('error_msg', task['status']))
            save(state)
            canvas(state, {part['node_id']: dict(status='error', assetStatus='failed', error=part['error'])})
            raise RuntimeError(part['error'])
        url = task['result_url']
        local = api.local_video(url)
        part.update(status='complete', local_path=str(local), result_url=url, completed_at=time.strftime('%Y-%m-%d %H:%M:%S'))
        save(state)
        canvas(state, {part['node_id']: dict(status='done', progress=100, assetStatus='ready',
            customTitle=part['label']+'｜待听审', url=url, originalUrl=url, output=url, audioReviewPending=True)})
        print(part['label']+' COMPLETE '+url, flush=True)
    state['status'] = 'complete'
    save(state)


if __name__ == '__main__':
    main()
