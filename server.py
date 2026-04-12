#!/usr/bin/env python3
"""
WebRTC Signaling Server for P2P File Share
Multi-host support with named device discovery
Serves both HTTP (port 8080) and HTTPS (port 8443) for Safari/iOS compatibility.
"""

import http.server
import socketserver
import json
import socket
import time
import threading
import uuid
import urllib.parse
import ssl
import os
import subprocess
import tempfile

HOST_EXPIRY_SECONDS = 45  # Remove hosts not seen in 45s (3 missed heartbeats)

server_port = 8080          # set in main()
https_server_port = None    # set after HTTPS server starts successfully

# Cloud mode: set PUBLIC_URL env var to the Netlify frontend URL.
# When set, the server skips local IP/HTTPS logic and returns PUBLIC_URL in all responses.
PUBLIC_URL = os.environ.get('PUBLIC_URL', '').rstrip('/')


class FileShareHandler(http.server.SimpleHTTPRequestHandler):
    shared_files    = {}  # {fileId: {name, size, type, host_id}}
    registered_hosts = {}  # {hostId: {name, ip, server_url, last_seen}}
    peer_inboxes    = {}  # {peerId: [messages]}
    _lock = threading.Lock()

    def do_GET(self):
        if self.path == '/':
            self.path = '/index.html'
        elif self.path.startswith('/api/files'):
            self.handle_file_list()
            return
        elif self.path.startswith('/api/signal'):
            self.handle_signal_get()
            return
        elif self.path == '/api/network-info':
            self.handle_network_info()
            return
        elif self.path == '/api/hosts':
            self.handle_hosts_list()
            return
        super().do_GET()

    def do_POST(self):
        if self.path == '/api/register-file':
            self.handle_file_registration()
        elif self.path == '/api/signal':
            self.handle_signal_post()
        elif self.path == '/api/register-host':
            self.handle_register_host()
        elif self.path == '/api/heartbeat':
            self.handle_heartbeat()
        else:
            self.send_error(404)

    def do_DELETE(self):
        if self.path.startswith('/api/remove-file/'):
            self.handle_file_removal()
        elif self.path.startswith('/api/deregister-host/'):
            self.handle_deregister_host()
        else:
            self.send_error(404)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Max-Age', '86400')
        self.end_headers()

    # ── Host Registry ──────────────────────────────────────────────────────────

    def handle_register_host(self):
        """Register a named host; returns its unique hostId."""
        try:
            data = self._read_json()
            name = (data.get('name') or 'Unknown Device').strip()[:50]
            host_id = 'host_' + uuid.uuid4().hex[:12]

            # Cloud mode: use the public Netlify URL so all clients reach the same server
            if PUBLIC_URL:
                srv_url = PUBLIC_URL
            else:
                local_ip = self.get_local_ip()
                # Prefer HTTPS URL so that Safari/iOS clients can connect
                if https_server_port:
                    srv_url = f'https://{local_ip}:{https_server_port}'
                else:
                    srv_url = f'http://{local_ip}:{server_port}'

            with self._lock:
                self.registered_hosts[host_id] = {
                    'name': name,
                    'ip': local_ip,
                    'server_url': srv_url,
                    'last_seen': time.time(),
                }

            print(f"[Host] Registered '{name}' as {host_id}")
            self.send_json_response({'hostId': host_id, 'server_url': srv_url})
        except Exception as e:
            self.send_error(500, str(e))

    def handle_heartbeat(self):
        """Keep a host alive."""
        try:
            data = self._read_json()
            host_id = data.get('hostId')
            with self._lock:
                if host_id in self.registered_hosts:
                    self.registered_hosts[host_id]['last_seen'] = time.time()
                    self.send_json_response({'status': 'ok'})
                else:
                    self.send_error(404, 'Host not found')
        except Exception as e:
            self.send_error(500, str(e))

    def handle_deregister_host(self):
        """Remove a host and its files."""
        try:
            host_id = self.path.split('/')[-1]
            with self._lock:
                host = self.registered_hosts.pop(host_id, None)
                if host:
                    removed = [fid for fid, f in self.shared_files.items()
                               if f.get('host_id') == host_id]
                    for fid in removed:
                        del self.shared_files[fid]
                    print(f"[Host] Deregistered '{host['name']}' ({host_id}), "
                          f"removed {len(removed)} file(s)")
            self.send_json_response({'status': 'ok'})
        except Exception as e:
            self.send_error(500, str(e))

    def handle_hosts_list(self):
        """Return all active (non-expired) hosts with their file counts."""
        try:
            now = time.time()
            with self._lock:
                # Expire stale hosts
                expired = [hid for hid, h in self.registered_hosts.items()
                           if now - h['last_seen'] > HOST_EXPIRY_SECONDS]
                for hid in expired:
                    del self.registered_hosts[hid]
                    print(f"[Host] Expired stale host {hid}")

                hosts = []
                for hid, h in self.registered_hosts.items():
                    count = sum(1 for f in self.shared_files.values()
                                if f.get('host_id') == hid)
                    hosts.append({
                        'hostId': hid,
                        'name': h['name'],
                        'ip': h['ip'],
                        'server_url': h['server_url'],
                        'files_count': count,
                    })

            self.send_json_response({'hosts': hosts})
        except Exception as e:
            self.send_error(500, str(e))

    # ── Signaling (per-peer inbox) ─────────────────────────────────────────────

    def handle_signal_post(self):
        """Route a signaling message into the recipient's inbox."""
        try:
            signal_data = self._read_json()
            to_peer   = signal_data.get('to')
            from_peer = signal_data.get('from', 'unknown')
            msg_type  = signal_data.get('type')

            if not to_peer:
                self.send_error(400, "Missing 'to' field")
                return

            with self._lock:
                self.peer_inboxes.setdefault(to_peer, []).append(signal_data)

            print(f"[Signal] {msg_type} {from_peer[:14]} → {to_peer[:14]}")
            self.send_json_response({'status': 'success'})
        except Exception as e:
            print(f"[Signal] ERROR: {e}")
            self.send_error(500, str(e))

    def handle_signal_get(self):
        """Return and clear a peer's inbox."""
        try:
            params  = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            peer_id = params.get('peerId', [''])[0]

            if not peer_id:
                self.send_error(400, "Missing peerId parameter")
                return

            with self._lock:
                messages = self.peer_inboxes.pop(peer_id, [])

            if messages:
                print(f"[Signal] {peer_id[:14]} retrieved {len(messages)} msg(s)")

            self.send_json_response({'messages': messages})
        except Exception as e:
            print(f"[Signal] ERROR: {e}")
            self.send_error(500, str(e))

    # ── File Registry ──────────────────────────────────────────────────────────

    def handle_file_list(self):
        """Return files, optionally filtered by hostId."""
        try:
            params  = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            host_id = params.get('hostId', [''])[0]

            with self._lock:
                files = [
                    {'id': fid, 'name': f['name'], 'size': f['size'], 'type': f['type']}
                    for fid, f in self.shared_files.items()
                    if not host_id or f.get('host_id') == host_id
                ]

            self.send_json_response({'files': files})
        except Exception as e:
            self.send_error(500, f"Error listing files: {e}")

    def handle_file_registration(self):
        """Register file metadata (no actual file stored)."""
        try:
            info = self._read_json()
            with self._lock:
                self.shared_files[info['id']] = {
                    'name':    info['name'],
                    'size':    info['size'],
                    'type':    info['type'],
                    'host_id': info.get('hostId', ''),
                }
            print(f"[File] Registered: {info['name']} ({self.fmt_size(info['size'])})")
            self.send_json_response({'status': 'success'})
        except Exception as e:
            self.send_error(500, str(e))

    def handle_file_removal(self):
        """Remove file metadata."""
        try:
            file_id = self.path.split('/')[-1]
            with self._lock:
                info = self.shared_files.pop(file_id, None)
            if info:
                print(f"[File] Removed: {info['name']}")
                self.send_json_response({'status': 'success'})
            else:
                self.send_error(404, 'File not found')
        except Exception as e:
            self.send_error(500, str(e))

    # ── Network Info ───────────────────────────────────────────────────────────

    def handle_network_info(self):
        try:
            if PUBLIC_URL:
                # Cloud mode: all devices use the public URL
                self.send_json_response({
                    'local_ip':   '',
                    'server_url': PUBLIC_URL,
                    'https_url':  PUBLIC_URL,
                    'status':     'running',
                })
            else:
                local_ip = self.get_local_ip()
                info = {
                    'local_ip':   local_ip,
                    'server_url': f'http://{local_ip}:{server_port}',
                    'status':     'running',
                }
                if https_server_port:
                    info['https_url'] = f'https://{local_ip}:{https_server_port}'
                self.send_json_response(info)
        except Exception as e:
            self.send_error(500, str(e))

    # ── Helpers ────────────────────────────────────────────────────────────────

    def _read_json(self):
        length = int(self.headers['Content-Length'])
        return json.loads(self.rfile.read(length).decode())

    def send_json_response(self, data):
        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def get_local_ip(self):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(('8.8.8.8', 80))
                return s.getsockname()[0]
        except Exception:
            return '127.0.0.1'

    def fmt_size(self, b):
        for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
            if b < 1024:
                return f'{b:.1f} {unit}'
            b /= 1024
        return f'{b:.1f} TB'

    def log_message(self, fmt, *args):
        pass  # Suppress per-request HTTP logs (our own prints are enough)


# ── HTTPS support ──────────────────────────────────────────────────────────────

def generate_self_signed_cert(local_ip):
    """Generate a self-signed SSL certificate for the local IP."""
    cert_dir = tempfile.mkdtemp()
    cert_file = os.path.join(cert_dir, 'cert.pem')
    key_file  = os.path.join(cert_dir, 'key.pem')

    # openssl config with SubjectAltName so modern browsers accept the cert
    cnf_content = (
        '[req]\n'
        'distinguished_name = req_distinguished_name\n'
        'x509_extensions = v3_req\n'
        'prompt = no\n'
        '[req_distinguished_name]\n'
        f'CN = {local_ip}\n'
        '[v3_req]\n'
        f'subjectAltName = IP:{local_ip},IP:127.0.0.1\n'
    )
    cnf_file = os.path.join(cert_dir, 'san.cnf')
    with open(cnf_file, 'w') as f:
        f.write(cnf_content)

    result = subprocess.run(
        [
            'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
            '-keyout', key_file, '-out', cert_file,
            '-days', '730', '-config', cnf_file,
        ],
        capture_output=True, timeout=20,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.decode().strip())

    return cert_file, key_file


def run_https_server(port, cert_file, key_file):
    """Run HTTPS server sharing the same handler (and thus the same state)."""
    global https_server_port

    class HttpsServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
        daemon_threads = True
        def server_bind(self):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            super().server_bind()

    try:
        with HttpsServer(('', port), FileShareHandler) as httpsd:
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(cert_file, key_file)
            httpsd.socket = ctx.wrap_socket(httpsd.socket, server_side=True)
            https_server_port = port          # signal main thread it's ready
            httpsd.serve_forever()
    except Exception as e:
        print(f'[HTTPS] Server error: {e}')


# ── Port helpers ───────────────────────────────────────────────────────────────

def get_available_port(start=8080):
    for port in range(start, start + 100):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(('', port))
                return port
        except OSError:
            continue
    raise RuntimeError('No available ports found')


def main():
    global server_port
    try:
        # Render (and most cloud hosts) set the PORT env var
        env_port = os.environ.get('PORT')
        server_port = int(env_port) if env_port else get_available_port(8080)

        class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
            daemon_threads = True
            allow_reuse_address = True
            def server_bind(self):
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                super().server_bind()

        with Server(('', server_port), FileShareHandler) as httpd:

            print('=' * 60)
            print('P2P File Share Server')
            print('=' * 60)

            if PUBLIC_URL:
                # ── Cloud mode ─────────────────────────────────────────────────
                print(f'Mode:    Cloud (Netlify + Render)')
                print(f'Port:    {server_port}')
                print(f'Public:  {PUBLIC_URL}')
                print('HTTPS handled by Netlify — no local cert needed.')
            else:
                # ── Local mode ─────────────────────────────────────────────────
                local_ip = FileShareHandler.get_local_ip(None)
                print(f'Local (host device):  http://localhost:{server_port}')
                print(f'HTTP:                 http://{local_ip}:{server_port}')

                https_started = False
                try:
                    cert_file, key_file = generate_self_signed_cert(local_ip)
                    https_port_candidate = get_available_port(8443)
                    https_thread = threading.Thread(
                        target=run_https_server,
                        args=(https_port_candidate, cert_file, key_file),
                        daemon=True,
                    )
                    https_thread.start()
                    time.sleep(0.8)
                    https_started = (https_server_port is not None)
                except Exception as e:
                    print(f'[HTTPS] Could not start ({e})')

                if https_started:
                    print(f'HTTPS (for Safari):   https://{local_ip}:{https_server_port}')
                    print()
                    print('Safari / iOS users must open the HTTPS URL.')
                    print('On first visit, tap "Advanced" → "visit this website"')
                    print('to accept the self-signed certificate.')
                else:
                    print()
                    print('WARNING: HTTPS unavailable — Safari/iOS may not work.')
                    print('(Install openssl and restart to enable HTTPS.)')

            print('=' * 60)
            print('Press Ctrl+C to stop\n')

            try:
                httpd.serve_forever()
            except KeyboardInterrupt:
                print('\nServer stopped')
                httpd.shutdown()

    except Exception as e:
        print(f'Error: {e}')


if __name__ == '__main__':
    main()
