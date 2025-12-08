#!/usr/bin/env python3
"""
WebRTC Signaling Server for P2P File Share  
Coordinates P2P connections with role-based message queuing
"""

import http.server
import socketserver
import json
import socket
import time

class FileShareHandler(http.server.SimpleHTTPRequestHandler):
    shared_files = {}  # File metadata only
    # Role-based signaling queues - CRITICAL for proper P2P
    signaling_queue = {
        'host': [],    # Messages FOR host (offers, ICE from clients)
        'client': []   # Messages FOR clients (answers, ICE from host)
    }
    peer_last_seen = {}
    
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

    def do_GET(self):
        if self.path == '/':
            self.path = '/index.html'
        elif self.path == '/api/files':
            self.handle_file_list()
            return
        elif self.path.startswith('/api/signal'):
            self.handle_signal_get()
            return
        elif self.path == '/api/network-info':
            self.handle_network_info()
            return
        
        super().do_GET()

    def do_POST(self):
        if self.path == '/api/register-file':
            self.handle_file_registration()
        elif self.path == '/api/signal':
            self.handle_signal_post()
        else:
            self.send_error(404)
    
    def do_DELETE(self):
        if self.path.startswith('/api/remove-file/'):
            self.handle_file_removal()
        else:
            self.send_error(404)
    
    def do_OPTIONS(self):
        """Handle CORS preflight requests"""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Max-Age', '86400')
        self.end_headers()

    def handle_file_list(self):
        """Return list of shared files (metadata only)"""
        try:
            files = []
            for file_id, file_info in self.shared_files.items():
                files.append({
                    'id': file_id,
                    'name': file_info['name'],
                    'size': file_info['size'],
                    'type': file_info['type']
                })
            
            self.send_json_response({'files': files})
        except Exception as e:
            self.send_error(500, f"Error listing files: {str(e)}")

    def handle_signal_post(self):
        """Handle WebRTC signaling with role-based routing"""
        try:
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            signal_data = json.loads(post_data.decode())
            
            msg_type = signal_data.get('type')
            from_peer = signal_data.get('from', 'unknown')
            
            # Route message to correct queue based on type
            if msg_type == 'offer':
                # Offers go to HOST queue
                self.signaling_queue['host'].append(signal_data)
                print(f"[P2P Signaling] → Added {msg_type} to HOST queue (size: {len(self.signaling_queue['host'])})")
                
            elif msg_type == 'answer':
                # Answers go to CLIENT queue
                self.signaling_queue['client'].append(signal_data)
                print(f"[P2P Signaling] → Added {msg_type} to CLIENT queue (size: {len(self.signaling_queue['client'])})")
                
            elif msg_type == 'ice-candidate':
                # ICE candidates go to BOTH queues
                self.signaling_queue['host'].append(signal_data)
                self.signaling_queue['client'].append(signal_data)
                print(f"[P2P Signaling] → Added {msg_type} to BOTH queues")
            
            self.peer_last_seen[from_peer] = time.time()
            self.send_json_response({'status': 'success'})
            
        except Exception as e:
            print(f"[P2P Signaling] ERROR: {e}")
            self.send_error(500, str(e))
    
    def handle_signal_get(self):
        """Retrieve messages based on role (host or client)"""
        try:
            # Parse query parameters for role
            import urllib.parse
            parsed = urllib.parse.urlparse(self.path)
            params = urllib.parse.parse_qs(parsed.query)
            role = params.get('role', [''])[0]
            
            if role not in ['host', 'client']:
                self.send_error(400, "Missing or invalid role parameter. Use ?role=host or ?role=client")
                return
            
            # Get messages for this role
            messages = self.signaling_queue.get(role, [])
            
            # Clear queue after retrieval
            self.signaling_queue[role] = []
            
            if messages:
                print(f"[P2P Signaling] → {role.upper()} retrieved {len(messages)} message(s)")
            
            self.send_json_response({'messages': messages})
            
        except Exception as e:
            print(f"[P2P Signaling] ERROR: {e}")
            self.send_error(500, str(e))

    def handle_file_registration(self):
        """Register file metadata (no actual file storage)"""
        try:
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            file_info = json.loads(post_data.decode())
            
            self.shared_files[file_info['id']] = {
                'name': file_info['name'],
                'size': file_info['size'],
                'type': file_info['type']
            }
            
            print(f"📁 File registered (metadata only): {file_info['name']} ({self.formatFileSize(file_info['size'])})")
            
            self.send_json_response({'status': 'success'})
            
        except Exception as e:
            self.send_error(500, str(e))

    def handle_file_removal(self):
        """Remove file metadata"""
        try:
            file_id = self.path.split('/')[-1]
            
            if file_id in self.shared_files:
                file_name = self.shared_files[file_id]['name']
                del self.shared_files[file_id]
                print(f"🗑️ File removed: {file_name}")
                self.send_json_response({'status': 'success'})
            else:
                self.send_error(404, "File not found")
                
        except Exception as e:
            self.send_error(500, str(e))

    def formatFileSize(self, bytes):
        """Format file size for display"""
        if bytes == 0:
            return '0 Bytes'
        k = 1024
        sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']
        i = int(bytes // (k ** (len(sizes) - 1)))
        for idx, size in enumerate(sizes):
            if bytes < k ** (idx + 1):
                return f"{bytes / (k ** idx):.1f} {size}"
        return f"{bytes / (k ** (len(sizes) - 1)):.1f} {sizes[-1]}"

    def handle_network_info(self):
        """Return network information"""
        try:
            local_ip = self.get_local_ip()
            info = {
                'local_ip': local_ip,
                'server_url': f'http://{local_ip}:{server_port}',
                'status': 'running'
            }
            self.send_json_response(info)
        except Exception as e:
            self.send_error(500, str(e))

    def send_json_response(self, data):
        """Send JSON response"""
        json_data = json.dumps(data).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(json_data)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json_data)

    def get_local_ip(self):
        """Get local IP address"""
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(("8.8.8.8", 80))
                return s.getsockname()[0]
        except:
            return "127.0.0.1"

    def log_message(self, format, *args):
        """Custom logging"""
        print(f"[{time.strftime('%H:%M:%S')}] {self.address_string()} - {format % args}")

def get_available_port(start_port=8080):
    """Find available port"""
    for port in range(start_port, start_port + 100):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(('', port))
                return port
        except OSError:
            continue
    raise Exception("No available ports found")

def print_server_info(port):
    """Print server info"""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            local_ip = s.getsockname()[0]
    except:
        local_ip = "127.0.0.1"
    
    print("=" * 65)
    print("🚀 P2P File Share Server (Role-Based Signaling)")
    print("=" * 65)
    print(f"📡 Port: {port}")
    print(f"🌐 Local: http://localhost:{port}")
    print(f"📱 Network: http://{local_ip}:{port}")
    print("=" * 65)
    print("Press Ctrl+C to stop")
    print()

def main():
    global server_port
    
    try:
        server_port = get_available_port(8080)
        
        class LoggingTCPServer(socketserver.TCPServer):
            def server_bind(self):
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                super().server_bind()
        
        with LoggingTCPServer(("", server_port), FileShareHandler) as httpd:
            print_server_info(server_port)
            
            try:
                httpd.serve_forever()
            except KeyboardInterrupt:
                print("\n\n🛑 Server stopped")
                httpd.shutdown()
                
    except Exception as e:
        print(f"❌ Error: {e}")

if __name__ == "__main__":
    main()