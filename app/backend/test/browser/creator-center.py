"""Creator portal browser regression using only local fixture accounts and API responses.

Requires Playwright with bundled Chromium. Run from any directory:
    python app/backend/test/browser/creator-center.py --output-dir test-artifacts
No account, media upload, remote service, or production database is used.
"""
import argparse, base64, json, pathlib, tempfile, threading, http.server, functools, time
from urllib.parse import urlparse, unquote, parse_qs
from playwright.sync_api import sync_playwright, expect
ROOT = pathlib.Path(__file__).resolve().parents[4]
parser = argparse.ArgumentParser(description='Run isolated creator-center and admin browser regressions.')
parser.add_argument('--output-dir', type=pathlib.Path, default=None)
args = parser.parse_args()
OUT = args.output_dir or pathlib.Path(tempfile.mkdtemp(prefix='linglish-creator-browser-'))
OUT.mkdir(parents=True, exist_ok=True)

class Handler(http.server.SimpleHTTPRequestHandler):

    def log_message(self, *args):
        pass
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(ROOT / 'app/frontend')))
threading.Thread(target=server.serve_forever, daemon=True).start()
BASE = f'http://127.0.0.1:{server.server_port}'

def token(id):
    enc = lambda v: base64.urlsafe_b64encode(json.dumps(v).encode()).decode().rstrip('=')
    return enc({'alg': 'HS256'}) + '.' + enc({'sub': str(id), 'exp': 4102444800}) + '.fixture'

def app(status, id=7):
    return {'id': 10, 'user_id': id, 'display_name': 'Maya 的口语手记', 'bio': '分享生活里的真实英语，让学习从一个小场景开始。', 'topic': '日常英语', 'sample_url': 'https://example.com/lesson', 'rights_confirmed': True, 'status': status, 'revision': 1, 'review_note': '请补充你的创作方向。' if status == 'rejected' else None}

def video(id, title, status='ready', public=False, subtitles=True):
    return {'id': id, 'uploader_id': 7, 'title': title, 'description': '原创场景练习。', 'category': '生活', 'difficulty_level': 'a2', 'status': status, 'is_public': public, 'video_path': f'/videos/{id}.mp4', 'mime_type': 'video/mp4', 'has_subtitles': subtitles, 'transcript_segments': [{'text': 'Let’s take a little break.', 'start': 0, 'end': 3}] if subtitles else []}
VIDEOS = [video(1, 'Coffee, conversations & a little English', public=True), video(2, 'A day in the city'), video(3, 'A useful conversation at the café'), video(4, 'On the road · 新视频', 'processing'), video(5, 'A quiet afternoon', subtitles=False), video(6, 'Try it again · 练习小记'), video(7, 'A video that needs attention', 'failed')]
REQUESTS = [{'id': 12, 'video_id': 2, 'request_type': 'public', 'status': 'pending'}, {'id': 11, 'video_id': 6, 'request_type': 'public', 'status': 'rejected', 'review_note': '请完善字幕后重试。'}]
results = []

class Fixture:

    def __init__(self, page, status=None, admin=False, logged=True):
        self.page = page
        self.app = app(status) if status else None
        self.account = 7
        self.admin = admin
        self.logged = logged
        self.videos = json.loads(json.dumps(VIDEOS))
        self.requests = json.loads(json.dumps(REQUESTS))
        self.calls = []
        self.app_fail = False
        self.upload_fail = False
        self.patch_fail = False
        self.get_fail = False
        self.review_conflict = False
        self.malformed_review = False
        self.hold_review = False
        self.review_held = []
        self.admin_items = [app('pending', 8)]
        self.hold = False
        self.held = []
        self.hold_post = False
        self.post_held = []
        self.refreshed_token = None
        self.ignore_request_pagination = False
        self.hold_request_offset = None
        self.request_held = []

    def route(self, r):
        u = urlparse(r.request.url)
        path = unquote(u.path)
        method = r.request.method
        if not r.request.url.startswith(BASE):
            r.abort()
            return
        if path.endswith(('.html', '.js', '.css', '.svg', '.png', '.ico', '.woff2')) or path == '/':
            r.continue_()
            return
        data = {}
        status = 200
        auth = r.request.headers.get('authorization')
        if path in ['/users/me', '/api/creator/application', '/video-resources', '/api/video-share-requests'] or path.startswith('/admin/creator-applications') or path.startswith('/video-resources/'):
            self.calls.append({'path': path, 'query': parse_qs(u.query), 'method': method, 'headers': r.request.headers, 'body': r.request.post_data if method != 'GET' else None})
            assert auth == f'Bearer {self.refreshed_token or token(self.account)}', {'path': path, 'auth': auth, 'account': self.account}
        if path == '/users/me':
            data = {'id': self.account, 'email': 'fixture@example.com', 'username': 'Local creator', 'is_admin': self.admin}
        elif path == '/api/creator/application':
            if method == 'GET':
                if self.hold:
                    self.held.append(r)
                    return
                if self.get_fail:
                    status = 503
                    data = {'message': 'Temporary fixture failure'}
                else:
                    data = {'application': self.app if self.account == 7 else None}
            elif self.hold_post:
                self.post_held.append(r)
                return
            elif self.app_fail:
                status = 503
                data = {'message': 'Temporary fixture failure'}
            else:
                body = json.loads(r.request.post_data)
                self.app = {**body, 'id': 10, 'user_id': self.account, 'status': 'pending', 'revision': 2}
                data = {'application': self.app}
                status = 201
        elif path == '/video-resources':
            data = {'items': [{k: v for k, v in item.items() if k != 'transcript_segments'} for item in self.videos] if self.account == 7 else []}
        elif path == '/api/video-share-requests':
            if method == 'GET':
                query = parse_qs(u.query)
                wanted = query.get('status', ['all'])[0]
                wanted_type = query.get('request_type', [None])[0]
                limit = min(100, max(1, int(query.get('limit', [50])[0])))
                offset = int(query.get('offset', [0])[0])
                items = [item for item in self.requests if (wanted == 'all' or item['status'] == wanted) and (not wanted_type or item['request_type'] == wanted_type)] if self.account == 7 else []
                if wanted == 'pending' and self.hold_request_offset == offset:
                    self.request_held.append((r, items[offset:offset + limit]))
                    return
                start = 0 if self.ignore_request_pagination else offset
                data = {'items': items[start:start + limit]}
            else:
                body = json.loads(r.request.post_data)
                item = {'id': 99, 'video_id': body['video_id'], 'request_type': 'public', 'status': 'pending'}
                self.requests.insert(0, item)
                data = {'request': item, 'success': True}
                status = 201
        elif path == '/video-resources/upload':
            assert 'multipart/form-data; boundary=' in r.request.headers.get('content-type', '')
            if self.upload_fail:
                status = 503
                data = {'message': 'Upload fixture failed'}
            else:
                item = video(8, 'New private fixture', 'processing')
                self.videos.insert(0, item)
                data = {'video': item}
                status = 202
        elif path.startswith('/video-resources/'):
            id = int(path.rsplit('/', 1)[-1])
            item = next((v for v in self.videos if v['id'] == id))
            if method == 'PATCH':
                if self.patch_fail:
                    status = 409
                    data = {'message': '公开或审核中的内容暂不能修改，请创建新草稿。'}
                else:
                    item.update(json.loads(r.request.post_data))
                    data = {'video': item}
            else:
                data = {'video': item}
        elif path == '/admin/creator-applications':
            if not self.admin:
                status = 403
                data = {'message': 'FORBIDDEN'}
            else:
                wanted = parse_qs(u.query).get('status', ['pending'])[0]
                items = [a for a in self.admin_items if wanted == 'all' or a['status'] == wanted]
                data = {'items': items, 'summary': {'pending': sum((a['status'] == 'pending' for a in self.admin_items)), 'approved': sum((a['status'] == 'approved' for a in self.admin_items)), 'rejected': 0}, 'limit': 50, 'offset': 0}
        elif path.startswith('/admin/creator-applications/'):
            body = json.loads(r.request.post_data)
            if self.hold_review:
                self.review_held.append(r)
                return
            if self.malformed_review:
                data = {}
            elif self.review_conflict:
                self.review_conflict = False
                self.malformed_review = False
                self.hold_review = False
                self.review_held = []
                self.admin_items[0]['revision'] = 2
                status = 409
                data = {'message': 'CREATOR_APPLICATION_CONFLICT'}
            else:
                self.admin_items[0]['status'] = body['decision']
                self.admin_items[0]['review_note'] = body['review_note']
                data = {'application': self.admin_items[0]}
        r.fulfill(status=status, content_type='application/json', body=json.dumps(data, ensure_ascii=False))

    def count(self, path, method='POST'):
        return len([c for c in self.calls if c['path'] == path and c['method'] == method])

def setup(browser, width, status=None, admin=False, logged=True):
    context = browser.new_context(viewport={'width': width, 'height': 1000}, service_workers='block')
    if logged:
        context.add_init_script('localStorage.setItem("linglish_token",' + json.dumps(token(7)) + ');')
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('dialog', lambda d: d.dismiss())
    fixture = Fixture(page, status, admin, logged)
    page.route('**/*', fixture.route)
    return (context, page, fixture, errors)

def layout(page, width):
    return page.evaluate("() => ({width:innerWidth,scroll:document.documentElement.scrollWidth,dialogs:[...document.querySelectorAll('dialog[open]')].map(e=>{const r=e.getBoundingClientRect();return{x:r.x,right:r.right}})})")
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context, page, f, errors = setup(browser, 820, 'approved')
    f.requests.append({'id': 13, 'video_id': 3, 'request_type': 'featured', 'status': 'pending'})
    page.goto(BASE + '/creator-center.html', wait_until='networkidle')
    card = page.locator('.resource-card[data-video-id="3"]')
    expect(card).to_contain_text('精选审核中')
    assert card.locator('button').count() == 0
    expect(card.get_by_role('link', name='预览学习')).to_be_visible()
    assert not errors, errors
    results.append({'featuredPendingLocksEditAndPublication': True})
    context.close()
    # The actual API caps every page at 100 even if a larger limit is asked for.
    # A pending featured review beyond that first page must still lock its video.
    context, page, f, errors = setup(browser, 1280, 'approved')
    f.requests = [{'id': 1000 - index, 'video_id': 1000 + index, 'request_type': 'public' if index % 2 else 'featured', 'status': 'pending'} for index in range(100)]
    f.requests.append({'id': 500, 'video_id': 3, 'request_type': 'featured', 'status': 'pending'})
    page.goto(BASE + '/creator-center.html', wait_until='networkidle')
    card = page.locator('.resource-card[data-video-id="3"]')
    expect(card).to_contain_text('精选审核中')
    assert card.locator('button').count() == 0
    pending_calls = [call for call in f.calls if call['path'] == '/api/video-share-requests' and call['query'].get('status') == ['pending']]
    assert [call['query']['offset'][0] for call in pending_calls] == ['0', '100']
    assert all(call['query']['limit'] == ['100'] for call in pending_calls)
    assert not errors, errors
    results.append({'pendingBeyondFirstHundredLocksMatchingResource': True})
    context.close()
    context, page, f, errors = setup(browser, 820, 'approved')
    f.requests = [{'id': 1000 - index, 'video_id': 1000 + index, 'request_type': 'featured', 'status': 'pending'} for index in range(100)]
    f.ignore_request_pagination = True
    page.goto(BASE + '/creator-center.html', wait_until='networkidle')
    expect(page.locator('#creator-message')).to_contain_text('审核状态未完整返回')
    expect(page.locator('#resources-section')).to_be_hidden()
    expect(page.locator('.resource-card')).to_have_count(0)
    pending_calls = [call for call in f.calls if call['path'] == '/api/video-share-requests' and call['query'].get('status') == ['pending']]
    assert len(pending_calls) == 2
    assert not errors, errors
    results.append({'ignoredPaginationStopsWithoutUnlockedCards': True})
    context.close()
    context, page, f, errors = setup(browser, 820, 'approved')
    f.requests = [{'id': 1000 - index, 'video_id': 1000 + index, 'request_type': 'featured', 'status': 'pending'} for index in range(100)]
    f.requests.append({'id': 500, 'video_id': 3, 'request_type': 'featured', 'status': 'pending'})
    f.hold_request_offset = 100
    with page.expect_request(lambda req: urlparse(req.url).path == '/api/video-share-requests' and parse_qs(urlparse(req.url).query).get('offset') == ['100']):
        page.goto(BASE + '/creator-center.html', wait_until='domcontentloaded')
    # Request events precede route delivery. Pump Playwright until the fixture
    # has actually held the response, rather than racing the route callback.
    deadline = time.monotonic() + 5
    while not f.request_held and time.monotonic() < deadline:
        page.wait_for_timeout(10)
    assert f.request_held, 'the old account must be waiting on the second request page'
    f.account = 8
    f.hold_request_offset = None
    page.evaluate('(t)=>{localStorage.setItem("linglish_token",t);window.dispatchEvent(new StorageEvent("storage",{key:"linglish_token"}));}', token(8))
    expect(page.locator('#application-section')).to_be_visible()
    expect(page.locator('.resource-card')).to_have_count(0)
    for held, items in f.request_held:
        held.fulfill(status=200, content_type='application/json', body=json.dumps({'items': items}))
    page.wait_for_load_state('networkidle')
    expect(page.locator('#creator-bio')).to_have_value('')
    expect(page.locator('.resource-card')).to_have_count(0)
    old_pages = [call for call in f.calls if call['path'] == '/api/video-share-requests' and call['headers']['authorization'] == f'Bearer {token(7)}' and call['query'].get('status') == ['pending']]
    assert [call['query']['offset'][0] for call in old_pages] == ['0', '100']
    assert not errors, errors
    results.append({'accountSwitchDuringLaterRequestPageDropsPrivateResponse': True})
    context.close()
    # A same-account token refresh may restart a load after /users/me has
    # completed, while the forms are still cleared and hidden. Those loading
    # placeholders must never replace the owner's saved draft or selected File.
    context, page, f, errors = setup(browser, 820)
    page.goto(BASE + '/creator-center.html', wait_until='networkidle')
    expect(page.locator('#creator-bio')).to_be_visible()
    page.locator('#creator-display-name').fill('Unsent creator name')
    page.locator('#creator-topic').fill('Everyday conversations')
    page.locator('#creator-bio').fill('Keep this application through overlapping refreshes.')
    page.locator('#creator-sample-url').fill('https://example.com/my-lesson')
    page.locator('#creator-rights').check()
    page.locator('#creator-video-file').set_input_files({'name': 'overlap.mp4', 'mimeType': 'video/mp4', 'buffer': b'overlap fixture video'})
    page.locator('#upload-title-input').fill('An unsent video title')
    page.locator('#upload-description').fill('Keep this unsent video description.')
    page.locator('#upload-category').fill('Daily life')
    f.hold = True
    with page.expect_request(lambda req: urlparse(req.url).path == '/api/creator/application'):
        page.locator('#resources-refresh').click()
    expect(page.locator('#application-section')).to_be_hidden()
    assert f.held, 'the first reload must be waiting after its account lookup'
    f.hold = False
    f.refreshed_token = token(7).replace('.fixture', '.refreshed')
    page.evaluate('(t)=>{const old=localStorage.getItem("linglish_token");localStorage.setItem("linglish_token",t);window.dispatchEvent(new StorageEvent("storage",{key:"linglish_token",oldValue:old,newValue:t,storageArea:localStorage}));}', f.refreshed_token)
    expect(page.locator('#creator-bio')).to_have_value('Keep this application through overlapping refreshes.')
    expect(page.locator('#creator-display-name')).to_have_value('Unsent creator name')
    expect(page.locator('#creator-topic')).to_have_value('Everyday conversations')
    expect(page.locator('#creator-sample-url')).to_have_value('https://example.com/my-lesson')
    expect(page.locator('#creator-rights')).to_be_checked()
    expect(page.locator('#upload-title-input')).to_have_value('An unsent video title')
    expect(page.locator('#upload-description')).to_have_value('Keep this unsent video description.')
    expect(page.locator('#upload-category')).to_have_value('Daily life')
    expect(page.locator('#selected-video-file')).to_contain_text('overlap.mp4')
    for held in f.held:
        held.fulfill(status=200, content_type='application/json', body=json.dumps({'application': None}))
    page.wait_for_load_state('networkidle')
    expect(page.locator('#creator-bio')).to_have_value('Keep this application through overlapping refreshes.')
    page.locator('#upload-submit').click()
    expect(page.locator('.resource-card[data-video-id="8"]')).to_be_visible()
    upload = [call for call in f.calls if call['path'] == '/video-resources/upload' and call['method'] == 'POST'][-1]
    assert 'filename="overlap.mp4"' in upload['body'] and 'overlap fixture video' in upload['body']
    assert not errors, errors
    results.append({'overlappingSameAccountRefreshPreservesDraftAndFile': True})
    context.close()
    for width in [390, 820, 1280]:
        for status in [None, 'pending', 'rejected', 'approved']:
            context, page, f, errors = setup(browser, width, status)
            page.goto(BASE + '/creator-center.html', wait_until='networkidle')
            expect(page.locator('#application-section')).to_be_visible()
            expect(page.locator('.resource-card')).to_have_count(7)
            assert layout(page, width)['scroll'] <= width, layout(page, width)
            assert page.locator('.resource-card[data-video-id="1"] button').count() == 0
            assert page.locator('.resource-card[data-video-id="2"] button').count() == 0
            assert page.locator('.resource-card[data-video-id="5"]').get_by_role('button', name='提交公开审核').count() == 0
            assert page.get_by_role('button', name='提交公开审核', exact=True).count() == (1 if status == 'approved' else 0)
            assert page.locator('.resource-card[data-video-id="3"] a').get_attribute('href') == f"./video-reader{('-desktop' if width >= 1024 else '')}.html?videoId=3"
            if status in ['pending', 'approved']:
                expect(page.locator('#application-submit')).to_be_hidden()
                expect(page.locator('#creator-bio')).to_be_disabled()
            if status == 'rejected':
                expect(page.locator('#application-submit')).to_have_text('修改并重新提交')
                expect(page.locator('#application-note')).to_contain_text('请补充')
            assert not errors, errors
            page.screenshot(path=str(OUT / f"creator-{width}-{status or 'new'}.png"), full_page=True)
            results.append({'width': width, 'state': status or 'new', 'layout': layout(page, width), 'errors': errors})
            context.close()
    context, page, f, errors = setup(browser, 390, logged=False)
    page.goto(BASE + '/creator-center.html', wait_until='networkidle')
    expect(page.locator('#creator-login')).to_be_visible()
    assert page.locator('#creator-login').get_attribute('href') == './mobile-auth.html?next=creator-center.html'
    assert not f.calls
    results.append({'anonymousLoginCTA': True})
    context.close()
    context, page, f, errors = setup(browser, 390)
    page.goto(BASE + '/creator-center.html', wait_until='networkidle')
    expect(page.locator('#creator-bio')).to_be_visible()
    page.locator('#creator-display-name').fill('Maya')
    page.locator('#creator-topic').fill('Daily English')
    page.locator('#creator-bio').fill('Useful short lessons.')
    page.locator('#creator-rights').focus()
    page.keyboard.press('Space')
    page.locator('#creator-sample-url').fill('http://127.1/')
    page.locator('#application-submit').click()
    expect(page.locator('#creator-message')).to_contain_text('公开')
    assert f.count('/api/creator/application') == 0
    page.locator('#creator-sample-url').fill('https://example.com/lesson')
    f.app_fail = True
    page.locator('#application-submit').click()
    expect(page.locator('#creator-message')).to_contain_text('Temporary')
    expect(page.locator('#creator-bio')).to_have_value('Useful short lessons.')
    expect(page.locator('#creator-rights')).to_be_checked()
    f.app_fail = False
    page.locator('#creator-display-name').focus()
    page.keyboard.press('Enter')
    expect(page.locator('#application-status')).to_have_text('资格审核中')
    expect(page.locator('#application-submit')).to_be_hidden()
    assert f.count('/api/creator/application') == 2
    assert not errors, errors
    results.append({'applicationKeyboardValidationRetention': True})
    context.close()
    context, page, f, errors = setup(browser, 1280, 'approved')
    page.goto(BASE + '/creator-center.html', wait_until='networkidle')
    expect(page.locator('#upload-section')).to_be_visible()
    page.locator('#creator-video-file').set_input_files({'name': 'audio.mp3', 'mimeType': 'audio/mpeg', 'buffer': b'fixture'})
    page.locator('#upload-submit').click()
    expect(page.locator('#creator-message')).to_contain_text('音频')
    assert f.count('/video-resources/upload') == 0
    page.locator('#creator-video-file').set_input_files({'name': 'lesson.mp4', 'mimeType': 'video/mp4', 'buffer': b'local fixture video'})
    f.upload_fail = True
    page.locator('#upload-submit').click()
    expect(page.locator('#creator-message')).to_contain_text('Upload fixture failed')
    assert page.locator('#creator-video-file').evaluate('(e)=>e.files.length') == 1
    expect(page.locator('#upload-title-input')).to_have_value('audio')
    f.upload_fail = False
    page.locator('#upload-title-input').fill('New private fixture')
    page.locator('#upload-submit').click()
    expect(page.locator('.resource-card')).to_have_count(8)
    expect(page.locator('.resource-card[data-video-id="8"]')).to_contain_text('处理中')
    assert page.locator('#creator-video-file').evaluate('(e)=>e.files.length') == 0
    card = page.locator('.resource-card[data-video-id="3"]')
    card.get_by_role('button', name='编辑草稿').click()
    expect(page.locator('#resource-editor')).to_be_visible()
    page.locator('#edit-title').fill('A revised draft')
    f.patch_fail = True
    page.get_by_role('button', name='保存草稿', exact=True).click()
    expect(page.locator('#editor-error')).to_contain_text('不能修改')
    expect(page.locator('#edit-title')).to_have_value('A revised draft')
    f.patch_fail = False
    page.get_by_role('button', name='保存草稿', exact=True).click()
    expect(page.locator('#resource-editor')).not_to_be_visible()
    expect(card).to_contain_text('A revised draft')
    card.get_by_role('button', name='提交公开审核').click()
    page.locator('#publish-note').fill('Please check this lesson.')
    page.get_by_role('button', name='确认提交审核').click()
    expect(page.locator('#publish-dialog')).not_to_be_visible()
    expect(card).to_contain_text('公开审核中')
    assert card.get_by_role('button', name='编辑草稿').count() == 0
    body = json.loads([c for c in f.calls if c['path'] == '/api/video-share-requests' and c['method'] == 'POST'][-1]['body'])
    assert body == {'video_id': 3, 'request_type': 'public', 'note': 'Please check this lesson.'}
    assert not errors, errors
    results.append({'uploadEditPublish': True})
    context.close()
    context, page, f, errors = setup(browser, 820)
    page.goto(BASE + '/creator-center.html', wait_until='networkidle')
    expect(page.locator('#creator-bio')).to_be_visible()
    page.locator('#creator-bio').fill('Unsent private draft')
    page.locator('#creator-video-file').set_input_files({'name': 'private.mp4', 'mimeType': 'video/mp4', 'buffer': b'fixture'})
    f.account = 8
    page.evaluate('(t)=>{localStorage.setItem("linglish_token",t);window.dispatchEvent(new StorageEvent("storage",{key:"linglish_token"}));}', token(8))
    expect(page.locator('#creator-bio')).to_have_value('')
    expect(page.locator('.resource-card')).to_have_count(0)
    expect(page.locator('#selected-video-file')).not_to_contain_text('private.mp4')
    f.account = 7
    page.evaluate('(t)=>{localStorage.setItem("linglish_token",t);window.dispatchEvent(new StorageEvent("storage",{key:"linglish_token"}));}', token(7))
    expect(page.locator('#creator-bio')).to_have_value('Unsent private draft')
    expect(page.locator('#selected-video-file')).to_contain_text('private.mp4')
    assert not errors, errors
    results.append({'accountIsolationDraftRetention': True})
    context.close()
    context, page, f, errors = setup(browser, 820)
    page.goto(BASE + '/creator-center.html', wait_until='networkidle')
    expect(page.locator('#creator-bio')).to_be_visible()
    page.locator('#creator-display-name').fill('Private draft')
    page.locator('#creator-topic').fill('English')
    page.locator('#creator-bio').fill('Unsent creator application.')
    page.locator('#creator-rights').check()
    f.hold_post = True
    page.locator('#application-submit').click()
    expect(page.locator('#application-submit')).to_be_disabled()
    f.account = 8
    page.evaluate('(t)=>{localStorage.setItem("linglish_token",t);window.dispatchEvent(new StorageEvent("storage",{key:"linglish_token"}));}', token(8))
    expect(page.locator('#creator-bio')).to_have_value('')
    expect(page.locator('#creator-bio')).to_be_enabled()
    for held in f.post_held:
        held.fulfill(status=201, content_type='application/json', body=json.dumps({'application': app('pending', 7)}))
    expect(page.locator('#creator-display-name')).to_have_value('')
    assert not errors, errors
    results.append({'accountSwitchDuringMutation': True})
    context.close()
    context, page, f, errors = setup(browser, 390, 'rejected')
    page.goto(BASE + '/creator-center.html', wait_until='networkidle')
    expect(page.locator('#creator-bio')).to_be_enabled()
    page.locator('#creator-bio').fill('A revised creative direction.')
    page.locator('#application-submit').click()
    expect(page.locator('#application-status')).to_have_text('资格审核中')
    assert json.loads([c for c in f.calls if c['method'] == 'POST' and c['path'] == '/api/creator/application'][-1]['body'])['bio'] == 'A revised creative direction.'
    assert not errors, errors
    results.append({'rejectedApplicationResubmission': True})
    context.close()
    context, page, f, errors = setup(browser, 820)
    page.goto(BASE + '/creator-center.html', wait_until='networkidle')
    expect(page.locator('#creator-bio')).to_be_visible()
    page.locator('#creator-bio').fill('Keep this draft through a failed refresh.')
    page.locator('#creator-video-file').set_input_files({'name': 'keep.mp4', 'mimeType': 'video/mp4', 'buffer': b'fixture'})
    f.get_fail = True
    page.locator('#resources-refresh').click()
    expect(page.locator('#creator-message')).to_contain_text('Temporary')
    expect(page.locator('#application-section')).to_be_hidden()
    expect(page.locator('.resource-card')).to_have_count(0)
    f.get_fail = False
    page.locator('#creator-retry').click()
    expect(page.locator('#creator-bio')).to_have_value('Keep this draft through a failed refresh.')
    expect(page.locator('#selected-video-file')).to_contain_text('keep.mp4')
    assert not errors, errors
    results.append({'failedRefreshClearsServerDataRetainsUnsentDraft': True})
    context.close()
    for width in [390, 820, 1280]:
        context, page, f, errors = setup(browser, width, admin=True)
        f.admin_items[0]['display_name'] = '<img src=x onerror=alert(1)>'
        f.admin_items[0]['sample_url'] = 'javascript:alert(1)'
        page.goto(BASE + '/admin-creators.html', wait_until='networkidle')
        expect(page.locator('.creator-review-card')).to_have_count(1)
        assert page.locator('.creator-review-card img').count() == 0
        assert page.locator('.creator-review-sample').count() == 0
        assert layout(page, width)['scroll'] <= width, layout(page, width)
        note = page.locator('.creator-review-form textarea')
        note.fill('Please clarify the topic.')
        f.review_conflict = True
        page.get_by_role('button', name='通过申请', exact=True).click()
        expect(page.locator('#creator-admin-message')).to_contain_text('已被更新')
        expect(page.locator('.creator-review-form textarea')).to_have_value('Please clarify the topic.')
        expect(page.locator('.creator-review-meta')).to_contain_text('版本 2')
        page.screenshot(path=str(OUT / f'admin-creators-{width}.png'), full_page=True)
        page.get_by_role('button', name='通过申请', exact=True).click()
        expect(page.locator('.creator-review-card')).to_have_count(0)
        reviews = [json.loads(c['body']) for c in f.calls if c['path'].endswith('/review')]
        assert reviews[0]['expected_revision'] == 1 and reviews[1]['expected_revision'] == 2
        assert not errors, errors
        results.append({'adminWidth': width, 'staleRevision': True, 'safeDOM': True, 'errors': errors})
        context.close()
    context, page, f, errors = setup(browser, 1280, admin=True)
    f.admin_items = [app('pending', 7)]
    page.goto(BASE + '/admin-creators.html', wait_until='networkidle')
    expect(page.get_by_role('button', name='通过申请', exact=True)).to_be_disabled()
    expect(page.get_by_role('button', name='不通过', exact=True)).to_be_disabled()
    results.append({'selfReviewBlocked': True})
    context.close()
    context, page, f, errors = setup(browser, 1280, admin=True)
    f.malformed_review = True
    page.goto(BASE + '/admin-creators.html', wait_until='networkidle')
    page.locator('.creator-review-form textarea').fill('Keep this review note.')
    page.get_by_role('button', name='通过申请', exact=True).click()
    expect(page.locator('#creator-admin-message')).to_contain_text('未完整返回')
    expect(page.locator('.creator-review-form textarea')).to_have_value('Keep this review note.')
    f.malformed_review = False
    page.get_by_role('button', name='不通过', exact=True).click()
    expect(page.locator('.creator-review-card')).to_have_count(0)
    expect(page.locator('#creator-admin-message')).to_contain_text('未通过结果')
    assert not errors, errors
    results.append({'malformedReviewRetainsNoteAndRejectWorks': True})
    context.close()
    context, page, f, errors = setup(browser, 1280, admin=True)
    f.hold_review = True
    page.goto(BASE + '/admin-creators.html', wait_until='networkidle')
    page.get_by_role('button', name='通过申请', exact=True).click()
    expect(page.get_by_role('button', name='通过申请', exact=True)).to_be_disabled()
    f.account = 8
    f.admin = False
    page.evaluate('(t)=>localStorage.setItem("linglish_token",t)', token(8))
    for held in f.review_held:
        held.fulfill(status=200, content_type='application/json', body=json.dumps({'application': app('approved', 8)}))
    expect(page.locator('.creator-review-card')).to_have_count(0)
    expect(page.locator('#creator-admin-message')).to_contain_text('管理员')
    assert not errors, errors
    results.append({'adminAccountChangeDropsPrivateQueue': True})
    context.close()
    browser.close()
server.shutdown()
(OUT / 'creator-browser-result.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
print(json.dumps({'cases': len(results), 'results': results}, ensure_ascii=False))
