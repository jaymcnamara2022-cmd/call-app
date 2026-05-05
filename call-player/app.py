from flask import Flask, request, jsonify, send_from_directory, Response, stream_with_context
import requests
import re
import json
import os
from urllib.parse import urlparse

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
    """Pull session cookie from env or the forwarded request header."""
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
    authed = check_auth()
    return jsonify({
        'ok': bool(api_key),
        'api_key_set': bool(api_key),
        'needs_secret': needs_secret,
        'authed': authed,
        'session_set': bool(os.environ.get('FATHOM_SESSION', '')),
    })

# ── API: calls list ───────────────────────────────────────────────────────────

@app.route('/api/calls')
def list_calls():
    if not check_auth():
        return jsonify({'error': 'Unauthorized'}), 401

    params = {'limit': request.args.get('limit', 20)}
    cursor = request.args.get('cursor')
    if cursor:
        params['cursor'] = cursor

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

    share_url = _find_share_url(recording_id)
    if not share_url:
        return jsonify({'error': 'Meeting not found'}), 404

    session = fathom_session(request)
    result = _extract_video_url(share_url, session)

    if result.get('url'):
        return jsonify({'url': result['url'], 'type': result.get('type'), 'share_url': share_url})

    return jsonify({'share_url': share_url, 'fallback': True})

def _find_share_url(recording_id):
    cursor = None
    for _ in range(5):
        params = {'limit': 100}
        if cursor:
            params['cursor'] = cursor
        resp = requests.get(f'{FATHOM_API}/meetings', headers=fathom_headers(),
                            params=params, timeout=20)
        if not resp.ok:
            break
        data = resp.json()
        for item in data.get('items', []):
            if item.get('recording_id') == recording_id:
                return item.get('share_url') or item.get('url', '')
        cursor = data.get('next_cursor')
        if not cursor:
            break
    return None

def _extract_video_url(share_url, session_cookie=''):
    try:
        headers = {
            'User-Agent': ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                           'AppleWebKit/537.36 (KHTML, like Gecko) '
                           'Chrome/122.0.0.0 Safari/537.36'),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
        }
        if session_cookie:
            headers['Cookie'] = session_cookie

        resp = requests.get(share_url, headers=headers, timeout=15, allow_redirects=True)
        html = resp.text

        # Strategy 1: Next.js SSR data blob
        m = re.search(r'<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)</script>', html)
        if m:
            try:
                result = _find_video_in_obj(json.loads(m.group(1)))
                if result:
                    return result
            except Exception:
                pass

        # Strategy 2: Mux / HLS / MP4 URL patterns in raw HTML
        patterns = [
            (r'https://stream\.mux\.com/[A-Za-z0-9_-]+\.m3u8(?:\?[^\s"\'<>]*)?', 'hls'),
            (r'https://[a-z0-9-]+\.cloudflarestream\.com/[a-f0-9]+/manifest/video\.m3u8(?:\?[^\s"\'<>]*)?', 'hls'),
            (r'https://[^\s"\'<>]+\.m3u8(?:\?[^\s"\'<>]*)?', 'hls'),
            (r'"(https://[^\s"\'<>]+\.mp4(?:\?[^\s"\'<>]*)?)"', 'mp4'),
        ]
        for pat, media_type in patterns:
            m = re.search(pat, html)
            if m:
                url = m.group(1) if m.lastindex else m.group(0)
                if url.startswith('https://'):
                    return {'url': url, 'type': media_type}

        # Strategy 3: og:video meta tag
        for pat in [
            r'<meta[^>]+property="og:video(?::url)?"[^>]+content="([^"]+)"',
            r'<meta[^>]+content="([^"]+)"[^>]+property="og:video(?::url)?"',
        ]:
            m = re.search(pat, html, re.IGNORECASE)
            if m:
                return {'url': m.group(1), 'type': 'unknown'}

    except Exception as e:
        print(f'Video extraction error: {e}')

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
        priority_keys = ['videoUrl', 'video_url', 'playbackUrl', 'playback_url',
                         'hlsUrl', 'hls_url', 'streamUrl', 'stream_url',
                         'mediaUrl', 'media_url', 'src', 'source', 'mp4Url', 'mp4_url']
        for key in priority_keys:
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

# ── Video proxy (handles CORS + auth for CDN streams) ─────────────────────────

ALLOWED_PROXY_DOMAINS = [
    'stream.mux.com', 'cloudflarestream.com', 'videodelivery.net',
    'fathom.video', 'fathom.ai', 'amazonaws.com', 'googleapis.com',
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
