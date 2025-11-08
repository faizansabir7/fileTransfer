class LocalFileShare {
    constructor() {
        this.isHost = true;
        this.files = new Map();
        this.connections = new Map();
        this.serverPort = 8080;
        this.serverUrl = '';
        this.currentHostUrl = null;
        this.init();
    }

    async init() {
        this.setupEventListeners();
        await this.detectNetworkInfo();
        this.setupPeerConnection();
        
        // Start in host mode by default
        this.startHostMode();
    }

    setupEventListeners() {
        // Mode switching
        document.getElementById('hostBtn').addEventListener('click', () => this.switchMode(true));
        document.getElementById('clientBtn').addEventListener('click', () => this.switchMode(false));

        // File upload
        const fileInput = document.getElementById('fileInput');
        const uploadArea = document.getElementById('uploadArea');

        fileInput.addEventListener('change', (e) => this.handleFiles(e.target.files));
        
        uploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadArea.classList.add('dragover');
        });

        uploadArea.addEventListener('dragleave', () => {
            uploadArea.classList.remove('dragover');
        });

        uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadArea.classList.remove('dragover');
            this.handleFiles(e.dataTransfer.files);
        });

        // Copy URL button
        document.getElementById('copyBtn').addEventListener('click', () => this.copyShareUrl());

        // Connect button
        document.getElementById('connectBtn').addEventListener('click', () => this.connectToHost());

        // QR Scanner
        document.getElementById('scanBtn').addEventListener('click', () => this.openQRScanner());
        document.querySelector('.close').addEventListener('click', () => this.closeQRScanner());

        // Service Worker for offline functionality
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('sw.js').catch(console.error);
        }
    }

    switchMode(isHost) {
        this.isHost = isHost;
        
        // Update UI
        document.getElementById('hostBtn').classList.toggle('active', isHost);
        document.getElementById('clientBtn').classList.toggle('active', !isHost);
        document.getElementById('hostMode').classList.toggle('active', isHost);
        document.getElementById('clientMode').classList.toggle('active', !isHost);

        if (isHost) {
            this.startHostMode();
        } else {
            this.startClientMode();
        }
    }

    async detectNetworkInfo() {
        try {
            // First try to get network info from the server
            const response = await fetch('/api/network-info');
            if (response.ok) {
                const networkInfo = await response.json();
                this.serverUrl = networkInfo.server_url;
                this.updateNetworkStatus('Connected to local network', 'success');
                return;
            }
        } catch (error) {
            console.log('Server network info not available, using WebRTC fallback');
        }

        try {
            // Fallback: Get local IP address using WebRTC
            const pc = new RTCPeerConnection({
                iceServers: []
            });
            
            pc.createDataChannel('');
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            
            return new Promise((resolve) => {
                pc.onicecandidate = (event) => {
                    if (event.candidate) {
                        const candidate = event.candidate.candidate;
                        const ipMatch = candidate.match(/(\d+\.\d+\.\d+\.\d+)/);
                        if (ipMatch) {
                            const localIP = ipMatch[1];
                            this.serverUrl = `http://${localIP}:${this.serverPort}`;
                            this.updateNetworkStatus('Connected to local network', 'success');
                            pc.close();
                            resolve(localIP);
                        }
                    }
                };
                
                // Timeout after 5 seconds
                setTimeout(() => {
                    pc.close();
                    this.serverUrl = `http://localhost:${this.serverPort}`;
                    this.updateNetworkStatus('Using localhost - network detection failed', 'warning');
                    resolve('localhost');
                }, 5000);
            });
        } catch (error) {
            console.error('Network detection failed:', error);
            this.updateNetworkStatus('Network detection failed - using localhost', 'error');
            this.serverUrl = `http://localhost:${this.serverPort}`;
        }
    }

    updateNetworkStatus(message, type = 'info') {
        const statusEl = document.getElementById('networkStatus');
        const urlEl = document.getElementById('serverUrl');
        
        statusEl.textContent = message;
        statusEl.className = `status-message ${type}`;
        
        if (this.serverUrl) {
            urlEl.textContent = `Server URL: ${this.serverUrl}`;
        }
    }

    async startHostMode() {
        try {
            // Simulate server start (in real implementation, this would start an actual server)
            await this.simulateServerStart();
            this.updateShareInfo();
        } catch (error) {
            console.error('Failed to start host mode:', error);
            this.updateNetworkStatus('Failed to start server', 'error');
        }
    }

    async simulateServerStart() {
        // In a real implementation, this would start an HTTP server
        // For demo purposes, we'll simulate it
        return new Promise(resolve => {
            setTimeout(() => {
                this.updateNetworkStatus('Server running - Ready to share files', 'success');
                resolve();
            }, 1000);
        });
    }

    startClientMode() {
        this.updateNetworkStatus('Ready to connect to a host', 'info');
        document.getElementById('connectionStatus').innerHTML = '';
        document.getElementById('availableFiles').innerHTML = '';
    }

    async handleFiles(files) {
        const fileList = document.getElementById('fileList');
        
        for (const file of Array.from(files)) {
            const fileId = this.generateId();
            this.files.set(fileId, file);
            
            // Upload file to server immediately
            await this.uploadFileToServer(fileId, file);
            
            const fileItem = this.createFileItem(file, fileId);
            fileList.appendChild(fileItem);
        }

        this.updateShareInfo();
    }

    async uploadFileToServer(fileId, file) {
        try {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('fileId', fileId);
            
            const response = await fetch('/api/upload', {
                method: 'POST',
                body: formData
            });
            
            if (response.ok) {
                console.log(`File uploaded: ${file.name}`);
                this.showToast(`${file.name} uploaded and ready to share!`);
            } else {
                console.error('Failed to upload file');
                this.showToast(`Failed to upload ${file.name}`);
            }
        } catch (error) {
            console.error('Error uploading file:', error);
            this.showToast(`Error uploading ${file.name}`);
        }
    }

    createFileItem(file, fileId) {
        const item = document.createElement('div');
        item.className = 'file-item fade-in';
        item.innerHTML = `
            <div class="file-icon">${this.getFileIcon(file.type)}</div>
            <div class="file-info">
                <div class="file-name">${file.name}</div>
                <div class="file-size">${this.formatFileSize(file.size)}</div>
            </div>
            <div class="file-actions">
                <button class="btn danger" onclick="fileShare.removeFile('${fileId}')">Remove</button>
            </div>
        `;
        return item;
    }

    async removeFile(fileId) {
        // Remove from local storage
        this.files.delete(fileId);
        
        // Remove from server
        try {
            const response = await fetch(`/api/remove-file/${fileId}`, {
                method: 'DELETE'
            });
            
            if (response.ok) {
                this.showToast('File removed successfully');
            }
        } catch (error) {
            console.error('Error removing file from server:', error);
        }
        
        this.updateFileList();
        this.updateShareInfo();
    }

    updateFileList() {
        const fileList = document.getElementById('fileList');
        fileList.innerHTML = '';
        
        this.files.forEach((file, fileId) => {
            const fileItem = this.createFileItem(file, fileId);
            fileList.appendChild(fileItem);
        });
    }

    updateShareInfo() {
        const shareInfo = document.getElementById('shareInfo');
        const shareUrl = document.getElementById('shareUrl');
        const qrCode = document.getElementById('qrCode');

        if (this.files.size > 0 && this.serverUrl) {
            shareInfo.style.display = 'block';
            shareUrl.value = this.serverUrl;
            
            // Generate QR Code
            qrCode.innerHTML = '';
            
            // Check if QRCode library is available
            if (typeof QRCode !== 'undefined') {
                try {
                    QRCode.toCanvas(qrCode, this.serverUrl, {
                        width: 200,
                        margin: 2,
                        color: {
                            dark: '#000000',
                            light: '#FFFFFF'
                        }
                    }, (error) => {
                        if (error) {
                            console.error('QR Code generation error:', error);
                            qrCode.innerHTML = '<p style="color: #666; text-align: center; padding: 20px;">QR code generation failed</p>';
                        }
                    });
                } catch (error) {
                    console.error('QR Code generation failed:', error);
                    qrCode.innerHTML = '<p style="color: #666; text-align: center; padding: 20px;">QR code unavailable</p>';
                }
            } else {
                console.warn('QRCode library not loaded');
                qrCode.innerHTML = '<p style="color: #666; text-align: center; padding: 20px;">QR code library not loaded</p>';
            }
        } else {
            shareInfo.style.display = 'none';
        }
    }

    copyShareUrl() {
        const shareUrl = document.getElementById('shareUrl');
        
        if (!shareUrl.value || shareUrl.value.trim() === '') {
            this.showToast('No URL to copy - please wait for server to start', 'error');
            return;
        }
        
        shareUrl.select();
        shareUrl.setSelectionRange(0, 99999);
        
        try {
            if (navigator.clipboard) {
                navigator.clipboard.writeText(shareUrl.value).then(() => {
                    this.showToast('URL copied to clipboard!');
                }).catch(() => {
                    // Fallback to execCommand
                    try {
                        document.execCommand('copy');
                        this.showToast('URL copied to clipboard!');
                    } catch (e) {
                        this.showToast('Failed to copy URL', 'error');
                    }
                });
            } else {
                // Fallback for older browsers
                document.execCommand('copy');
                this.showToast('URL copied to clipboard!');
            }
        } catch (error) {
            console.error('Copy failed:', error);
            this.showToast('Failed to copy URL - please copy manually', 'error');
        }
    }

    async connectToHost() {
        const hostUrl = document.getElementById('hostUrl').value.trim();
        if (!hostUrl) {
            this.showConnectionStatus('Please enter a host URL', 'error');
            return;
        }

        this.showConnectionStatus('Connecting...', 'info');
        
        try {
            // Test actual connection to the server
            const testUrl = hostUrl.endsWith('/') ? hostUrl + 'api/files' : hostUrl + '/api/files';
            const response = await fetch(testUrl);
            
            if (response.ok) {
                this.showConnectionStatus('Connected successfully!', 'success');
                this.currentHostUrl = hostUrl;
                await this.loadAvailableFiles();
            } else {
                throw new Error(`Server responded with ${response.status}`);
            }
        } catch (error) {
            this.showConnectionStatus('Connection failed: ' + error.message, 'error');
        }
    }

    async simulateConnection(hostUrl) {
        return new Promise((resolve, reject) => {
            setTimeout(() => {
                // Simulate connection success/failure
                if (hostUrl.includes('localhost') || hostUrl.includes('192.168') || hostUrl.includes('10.0')) {
                    resolve();
                } else {
                    reject(new Error('Invalid host URL'));
                }
            }, 2000);
        });
    }

    showConnectionStatus(message, type) {
        const status = document.getElementById('connectionStatus');
        status.textContent = message;
        status.className = `status-message ${type}`;
    }

    async loadAvailableFiles() {
        const availableFiles = document.getElementById('availableFiles');
        
        try {
            // Use the current host URL if connecting to remote, otherwise use relative path
            const filesUrl = this.currentHostUrl ? 
                (this.currentHostUrl.endsWith('/') ? this.currentHostUrl + 'api/files' : this.currentHostUrl + '/api/files') : 
                '/api/files';
                
            console.log('Fetching files from:', filesUrl);
            const response = await fetch(filesUrl);
            const data = await response.json();
            
            console.log('Files received:', data);
            
            availableFiles.innerHTML = '<h3>Available Files:</h3>';
            
            if (data.files && data.files.length > 0) {
                data.files.forEach(file => {
                    const fileItem = document.createElement('div');
                    fileItem.className = 'available-file fade-in';
                    fileItem.innerHTML = `
                        <div class="file-icon">${this.getFileIcon(file.type)}</div>
                        <div class="file-info">
                            <div class="file-name">${file.name}</div>
                            <div class="file-size">${this.formatFileSize(file.size)}</div>
                        </div>
                        <button class="download-btn" onclick="fileShare.downloadFile('${file.id}', '${file.name}')">
                            Download
                        </button>
                    `;
                    availableFiles.appendChild(fileItem);
                });
                this.showToast(`Found ${data.files.length} file(s) to download`);
            } else {
                availableFiles.innerHTML += '<p style="color: #666; font-style: italic;">No files shared yet. Host device needs to add files first.</p>';
            }
        } catch (error) {
            console.error('Error loading files:', error);
            availableFiles.innerHTML += '<p style="color: red;">Error loading files. Please check connection and try again.</p>';
        }
    }

    async downloadFile(fileId, fileName) {
        try {
            // Use the current host URL for downloads
            const downloadUrl = this.currentHostUrl ? 
                (this.currentHostUrl.endsWith('/') ? this.currentHostUrl + `api/download/${fileId}` : this.currentHostUrl + `/api/download/${fileId}`) : 
                `/api/download/${fileId}`;
                
            console.log('Downloading from:', downloadUrl);
            
            // Detect mobile browsers
            const userAgent = navigator.userAgent.toLowerCase();
            const isMobile = /mobile|android|iphone|ipad/.test(userAgent);
            
            if (isMobile) {
                // Mobile: Always use direct navigation to prevent ANY memory/reload issues
                this.showToast(`Starting download: ${fileName}`, 'info');
                
                // Force direct browser download without any fetch operations
                window.location.href = downloadUrl;
                
                // Show success message after a short delay
                setTimeout(() => {
                    this.showToast(`${fileName} download started! Check your downloads.`);
                }, 2000);
                
            } else {
                // Small files (<100MB): Use fetch with progress tracking for better UX
                const progressContainer = document.getElementById('downloadProgress');
                const progressList = document.getElementById('progressList');
                
                progressContainer.style.display = 'block';
                
                const progressItem = document.createElement('div');
                progressItem.className = 'progress-item';
                progressItem.innerHTML = `
                    <div class="progress-header">
                        <span>${fileName}</span>
                        <span id="progress-${fileId}">0%</span>
                    </div>
                    <div class="progress-bar">
                        <div class="progress-fill" id="fill-${fileId}" style="width: 0%"></div>
                    </div>
                `;
                progressList.appendChild(progressItem);
                
                const response = await fetch(downloadUrl);
                
                if (!response.ok) {
                    throw new Error('Download failed');
                }
                
                // Get the file size for progress tracking
                const contentLength = response.headers.get('content-length');
                const total = parseInt(contentLength, 10);
                let loaded = 0;
                
                const reader = response.body.getReader();
                const stream = new ReadableStream({
                    start(controller) {
                        function pump() {
                            return reader.read().then(({ done, value }) => {
                                if (done) {
                                    controller.close();
                                    return;
                                }
                                
                                loaded += value.length;
                                const progress = Math.round((loaded / total) * 100);
                                
                                // Update progress
                                const progressText = document.getElementById(`progress-${fileId}`);
                                const progressFill = document.getElementById(`fill-${fileId}`);
                                
                                if (progressText && progressFill) {
                                    progressText.textContent = `${progress}%`;
                                    progressFill.style.width = `${progress}%`;
                                }
                                
                                controller.enqueue(value);
                                return pump();
                            });
                        }
                        return pump();
                    }
                });
                
                // Convert stream to blob and download
                const responseWithStream = new Response(stream);
                const blob = await responseWithStream.blob();
                
                // Create download link
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = fileName;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                window.URL.revokeObjectURL(url);
                
                this.showToast(`${fileName} downloaded successfully!`);
            }
            
        } catch (error) {
            console.error('Download error:', error);
            this.showToast(`Failed to download ${fileName}`, 'error');
        }
    }

    async simulateDownload(fileId, fileName) {
        const progressText = document.getElementById(`progress-${fileId}`);
        const progressFill = document.getElementById(`fill-${fileId}`);
        
        for (let i = 0; i <= 100; i += 10) {
            await new Promise(resolve => setTimeout(resolve, 200));
            progressText.textContent = `${i}%`;
            progressFill.style.width = `${i}%`;
        }
        
        // Simulate file download completion
        this.showToast(`${fileName} downloaded successfully!`);
    }

    openQRScanner() {
        const modal = document.getElementById('cameraModal');
        const video = document.getElementById('cameraVideo');
        const canvas = document.getElementById('qrCanvas');
        const context = canvas.getContext('2d');
        
        modal.style.display = 'block';
        
        // Check if jsQR library is available
        if (typeof jsQR === 'undefined') {
            this.showToast('QR scanner library not loaded. Please enter URL manually.', 'error');
            this.closeQRScanner();
            return;
        }
        
        // Check for camera permission and start scanning
        navigator.mediaDevices.getUserMedia({ 
            video: { 
                facingMode: 'environment',
                width: { ideal: 640 },
                height: { ideal: 480 }
            } 
        }).then(stream => {
            video.srcObject = stream;
            video.play();
            
            let isScanning = true;
            
            const scanQR = () => {
                if (!isScanning) return;
                
                if (video.readyState === video.HAVE_ENOUGH_DATA) {
                    canvas.width = video.videoWidth;
                    canvas.height = video.videoHeight;
                    context.drawImage(video, 0, 0, canvas.width, canvas.height);
                    
                    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
                    
                    try {
                        const code = jsQR(imageData.data, imageData.width, imageData.height);
                        
                        if (code && code.data) {
                            isScanning = false;
                            document.getElementById('hostUrl').value = code.data;
                            this.closeQRScanner();
                            this.showToast('QR Code scanned successfully!');
                            return;
                        }
                    } catch (error) {
                        console.error('QR scanning error:', error);
                    }
                }
                
                if (isScanning) {
                    requestAnimationFrame(scanQR);
                }
            };
            
            // Store scanning state so we can stop it
            this.qrScanningActive = true;
            video.addEventListener('loadedmetadata', () => {
                if (this.qrScanningActive) {
                    scanQR();
                }
            });
            
            // Start scanning immediately if video is ready
            if (video.readyState >= 2) {
                scanQR();
            }
            
        }).catch(error => {
            console.error('Camera access failed:', error);
            let errorMessage = 'Camera access failed. ';
            
            if (error.name === 'NotAllowedError') {
                errorMessage += 'Please allow camera permission and try again.';
            } else if (error.name === 'NotFoundError') {
                errorMessage += 'No camera found on this device.';
            } else {
                errorMessage += 'Please enter URL manually.';
            }
            
            this.showToast(errorMessage, 'error');
            this.closeQRScanner();
        });
    }

    closeQRScanner() {
        const modal = document.getElementById('cameraModal');
        const video = document.getElementById('cameraVideo');
        
        // Stop scanning
        this.qrScanningActive = false;
        
        // Stop video stream
        if (video.srcObject) {
            video.srcObject.getTracks().forEach(track => track.stop());
            video.srcObject = null;
        }
        
        modal.style.display = 'none';
    }

    setupPeerConnection() {
        // WebRTC setup for peer-to-peer communication
        this.peerConnection = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' }
            ]
        });

        this.dataChannel = this.peerConnection.createDataChannel('fileTransfer', {
            ordered: true
        });

        this.dataChannel.onopen = () => {
            console.log('Data channel opened');
        };

        this.dataChannel.onmessage = (event) => {
            this.handleDataChannelMessage(event.data);
        };
    }

    handleDataChannelMessage(data) {
        try {
            const message = JSON.parse(data);
            console.log('Received message:', message);
            
            switch (message.type) {
                case 'fileList':
                    this.displayAvailableFiles(message.files);
                    break;
                case 'fileChunk':
                    this.handleFileChunk(message);
                    break;
                case 'fileComplete':
                    this.handleFileComplete(message);
                    break;
            }
        } catch (error) {
            console.error('Error handling data channel message:', error);
        }
    }

    getFileIcon(mimeType) {
        if (mimeType.startsWith('image/')) return '🖼️';
        if (mimeType.startsWith('video/')) return '🎬';
        if (mimeType.startsWith('audio/')) return '🎵';
        if (mimeType.includes('pdf')) return '📄';
        if (mimeType.includes('text/') || mimeType.includes('document')) return '📝';
        if (mimeType.includes('zip') || mimeType.includes('rar')) return '📦';
        return '📁';
    }

    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    generateId() {
        return Math.random().toString(36).substr(2, 9);
    }

    showToast(message, type = 'success') {
        // Create toast notification
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = message;
        
        // Set background color based on type
        let backgroundColor = '#4CAF50'; // success - green
        if (type === 'error') {
            backgroundColor = '#f44336'; // error - red
        } else if (type === 'warning') {
            backgroundColor = '#ff9800'; // warning - orange
        } else if (type === 'info') {
            backgroundColor = '#2196F3'; // info - blue
        }
        
        toast.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: ${backgroundColor};
            color: white;
            padding: 15px 20px;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            z-index: 1000;
            animation: slideIn 0.3s ease-out;
            max-width: 300px;
            word-wrap: break-word;
        `;
        
        document.body.appendChild(toast);
        
        // Show longer for errors
        const duration = type === 'error' ? 5000 : 3000;
        
        setTimeout(() => {
            toast.style.animation = 'slideOut 0.3s ease-in forwards';
            setTimeout(() => {
                if (document.body.contains(toast)) {
                    document.body.removeChild(toast);
                }
            }, 300);
        }, duration);
    }
}

// Initialize the application
const fileShare = new LocalFileShare();

// Add toast animations to CSS
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
    }
    
    @keyframes slideOut {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(100%); opacity: 0; }
    }
`;
document.head.appendChild(style);