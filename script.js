class LocalFileShare {
    constructor() {
        this.isHost = true;
        this.files = new Map(); // Store File objects in memory
        this.peerConnections = new Map(); // Map of peerId -> RTCPeerConnection
        this.dataChannels = new Map(); // Map of peerId -> RTCDataChannel
        this.serverUrl = '';
        this.currentHostUrl = null;
        this.peerId = null; // Will be set in switchMode() based on host/client mode
        this.signalingPollInterval = null;
        this.isPolling = false;

        // File transfer state
        this.transfers = new Map(); // Map of transferId -> {chunks, received, total, fileName}
        
        // Keep-alive intervals for connections
        this.keepAliveIntervals = new Map(); // Map of peerId -> interval
        
        // Reconnection state
        this.reconnecting = new Set(); // Set of peerIds currently reconnecting

        this.init();
    }

    async init() {
        this.setupEventListeners();
        await this.detectNetworkInfo();

        // Start in host mode by default (this will set peer ID)
        this.switchMode(true);
    }

    generatePeerId() {
        return 'peer_' + Math.random().toString(36).substr(2, 12) + '_' + Date.now();
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

        // P2P Reset button
        document.getElementById('resetP2PBtn').addEventListener('click', () => this.resetP2PConnection());

        // Service Worker for offline functionality
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('sw.js').catch(console.error);
        }
    }

    switchMode(isHost) {
        this.isHost = isHost;

        // Set peer ID based on mode
        if (isHost) {
            this.peerId = 'host'; // Fixed peer ID for hosts
        } else {
            this.peerId = this.generatePeerId(); // Random peer ID for clients
        }

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
            const data = await response.json();
            this.serverUrl = data.server_url;
            this.updateNetworkStatus('Connected to local network', 'success');
            console.log('[Network] Server URL:', this.serverUrl);
        } catch (error) {
            console.error('[Network] Error detecting network info:', error);
            this.updateNetworkStatus('Network detection failed - using localhost', 'error');
            this.serverUrl = `http://localhost:8080`;
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
            console.log('[P2P] Starting host mode as:', this.peerId);
            this.updateNetworkStatus('Server running - Ready to share files', 'success');
            this.updateShareInfo();

            // Start listening for P2P connection requests
            this.startSignalingPoll();
        } catch (error) {
            console.error('Failed to start host mode:', error);
            this.updateNetworkStatus('Failed to start server', 'error');
        }
    }

    startClientMode() {
        this.stopSignalingPoll();
        this.updateNetworkStatus('Ready to connect to a host', 'info');
        document.getElementById('connectionStatus').innerHTML = '';
        document.getElementById('availableFiles').innerHTML = '';
    }

    async handleFiles(files) {
        const fileList = document.getElementById('fileList');

        for (const file of Array.from(files)) {
            const fileId = this.generateId();
            // Store file in memory
            this.files.set(fileId, file);

            // Register file metadata with server (NOT the actual file)
            await this.registerFileMetadata(fileId, file);

            const fileItem = this.createFileItem(file, fileId);
            fileList.appendChild(fileItem);
        }

        this.updateShareInfo();
    }

    async registerFileMetadata(fileId, file) {
        try {
            const metadata = {
                id: fileId,
                name: file.name,
                size: file.size,
                type: file.type
            };

            const response = await fetch('/api/register-file', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(metadata)
            });

            if (response.ok) {
                console.log(`[P2P] File registered (metadata only): ${file.name}`);
                this.showToast(`${file.name} ready to share via P2P!`);
            } else {
                console.error('Failed to register file metadata');
                this.showToast(`Failed to register ${file.name}`, 'error');
            }
        } catch (error) {
            console.error('Error registering file metadata:', error);
            this.showToast(`Error registering ${file.name}`, 'error');
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
        // Remove from local memory
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

    // ==================== WebRTC P2P Implementation ====================

    startSignalingPoll() {
        if (this.isPolling) return;

        this.isPolling = true;
        console.log('[P2P] Starting signaling poll');
        this.pollSignaling();

        // Poll every 2 seconds
        this.signalingPollInterval = setInterval(() => {
            this.pollSignaling();
        }, 2000);
    }

    stopSignalingPoll() {
        if (this.signalingPollInterval) {
            clearInterval(this.signalingPollInterval);
            this.signalingPollInterval = null;
        }
        this.isPolling = false;
    }

    async pollSignaling() {
        try {
            // Use role-based signaling - host gets offers, client gets answers
            const role = this.isHost ? 'host' : 'client';
            const response = await fetch(`/api/signal?role=${role}`);
            if (response.ok) {
                const data = await response.json();
                if (data.messages && data.messages.length > 0) {
                    console.log(`[Signaling] Retrieved ${data.messages.length} message(s) for ${role}`);
                    for (const message of data.messages) {
                        await this.handleSignalingMessage(message);
                    }
                }
            }
        } catch (error) {
            console.error('[P2P] Signaling poll error:', error);
        }
    }

    async sendSignalingMessage(toPeer, type, data) {
        try {
            const message = {
                from: this.peerId,
                to: toPeer,
                type: type,
                data: data
            };

            const response = await fetch('/api/signal', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(message)
            });

            if (!response.ok) {
                console.error('[P2P] Failed to send signaling message');
            }
        } catch (error) {
            console.error('[P2P] Error sending signaling message:', error);
        }
    }

    async handleSignalingMessage(message) {
        const fromPeer = message.from;
        console.log(`[P2P] Received ${message.type} from ${fromPeer}`);

        switch (message.type) {
            case 'offer':
                await this.handleOffer(fromPeer, message.data);
                break;
            case 'answer':
                await this.handleAnswer(fromPeer, message.data);
                break;
            case 'ice-candidate':
                await this.handleIceCandidate(fromPeer, message.data);
                break;
        }
    }

    createPeerConnection(peerId) {
        console.log(`[P2P] Creating peer connection for ${peerId}`);

        // CRITICAL: MUST include STUN servers for ICE candidates to be generated!
        // Added multiple STUN servers and iceTransportPolicy for better reliability
        const pc = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' },
                { urls: 'stun:stun3.l.google.com:19302' },
                { urls: 'stun:stun4.l.google.com:19302' }
            ],
            iceTransportPolicy: 'all', // Try all connection types
            iceCandidatePoolSize: 10 // Pre-gather candidates
        });

        // Queue for ICE candidates that arrive before remote description is set
        pc.pendingIceCandidates = [];

        // ICE candidate handling
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                const candidateStr = event.candidate.candidate;
                console.log('[P2P] 🧊 ICE candidate generated:', candidateStr.substring(0, 60) + '...');
                console.log(`[P2P] 🧊 Sending ICE candidate to ${peerId}`);
                this.sendSignalingMessage(peerId, 'ice-candidate', event.candidate);
            } else {
                console.log('[P2P] 🧊 ICE gathering complete (null candidate)');
            }
        };

        // ICE gathering state
        pc.onicegatheringstatechange = () => {
            console.log(`[P2P] 🧊 ICE gathering state changed: ${pc.iceGatheringState}`);
        };

        // ICE connection state
        pc.oniceconnectionstatechange = () => {
            console.log(`[P2P] 🧊 ICE connection state changed: ${pc.iceConnectionState}`);
            if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
                console.log('[P2P] ✅ ICE connection established!');
            } else if (pc.iceConnectionState === 'failed') {
                console.error('[P2P] ❌ ICE connection failed');
                
                // Attempt ICE restart for clients
                if (!this.isHost && pc.connectionState !== 'closed') {
                    console.log('[P2P] Attempting ICE restart...');
                    this.restartIce(peerId);
                }
            } else if (pc.iceConnectionState === 'disconnected') {
                console.warn('[P2P] 🧊 ICE connection disconnected');
                
                // Give it a few seconds to reconnect before restarting ICE
                setTimeout(() => {
                    const currentPc = this.peerConnections.get(peerId);
                    if (currentPc && currentPc.iceConnectionState === 'disconnected') {
                        console.log('[P2P] ICE still disconnected, attempting restart...');
                        this.restartIce(peerId);
                    }
                }, 5000);
            }
        };

        // Connection state logging
        pc.onconnectionstatechange = () => {
            console.log(`[P2P] Connection state: ${pc.connectionState}`);
            
            // Update P2P status display
            this.updateP2PStatus();
            
            if (pc.connectionState === 'connected') {
                console.log('[P2P] ✅ Peer connection established!');
                this.showToast('P2P connection established!', 'success');
                
                // Start keep-alive for this connection
                this.startKeepAlive(peerId);
            } else if (pc.connectionState === 'failed') {
                console.error('[P2P] ❌ Connection failed');
                this.showToast('P2P connection failed - Click Reset to retry', 'error');
                
                // Attempt to reconnect if we're a client
                if (!this.isHost) {
                    console.log('[P2P] Attempting to reconnect...');
                    setTimeout(() => this.reconnectToPeer(peerId), 2000);
                }
            } else if (pc.connectionState === 'disconnected') {
                console.warn('[P2P] ⚠️ Connection disconnected');
                this.showToast('P2P connection lost - Click Reset to reconnect', 'warning');
                
                // Stop keep-alive
                this.stopKeepAlive(peerId);
                
                // Attempt to reconnect if we're a client
                if (!this.isHost) {
                    console.log('[P2P] Attempting to reconnect...');
                    setTimeout(() => this.reconnectToPeer(peerId), 2000);
                }
            }
        };

        // Data channel handling (for client receiving channel from host)
        pc.ondatachannel = (event) => {
            console.log('[P2P] Data channel received from peer');
            const dataChannel = event.channel;
            this.setupDataChannel(peerId, dataChannel);
        };

        this.peerConnections.set(peerId, pc);
        return pc;
    }

    setupDataChannel(peerId, dataChannel) {
        console.log(`[P2P] Setting up data channel for ${peerId}, current state: ${dataChannel.readyState}`);

        dataChannel.binaryType = 'arraybuffer';

        dataChannel.onopen = () => {
            console.log(`[P2P] ✅ Data channel opened with ${peerId}, readyState: ${dataChannel.readyState}`);
            this.dataChannels.set(peerId, dataChannel);
            this.showToast('Data channel ready for file transfer!', 'success');
            
            // Update P2P status display
            this.updateP2PStatus();
        };

        dataChannel.onclose = () => {
            console.log(`[P2P] Data channel closed with ${peerId}`);
            this.dataChannels.delete(peerId);
            
            // Update P2P status display
            this.updateP2PStatus();
        };

        dataChannel.onerror = (error) => {
            console.error(`[P2P] Data channel error:`, error);
        };

        dataChannel.onmessage = (event) => {
            this.handleDataChannelMessage(peerId, event.data);
        };
    }

    // Handle incoming offer (host side)
    async handleOffer(fromPeer, offer) {
        try {
            let pc = this.peerConnections.get(fromPeer);
            
            // If connection exists and is stable or connected, check if we should ignore this offer
            if (pc) {
                console.log(`[P2P] Existing connection found for ${fromPeer}, state: ${pc.connectionState}, signaling: ${pc.signalingState}`);
                
                // If already connected or connecting successfully, ignore duplicate offers
                if (pc.connectionState === 'connected') {
                    console.log('[P2P] Already connected, ignoring duplicate offer');
                    return;
                }
                
                // If currently negotiating, ignore
                if (pc.signalingState !== 'stable') {
                    console.log(`[P2P] Already negotiating with ${fromPeer}, ignoring duplicate offer`);
                    return;
                }
                
                // Check if we already have a data channel for this peer
                const existingChannel = this.dataChannels.get(fromPeer);
                if (existingChannel && existingChannel.readyState === 'open') {
                    console.log('[P2P] Data channel already open, ignoring duplicate offer');
                    return;
                }
            } else {
                // Create new peer connection
                pc = this.createPeerConnection(fromPeer);
            }

            // Do NOT create data channel here - the offerer (client) creates it
            // The host will receive it via ondatachannel event
            console.log('[P2P] Host will receive data channel via ondatachannel event');

            await pc.setRemoteDescription(new RTCSessionDescription(offer));
            
            // Process any queued ICE candidates now that remote description is set
            if (pc.pendingIceCandidates && pc.pendingIceCandidates.length > 0) {
                console.log(`[P2P] 🧊 Processing ${pc.pendingIceCandidates.length} queued ICE candidates`);
                for (const candidate of pc.pendingIceCandidates) {
                    try {
                        await pc.addIceCandidate(new RTCIceCandidate(candidate));
                        console.log('[P2P] ✅ Queued ICE candidate added');
                    } catch (error) {
                        console.error('[P2P] ❌ Error adding queued ICE candidate:', error);
                    }
                }
                pc.pendingIceCandidates = [];
            }
            
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            // Send answer to client
            await this.sendSignalingMessage(fromPeer, 'answer', answer);

            console.log('[P2P] Answer sent');
        } catch (error) {
            console.error('[P2P] Error handling offer:', error);
        }
    }

    // Handle incoming answer (client side)
    async handleAnswer(fromPeer, answer) {
        try {
            const pc = this.peerConnections.get(fromPeer);
            if (pc) {
                // Check if we already have a remote description (answer already set)
                if (pc.signalingState === 'stable') {
                    console.log('[P2P] Connection already stable, ignoring duplicate answer');
                    return;
                }

                // Only set answer if we're in the right state (have-local-offer)
                if (pc.signalingState !== 'have-local-offer') {
                    console.warn(`[P2P] Wrong signaling state for answer: ${pc.signalingState}, expected 'have-local-offer'`);
                    return;
                }

                await pc.setRemoteDescription(new RTCSessionDescription(answer));
                console.log('[P2P] Answer received and set');
                
                // Process any queued ICE candidates now that remote description is set
                if (pc.pendingIceCandidates && pc.pendingIceCandidates.length > 0) {
                    console.log(`[P2P] 🧊 Processing ${pc.pendingIceCandidates.length} queued ICE candidates`);
                    for (const candidate of pc.pendingIceCandidates) {
                        try {
                            await pc.addIceCandidate(new RTCIceCandidate(candidate));
                            console.log('[P2P] ✅ Queued ICE candidate added');
                        } catch (error) {
                            console.error('[P2P] ❌ Error adding queued ICE candidate:', error);
                        }
                    }
                    pc.pendingIceCandidates = [];
                }
            } else {
                // Ignore answers for peers we don't have connections for (old sessions after reset)
                console.log(`[P2P] Ignoring answer from ${fromPeer} (no active connection, likely old session)`);
            }
        } catch (error) {
            console.error('[P2P] Error handling answer:', error);
        }
    }

    // Handle ICE candidate
    async handleIceCandidate(fromPeer, candidate) {
        try {
            console.log(`[P2P] 🧊 Received ICE candidate from ${fromPeer}`);
            const pc = this.peerConnections.get(fromPeer);
            if (pc) {
                const candidateStr = candidate.candidate ? candidate.candidate.substring(0, 60) + '...' : 'end-of-candidates';
                console.log(`[P2P] 🧊 Adding ICE candidate:`, candidateStr);
                console.log(`[P2P] 🧊 Current signaling state: ${pc.signalingState}, ICE connection state: ${pc.iceConnectionState}`);
                
                // If we don't have a remote description yet, queue the candidate
                if (!pc.remoteDescription || pc.remoteDescription.type === '') {
                    console.log('[P2P] 🧊 Remote description not set yet, queuing ICE candidate');
                    pc.pendingIceCandidates = pc.pendingIceCandidates || [];
                    pc.pendingIceCandidates.push(candidate);
                    return;
                }
                
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
                console.log('[P2P] ✅ ICE candidate added successfully');
            } else {
                // Ignore candidates for peers we don't have connections for (old sessions after reset)
                console.log(`[P2P] Ignoring ICE candidate from ${fromPeer} (no active connection, likely old session)`);
            }
        } catch (error) {
            console.error('[P2P] ❌ Error adding ICE candidate:', error);
        }
    }

    // ==================== Client Connection ====================

    async connectToHost() {
        const hostUrl = document.getElementById('hostUrl').value.trim();
        if (!hostUrl) {
            this.showConnectionStatus('Please enter a host URL', 'error');
            return;
        }

        this.showConnectionStatus('Connecting...', 'info');
        this.currentHostUrl = hostUrl;

        try {
            // Clean up ALL existing P2P connections (force complete fresh start)
            console.log('[P2P] Cleaning up all existing connections for fresh start...');
            this.peerConnections.forEach((pc, peerId) => {
                console.log(`[P2P] Closing connection to ${peerId}`);
                pc.close();
            });
            this.peerConnections.clear();
            this.dataChannels.clear();
            
            // Stop all keep-alives
            this.keepAliveIntervals.forEach((interval, peerId) => {
                clearInterval(interval);
            });
            this.keepAliveIntervals.clear();
            
            // Clear reconnecting state
            this.reconnecting.clear();
            
            // Generate NEW client peer ID to avoid signaling conflicts
            const oldPeerId = this.peerId;
            this.peerId = this.generatePeerId();
            console.log(`[P2P] Generated new client peer ID: ${this.peerId} (was ${oldPeerId})`);
            
            // Stop and restart signaling
            this.stopSignalingPoll();
            
            const hostPeerId = 'host';

            // Test connection to server
            const testUrl = hostUrl.endsWith('/') ? hostUrl + 'api/files' : hostUrl + '/api/files';
            const response = await fetch(testUrl);

            if (response.ok) {
                this.showConnectionStatus('Connected to server, establishing P2P...', 'info');

                // Load available files
                await this.loadAvailableFiles();

                // Initiate fresh P2P connection to host
                console.log('[P2P] Starting fresh P2P connection...');
                await this.initiateP2PConnection(hostPeerId);
                
                this.showToast('P2P connection initiated!', 'info');
                
                // Show P2P controls
                document.getElementById('p2pControls').style.display = 'flex';
                this.updateP2PStatus();

            } else {
                throw new Error(`Server responded with ${response.status}`);
            }
        } catch (error) {
            this.showConnectionStatus('Connection failed: ' + error.message, 'error');
        }
    }
    
    async resetP2PConnection() {
        console.log('[P2P] Manual reset requested');
        this.showToast('Resetting P2P connection...', 'info');
        
        const hostPeerId = 'host';
        
        // Clean up ALL peer connections (not just host)
        console.log('[P2P] Cleaning up all peer connections...');
        this.peerConnections.forEach((pc, peerId) => {
            console.log(`[P2P] Closing connection to ${peerId}`);
            pc.close();
        });
        this.peerConnections.clear();
        this.dataChannels.clear();
        
        // Stop all keep-alives
        this.keepAliveIntervals.forEach((interval, peerId) => {
            clearInterval(interval);
        });
        this.keepAliveIntervals.clear();
        
        // Clear reconnecting state
        this.reconnecting.clear();
        
        // Generate NEW client peer ID to avoid signaling conflicts
        const oldPeerId = this.peerId;
        this.peerId = this.generatePeerId();
        console.log(`[P2P] Generated new client peer ID: ${this.peerId} (was ${oldPeerId})`);
        
        // Update status
        this.updateP2PStatus('disconnected');
        
        // Wait a moment for cleanup
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Restart signaling with new peer ID
        this.stopSignalingPoll();
        
        try {
            // Create fresh connection
            console.log('[P2P] Creating fresh P2P connection with new peer ID...');
            this.updateP2PStatus('connecting');
            
            await this.initiateP2PConnection(hostPeerId);
            
            // Wait for connection to establish
            let attempts = 0;
            while (attempts < 20) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                const dc = this.dataChannels.get(hostPeerId);
                const pc = this.peerConnections.get(hostPeerId);
                
                if (dc && dc.readyState === 'open') {
                    console.log('[P2P] ✅ Reset successful, connection established!');
                    this.showToast('P2P connection reset successfully!', 'success');
                    this.updateP2PStatus('connected');
                    return;
                }
                
                // Show progress
                if (attempts % 3 === 0) {
                    console.log(`[P2P] Waiting for connection... (${attempts + 1}/20)`);
                }
                
                attempts++;
            }
            
            // If we get here, connection failed
            throw new Error('Connection timeout after reset');
            
        } catch (error) {
            console.error('[P2P] Reset failed:', error);
            this.showToast('Reset failed: ' + error.message, 'error');
            this.updateP2PStatus('failed');
        }
    }
    
    updateP2PStatus(status) {
        const statusEl = document.getElementById('p2pStatus');
        if (!statusEl) return;
        
        const hostPeerId = 'host';
        const pc = this.peerConnections.get(hostPeerId);
        const dc = this.dataChannels.get(hostPeerId);
        
        // Determine current status if not provided
        if (!status) {
            if (dc && dc.readyState === 'open' && pc && pc.connectionState === 'connected') {
                status = 'connected';
            } else if (pc && (pc.connectionState === 'connecting' || pc.iceConnectionState === 'checking')) {
                status = 'connecting';
            } else if (pc && pc.connectionState === 'disconnected') {
                status = 'disconnected';
            } else if (pc && pc.connectionState === 'failed') {
                status = 'failed';
            } else {
                status = 'unknown';
            }
        }
        
        // Update display
        const statusIcons = {
            'connected': '✅',
            'connecting': '🔄',
            'disconnected': '⚠️',
            'failed': '❌',
            'unknown': '❓'
        };
        
        const statusTexts = {
            'connected': 'P2P Connected',
            'connecting': 'P2P Connecting...',
            'disconnected': 'P2P Disconnected',
            'failed': 'P2P Failed',
            'unknown': 'P2P Status Unknown'
        };
        
        statusEl.innerHTML = `${statusIcons[status]} ${statusTexts[status]}`;
        statusEl.className = `p2p-status status-${status}`;
    }

    async initiateP2PConnection(hostPeerId) {
        try {
            // Check if we already have a connection to this peer
            const existingPc = this.peerConnections.get(hostPeerId);
            if (existingPc) {
                console.log(`[P2P] Connection to ${hostPeerId} already exists, state: ${existingPc.connectionState}, signaling: ${existingPc.signalingState}`);
                
                // If connected, don't recreate
                if (existingPc.connectionState === 'connected') {
                    console.log('[P2P] Already connected, not creating new connection');
                    return;
                }
                
                // If connecting or negotiating, wait for it to complete
                if (existingPc.connectionState === 'connecting' || existingPc.signalingState !== 'stable') {
                    console.log('[P2P] Connection already in progress, waiting...');
                    return;
                }
                
                // If failed or disconnected, clean up and recreate
                if (existingPc.connectionState === 'failed' || existingPc.connectionState === 'disconnected') {
                    console.log('[P2P] Cleaning up failed connection');
                    existingPc.close();
                    this.peerConnections.delete(hostPeerId);
                    this.dataChannels.delete(hostPeerId);
                }
            }

            console.log(`[P2P] Initiating connection to host: ${hostPeerId}`);

            const pc = this.createPeerConnection(hostPeerId);

            // IMPORTANT: Client must create the data channel as the offerer!
            // The host will receive it via ondatachannel event
            console.log('[P2P] Creating data channel as offerer (client side)');
            const dataChannel = pc.createDataChannel('fileTransfer', { ordered: true });
            this.setupDataChannel(hostPeerId, dataChannel);

            // Create offer
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            // Send offer to host
            await this.sendSignalingMessage(hostPeerId, 'offer', offer);

            // Start polling for answer (only if not already polling)
            if (!this.isPolling) {
                this.startSignalingPoll();
            }

            console.log('[P2P] Offer sent to host, waiting for answer...');
        } catch (error) {
            console.error('[P2P] Error initiating P2P connection:', error);
            this.showToast('Failed to initiate P2P connection', 'error');
        }
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
                        <button class="download-btn p2p-btn" onclick="fileShare.downloadFileP2P('${file.id}', '${file.name}')">
                            📡 P2P Download
                        </button>
                    `;
                    availableFiles.appendChild(fileItem);
                });
                this.showToast(`Found ${data.files.length} file(s) via P2P`);
            } else {
                availableFiles.innerHTML += '<p style="color: #666; font-style: italic;">No files shared yet. Host device needs to add files first.</p>';
            }
        } catch (error) {
            console.error('Error loading files:', error);
            availableFiles.innerHTML += '<p style="color: red;">Error loading files. Please check connection and try again.</p>';
        }
    }

    // ==================== File Transfer via P2P ====================

    async downloadFileP2P(fileId, fileName) {
        try {
            const hostPeerId = 'host';
            
            // Check if we have an existing open data channel
            let dataChannel = this.dataChannels.get(hostPeerId);
            let pc = this.peerConnections.get(hostPeerId);
            
            console.log(`[P2P] Download requested for ${fileName}`);
            console.log(`[P2P] Current state - PC: ${pc ? pc.connectionState : 'none'}, DC: ${dataChannel ? dataChannel.readyState : 'none'}`);

            if (!dataChannel || dataChannel.readyState !== 'open') {
                console.log('[P2P] Data channel not ready, establishing connection...');
                this.showToast('P2P connection not ready. Establishing connection...', 'warning');
                
                // Check if we need to create a new connection
                const needNewConnection = !pc || 
                    pc.connectionState === 'failed' || 
                    pc.connectionState === 'closed' ||
                    pc.connectionState === 'disconnected';
                
                if (needNewConnection) {
                    console.log('[P2P] Creating new connection...');
                    await this.initiateP2PConnection(hostPeerId);
                } else {
                    console.log('[P2P] Connection exists but data channel not ready, waiting...');
                }

                // Wait for connection with retry logic
                let attempts = 0;
                const maxAttempts = 20;
                while (attempts < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    
                    // Refresh references
                    pc = this.peerConnections.get(hostPeerId);
                    dataChannel = this.dataChannels.get(hostPeerId);
                    
                    // Log detailed status
                    if (pc) {
                        console.log(`[P2P] Waiting for connection... (${attempts + 1}/${maxAttempts}) - PC: ${pc.connectionState}, ICE: ${pc.iceConnectionState}, Signaling: ${pc.signalingState}, DC: ${dataChannel ? dataChannel.readyState : 'none'}`);
                    } else {
                        console.log(`[P2P] Waiting for connection... (${attempts + 1}/${maxAttempts}) - No peer connection yet`);
                    }
                    
                    if (dataChannel && dataChannel.readyState === 'open') {
                        console.log('[P2P] ✅ Connection established and ready!');
                        break;
                    }
                    
                    // If connection failed, try to reconnect
                    if (pc && pc.connectionState === 'failed' && attempts === 5) {
                        console.log('[P2P] Connection failed, attempting to reconnect...');
                        if (pc) pc.close();
                        this.peerConnections.delete(hostPeerId);
                        this.dataChannels.delete(hostPeerId);
                        await this.initiateP2PConnection(hostPeerId);
                    }
                    
                    // Try reconnecting again if still not connected
                    if (attempts === 12 && (!dataChannel || dataChannel.readyState !== 'open')) {
                        console.log('[P2P] Second reconnection attempt...');
                        if (pc) pc.close();
                        this.peerConnections.delete(hostPeerId);
                        this.dataChannels.delete(hostPeerId);
                        await this.initiateP2PConnection(hostPeerId);
                    }
                    
                    attempts++;
                }

                if (!dataChannel || dataChannel.readyState !== 'open') {
                    const pcState = pc ? `PC: ${pc.connectionState}, ICE: ${pc.iceConnectionState}` : 'No connection';
                    throw new Error(`Could not establish P2P connection after ${maxAttempts} attempts. ${pcState}`);
                }
            } else {
                console.log('[P2P] ✅ Using existing connection (already open)');
            }

            console.log(`[P2P] Requesting file: ${fileName} (ID: ${fileId})`);

            // Send file request
            dataChannel.send(JSON.stringify({
                type: 'file-request',
                fileId: fileId,
                fileName: fileName
            }));

            this.showToast(`Downloading ${fileName} via P2P...`, 'info');

        } catch (error) {
            console.error('[P2P] Error downloading file:', error);
            this.showToast(`P2P download failed: ${error.message}`, 'error');
        }
    }
    
    startKeepAlive(peerId) {
        // Stop any existing keep-alive for this peer
        this.stopKeepAlive(peerId);
        
        console.log(`[P2P] Starting keep-alive for ${peerId}`);
        
        // Send ping every 10 seconds
        const interval = setInterval(() => {
            const dataChannel = this.dataChannels.get(peerId);
            if (dataChannel && dataChannel.readyState === 'open') {
                try {
                    dataChannel.send(JSON.stringify({
                        type: 'ping',
                        timestamp: Date.now()
                    }));
                    console.log(`[P2P] Keep-alive ping sent to ${peerId}`);
                } catch (error) {
                    console.error('[P2P] Error sending keep-alive:', error);
                }
            } else {
                // Channel closed, stop keep-alive
                this.stopKeepAlive(peerId);
            }
        }, 10000);
        
        this.keepAliveIntervals.set(peerId, interval);
    }
    
    stopKeepAlive(peerId) {
        const interval = this.keepAliveIntervals.get(peerId);
        if (interval) {
            clearInterval(interval);
            this.keepAliveIntervals.delete(peerId);
            console.log(`[P2P] Keep-alive stopped for ${peerId}`);
        }
    }
    
    async reconnectToPeer(peerId) {
        // Prevent multiple simultaneous reconnection attempts
        if (this.reconnecting.has(peerId)) {
            console.log(`[P2P] Already reconnecting to ${peerId}`);
            return;
        }
        
        this.reconnecting.add(peerId);
        console.log(`[P2P] Reconnecting to ${peerId}...`);
        
        try {
            // Clean up old connection
            const oldPc = this.peerConnections.get(peerId);
            if (oldPc) {
                oldPc.close();
            }
            this.peerConnections.delete(peerId);
            this.dataChannels.delete(peerId);
            this.stopKeepAlive(peerId);
            
            // Wait a bit before reconnecting
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Initiate new connection
            await this.initiateP2PConnection(peerId);
            
            console.log(`[P2P] Reconnection initiated for ${peerId}`);
        } catch (error) {
            console.error(`[P2P] Error reconnecting to ${peerId}:`, error);
        } finally {
            this.reconnecting.delete(peerId);
        }
    }
    
    async restartIce(peerId) {
        const pc = this.peerConnections.get(peerId);
        if (!pc || pc.connectionState === 'closed') {
            console.log('[P2P] Cannot restart ICE, connection closed');
            return;
        }
        
        try {
            console.log(`[P2P] Restarting ICE for ${peerId}...`);
            
            // Create a new offer with iceRestart flag
            const offer = await pc.createOffer({ iceRestart: true });
            await pc.setLocalDescription(offer);
            
            // Send the new offer
            await this.sendSignalingMessage(peerId, 'offer', offer);
            
            console.log('[P2P] ICE restart offer sent');
        } catch (error) {
            console.error('[P2P] Error restarting ICE:', error);
            
            // If ICE restart fails, try full reconnection
            console.log('[P2P] ICE restart failed, attempting full reconnection...');
            await this.reconnectToPeer(peerId);
        }
    }

    handleDataChannelMessage(peerId, data) {
        // Check if it's JSON (metadata) or binary (file data)
        if (typeof data === 'string') {
            try {
                const message = JSON.parse(data);
                this.handleControlMessage(peerId, message);
            } catch (error) {
                console.error('[P2P] Error parsing control message:', error);
            }
        } else {
            // Binary data - file chunk
            this.handleFileChunk(peerId, data);
        }
    }

    handleControlMessage(peerId, message) {
        // Don't log ping/pong to reduce console noise
        if (message.type !== 'ping' && message.type !== 'pong') {
            console.log(`[P2P] Control message from ${peerId}:`, message.type);
        }

        switch (message.type) {
            case 'file-request':
                // Host receives file request from client
                this.sendFileToClient(peerId, message.fileId);
                break;
            case 'file-meta':
                // Client receives file metadata
                this.initializeFileReceive(peerId, message);
                break;
            case 'file-chunk':
                // Chunk metadata
                break;
            case 'file-complete':
                // Complete file transfer
                this.completeFileReceive(peerId, message);
                break;
            case 'ping':
                // Respond to keep-alive ping with pong
                this.sendPong(peerId, message.timestamp);
                break;
            case 'pong':
                // Keep-alive pong received
                const latency = Date.now() - message.timestamp;
                console.log(`[P2P] Keep-alive pong from ${peerId}, latency: ${latency}ms`);
                break;
        }
    }
    
    sendPong(peerId, timestamp) {
        const dataChannel = this.dataChannels.get(peerId);
        if (dataChannel && dataChannel.readyState === 'open') {
            try {
                dataChannel.send(JSON.stringify({
                    type: 'pong',
                    timestamp: timestamp
                }));
            } catch (error) {
                console.error('[P2P] Error sending pong:', error);
            }
        }
    }

    // Host sends file to client
    async sendFileToClient(peerId, fileId) {
        const file = this.files.get(fileId);
        if (!file) {
            console.error(`[P2P] File not found: ${fileId}`);
            return;
        }

        const dataChannel = this.dataChannels.get(peerId);
        if (!dataChannel) {
            console.error(`[P2P] No data channel for peer: ${peerId}`);
            return;
        }

        console.log(`[P2P] Sending file ${file.name} to ${peerId}`);

        // Send file metadata
        dataChannel.send(JSON.stringify({
            type: 'file-meta',
            transferId: fileId,
            fileName: file.name,
            fileSize: file.size,
            fileType: file.type,
            chunkSize: 64 * 1024 // Reduced to 64KB chunks for better flow control
        }));

        // Read and send file in chunks with proper flow control
        const chunkSize = 64 * 1024; // 64KB chunks (smaller = more reliable for large files)
        const BUFFER_THRESHOLD = 16 * 1024 * 1024; // 16MB buffer threshold
        const reader = new FileReader();
        let offset = 0;
        let chunkIndex = 0;

        const sendNextChunk = () => {
            if (offset >= file.size) {
                // File transfer complete
                dataChannel.send(JSON.stringify({
                    type: 'file-complete',
                    transferId: fileId
                }));
                console.log(`[P2P] File transfer complete: ${file.name}`);
                return;
            }

            // CRITICAL: Check buffer before sending to prevent overflow
            if (dataChannel.bufferedAmount > BUFFER_THRESHOLD) {
                console.log(`[P2P] Buffer full (${dataChannel.bufferedAmount} bytes), waiting...`);
                // Wait for buffer to drain before sending more
                setTimeout(() => sendNextChunk(), 100);
                return;
            }

            const slice = file.slice(offset, offset + chunkSize);
            reader.readAsArrayBuffer(slice);
        };

        reader.onload = (e) => {
            if (dataChannel.readyState === 'open') {
                try {
                    dataChannel.send(e.target.result);
                    offset += e.target.result.byteLength;
                    chunkIndex++;

                    // Log progress every 100 chunks
                    if (chunkIndex % 100 === 0) {
                        const progress = Math.round((offset / file.size) * 100);
                        console.log(`[P2P] Sending ${file.name}: ${progress}% (buffer: ${dataChannel.bufferedAmount} bytes)`);
                    }

                    // Send next chunk with small delay to avoid overwhelming
                    setTimeout(() => sendNextChunk(), 0);
                } catch (error) {
                    console.error('[P2P] Error sending chunk:', error);
                    // Try to recover by waiting and retrying
                    setTimeout(() => sendNextChunk(), 100);
                }
            } else {
                console.error('[P2P] Data channel closed during transfer');
            }
        };

        reader.onerror = (error) => {
            console.error('[P2P] Error reading file:', error);
        };

        sendNextChunk();
    }

    initializeFileReceive(peerId, meta) {
        console.log(`[P2P] 🚀 Initializing receive: ${meta.fileName}`);
        console.log(`[P2P] 📦 File size: ${this.formatFileSize(meta.fileSize)}`);
        console.log(`[P2P] 🆔 Transfer ID: ${meta.transferId}`);

        this.transfers.set(meta.transferId, {
            fileName: meta.fileName,
            fileSize: meta.fileSize,
            fileType: meta.fileType,
            chunkSize: meta.chunkSize,
            chunks: [],
            receivedBytes: 0,
            progressElement: null,
            startTime: Date.now()
        });

        // Prevent page unload during download
        this.preventUnloadDuringTransfer();

        // Create progress UI
        console.log(`[P2P] 🎨 About to create progress UI...`);
        this.createProgressUI(meta.transferId, meta.fileName);
        console.log(`[P2P] ✅ Progress UI creation completed`);
    }
    
    preventUnloadDuringTransfer() {
        // Add beforeunload handler to prevent accidental navigation
        if (!this.unloadHandler) {
            this.unloadHandler = (e) => {
                if (this.transfers.size > 0) {
                    const message = 'Download in progress! Are you sure you want to leave?';
                    e.preventDefault();
                    e.returnValue = message;
                    console.log('[P2P] 🚨 Prevented page unload during transfer');
                    return message;
                }
            };
            window.addEventListener('beforeunload', this.unloadHandler);
            console.log('[P2P] 🔒 Page unload protection enabled');
        }
    }
    
    allowUnload() {
        // Remove beforeunload handler when no transfers are active
        if (this.unloadHandler && this.transfers.size === 0) {
            window.removeEventListener('beforeunload', this.unloadHandler);
            this.unloadHandler = null;
            console.log('[P2P] 🔓 Page unload protection disabled');
        }
    }

    handleFileChunk(peerId, chunk) {
        // Find active transfer
        for (const [transferId, transfer] of this.transfers.entries()) {
            if (transfer.receivedBytes < transfer.fileSize) {
                transfer.chunks.push(chunk);
                transfer.receivedBytes += chunk.byteLength;

                // Update progress
                const progress = Math.round((transfer.receivedBytes / transfer.fileSize) * 100);
                const elapsedTime = (Date.now() - transfer.startTime) / 1000; // seconds
                const speed = transfer.receivedBytes / elapsedTime; // bytes per second
                const remaining = (transfer.fileSize - transfer.receivedBytes) / speed; // seconds
                
                console.log(`[P2P] Receiving ${transfer.fileName}: ${progress}%`);
                
                // Update progress UI
                this.updateProgressUI(transferId, progress, speed, remaining);

                break;
            }
        }
    }

    async completeFileReceive(peerId, message) {
        const transfer = this.transfers.get(message.transferId);
        if (!transfer) {
            console.error('[P2P] Transfer not found');
            return;
        }

        console.log(`[P2P] Completing file receive: ${transfer.fileName}`);
        console.log(`[P2P] Total chunks received: ${transfer.chunks.length}, Total bytes: ${transfer.receivedBytes}`);

        const fileSizeMB = transfer.fileSize / (1024 * 1024);
        console.log(`[P2P] File size: ${fileSizeMB.toFixed(2)} MB`);
        
        // For very large files on mobile, try File System Access API first
        if (this.isMobileBrowser() && fileSizeMB > 500 && 'showSaveFilePicker' in window) {
            console.log('[P2P] Large file on mobile - attempting direct File System Access API write...');
            try {
                await this.saveFileDirectly(transfer);
                this.showToast(`${transfer.fileName} downloaded successfully!`, 'success');
                
                setTimeout(() => {
                    this.removeProgressUI(message.transferId);
                }, 1000);
                
                setTimeout(() => {
                    this.transfers.delete(message.transferId);
                }, 2000);
                return;
            } catch (fsError) {
                if (fsError.name === 'AbortError') {
                    console.log('[P2P] User cancelled');
                    this.removeProgressUI(message.transferId);
                    this.transfers.delete(message.transferId);
                    return;
                }
                console.log('[P2P] Direct save failed, trying blob method:', fsError.message);
            }
        }

        try {
            // Combine all chunks
            // Use application/octet-stream to force download for all file types
            console.log('[P2P] Creating blob from chunks...');
            
            // For mobile with large files, warn before creating blob
            if (this.isMobileBrowser() && fileSizeMB > 800) {
                console.warn('[P2P] ⚠️ Very large file on mobile - may cause memory issues');
                this.showToast('Processing large file... Please wait and do not close the browser.', 'warning');
            }
            
            const blob = new Blob(transfer.chunks, { 
                type: transfer.fileType || 'application/octet-stream' 
            });
            console.log(`[P2P] Blob created: ${blob.size} bytes`);

            // Use File System Access API if available (Chrome/Edge), otherwise fallback
            await this.saveFileToDownloads(blob, transfer.fileName);

            this.showToast(`${transfer.fileName} downloaded successfully!`, 'success');

            // Remove progress UI after a short delay to show 100%
            setTimeout(() => {
                this.removeProgressUI(message.transferId);
            }, 1000);

        } catch (error) {
            console.error('[P2P] Error completing file receive:', error);
            this.showToast(`Error saving ${transfer.fileName}: ${error.message}`, 'error');
            
            // Try emergency fallback - download in smaller pieces
            this.emergencyChunkedDownload(transfer);
        } finally {
            // Clean up transfer data to free memory
            setTimeout(() => {
                this.transfers.delete(message.transferId);
                // Allow page unload if no more transfers
                this.allowUnload();
            }, 2000);
        }
    }
    
    async saveFileDirectly(transfer) {
        console.log('[P2P] 💾 Saving file directly without creating large blob in memory...');
        
        const handle = await window.showSaveFilePicker({
            suggestedName: transfer.fileName,
            types: [{
                description: 'File',
                accept: { [transfer.fileType || '*/*']: [this.getFileExtension(transfer.fileName)] }
            }]
        });
        
        const writable = await handle.createWritable();
        
        // Write chunks directly to disk without creating a single large blob
        let written = 0;
        for (let i = 0; i < transfer.chunks.length; i++) {
            await writable.write(transfer.chunks[i]);
            written += transfer.chunks[i].byteLength;
            
            if (i % 100 === 0) {
                const progress = (written / transfer.fileSize) * 100;
                console.log(`[P2P] Writing to disk: ${progress.toFixed(1)}%`);
            }
        }
        
        await writable.close();
        console.log('[P2P] ✅ File written directly to disk successfully!');
    }

    emergencyChunkedDownload(transfer) {
        console.log('[P2P] 🚨 Emergency chunked download mode activated');
        
        try {
            // For very large files that cause memory issues, download in parts
            const maxChunkSize = 50 * 1024 * 1024; // 50MB per download part
            const totalSize = transfer.fileSize;
            let offset = 0;
            let partNumber = 1;
            
            // Use a delay between downloads to avoid overwhelming the browser
            const downloadNextPart = () => {
                if (offset >= transfer.chunks.length) {
                    this.showToast(`File downloaded in ${partNumber - 1} parts. Combine them to get the full file.`, 'warning');
                    // Remove progress UI
                    setTimeout(() => {
                        this.removeProgressUI(transfer.transferId || 'unknown');
                    }, 1000);
                    return;
                }
                
                let currentSize = 0;
                const partChunks = [];
                
                // Collect chunks up to maxChunkSize
                while (offset < transfer.chunks.length && currentSize < maxChunkSize) {
                    const chunk = transfer.chunks[offset];
                    partChunks.push(chunk);
                    currentSize += chunk.byteLength;
                    offset++;
                }
                
                // Create and download this part
                const partBlob = new Blob(partChunks, { type: 'application/octet-stream' });
                const fileName = transfer.fileName;
                const baseName = fileName.substring(0, fileName.lastIndexOf('.')) || fileName;
                const extension = fileName.substring(fileName.lastIndexOf('.')) || '';
                const partFileName = `${baseName}.part${partNumber}${extension}`;
                
                console.log(`[P2P] Downloading part ${partNumber}: ${partBlob.size} bytes`);
                this.triggerDownload(partBlob, partFileName);
                
                partNumber++;
                
                // Download next part after a delay (2 seconds between parts)
                setTimeout(downloadNextPart, 2000);
            };
            
            // Start downloading parts
            downloadNextPart();
            
        } catch (error) {
            console.error('[P2P] Emergency download also failed:', error);
            this.showToast('Download failed. Please try a smaller file.', 'error');
        }
    }

    async saveFileToDownloads(blob, fileName) {
        const fileSizeMB = blob.size / (1024 * 1024);
        console.log(`[P2P] Saving file: ${fileName} (${fileSizeMB.toFixed(2)} MB)`);
        
        try {
            // For very large files on mobile, use File System Access API if available
            // This is more reliable for large files as it streams to disk
            if ('showSaveFilePicker' in window && fileSizeMB > 100) {
                console.log('[P2P] Large file detected, attempting File System Access API...');
                try {
                    const handle = await window.showSaveFilePicker({
                        suggestedName: fileName,
                        types: [{
                            description: 'File',
                            accept: { [blob.type || '*/*']: [this.getFileExtension(fileName)] }
                        }]
                    });
                    
                    console.log('[P2P] Writing file to disk in chunks...');
                    const writable = await handle.createWritable();
                    
                    // Write in chunks for large files to avoid memory issues
                    const chunkSize = 10 * 1024 * 1024; // 10MB chunks
                    let offset = 0;
                    
                    while (offset < blob.size) {
                        const chunk = blob.slice(offset, offset + chunkSize);
                        await writable.write(chunk);
                        offset += chunkSize;
                        
                        const progress = Math.min(100, (offset / blob.size) * 100);
                        console.log(`[P2P] Writing to disk: ${progress.toFixed(1)}%`);
                    }
                    
                    await writable.close();
                    console.log('[P2P] ✅ File saved successfully using File System Access API');
                    return; // Success, exit
                } catch (fsError) {
                    if (fsError.name === 'AbortError') {
                        console.log('[P2P] User cancelled save dialog');
                        this.showToast('Download cancelled by user', 'info');
                        return; // User cancelled, don't fallback
                    }
                    console.log('[P2P] File System Access failed, using fallback:', fsError.message);
                }
            }
            
            // Fallback to traditional download method
            console.log('[P2P] Using traditional download method');
            
            // For mobile browsers with large files, warn user
            if (fileSizeMB > 500 && this.isMobileBrowser()) {
                this.showToast('Large file - download may take a moment...', 'warning');
            }
            
            this.triggerDownload(blob, fileName);
        } catch (error) {
            console.error('[P2P] Error saving file:', error);
            
            // Check if it's a memory error
            if (error.message && (error.message.includes('memory') || error.message.includes('quota'))) {
                console.log('[P2P] Memory error detected, attempting emergency chunked download');
                throw error; // Let completeFileReceive catch this and use emergencyChunkedDownload
            }
            
            // Last resort - still try to download
            this.triggerDownload(blob, fileName);
        }
    }
    
    isMobileBrowser() {
        return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    }

    triggerDownload(blob, fileName) {
        console.log(`[P2P] 💾 Triggering download for: ${fileName} (${(blob.size / (1024 * 1024)).toFixed(2)} MB)`);
        
        try {
            // Force download by using application/octet-stream
            const downloadBlob = new Blob([blob], { type: 'application/octet-stream' });
            const url = URL.createObjectURL(downloadBlob);
            
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            a.style.display = 'none';
            a.style.position = 'fixed';
            a.style.left = '-9999px';
            
            // Multiple attributes to ensure download
            a.setAttribute('download', fileName);
            
            // CRITICAL: Don't use target="_blank" on mobile - causes navigation issues
            // Don't use target at all to prevent any navigation
            a.rel = 'noopener noreferrer';
            
            document.body.appendChild(a);
            
            console.log(`[P2P] Download element created and added to DOM`);
            
            // Prevent any navigation events
            a.addEventListener('click', (e) => {
                console.log('[P2P] Download link clicked, preventing navigation...');
                // Don't prevent default - we need the download to work
                // But stop propagation to prevent any parent handlers
                e.stopPropagation();
                e.stopImmediatePropagation();
            }, { once: true, capture: true });
            
            // Use setTimeout to ensure the element is in the DOM
            setTimeout(() => {
                try {
                    console.log('[P2P] Triggering download click...');
                    
                    // Create and dispatch a proper mouse event
                    const clickEvent = new MouseEvent('click', {
                        view: window,
                        bubbles: false,
                        cancelable: true
                    });
                    
                    a.dispatchEvent(clickEvent);
                    console.log('[P2P] ✅ Download triggered successfully');
                    
                    // Show success message
                    this.showToast('Download started! Check your downloads folder.', 'success');
                } catch (error) {
                    console.error('[P2P] ❌ Error triggering download:', error);
                    this.showToast('Download failed. Please try again.', 'error');
                }
                
                // Clean up after a longer delay for large files
                // On mobile, keep the element longer to ensure download completes
                const cleanupDelay = this.isMobileBrowser() 
                    ? (blob.size > 100 * 1024 * 1024 ? 10000 : 5000)
                    : (blob.size > 100 * 1024 * 1024 ? 5000 : 1000);
                    
                console.log(`[P2P] Will cleanup in ${cleanupDelay}ms`);
                    
                setTimeout(() => {
                    if (document.body.contains(a)) {
                        document.body.removeChild(a);
                        console.log('[P2P] Download element removed from DOM');
                    }
                    URL.revokeObjectURL(url);
                    console.log('[P2P] Blob URL revoked');
                }, cleanupDelay);
            }, 150);
        } catch (error) {
            console.error('[P2P] ❌ Fatal error in triggerDownload:', error);
            this.showToast('Download failed: ' + error.message, 'error');
        }
    }

    getFileExtension(fileName) {
        const parts = fileName.split('.');
        return parts.length > 1 ? '.' + parts[parts.length - 1] : '';
    }

    createProgressUI(transferId, fileName) {
        console.log(`[P2P] 🎨 Creating progress UI for ${fileName}, transferId: ${transferId}`);
        
        const progressContainer = document.createElement('div');
        progressContainer.id = `progress-${transferId}`;
        progressContainer.className = 'download-progress';
        progressContainer.innerHTML = `
            <div class="progress-header">
                <span class="progress-filename">📥 ${fileName}</span>
                <span class="progress-percentage">0%</span>
            </div>
            <div class="progress-bar-container">
                <div class="progress-bar" style="width: 0%"></div>
            </div>
            <div class="progress-details">
                <span class="progress-speed">Speed: calculating...</span>
                <span class="progress-remaining">ETA: calculating...</span>
            </div>
        `;

        // Add to UI - create progress list if it doesn't exist
        let progressList = document.getElementById('downloadProgress');
        if (!progressList) {
            console.log('[P2P] 🎨 Progress list not found, creating new one...');
            // Create progress list container
            progressList = document.createElement('div');
            progressList.id = 'downloadProgress';
            progressList.className = 'download-progress-list';
            progressList.style.display = 'block';
            
            // Add title
            const title = document.createElement('h3');
            title.textContent = 'Downloads';
            progressList.appendChild(title);
            
            // Try multiple insertion strategies
            const availableFiles = document.getElementById('availableFiles');
            const clientMode = document.getElementById('clientMode');
            
            if (availableFiles && availableFiles.parentNode) {
                // Insert after available files
                if (availableFiles.nextSibling) {
                    availableFiles.parentNode.insertBefore(progressList, availableFiles.nextSibling);
                } else {
                    availableFiles.parentNode.appendChild(progressList);
                }
                console.log('[P2P] ✅ Progress list added after availableFiles');
            } else if (clientMode) {
                // Fallback: append to client mode
                clientMode.appendChild(progressList);
                console.log('[P2P] ✅ Progress list added to clientMode');
            } else {
                // Last resort: append to body
                document.body.appendChild(progressList);
                console.log('[P2P] ⚠️ Progress list added to body (fallback)');
            }
        } else {
            console.log('[P2P] ✅ Progress list already exists, reusing it');
        }
        
        progressList.style.display = 'block';
        progressList.appendChild(progressContainer);
        console.log(`[P2P] ✅ Progress UI created and added! Element ID: progress-${transferId}`);
        console.log(`[P2P] 📊 Progress element exists in DOM:`, document.getElementById(`progress-${transferId}`) !== null);
    }

    updateProgressUI(transferId, progress, speed, remaining) {
        const progressElement = document.getElementById(`progress-${transferId}`);
        if (!progressElement) {
            console.error(`[P2P] ❌ Progress element not found for transfer ${transferId}`);
            console.log(`[P2P] 🔍 Looking for element: progress-${transferId}`);
            console.log(`[P2P] 🔍 Available progress elements:`, 
                Array.from(document.querySelectorAll('[id^="progress-"]')).map(el => el.id));
            return;
        }

        // Update percentage
        const percentageEl = progressElement.querySelector('.progress-percentage');
        if (percentageEl) {
            percentageEl.textContent = `${progress}%`;
        } else {
            console.warn(`[P2P] ⚠️ Percentage element not found`);
        }
        
        // Update progress bar
        const barEl = progressElement.querySelector('.progress-bar');
        if (barEl) {
            barEl.style.width = `${progress}%`;
        } else {
            console.warn(`[P2P] ⚠️ Progress bar element not found`);
        }
        
        // Update speed
        const speedText = speed > 1024 * 1024 
            ? `${(speed / (1024 * 1024)).toFixed(2)} MB/s`
            : `${(speed / 1024).toFixed(2)} KB/s`;
        const speedEl = progressElement.querySelector('.progress-speed');
        if (speedEl) {
            speedEl.textContent = `Speed: ${speedText}`;
        }
        
        // Update remaining time
        const remainingText = remaining > 60 
            ? `${Math.floor(remaining / 60)}m ${Math.floor(remaining % 60)}s`
            : `${Math.floor(remaining)}s`;
        const etaEl = progressElement.querySelector('.progress-remaining');
        if (etaEl) {
            etaEl.textContent = `ETA: ${remainingText}`;
        }
        
        // Log progress updates
        if (progress % 10 === 0 || progress < 10) {
            console.log(`[P2P] 📊 Progress updated: ${progress}%, ${speedText}, ETA: ${remainingText}`);
        }
    }

    removeProgressUI(transferId) {
        const progressElement = document.getElementById(`progress-${transferId}`);
        if (progressElement) {
            progressElement.style.animation = 'slideOut 0.3s ease-in forwards';
            setTimeout(() => {
                if (progressElement.parentNode) {
                    progressElement.parentNode.removeChild(progressElement);
                }
            }, 300);
        }
    }

    // ==================== QR Scanner ====================

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

    // ==================== Utility Methods ====================

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
    
    .p2p-btn {
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        border: none;
        color: white;
    }
    
    .p2p-btn:hover {
        background: linear-gradient(135deg, #764ba2 0%, #667eea 100%);
    }
    
    .download-progress-list {
        margin-top: 20px;
        padding: 20px;
        background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
        border-radius: 12px;
        box-shadow: 0 4px 15px rgba(0,0,0,0.1);
    }
    
    .download-progress-list h3 {
        color: #2c3e50;
        font-size: 18px;
        font-weight: 600;
        margin: 0 0 15px 0;
        display: flex;
        align-items: center;
    }
    
    .download-progress-list h3:before {
        content: "⬇️";
        margin-right: 8px;
        font-size: 20px;
    }
    
    .download-progress {
        background: white;
        border-radius: 8px;
        padding: 18px;
        margin-bottom: 12px;
        box-shadow: 0 3px 12px rgba(0,0,0,0.15);
        animation: slideIn 0.3s ease-out;
        border-left: 4px solid #667eea;
    }
    
    .progress-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 10px;
    }
    
    .progress-filename {
        font-weight: 600;
        color: #2c3e50;
        font-size: 15px;
    }
    
    .progress-percentage {
        font-weight: bold;
        color: #667eea;
        font-size: 18px;
        background: #e8eaf6;
        padding: 4px 10px;
        border-radius: 4px;
    }
    
    .progress-bar-container {
        width: 100%;
        height: 8px;
        background: #e0e0e0;
        border-radius: 4px;
        overflow: hidden;
        margin-bottom: 8px;
    }
    
    .progress-bar {
        height: 100%;
        background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
        border-radius: 4px;
        transition: width 0.3s ease;
        position: relative;
        overflow: hidden;
    }
    
    .progress-bar::after {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        bottom: 0;
        right: 0;
        background: linear-gradient(
            90deg,
            transparent,
            rgba(255, 255, 255, 0.3),
            transparent
        );
        animation: shimmer 2s infinite;
    }
    
    @keyframes shimmer {
        0% { transform: translateX(-100%); }
        100% { transform: translateX(100%); }
    }
    
    .progress-details {
        display: flex;
        justify-content: space-between;
        font-size: 12px;
        color: #666;
    }
    
    .progress-speed, .progress-remaining {
        font-family: monospace;
    }
    
    .p2p-controls {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 15px;
        padding: 15px;
        background: #f8f9fa;
        border-radius: 8px;
        margin: 20px 0;
    }
    
    .p2p-status {
        font-weight: 600;
        font-size: 14px;
        padding: 8px 16px;
        border-radius: 6px;
        display: inline-block;
    }
    
    .p2p-status.status-connected {
        background: #d4edda;
        color: #155724;
    }
    
    .p2p-status.status-connecting {
        background: #d1ecf1;
        color: #0c5460;
        animation: pulse 1.5s ease-in-out infinite;
    }
    
    .p2p-status.status-disconnected {
        background: #fff3cd;
        color: #856404;
    }
    
    .p2p-status.status-failed {
        background: #f8d7da;
        color: #721c24;
    }
    
    .p2p-status.status-unknown {
        background: #e2e3e5;
        color: #383d41;
    }
    
    @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.6; }
    }
    
    .btn.warning {
        background: #ff9800;
        color: white;
        border: none;
        padding: 10px 20px;
        border-radius: 6px;
        cursor: pointer;
        font-weight: 600;
        transition: all 0.3s ease;
    }
    
    .btn.warning:hover {
        background: #f57c00;
        transform: translateY(-2px);
        box-shadow: 0 4px 12px rgba(255, 152, 0, 0.3);
    }
    
    .btn.warning:active {
        transform: translateY(0);
    }
`;
document.head.appendChild(style);