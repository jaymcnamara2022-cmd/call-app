from flask import Flask, request, jsonify, send_from_directory, Response, stream_with_context
import requests
import re
import json
import os
from urllib.parse import urlparse, quote

app = Flask(__name__, static_folder='static')

FATHOM_API = 'https://api.fathom.ai/external/v1'

# ── Helpers ───────────────────────────────────────────────────────────────────

def fathom_headers():
    return {'X-Api-Key': os.environ.get('FATHOM_API_KEY', '')}

def check_auth():
    secret = os.environ.get('APP_SECRET', '')
    if not secret:
        return True
    return (request.headers.get('X-App-Secret') or request.args.get('secret', '')) == secret

def fathom_session(req):
    return (req.headers.get('X-Fathom-Session') or
            os.environ.get('FATHOM_SESSION', ''))

# ── Static serving ────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return send_from_directory('static', 'index.html')

@app.route('/<path:path>')
def static_files(path):
    return send_from_directory('static', path)

# ── API: health ───────────────────────────────────────────────────────────────

@app.route('/api/health')
def health():
    api_key = os.environ.get('FATHOM_API_KEY', '')
    needs_secret = bool(os.environ.get('APP_SECRET', ''))
    return jsonify({
        'ok': bool(api_key),
        'api_key_set': bool(api_key),
        'needs_secret': needs_secret,
        'authed': check_auth(),
        'session_set': bool(os.environ.get('FATHOM_SESSION', '')),
    })

# ── API: calls list ───────────────────────────────────────────────────────────

@app.route('/api/calls')
def list_calls():
    if not check_auth():
        return jsonify({'error': 'Unauthorized'}), 401

    user_email = os.environ.get('FATHOM_USER_EMAIL', '')
    params = [('limit', request.args.get('limit', 20))]
    if request.args.get('cursor'):
        params.append(('cursor', request.args.get('cursor')))
    if user_email:
        params.append(('recorded_by[]', user_email))

    resp = requests.get(f'{FATHOM_API}/meetings', headers=fathom_headers(),
                        params=params, timeout=20)
    if not resp.ok:
        return jsonify({'error': f'Fathom API error {resp.status_code}'}), resp.status_code
    return jsonify(resp.json())

# ── API: transcript ───────────────────────────────────────────────────────────

@app.route('/api/calls/<recording_id>/transcript')
def get_transcript(recording_id):
    if not check_auth():
        return jsonify({'error': 'Unauthorized'}), 401

    resp = requests.get(f'{FATHOM_API}/recordings/{recording_id}/transcript',
                        headers=fathom_headers(), timeout=20)
    if not resp.ok:
        return jsonify({'error': f'Fathom API error {resp.status_code}'}), resp.status_code
    return jsonify(resp.json())

# ── API: video URL ────────────────────────────────────────────────────────────

@app.route('/api/calls/<recording_id>/video')
def get_video(recording_id):
    if not check_auth():
        return jsonify({'error': 'Unauthorized'}), 401

    meeting = _find_meeting(recording_id)
    if not meeting:
        return jsonify({'error': 'Meeting not found'}), 404

    url       = meeting.get('url', '')
    share_url = meeting.get('share_url', '')
    session   = fathom_session(request)

    # Extract numeric call ID from either URL field
    # Pattern: https://fathom.video/calls/662363819
    call_id = None
    for candidate in [url, share_url]:
        m = re.search(r'fathom\.video/calls/(\d+)', candidate or '')
        if m:
            call_id = m.group(1)
            break

    if call_id and session:
        result = _fetch_video_via_redirect(call_id, session)
        if result:
            return jsonify({'url': result, 'type': 'hls', 'share_url': share_url or url})

    # Fall back to page-scraping strategies
    result = _extract_video_from_page(share_url or url, session)
    if result.get('url'):
        return jsonify({'url': result['url'], 'type': result.get('type'), 'share_url': share_url or url})

    return jsonify({'share_url': share_url or url, 'fallback': True})


def _find_meeting(recording_id):
    """Page through meetings until we find the one matching recording_id."""
    cursor = None
    user_email = os.environ.get('FATHOM_USER_EMAIL', '')
    for _ in range(10):
        params = [('limit', 100)]
        if cursor:
            params.append(('cursor', cursor))
        if user_email:
            params.append(('recorded_by[]', user_email))
        resp = requests.get(f'{FATHOM_API}/meetings', headers=fathom_headers(),
                            params=params, timeout=20)
        if not resp.ok:
            break
        data = resp.json()
        for item in data.get('items', []):
            if item.get('recording_id') == recording_id:
                return item
        cursor = data.get('next_cursor')
        if not cursor:
            break
    return None


def _fetch_video_via_redirect(call_id, session_cookie):
    """
    Hit https://fathom.video/calls/{id}/video.m3u8 with the session cookie.
    Fathom returns a 302 redirect to the actual CDN stream URL.
    We return that CDN URL so the frontend can play it directly.
    """
    video_endpoint = f'https://fathom.video/calls/{call_id}/video.m3u8'
    headers = {
        'User-Agent': ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                       'AppleWebKit/537.36 (KHTML, like Gecko) '
                       'Chrome/122.0.0.0 Safari/537.36'),
        'Cookie': session_cookie,
        'Referer': f'https://fathom.video/calls/{call_id}',
        'Accept': '*/*',
        'Origin': 'https://fathom.video',
    }
    try:
        resp = requests.get(video_endpoint, headers=headers,
                            allow_redirects=False, timeout=10)
        if resp.status_code in (301, 302, 303, 307, 308):
            location = resp.headers.get('Location', '')
            if location and location.startswith('http'):
                print(f'Video CDN URL: {location[:80]}')
                return location
        elif resp.status_code == 200:
            # No redirect — proxy the Fathom endpoint directly
            return f'/api/proxy/video?url={quote(video_endpoint)}'
        else:
            print(f'Video endpoint returned {resp.status_code}')
    except Exception as e:
        print(f'Video redirect error: {e}')
    return None


def _extract_video_from_page(share_url, session_cookie=''):
    """Fallback: scrape the share page for video URLs."""
    if not share_url:
        return {}
    try:
        headers = {
            'User-Agent': ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                           'AppleWebKit/537.36 (KHTML, like Gecko) '
                           'Chrome/122.0.0.0 Safari/537.36'),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        }
        if session_cookie:
            headers['Cookie'] = session_cookie

        resp = requests.get(share_url, headers=headers, timeout=15, allow_redirects=True)
        html = resp.text

        # Next.js SSR data
        m = re.search(r'<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)</script>', html)
        if m:
            try:
                result = _find_video_in_obj(json.loads(m.group(1)))
                if result:
                    return result
            except Exception:
                pass

        # Direct URL patterns
        for pat, media_type in [
            (r'https://stream\.mux\.com/[A-Za-z0-9_-]+\.m3u8(?:\?[^\s"\'<>]*)?', 'hls'),
            (r'https://[^\s"\'<>]+\.m3u8(?:\?[^\s"\'<>]*)?', 'hls'),
            (r'"(https://[^\s"\'<>]+\.mp4(?:\?[^\s"\'<>]*)?)"', 'mp4'),
        ]:
            m = re.search(pat, html)
            if m:
                url = m.group(1) if m.lastindex else m.group(0)
                if url.startswith('https://'):
                    return {'url': url, 'type': media_type}
    except Exception as e:
        print(f'Page scrape error: {e}')
    return {}


def _find_video_in_obj(obj, depth=0):
    if depth > 12:
        return None
    if isinstance(obj, str):
        for pat, t in [
            (r'^https://stream\.mux\.com/[A-Za-z0-9_-]+\.m3u8', 'hls'),
            (r'^https://[^\s]+\.m3u8', 'hls'),
            (r'^https://[^\s]+\.(mp4|webm)$', 'mp4'),
        ]:
            if re.match(pat, obj):
                return {'url': obj, 'type': t}
        return None
    if isinstance(obj, dict):
        for key in ['videoUrl', 'video_url', 'playbackUrl', 'hlsUrl', 'streamUrl', 'src']:
            if key in obj and isinstance(obj[key], str):
                r = _find_video_in_obj(obj[key], depth + 1)
                if r:
                    return r
        for v in obj.values():
            if isinstance(v, (dict, list)):
                r = _find_video_in_obj(v, depth + 1)
                if r:
                    return r
    if isinstance(obj, list):
        for item in obj[:30]:
            r = _find_video_in_obj(item, depth + 1)
            if r:
                return r
    return None

# ── Video proxy ───────────────────────────────────────────────────────────────

ALLOWED_PROXY_DOMAINS = [
    'stream.mux.com', 'cloudflarestream.com', 'videodelivery.net',
    'fathom.video', 'fathom.ai', 'amazonaws.com', 'cloudfront.net',
    'googleapis.com', 'googleusercontent.com',
]

@app.route('/api/proxy/video')
def proxy_video():
    if not check_auth():
        return jsonify({'error': 'Unauthorized'}), 401

    url = request.args.get('url', '')
    if not url:
        return jsonify({'error': 'No URL'}), 400

    parsed = urlparse(url)
    if not any(d in parsed.netloc for d in ALLOWED_PROXY_DOMAINS):
        return jsonify({'error': 'Domain not allowed'}), 403

    proxy_headers = {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    }
    session = fathom_session(request)
    if session and 'fathom' in parsed.netloc:
        proxy_headers['Cookie'] = session

    range_h = request.headers.get('Range')
    if range_h:
        proxy_headers['Range'] = range_h

    upstream = requests.get(url, headers=proxy_headers, stream=True, timeout=30)

    out_headers = {'Access-Control-Allow-Origin': '*'}
    for h in ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']:
        if h in upstream.headers:
            out_headers[h] = upstream.headers[h]

    return Response(
        stream_with_context(upstream.iter_content(chunk_size=65536)),
        status=upstream.status_code,
        headers=out_headers,
    )

# ── Run ───────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    app.run(host='0.0.0.0', port=port)
