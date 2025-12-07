#!/usr/bin/env python3
"""
Simple HTTP server for Local File Share
Serves the web application and handles file transfers
"""

import http.server
import socketserver
import json
import os
import urllib.parse
import socket
import threading
import time
import re
from pathlib import Path

class FileShareHandler(http.server.SimpleHTTPRequestHandler):
    shared_files = {}  # Class variable to persist across requests
    
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

    def do_GET(self):
        if self.path == '/':
            self.path = '/index.html'
        elif self.path == '/api/files':
            self.handle_file_list()
            return
        elif self.path.startswith('/api/download/'):
            self.handle_file_download()
            return
        elif self.path == '/api/network-info':
            self.handle_network_info()
            return
        
        super().do_GET()

    def do_POST(self):
        if self.path == '/api/upload':
            self.handle_file_upload()
        elif self.path == '/api/register-file':
            self.handle_file_registration()
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
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Range')
        self.send_header('Access-Control-Max-Age', '86400')  # 24 hours
        self.end_headers()

    def handle_file_list(self):
        """Return list of shared files"""
        try:
            files = []
            # Return files from the shared_files registry, not from disk
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

    def handle_file_download(self):
        """Handle file download requests with proper large file support"""
        try:
            file_id = self.path.split('/')[-1]
            
            # Check if file is registered
            if file_id not in self.shared_files:
                self.send_error(404, "File not found")
                return
            
            file_info = self.shared_files[file_id]
            file_path = Path(file_info['path'])
            
            # Check if file exists on disk
            if not file_path.exists():
                self.send_error(404, "File not found on disk")
                return
            
            file_size = file_path.stat().st_size
            range_header = self.headers.get('Range')
            
            # Handle range requests for resumable downloads
            if range_header:
                # Parse range header (e.g., "bytes=0-1023")
                try:
                    range_match = re.match(r'bytes=(\d+)-(\d*)', range_header)
                    if range_match:
                        start = int(range_match.group(1))
                        end = int(range_match.group(2)) if range_match.group(2) else file_size - 1
                        
                        # Ensure valid range
                        if start >= file_size or end >= file_size or start > end:
                            self.send_error(416, "Range Not Satisfiable")
                            return
                        
                        content_length = end - start + 1
                        
                        # Send partial content response
                        user_agent = self.headers.get('User-Agent', '').lower()
                        is_mobile = any(mobile in user_agent for mobile in ['mobile', 'android', 'iphone', 'ipad'])
                        
                        self.send_response(206)  # Partial Content
                        
                        # Use application/octet-stream for mobile browsers
                        if is_mobile:
                            self.send_header('Content-Type', 'application/octet-stream')
                        else:
                            self.send_header('Content-Type', file_info.get('type', 'application/octet-stream'))
                        
                        self.send_header('Content-Disposition', f'attachment; filename="{file_info["name"]}"')
                        self.send_header('Content-Length', str(content_length))
                        self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
                        self.send_header('Accept-Ranges', 'bytes')
                        
                        # Mobile-specific headers
                        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
                        self.send_header('Pragma', 'no-cache')
                        self.send_header('Expires', '0')
                        
                        # CORS headers
                        self.send_header('Access-Control-Allow-Origin', '*')
                        self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
                        self.send_header('Access-Control-Allow-Headers', 'Range, Content-Type')
                        self.send_header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
                        
                        # Connection headers for stability
                        self.send_header('Connection', 'close')
                        
                        self.end_headers()
                        
                        # Stream the requested range
                        print(f"[DOWNLOAD] Serving range {start}-{end} of {file_info['name']} ({self.formatFileSize(content_length)})")
                        
                        with open(file_path, 'rb') as f:
                            f.seek(start)
                            bytes_to_send = content_length
                            chunk_size = 65536  # 64KB chunks
                            
                            while bytes_to_send > 0:
                                chunk_size_to_read = min(chunk_size, bytes_to_send)
                                chunk = f.read(chunk_size_to_read)
                                if not chunk:
                                    break
                                self.wfile.write(chunk)
                                bytes_to_send -= len(chunk)
                        return
                        
                except ValueError:
                    # Invalid range header, fall through to full download
                    pass
            
            # Full file download
            print(f"[DOWNLOAD] Serving full file: {file_info['name']} ({self.formatFileSize(file_size)})")
            
            # Check if request is from mobile browser
            user_agent = self.headers.get('User-Agent', '').lower()
            is_mobile = any(mobile in user_agent for mobile in ['mobile', 'android', 'iphone', 'ipad'])
            
            self.send_response(200)
            
            # Use application/octet-stream for mobile browsers to force download
            if is_mobile:
                self.send_header('Content-Type', 'application/octet-stream')
            else:
                self.send_header('Content-Type', file_info.get('type', 'application/octet-stream'))
            
            # Critical headers for mobile downloads
            self.send_header('Content-Disposition', f'attachment; filename="{file_info["name"]}"')
            self.send_header('Content-Length', str(file_size))
            self.send_header('Accept-Ranges', 'bytes')
            
            # Mobile-specific headers
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
            
            # CORS headers
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Range, Content-Type')
            self.send_header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
            
            # Connection headers for stability
            self.send_header('Connection', 'close')
            
            self.end_headers()
            
            # Stream the entire file with larger chunks
            bytes_sent = 0
            last_progress_report = 0
            
            with open(file_path, 'rb') as f:
                while True:
                    chunk = f.read(65536)  # 64KB chunks for better performance
                    if not chunk:
                        break
                    
                    try:
                        self.wfile.write(chunk)
                        bytes_sent += len(chunk)
                        
                        # Report progress for large files every 50MB
                        if file_size > 50 * 1024 * 1024 and bytes_sent - last_progress_report > 50 * 1024 * 1024:
                            progress = (bytes_sent / file_size) * 100
                            print(f"[DOWNLOAD] Progress: {progress:.1f}% ({self.formatFileSize(bytes_sent)}/{self.formatFileSize(file_size)})")
                            last_progress_report = bytes_sent
                            
                    except (ConnectionResetError, BrokenPipeError):
                        print(f"[DOWNLOAD] Client disconnected during download of {file_info['name']}")
                        break
            
            if bytes_sent == file_size:
                print(f"[DOWNLOAD] Complete: {file_info['name']} ({self.formatFileSize(bytes_sent)})")
            else:
                print(f"[DOWNLOAD] Incomplete: {file_info['name']} ({self.formatFileSize(bytes_sent)}/{self.formatFileSize(file_size)})")
                
        except Exception as e:
            print(f"[DOWNLOAD] ERROR: {e}")
            import traceback
            traceback.print_exc()
            self.send_error(500, f"Error downloading file: {str(e)}")

    def handle_file_registration(self):
        """Handle file registration from client"""
        try:
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            file_info = json.loads(post_data.decode())
            
            # Store file information
            self.shared_files[file_info['id']] = {
                'name': file_info['name'],
                'size': file_info['size'],
                'type': file_info['type']
            }
            
            print(f"📁 File registered: {file_info['name']} ({self.formatFileSize(file_info['size'])})")
            
            self.send_json_response({'status': 'success', 'message': 'File registered successfully'})
            
        except Exception as e:
            self.send_error(500, f"Error registering file: {str(e)}")

    def handle_file_removal(self):
        """Handle file removal requests"""
        try:
            file_id = self.path.split('/')[-1]
            
            if file_id in self.shared_files:
                file_name = self.shared_files[file_id]['name']
                del self.shared_files[file_id]
                print(f"🗑️ File removed: {file_name}")
                self.send_json_response({'status': 'success', 'message': 'File removed successfully'})
            else:
                self.send_error(404, "File not found")
                
        except Exception as e:
            self.send_error(500, f"Error removing file: {str(e)}")

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

    def handle_file_upload(self):
        """Handle file upload requests with true streaming for large files"""
        try:
            print(f"[UPLOAD] Received upload request")
            
            # Check if Content-Length header exists
            content_length_header = self.headers.get('Content-Length')
            if not content_length_header:
                print(f"[UPLOAD] ERROR: Missing Content-Length header")
                self.send_error(400, "Missing Content-Length header")
                return
            
            content_length = int(content_length_header)
            content_type = self.headers.get('Content-Type', '')
            
            print(f"[UPLOAD] Content-Length: {self.formatFileSize(content_length)}")
            print(f"[UPLOAD] Content-Type: {content_type}")
            
            if 'multipart/form-data' not in content_type:
                print(f"[UPLOAD] ERROR: Invalid content type")
                self.send_error(400, "Invalid content type")
                return
            
            # Extract boundary
            boundary_match = re.search(r'boundary=([^;]+)', content_type)
            if not boundary_match:
                print(f"[UPLOAD] ERROR: No boundary found")
                self.send_error(400, "No boundary in content type")
                return
            
            boundary = boundary_match.group(1).strip()
            boundary_bytes = f'--{boundary}'.encode()
            end_boundary_bytes = f'--{boundary}--'.encode()
            print(f"[UPLOAD] Boundary: {boundary}")
            
            # Create uploads directory if it doesn't exist
            upload_dir = Path('./uploads')
            upload_dir.mkdir(exist_ok=True)
            
            # Streaming multipart parser for large files
            filename = None
            file_id = None
            output_file = None
            temp_file_path = None
            
            buffer = b''
            bytes_read = 0
            chunk_size = 65536  # 64KB chunks for better performance
            state = 'seeking_part'  # seeking_part, reading_headers, reading_file_data
            file_bytes_written = 0
            last_progress_report = 0
            
            try:
                while bytes_read < content_length:
                    # Read chunk
                    remaining = min(chunk_size, content_length - bytes_read)
                    chunk = self.rfile.read(remaining)
                    if not chunk:
                        print(f"[UPLOAD] ERROR: Unexpected end of data at {bytes_read}/{content_length}")
                        break
                    
                    bytes_read += len(chunk)
                    buffer += chunk
                    
                    # Report progress every 10MB for large files
                    if content_length > 10 * 1024 * 1024 and bytes_read - last_progress_report > 10 * 1024 * 1024:
                        progress = (bytes_read / content_length) * 100
                        print(f"[UPLOAD] Progress: {progress:.1f}% ({self.formatFileSize(bytes_read)}/{self.formatFileSize(content_length)})")
                        last_progress_report = bytes_read
                    
                    # Process buffer based on current state
                    while True:
                        if state == 'seeking_part':
                            # Look for start of next part
                            boundary_pos = buffer.find(boundary_bytes)
                            if boundary_pos == -1:
                                # Keep some buffer in case boundary spans chunks
                                if len(buffer) > len(boundary_bytes):
                                    buffer = buffer[-(len(boundary_bytes)):]
                                break
                            
                            # Found boundary, move to headers
                            buffer = buffer[boundary_pos + len(boundary_bytes):]
                            if buffer.startswith(b'\r\n'):
                                buffer = buffer[2:]
                            state = 'reading_headers'
                            continue
                        
                        elif state == 'reading_headers':
                            # Look for end of headers
                            header_end = buffer.find(b'\r\n\r\n')
                            if header_end == -1:
                                break  # Need more data
                            
                            # Extract headers
                            headers = buffer[:header_end].decode('utf-8', errors='ignore')
                            buffer = buffer[header_end + 4:]
                            
                            # Parse headers
                            if 'name="fileId"' in headers:
                                # Extract fileId value
                                value_end = buffer.find(b'\r\n--')
                                if value_end != -1:
                                    file_id = buffer[:value_end].decode().strip()
                                    print(f"[UPLOAD] Found fileId: {file_id}")
                                    buffer = buffer[value_end:]
                                    state = 'seeking_part'
                                    continue
                                else:
                                    # Value might be in next chunk
                                    break
                                    
                            elif 'name="file"' in headers and 'filename=' in headers:
                                # Extract filename
                                filename_match = re.search(r'filename="([^"]*)"', headers)
                                if filename_match:
                                    filename = filename_match.group(1)
                                    print(f"[UPLOAD] Found filename: {filename}")
                                    
                                    # Create output file
                                    if file_id:
                                        temp_file_path = upload_dir / f"temp_{file_id}_{filename}"
                                    else:
                                        temp_file_path = upload_dir / f"temp_{filename}"
                                    
                                    output_file = open(temp_file_path, 'wb')
                                    state = 'reading_file_data'
                                    file_bytes_written = 0
                                    print(f"[UPLOAD] Starting file write to: {temp_file_path}")
                                    continue
                            else:
                                # Skip this part
                                state = 'seeking_part'
                                continue
                        
                        elif state == 'reading_file_data':
                            if not output_file:
                                state = 'seeking_part'
                                continue
                            
                            # Look for end boundary
                            boundary_pos = buffer.find(boundary_bytes)
                            if boundary_pos == -1:
                                # No boundary found, write most of buffer (keep some for boundary detection)
                                if len(buffer) > len(boundary_bytes) + 10:
                                    write_data = buffer[:-(len(boundary_bytes) + 10)]
                                    buffer = buffer[-(len(boundary_bytes) + 10):]
                                    output_file.write(write_data)
                                    file_bytes_written += len(write_data)
                                break
                            else:
                                # Found boundary, write data up to boundary (excluding \r\n before boundary)
                                write_data = buffer[:boundary_pos]
                                if write_data.endswith(b'\r\n'):
                                    write_data = write_data[:-2]
                                
                                output_file.write(write_data)
                                file_bytes_written += len(write_data)
                                output_file.close()
                                output_file = None
                                
                                print(f"[UPLOAD] File data complete: {self.formatFileSize(file_bytes_written)} written")
                                
                                buffer = buffer[boundary_pos:]
                                state = 'seeking_part'
                                continue
                        
                        break  # Exit inner loop
                
                # Close any open file
                if output_file:
                    output_file.close()
                    output_file = None
                
                # Finalize upload if we have all required data
                if filename and file_id and temp_file_path and temp_file_path.exists():
                    # Move temp file to final location
                    final_file_path = upload_dir / f"{file_id}_{filename}"
                    temp_file_path.rename(final_file_path)
                    
                    file_size = final_file_path.stat().st_size
                    
                    # Register in shared files
                    self.shared_files[file_id] = {
                        'name': filename,
                        'size': file_size,
                        'type': self.guess_type(filename)[0] or 'application/octet-stream',
                        'path': str(final_file_path)
                    }
                    
                    print(f"📁 File uploaded successfully: {filename} ({self.formatFileSize(file_size)})")
                    print(f"📁 Saved to: {final_file_path}")
                    print(f"📁 Total shared files: {len(self.shared_files)}")
                    
                    self.send_json_response({'status': 'success', 'message': 'File uploaded successfully'})
                else:
                    # Clean up temp file if it exists
                    if temp_file_path and temp_file_path.exists():
                        temp_file_path.unlink()
                    print(f"[UPLOAD] ERROR: Missing data - filename: {filename}, file_id: {file_id}")
                    self.send_error(400, "Missing file data")
                    
            except Exception as e:
                # Clean up
                if output_file:
                    output_file.close()
                if temp_file_path and temp_file_path.exists():
                    temp_file_path.unlink()
                raise e
            
        except Exception as e:
            print(f"[UPLOAD] ERROR: {e}")
            import traceback
            traceback.print_exc()
            self.send_error(500, f"Error uploading file: {str(e)}")

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
            self.send_error(500, f"Error getting network info: {str(e)}")

    def send_json_response(self, data):
        """Send JSON response"""
        json_data = json.dumps(data).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(json_data)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
        self.wfile.write(json_data)

    def get_local_ip(self):
        """Get local IP address"""
        try:
            # Connect to a remote address to get local IP
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(("8.8.8.8", 80))
                return s.getsockname()[0]
        except:
            return "127.0.0.1"

    def log_message(self, format, *args):
        """Override to customize logging"""
        print(f"[{time.strftime('%H:%M:%S')}] {self.address_string()} - {format % args}")

def get_available_port(start_port=8080):
    """Find an available port starting from start_port"""
    for port in range(start_port, start_port + 100):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(('', port))
                return port
        except OSError:
            continue
    raise Exception("No available ports found")

def print_server_info(port):
    """Print server information"""
    try:
        # Get local IP
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            local_ip = s.getsockname()[0]
    except:
        local_ip = "127.0.0.1"
    
    print("=" * 60)
    print("🚀 Local File Share Server Started!")
    print("=" * 60)
    print(f"📡 Server running on port: {port}")
    print(f"🌐 Local URL: http://localhost:{port}")
    print(f"📱 Network URL: http://{local_ip}:{port}")
    print("=" * 60)
    print("📋 Instructions:")
    print("1. Open the Network URL on any device in the same network")
    print("2. Use 'Host Files' mode to share files")
    print("3. Use 'Connect to Host' mode to receive files")
    print("4. Share the Network URL with other devices")
    print("=" * 60)
    print("Press Ctrl+C to stop the server")
    print()

def main():
    global server_port
    
    try:
        # Find available port
        server_port = get_available_port(8080)
        
        # Create server with explicit logging and large file support
        class LoggingTCPServer(socketserver.TCPServer):
            def handle_error(self, request, client_address):
                print(f"[ERROR] Exception occurred during processing of request from {client_address}")
                import traceback
                traceback.print_exc()
            
            def server_bind(self):
                # Enable socket reuse and configure for large transfers
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                # Increase socket buffer sizes for large file transfers
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024 * 1024)  # 1MB receive buffer
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 1024 * 1024)  # 1MB send buffer
                super().server_bind()
        
        # Configure FileShareHandler for large files
        FileShareHandler.timeout = 300  # 5 minute timeout for uploads
        
        # Create server
        with LoggingTCPServer(("", server_port), FileShareHandler) as httpd:
            # Set server timeout for large file transfers
            httpd.timeout = 300
            
            print_server_info(server_port)
            print("[DEBUG] Server logging enabled")
            print("[DEBUG] Large file support enabled (300s timeout, 1MB buffers)")
            
            # Start server
            try:
                httpd.serve_forever()
            except KeyboardInterrupt:
                print("\n\n🛑 Server stopped by user")
                httpd.shutdown()
                
    except Exception as e:
        print(f"❌ Error starting server: {e}")
        print("Try running with administrator/root privileges or check if the port is already in use.")

if __name__ == "__main__":
    main()