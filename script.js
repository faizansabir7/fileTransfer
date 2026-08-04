class LocalFileShare {
    constructor() {
        this.isHost = true;
        this.files = new Map(); // Store File objects in memory
        this.peerConnections = new Map(); // Map of peerId -> RTCPeerConnection
        this.dataChannels = new Map(); // Map of peerId -> RTCDataChannel
        this.serverUrl = '';
        this.currentHostUrl = null;
        this.peerId = null; // Set after registration (host) or on mode switch (client)
        this.signalingPollInterval = null;
        this.isPolling = false;

        // Host-mode state
        this.hostId = null;             // Set after register-host
        this.heartbeatInterval = null;  // Keeps host alive in server registry

        // Client-mode state
        this.currentTargetHostId = null; // hostId of the host we're connected to

        // File transfer state
        // Receiver side: one active transfer at a time (data channel is ordered,
        // so interleaved transfers would corrupt) + a queue of pending downloads.
        this.receiveState = { active: null, queue: [] };
        // Host side: serialize sends per peer + flow-control state per transfer
        this.sendQueues = new Map();  // peerId -> [{fileId, transferId}]
        this.sendActive = new Set();  // peerIds with a send loop running
        this.sendStates = new Map();  // transferId -> {acked, aborted, ackWaiter}
        this.channelWaiters = new Map(); // peerId -> [{resolve, reject}] waiting for channel open
        this.swKeepaliveTimer = null;
        this.fastPollUntil = 0; // poll signaling fast while negotiation is active
        this.wakeLock = null;   // screen wake lock during transfers (phones)

        // Keep-alive intervals for connections
        this.keepAliveIntervals = new Map(); // Map of peerId -> interval

        // Reconnection state
        this.reconnecting = new Set(); // Set of peerIds currently reconnecting

        this.init();
    }

    async init() {
        this.setupEventListeners();
        this._cleanupOpfsLeftovers(); // remove staged downloads from crashed sessions

        // Phones drop the wake lock when the tab is hidden — re-acquire on return
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && this.receiveState.active) {
                this._acquireWakeLock();
            }
        });

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

        // Host name setup
        document.getElementById('startHostingBtn').addEventListener('click', () => this.startHosting());
        document.getElementById('hostName').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.startHosting();
        });
        document.getElementById('hostName').addEventListener('input', () => {
            this.setHostSetupStatus('', '');
        });
        document.getElementById('stopHostingBtn').addEventListener('click', () => this.stopHosting());

        // File upload (inside hostingActive section)
        const fileInput = document.getElementById('fileInput');
        const uploadArea = document.getElementById('uploadArea');

        fileInput.addEventListener('change', (e) => this.handleFiles(e.target.files));

        // Fallback for browsers where the invisible file-input overlay doesn't
        // receive the tap (the overlay handles it natively everywhere else).
        uploadArea.addEventListener('click', (e) => {
            if (e.target !== fileInput) fileInput.click();
        });

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

        // Connect button (manual form)
        document.getElementById('connectBtn').addEventListener('click', () => this.connectToHost());

        // QR Scanner
        document.getElementById('scanBtn').addEventListener('click', () => this.openQRScanner());
        document.querySelector('.close').addEventListener('click', () => this.closeQRScanner());

        // P2P Reset button
        document.getElementById('resetP2PBtn').addEventListener('click', () => this.resetP2PConnection());

        // Host discovery
        document.getElementById('refreshHostsBtn').addEventListener('click', () => this.discoverHosts());

        // Toggle manual connect form
        document.getElementById('toggleManualBtn').addEventListener('click', () => {
            const form = document.getElementById('manualConnectForm');
            const btn = document.getElementById('toggleManualBtn');
            const isHidden = form.style.display === 'none' || form.style.display === '';
            form.style.display = isHidden ? 'block' : 'none';
            btn.textContent = isHidden ? 'Hide manual connect' : 'Enter URL manually';
        });

        // Service Worker: offline cache + streaming downloads to disk
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
                .then((reg) => reg.update().catch(() => {}))
                .catch(console.error);
        }
    }

    switchMode(isHost) {
        // If leaving host mode, deregister
        if (!isHost && this.isHost && this.hostId) {
            this.stopHosting();
        }

        this.isHost = isHost;

        if (!isHost) {
            this.peerId = this.generatePeerId();
        }
        // Host peerId is set later by startHosting() after server registration

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
            const response = await fetch('/api/network-info');
            const data = await response.json();
            // Prefer HTTPS URL — required for WebRTC in Safari/iOS
            this.serverUrl = data.https_url || data.server_url;
            this.httpsUrl  = data.https_url || null;
            this.updateNetworkStatus('Connected to local network', 'success');
            console.log('[Network] Server URL:', this.serverUrl, '| HTTPS:', this.httpsUrl);
        } catch (error) {
            console.error('[Network] Error detecting network info:', error);
            this.updateNetworkStatus('Network detection failed - using localhost', 'error');
            this.serverUrl = 'http://localhost:8080';
            this.httpsUrl  = null;
        }
    }

    updateNetworkStatus(message, type = 'info') {
        const statusEl = document.getElementById('networkStatus');
        const urlEl    = document.getElementById('serverUrl');

        statusEl.textContent = message;
        statusEl.className = `status-message ${type}`;

        if (this.serverUrl) {
            let text = `Share URL: ${this.serverUrl}`;
            if (this.httpsUrl) {
                text += ' (HTTPS — required for Safari)';
            }
            urlEl.textContent = text;
        }
    }

    async startHostMode() {
        // Show name setup; don't start signaling until user clicks "Start Hosting"
        document.getElementById('hostNameSetup').style.display = 'block';
        document.getElementById('hostingActive').style.display = 'none';
        this.updateNetworkStatus('Enter your name to start hosting', 'info');

        // Pre-fill saved name if available
        const saved = localStorage.getItem('hostName');
        if (saved) document.getElementById('hostName').value = saved;
    }

    setHostSetupStatus(msg, type = 'info') {
        const el = document.getElementById('hostSetupStatus');
        if (el) { el.textContent = msg; el.className = `setup-status ${type}`; }
    }

    async startHosting() {
        const nameInput = document.getElementById('hostName');
        const btn = document.getElementById('startHostingBtn');
        const name = nameInput.value.trim();

        if (!name) {
            nameInput.focus();
            this.setHostSetupStatus('Please enter a name first.', 'error');
            return;
        }

        // Show loading state
        btn.disabled = true;
        btn.textContent = 'Starting...';
        this.setHostSetupStatus('Registering with server...', 'info');

        try {
            const res = await fetch('/api/register-host', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({name})
            });

            if (!res.ok) {
                throw new Error(`Server returned ${res.status} — make sure you restarted the server`);
            }

            const data = await res.json();

            if (!data.hostId) {
                throw new Error('Server did not return a host ID');
            }

            this.hostId = data.hostId;
            this.peerId = data.hostId;
            localStorage.setItem('hostName', name);

            // Show hosting-active section
            document.getElementById('hostNameSetup').style.display = 'none';
            document.getElementById('hostingActive').style.display = 'block';
            document.getElementById('hostingNameDisplay').textContent = name;

            this.updateNetworkStatus(`Hosting as "${name}"`, 'success');
            this.updateShareInfo();
            this.startSignalingPoll();
            this.startHeartbeat();

        } catch (err) {
            this.setHostSetupStatus(`Error: ${err.message}`, 'error');
            btn.disabled = false;
            btn.textContent = 'Start Hosting';
        }
    }

    stopHosting() {
        if (this.hostId) {
            fetch(`/api/deregister-host/${this.hostId}`, {method: 'DELETE'}).catch(() => {});
            this.hostId = null;
        }
        this.peerId = null;
        this.stopSignalingPoll();
        this.stopHeartbeat();

        // Reset host UI
        document.getElementById('hostingActive').style.display = 'none';
        document.getElementById('hostNameSetup').style.display = 'block';
        document.getElementById('fileList').innerHTML = '';
        document.getElementById('shareInfo').style.display = 'none';
        this.files.clear();
        this.updateNetworkStatus('Enter your name to start hosting', 'info');
    }

    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatInterval = setInterval(() => {
            if (this.hostId) {
                fetch('/api/heartbeat', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({hostId: this.hostId})
                }).catch(() => {});
            }
        }, 15000);
    }

    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    startClientMode() {
        this.stopSignalingPoll();
        this.currentTargetHostId = null;
        this.updateNetworkStatus('Ready to connect to a host', 'info');
        document.getElementById('connectionStatus').innerHTML = '';
        document.getElementById('availableFiles').innerHTML = '';
        document.getElementById('p2pControls').style.display = 'none';
        this.discoverHosts();
    }

    async discoverHosts() {
        const hostsList = document.getElementById('hostsList');
        if (!hostsList) return;

        hostsList.innerHTML = '<div class="discovering">Searching for hosts...</div>';

        try {
            const response = await fetch('/api/hosts');
            if (!response.ok) throw new Error('Failed to fetch hosts');
            const data = await response.json();

            hostsList.innerHTML = '';

            if (!data.hosts || data.hosts.length === 0) {
                hostsList.innerHTML = '<div class="no-hosts">No hosts found. Switch another device to Host mode first.</div>';
                return;
            }

            data.hosts.forEach(hostInfo => {
                const card = document.createElement('div');
                card.className = 'host-card';
                const fileLabel = hostInfo.files_count === 1 ? '1 file' : `${hostInfo.files_count} files`;
                card.innerHTML = `
                    <div class="host-status-dot"></div>
                    <div class="host-card-info">
                        <div class="host-name">${this._escapeHtml(hostInfo.name)}</div>
                        <div class="host-details">${hostInfo.ip} &middot; ${fileLabel} shared</div>
                    </div>
                    <button class="btn host-connect-btn">Connect</button>
                `;
                card.querySelector('.host-connect-btn').addEventListener('click', () => {
                    this.connectToHost(hostInfo.server_url, hostInfo.hostId);
                });
                hostsList.appendChild(card);
            });
        } catch (error) {
            hostsList.innerHTML = '<div class="no-hosts">No hosts found. Make sure a device is running as Host on your network.</div>';
        }
    }

    _escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
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
                type: file.type,
                hostId: this.hostId || ''
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
                <div class="file-name">${this._escapeHtml(file.name)}</div>
                <div class="file-size">${this.formatFileSize(file.size)}</div>
            </div>
            <div class="file-actions">
                <button class="btn danger">Remove</button>
            </div>
        `;
        item.querySelector('.btn.danger').addEventListener('click', () => this.removeFile(fileId));
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
                    // toCanvas needs an actual <canvas>, not the container div
                    const canvas = document.createElement('canvas');
                    qrCode.appendChild(canvas);
                    QRCode.toCanvas(canvas, this.serverUrl, {
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

        // Adaptive polling: 400ms while a negotiation is active (fast ICE
        // exchange), 2.5s when idle (cheap on the signaling server).
        const loop = async () => {
            if (!this.isPolling) return;
            await this.pollSignaling();
            if (!this.isPolling) return;
            const delay = Date.now() < this.fastPollUntil ? 400 : 2500;
            this.signalingPollInterval = setTimeout(loop, delay);
        };
        loop();
    }

    stopSignalingPoll() {
        if (this.signalingPollInterval) {
            clearTimeout(this.signalingPollInterval);
            this.signalingPollInterval = null;
        }
        this.isPolling = false;
    }

    bumpFastPoll() {
        this.fastPollUntil = Date.now() + 30000;
    }

    async pollSignaling() {
        if (!this.peerId) return; // Not registered yet
        try {
            const response = await fetch(`/api/signal?peerId=${encodeURIComponent(this.peerId)}`);
            if (response.ok) {
                const data = await response.json();
                if (data.messages && data.messages.length > 0) {
                    this.bumpFastPoll(); // negotiation in progress — poll fast
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
            this.bumpFastPoll(); // we expect a reply — poll fast for a while
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
            ],
            iceTransportPolicy: 'all',
            sdpSemantics: 'unified-plan', // Required for Safari compatibility
            // Note: iceCandidatePoolSize removed — breaks Safari
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

        const onOpen = () => {
            console.log(`[P2P] ✅ Data channel opened with ${peerId}, readyState: ${dataChannel.readyState}`);
            this.dataChannels.set(peerId, dataChannel);
            this.showToast('Data channel ready for file transfer!', 'success');

            // Wake up anyone awaiting this channel (ensureP2P)
            const waiters = this.channelWaiters.get(peerId);
            if (waiters) {
                this.channelWaiters.delete(peerId);
                waiters.forEach(w => w.resolve(dataChannel));
            }

            // Update P2P status display
            this.updateP2PStatus();
        };

        // Safari: ondatachannel fires when channel is already open, so onopen never fires
        if (dataChannel.readyState === 'open') {
            onOpen();
        } else {
            dataChannel.onopen = onOpen;
        }

        dataChannel.onclose = () => {
            console.log(`[P2P] Data channel closed with ${peerId}`);
            // Only clear the mapping if it still points at THIS channel — a
            // reconnect may already have installed a fresh one under this key
            if (this.dataChannels.get(peerId) === dataChannel) {
                this.dataChannels.delete(peerId);

                // Active download interrupted → resume instead of failing
                const t = this.receiveState.active;
                if (t && !t.failed && !this.isHost && peerId === this.currentTargetHostId) {
                    setTimeout(() => this._attemptResume(t, 'connection lost'), 500);
                }
            }

            // Update P2P status display
            this.updateP2PStatus();
        };

        dataChannel.onerror = (error) => {
            console.error(`[P2P] Data channel error:`, error);
        };

        dataChannel.onmessage = (event) => {
            this.handleDataChannelMessage(peerId, event);
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
                        if (!candidate || !candidate.candidate) continue;
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
                
                // Skip end-of-candidates markers — Safari throws on empty candidate string
                if (!candidate || !candidate.candidate) {
                    console.log('[P2P] 🧊 Skipping end-of-candidates marker');
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

    async lookupHostId(url) {
        try {
            const base = url.endsWith('/') ? url.slice(0, -1) : url;
            const res = await fetch(`${base}/api/hosts`);
            if (!res.ok) return null;
            const data = await res.json();
            if (data.hosts && data.hosts.length > 0) return data.hosts[0].hostId;
            return null;
        } catch (e) {
            return null;
        }
    }

    async connectToHost(url = null, hostId = null) {
        const hostUrl = url || document.getElementById('hostUrl').value.trim();
        if (!hostUrl) {
            this.showConnectionStatus('Please enter a host URL', 'error');
            return;
        }

        // Resolve hostId if not provided (manual URL entry)
        let targetHostId = hostId;
        if (!targetHostId) {
            this.showConnectionStatus('Looking up host...', 'info');
            targetHostId = await this.lookupHostId(hostUrl);
            if (!targetHostId) {
                this.showConnectionStatus('No active host found at that URL', 'error');
                return;
            }
        }
        this.currentTargetHostId = targetHostId;

        this.showConnectionStatus('Connecting...', 'info');
        this.currentHostUrl = hostUrl;
        this._relayInfo = undefined; // re-probe relay capability per host

        try {
            // Clean up ALL existing P2P connections (force complete fresh start)
            console.log('[P2P] Cleaning up all existing connections for fresh start...');
            Array.from(this.peerConnections.keys()).forEach(pid => this.teardownPeer(pid));

            // Generate NEW client peer ID to avoid signaling conflicts
            this.peerId = this.generatePeerId();
            this.stopSignalingPoll();

            const hostPeerId = targetHostId;

            // Test connection to server
            const testUrl = hostUrl.endsWith('/') ? hostUrl + 'api/files' : hostUrl + '/api/files';
            const response = await fetch(`${testUrl}?hostId=${encodeURIComponent(hostPeerId)}`);

            if (response.ok) {
                this.showConnectionStatus('Connected to server, establishing P2P...', 'info');

                // Load available files
                await this.loadAvailableFiles();

                // Show P2P controls
                document.getElementById('p2pControls').style.display = 'flex';

                // Establish P2P with automatic retries
                await this.ensureP2P(hostPeerId);
                this.showConnectionStatus('Connected — P2P ready', 'success');
                this.showToast('P2P connection established!', 'success');
            } else {
                throw new Error(`Server responded with ${response.status}`);
            }
        } catch (error) {
            this.showConnectionStatus('Connection failed: ' + error.message, 'error');
        }
    }
    
    async resetP2PConnection() {
        const hostPeerId = this.currentTargetHostId;
        if (!hostPeerId) {
            this.showToast('No active connection to reset', 'error');
            return;
        }
        console.log('[P2P] Manual reset requested');
        this.showToast('Resetting P2P connection...', 'info');

        // Clean up ALL peer connections and reconnect with a fresh peer ID
        Array.from(this.peerConnections.keys()).forEach(pid => this.teardownPeer(pid));
        this.peerId = this.generatePeerId();
        this.stopSignalingPoll();

        try {
            await this.ensureP2P(hostPeerId);
            this.showToast('P2P connection re-established!', 'success');
        } catch (error) {
            console.error('[P2P] Reset failed:', error);
            this.showToast('Reset failed: ' + error.message, 'error');
        }
    }
    
    updateP2PStatus(status) {
        const statusEl = document.getElementById('p2pStatus');
        if (!statusEl) return;

        const hostPeerId = this.currentTargetHostId;
        const pc = hostPeerId ? this.peerConnections.get(hostPeerId) : null;
        const dc = hostPeerId ? this.dataChannels.get(hostPeerId) : null;
        
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
        const statusTexts = {
            'connected': 'P2P Connected',
            'connecting': 'P2P Connecting...',
            'disconnected': 'P2P Disconnected',
            'failed': 'P2P Failed',
            'unknown': 'P2P Status Unknown'
        };

        statusEl.textContent = statusTexts[status] || 'P2P Status Unknown';
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

            // Create offer — pass explicit constraints for Safari compatibility
            const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
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
            // Fetch files for the specific host we're connecting to
            const base = this.currentHostUrl
                ? (this.currentHostUrl.endsWith('/') ? this.currentHostUrl.slice(0,-1) : this.currentHostUrl)
                : '';
            const hostParam = this.currentTargetHostId ? `?hostId=${encodeURIComponent(this.currentTargetHostId)}` : '';
            const filesUrl = `${base}/api/files${hostParam}`;

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
                            <div class="file-name">${this._escapeHtml(file.name)}</div>
                            <div class="file-size">${this.formatFileSize(file.size)}</div>
                        </div>
                        <button class="download-btn p2p-btn">Download</button>
                    `;
                    // addEventListener instead of inline onclick — filenames with
                    // quotes would break an inline handler string
                    fileItem.querySelector('.download-btn').addEventListener('click', () => {
                        this.downloadFileP2P(file.id, file.name, file.size);
                    });
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

    // ── Connection helpers ─────────────────────────────────────────────────

    teardownPeer(peerId) {
        const pc = this.peerConnections.get(peerId);
        if (pc) { try { pc.close(); } catch (e) {} }
        this.peerConnections.delete(peerId);
        this.dataChannels.delete(peerId);
        this.stopKeepAlive(peerId);
        this.reconnecting.delete(peerId);
        const waiters = this.channelWaiters.get(peerId);
        if (waiters) {
            this.channelWaiters.delete(peerId);
            waiters.forEach(w => w.reject(new Error('Connection torn down')));
        }
    }

    waitForChannel(peerId, timeoutMs) {
        const existing = this.dataChannels.get(peerId);
        if (existing && existing.readyState === 'open') return Promise.resolve(existing);

        return new Promise((resolve, reject) => {
            const waiter = {};
            const timer = setTimeout(() => {
                const list = this.channelWaiters.get(peerId);
                if (list) {
                    const i = list.indexOf(waiter);
                    if (i !== -1) list.splice(i, 1);
                }
                reject(new Error('Timed out waiting for data channel'));
            }, timeoutMs);
            waiter.resolve = (dc) => { clearTimeout(timer); resolve(dc); };
            waiter.reject = (err) => { clearTimeout(timer); reject(err); };
            const list = this.channelWaiters.get(peerId) || [];
            list.push(waiter);
            this.channelWaiters.set(peerId, list);
        });
    }

    // Get an open data channel to the host, retrying with a fresh connection
    // (and fresh peer ID) if negotiation stalls or fails.
    async ensureP2P(hostPeerId) {
        let dc = this.dataChannels.get(hostPeerId);
        if (dc && dc.readyState === 'open') return dc;

        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                this.updateP2PStatus('connecting');
                if (attempt > 0) {
                    console.log(`[P2P] Retry ${attempt}: reconnecting with fresh peer ID`);
                    this.teardownPeer(hostPeerId);
                    this.peerId = this.generatePeerId();
                    await new Promise(r => setTimeout(r, 600));
                }
                await this.initiateP2PConnection(hostPeerId);
                dc = await this.waitForChannel(hostPeerId, 15000);
                this.updateP2PStatus('connected');
                return dc;
            } catch (e) {
                console.warn(`[P2P] Connection attempt ${attempt + 1} failed:`, e.message);
            }
        }
        this.updateP2PStatus('failed');
        throw new Error('Could not establish P2P connection');
    }

    // ── Download sinks ─────────────────────────────────────────────────────
    // A sink receives chunks and puts them somewhere safe. Preference order:
    //   1. Service worker stream → native browser download, direct to disk,
    //      no size limit (Chrome/Firefox/Edge/Android, needs HTTPS).
    //      NOT on WebKit: Safari buffers SW-streamed downloads in RAM and iOS
    //      kills the whole browser around ~0.5 GB — the crash this avoids.
    //   2. File System Access API → save dialog, streams to disk (Chrome/Edge)
    //   3. OPFS staging → chunks go to disk-backed browser storage via a
    //      worker, finished file is handed to the download manager at the end
    //      (this is the Safari/iPhone path)
    //   4. In-memory Blob → last resort, limited by RAM

    async createSink(transferId, fileName, fileSize) {
        // All iOS browsers + macOS Safari report an Apple vendor. WebKit
        // buffers SW-streamed downloads in RAM, so allow the direct path
        // there only up to a safe size — bigger files went to the relay
        // in startReceive, or fall through to staging below.
        const isWebKit = /^Apple/i.test(navigator.vendor || '');
        const swAllowed = !isWebKit || (fileSize > 0 && fileSize <= 400 * 1024 * 1024);

        if (swAllowed) {
            try {
                const sink = await this._createSwSink(transferId, fileName, fileSize);
                if (sink) return sink;
            } catch (e) {
                console.warn('[DL] Service worker streaming unavailable:', e.message);
            }
        }

        try {
            const sink = await this._createFsSink(fileName);
            if (sink) return sink;
        } catch (e) {
            if (e.name === 'AbortError') throw e; // user cancelled the save dialog
            console.warn('[DL] File System Access unavailable:', e.message);
        }

        try {
            const sink = await this._createOpfsSink(transferId, fileName, fileSize);
            if (sink) return sink;
        } catch (e) {
            console.warn('[DL] OPFS staging unavailable:', e.message);
        }

        const sizeMB = (fileSize || 0) / (1024 * 1024);
        if (sizeMB > 500) {
            this.showToast(
                `${Math.round(sizeMB)} MB won't fit in this browser's memory reliably. ` +
                `Free up device storage or update your browser, then retry.`,
                'warning'
            );
        }
        return this._createMemorySink(fileName);
    }

    async _createSwSink(transferId, fileName, fileSize) {
        if (!('serviceWorker' in navigator)) return null;
        const ctrl = navigator.serviceWorker.controller;
        if (!ctrl) return null; // SW not controlling this page (first load / HTTP)

        const mc = new MessageChannel();
        const port = mc.port1;
        const state = { ackResolve: null, canceled: false };

        let readyResolve, readyReject, startedResolve, startedReject;
        const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
        const started = new Promise((res, rej) => { startedResolve = res; startedReject = rej; });

        port.onmessage = (ev) => {
            const m = ev.data || {};
            if (m.type === 'ready') readyResolve(m.url);
            else if (m.type === 'started') startedResolve();
            else if (m.type === 'ack' || m.type === 'canceled') {
                if (m.type === 'canceled') state.canceled = true;
                const r = state.ackResolve;
                state.ackResolve = null;
                if (r) r();
            }
        };

        ctrl.postMessage({ type: 'download-init', id: transferId, name: fileName, size: fileSize }, [mc.port2]);

        const readyTimer = setTimeout(() => readyReject(new Error('Service worker did not respond')), 4000);
        const url = await ready;
        clearTimeout(readyTimer);

        // Navigating a hidden iframe to the virtual URL makes the browser
        // treat it as a regular download (shows in the downloads UI).
        const iframe = document.createElement('iframe');
        iframe.hidden = true;
        iframe.src = url;
        document.body.appendChild(iframe);

        const startTimer = setTimeout(() => startedReject(new Error('Browser did not start the download')), 8000);
        try {
            await started;
        } catch (e) {
            iframe.remove();
            port.postMessage({ type: 'abort' });
            throw e;
        }
        clearTimeout(startTimer);

        this._startSwKeepalive();
        console.log('[DL] Streaming to browser downloads via service worker');

        return {
            mode: 'sw',
            // Each write waits for the SW's ack, which follows disk-drain pace —
            // this is what bounds memory end-to-end.
            write: (chunk) => {
                if (state.canceled) return Promise.reject(new Error('Download canceled in browser'));
                return new Promise((resolve, reject) => {
                    state.ackResolve = () => state.canceled
                        ? reject(new Error('Download canceled in browser'))
                        : resolve();
                    port.postMessage({ type: 'chunk', data: chunk }, [chunk]);
                });
            },
            close: async () => {
                port.postMessage({ type: 'end' });
                setTimeout(() => iframe.remove(), 5000);
            },
            abort: async () => {
                port.postMessage({ type: 'abort' });
                iframe.remove();
            },
        };
    }

    async _createFsSink(fileName) {
        if (!window.showSaveFilePicker) return null;
        const handle = await window.showSaveFilePicker({ suggestedName: fileName });
        const writable = await handle.createWritable();
        console.log('[DL] Streaming to disk via File System Access API');
        return {
            mode: 'fs',
            write: (chunk) => writable.write(chunk),
            close: () => writable.close(),
            abort: () => writable.abort(),
        };
    }

    // OPFS staging: write chunks to origin-private file system (disk, not RAM)
    // through a worker using the synchronous access API (Safari 16.4+, Chrome,
    // Firefox). On completion the disk-backed File is handed to the browser's
    // download manager — memory stays flat no matter the file size.
    async _createOpfsSink(transferId, fileName, fileSize) {
        if (!(navigator.storage && navigator.storage.getDirectory) || typeof Worker === 'undefined') {
            return null;
        }

        // Best-effort quota preflight so a 2 GB transfer doesn't die at 90%
        try {
            const est = await navigator.storage.estimate();
            if (est && est.quota && fileSize && (est.quota - (est.usage || 0)) < fileSize * 1.05) {
                throw new Error(`Not enough browser storage for ${this.formatFileSize(fileSize)} — free up space on this device`);
            }
        } catch (e) {
            if (String(e.message).startsWith('Not enough')) throw e;
            // estimate() itself failed — proceed and let writes surface errors
        }

        // Stage under the real filename (in a per-transfer folder) so the file
        // handed to the share sheet / download carries the right name
        const safeName = fileName.replace(/[\/\\]/g, '_') || 'download';
        const workerUrl = URL.createObjectURL(new Blob([this._opfsWorkerCode()], { type: 'application/javascript' }));
        const worker = new Worker(workerUrl);
        URL.revokeObjectURL(workerUrl);

        // Writes are serialized by the transfer's writeChain, so a single
        // pending request/response slot is enough.
        let pending = null;
        worker.onmessage = (ev) => {
            const m = ev.data || {};
            const p = pending;
            pending = null;
            if (!p) return;
            if (m.type === 'error') p.reject(new Error(m.error));
            else p.resolve(m);
        };
        worker.onerror = (ev) => {
            const p = pending;
            pending = null;
            if (p) p.reject(new Error(ev.message || 'OPFS worker error'));
        };
        const call = (msg, transferables) => new Promise((resolve, reject) => {
            pending = { resolve, reject };
            worker.postMessage(msg, transferables || []);
        });

        try {
            await Promise.race([
                call({ type: 'init', dir: transferId, name: safeName }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('OPFS init timed out')), 8000)),
            ]);
        } catch (e) {
            worker.terminate();
            throw e; // e.g. createSyncAccessHandle unsupported → next fallback
        }

        console.log('[DL] Staging to disk (OPFS) — download appears when transfer completes');
        let offset = 0;

        return {
            mode: 'opfs',
            write: async (chunk) => {
                const at = offset;
                offset += chunk.byteLength;
                await call({ type: 'chunk', data: chunk, offset: at }, [chunk]);
            },
            close: async () => {
                await call({ type: 'close' });
                worker.terminate();

                const handle = await this._getStagedFileHandle(transferId, safeName);
                const file = await handle.getFile();
                // Never hand over a truncated file (silent short writes exist
                // in private browsing / storage-pressure situations)
                if (fileSize && file.size !== fileSize) {
                    throw new Error(`Staged file incomplete (${this.formatFileSize(file.size)} of ${this.formatFileSize(fileSize)}) — device storage may be full`);
                }
                this._offerManualSave(transferId, fileName, file, fileSize);
                return 'manual-save-offered';
            },
            abort: async () => {
                try { await call({ type: 'abort' }); } catch (e) {}
                worker.terminate();
                this._removeStagedDir(transferId);
            },
        };
    }

    async _getStagedFileHandle(transferId, safeName) {
        const root = await navigator.storage.getDirectory();
        const tmp = await root.getDirectoryHandle('dl_tmp', { create: true });
        const dir = await tmp.getDirectoryHandle(transferId, { create: true });
        return dir.getFileHandle(safeName);
    }

    async _removeStagedDir(transferId) {
        try {
            const root = await navigator.storage.getDirectory();
            const tmp = await root.getDirectoryHandle('dl_tmp');
            await tmp.removeEntry(transferId, { recursive: true });
        } catch (e) { /* already gone */ }
    }

    // After an OPFS transfer completes, turn its progress card into a save
    // card. On iOS the primary action is the share sheet ("Save to Files") —
    // blob-URL downloads on WebKit buffer in RAM and die at a few hundred MB,
    // while the share sheet copies the disk-backed file through the OS.
    _offerManualSave(transferId, fileName, file, fileSize) {
        // Wrap to guarantee a proper name/type — a metadata-level reference,
        // not a data copy
        const shareFile = new File([file], fileName, { type: file.type || 'application/octet-stream' });
        const canShare = !!(navigator.share && navigator.canShare &&
                            navigator.canShare({ files: [shareFile] }));
        const isWebKit = /^Apple/i.test(navigator.vendor || '');

        let url = null;
        const getUrl = () => {
            if (!url) url = URL.createObjectURL(shareFile);
            return url;
        };
        const cleanup = () => {
            if (url) { URL.revokeObjectURL(url); url = null; }
            this._removeStagedDir(transferId);
        };

        // Auto-trigger a normal download only where it's reliable: non-WebKit
        // browsers, or small files. Large WebKit blob downloads are the
        // "download failed and cannot be retried" path.
        if (!isWebKit || !fileSize || fileSize < 200 * 1024 * 1024) {
            const a = document.createElement('a');
            a.href = getUrl();
            a.download = fileName;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            setTimeout(() => a.remove(), 5000);
        }

        const el = document.getElementById(`progress-${transferId}`);
        if (!el) {
            setTimeout(cleanup, 15 * 60 * 1000);
            return;
        }

        const hint = canShare
            ? 'Tap "Save to Files" and pick a location — works for any size.'
            : "If the save prompt didn't appear or failed, save it again — no re-download needed.";
        el.innerHTML = `
            <div class="progress-header">
                <span class="progress-filename">${this._escapeHtml(fileName)}</span>
                <span class="progress-percentage">✓</span>
            </div>
            <div class="progress-details"><span>${hint}</span></div>
            <div style="display:flex; gap:10px; margin-top:10px; flex-wrap:wrap;">
                ${canShare ? '<button class="btn p2p-btn manual-share-btn" style="padding:10px 20px; font-weight:600;">Save to Files</button>' : ''}
                <a class="btn manual-save-btn" href="${getUrl()}" download="${this._escapeHtml(fileName)}"
                   style="text-decoration:none; padding:10px 20px; border-radius:6px;">${canShare ? 'Normal download' : 'Save again'}</a>
                <button class="btn manual-save-dismiss" style="padding:10px 20px;">Done</button>
            </div>
        `;

        const shareBtn = el.querySelector('.manual-share-btn');
        if (shareBtn) {
            shareBtn.addEventListener('click', async () => {
                try {
                    await navigator.share({ files: [shareFile], title: fileName });
                    this.showToast(`${fileName} handed to the system — done!`, 'success');
                } catch (e) {
                    if (e.name !== 'AbortError') {
                        this.showToast('Share failed: ' + e.message, 'error');
                    }
                }
            });
        }
        el.querySelector('.manual-save-dismiss').addEventListener('click', () => {
            this.removeProgressUI(transferId);
            // Give an in-flight save started from this card time to finish
            setTimeout(cleanup, 60 * 1000);
        });

        // Auto-reclaim staged space if the user never dismisses
        setTimeout(() => {
            if (document.getElementById(`progress-${transferId}`)) {
                this.removeProgressUI(transferId);
            }
            cleanup();
        }, 15 * 60 * 1000);
    }

    _opfsWorkerCode() {
        return `
            let access = null;
            self.onmessage = async (e) => {
                const m = e.data;
                try {
                    if (m.type === 'init') {
                        const root = await navigator.storage.getDirectory();
                        const tmp = await root.getDirectoryHandle('dl_tmp', { create: true });
                        const dir = await tmp.getDirectoryHandle(m.dir, { create: true });
                        const handle = await dir.getFileHandle(m.name, { create: true });
                        access = await handle.createSyncAccessHandle();
                        access.truncate(0);
                        self.postMessage({ type: 'ready' });
                    } else if (m.type === 'chunk') {
                        const n = access.write(new Uint8Array(m.data), { at: m.offset });
                        // Short write = storage full (some browsers truncate
                        // silently instead of throwing, e.g. private browsing)
                        if (n < m.data.byteLength) {
                            throw new Error('Device storage full — could not write chunk');
                        }
                        self.postMessage({ type: 'ack' });
                    } else if (m.type === 'close') {
                        access.flush();
                        access.close();
                        access = null;
                        self.postMessage({ type: 'closed' });
                    } else if (m.type === 'abort') {
                        try { if (access) access.close(); } catch (err) {}
                        access = null;
                        self.postMessage({ type: 'aborted' });
                    }
                } catch (err) {
                    self.postMessage({ type: 'error', error: err.message || String(err) });
                }
            };
        `;
    }

    async _cleanupOpfsLeftovers() {
        try {
            if (!(navigator.storage && navigator.storage.getDirectory)) return;
            const root = await navigator.storage.getDirectory();
            for await (const name of root.keys()) {
                // 'dl_tmp' dir (current layout) + legacy 'dl_*' files
                if (name === 'dl_tmp' || name.startsWith('dl_')) {
                    await root.removeEntry(name, { recursive: true }).catch(() => {});
                }
            }
        } catch (e) { /* OPFS unsupported — nothing to clean */ }
    }

    // Keep the screen on during transfers — phones otherwise sleep and iOS
    // suspends the page, killing the WebRTC connection mid-download.
    async _acquireWakeLock() {
        try {
            if ('wakeLock' in navigator && !this.wakeLock) {
                this.wakeLock = await navigator.wakeLock.request('screen');
                this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
            }
        } catch (e) { /* not supported / denied — best effort */ }
    }

    _releaseWakeLock() {
        if (this.wakeLock) {
            this.wakeLock.release().catch(() => {});
            this.wakeLock = null;
        }
    }

    _createMemorySink(fileName) {
        console.log('[DL] Buffering in memory (fallback mode)');
        const chunks = [];
        return {
            mode: 'memory',
            write: (chunk) => { chunks.push(chunk); },
            close: async () => {
                const blob = new Blob(chunks, { type: 'application/octet-stream' });
                chunks.length = 0;
                this.triggerDownload(blob, fileName);
            },
            abort: async () => { chunks.length = 0; },
        };
    }

    _startSwKeepalive() {
        if (this.swKeepaliveTimer) return;
        // Regular messages keep the service worker alive during long transfers
        this.swKeepaliveTimer = setInterval(() => {
            const c = navigator.serviceWorker && navigator.serviceWorker.controller;
            if (c) c.postMessage({ type: 'keepalive' });
        }, 8000);
    }

    _maybeStopSwKeepalive() {
        if (this.swKeepaliveTimer && !this.receiveState.active) {
            clearInterval(this.swKeepaliveTimer);
            this.swKeepaliveTimer = null;
        }
    }

    // ── Receiving files ────────────────────────────────────────────────────

    async downloadFileP2P(fileId, fileName, fileSize) {
        const hostPeerId = this.currentTargetHostId;
        if (!hostPeerId) {
            this.showToast('Not connected to a host', 'error');
            return;
        }

        if (this.receiveState.active) {
            this.receiveState.queue.push({ fileId, fileName, fileSize });
            this.showToast(`${fileName} queued — starts after the current download`, 'info');
            return;
        }

        await this.startReceive(fileId, fileName, fileSize);
    }

    async startReceive(fileId, fileName, fileSize) {
        const hostPeerId = this.currentTargetHostId;
        const transferId = 't_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

        const transfer = {
            transferId, fileId, fileName,
            fileSize: fileSize || 0,
            sink: null,
            receivedBytes: 0,
            writtenBytes: 0,
            lastAckSent: 0,
            lastUiUpdate: 0,
            startTime: Date.now(),
            writeChain: Promise.resolve(),
            failed: false,
            watchdog: null,
            resuming: false,
            resumeAttempts: 0,
        };
        this.receiveState.active = transfer; // reserve slot so new clicks queue up

        try {
            const dc = await this.ensureP2P(hostPeerId);

            // iPhone/Safari strategy:
            //  ≤400 MB → service-worker streaming: direct write into the
            //            browser's downloads (WebKit tolerates this size in RAM)
            //  >400 MB → LAN relay → native URL download (WebKit buffers SW
            //            streams, blob downloads and the share sheet in RAM,
            //            so a plain network download is the only reliable path)
            const isWebKit = /^Apple/i.test(navigator.vendor || '');
            const WEBKIT_DIRECT_LIMIT = 400 * 1024 * 1024;
            if (isWebKit && fileSize > WEBKIT_DIRECT_LIMIT) {
                if (await this._relayAvailable(fileSize)) {
                    transfer.mode = 'relay';
                    dc.send(JSON.stringify({ type: 'relay-request', fileId, transferId }));
                    this.preventUnloadDuringTransfer();
                    this._acquireWakeLock();
                    this.createProgressUI(transferId, fileName);
                    this._resetWatchdog(transfer);
                    this.showToast(`Preparing ${fileName} on the host…`, 'info');
                    return;
                }
                this.showToast('Files this large usually fail on iPhone without the local server (relay) running', 'warning');
            }

            transfer.sink = await this.createSink(transferId, fileName, fileSize);
            dc.send(JSON.stringify({ type: 'file-request', fileId, transferId }));
            this.preventUnloadDuringTransfer();
            this._acquireWakeLock();
            this.createProgressUI(transferId, fileName);
            this._resetWatchdog(transfer);
            this.showToast(`Downloading ${fileName}…`, 'info');
        } catch (error) {
            this.receiveState.active = null;
            if (transfer.sink) transfer.sink.abort().catch(() => {});
            if (error && error.name === 'AbortError') {
                this._processReceiveQueue(); // user cancelled the save dialog
                return;
            }
            console.error('[P2P] Error starting download:', error);
            this.showToast(`Download failed: ${error.message}`, 'error');
            this._processReceiveQueue();
        }
    }

    _resetWatchdog(transfer) {
        if (transfer.watchdog) clearTimeout(transfer.watchdog);
        transfer.watchdog = setTimeout(() => {
            this._attemptResume(transfer, 'stalled — no data for 30s');
        }, 30000);
    }

    // A dropped/stalled connection doesn't kill the download: reconnect with a
    // fresh peer ID and ask the host to continue from the bytes already written.
    async _attemptResume(transfer, reason) {
        if (transfer.failed || transfer.resuming) return;
        if (this.receiveState.active !== transfer) return;

        transfer.resuming = true;
        transfer.resumeAttempts++;
        if (transfer.resumeAttempts > 5) {
            transfer.resuming = false;
            this.failReceive(transfer, new Error(`${reason} (gave up after 5 resume attempts)`));
            return;
        }

        console.warn(`[P2P] Transfer interrupted (${reason}) — resuming from ` +
            `${this.formatFileSize(transfer.writtenBytes)} (attempt ${transfer.resumeAttempts}/5)`);
        this.showToast(`Connection hiccup — resuming ${transfer.fileName}…`, 'warning');
        if (transfer.watchdog) clearTimeout(transfer.watchdog);

        try {
            // Kill the old channel first so no stale in-flight chunks get
            // written after we pick the resume offset
            this.teardownPeer(this.currentTargetHostId);
            this.peerId = this.generatePeerId();

            // Let queued sink writes settle — writtenBytes is then final
            await transfer.writeChain.catch(() => {});
            if (transfer.failed) return;

            const dc = await this.ensureP2P(this.currentTargetHostId);
            if (transfer.failed) return;

            if (transfer.mode === 'relay') {
                // Relay: just ask the host to stage the file again
                dc.send(JSON.stringify({
                    type: 'relay-request',
                    fileId: transfer.fileId,
                    transferId: transfer.transferId,
                }));
                this._resetWatchdog(transfer);
                return;
            }

            // Bytes received but never written died with the old channel
            transfer.receivedBytes = transfer.writtenBytes;
            transfer.lastAckSent = transfer.writtenBytes;

            dc.send(JSON.stringify({
                type: 'file-request',
                fileId: transfer.fileId,
                transferId: transfer.transferId,
                offset: transfer.writtenBytes,
            }));
            this._resetWatchdog(transfer);
            console.log(`[P2P] Resume requested from ${this.formatFileSize(transfer.writtenBytes)}`);
        } catch (e) {
            this.failReceive(transfer, new Error('Could not reconnect to resume: ' + e.message));
        } finally {
            transfer.resuming = false;
        }
    }

    failReceive(transfer, error) {
        if (transfer.failed) return;
        transfer.failed = true;
        if (transfer.watchdog) clearTimeout(transfer.watchdog);
        console.error(`[P2P] Transfer failed: ${transfer.fileName}:`, error);

        if (transfer.sink) transfer.sink.abort().catch(() => {});

        // Tell the host to stop sending
        const dc = this.dataChannels.get(this.currentTargetHostId);
        if (dc && dc.readyState === 'open') {
            try { dc.send(JSON.stringify({ type: 'transfer-abort', transferId: transfer.transferId })); } catch (e) {}
        }

        this.showToast(`${transfer.fileName} failed: ${error.message}`, 'error');
        this.removeProgressUI(transfer.transferId);

        if (this.receiveState.active === transfer) {
            this.receiveState.active = null;
            this.allowUnload();
            this._processReceiveQueue();
        }
    }

    _processReceiveQueue() {
        this._maybeStopSwKeepalive();
        const next = this.receiveState.queue.shift();
        if (next) this.startReceive(next.fileId, next.fileName, next.fileSize);
        else this._releaseWakeLock();
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

    handleDataChannelMessage(peerId, event) {
        const data = event.data;
        // Check if it's JSON (metadata) or binary (file data)
        if (typeof data === 'string') {
            try {
                const message = JSON.parse(data);
                this.handleControlMessage(peerId, message);
            } catch (error) {
                console.error('[P2P] Error parsing control message:', error);
            }
        } else if (data instanceof Blob) {
            // Safari sends Blob even when binaryType = 'arraybuffer'.
            // Serialize the async conversions — parallel arrayBuffer() calls can
            // resolve out of order and corrupt the file.
            this._blobChain = (this._blobChain || Promise.resolve())
                .then(() => data.arrayBuffer())
                .then(buffer => this.handleFileChunk(peerId, buffer))
                .catch(err => console.error('[P2P] Blob chunk error:', err));
        } else {
            // ArrayBuffer (Chrome, Firefox)
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
                // Host receives file request from client (offset > 0 = resume)
                this.enqueueSend(peerId, message.fileId, message.transferId || message.fileId, message.offset || 0);
                break;
            case 'relay-request':
                // Host: stage the file on the LAN server for a WebKit receiver
                this._handleRelayRequest(peerId, message);
                break;
            case 'relay-progress': {
                // Client: host reports its upload progress to the relay
                const t = this.receiveState.active;
                if (t && t.transferId === message.transferId && !t.failed) {
                    this._resetWatchdog(t);
                    const total = message.total || t.fileSize || 0;
                    const pct = total ? Math.min(100, Math.round((message.uploaded / total) * 100)) : 0;
                    const elapsed = (Date.now() - t.startTime) / 1000;
                    const speed = message.uploaded / Math.max(elapsed, 0.001);
                    const remaining = total ? (total - message.uploaded) / Math.max(speed, 1) : 0;
                    this.updateProgressUI(t.transferId, pct, speed, remaining);
                }
                break;
            }
            case 'relay-ready':
                // Client: file is staged — start the native browser download
                this._completeRelayReceive(message);
                break;
            case 'file-meta': {
                // Client: host confirmed the transfer — trust its size/type
                const t = this.receiveState.active;
                if (t && t.transferId === message.transferId) {
                    t.fileSize = message.fileSize || t.fileSize;
                    this._resetWatchdog(t);
                }
                break;
            }
            case 'file-complete':
                // Complete file transfer
                this.completeFileReceive(peerId, message);
                break;
            case 'flow-ack': {
                // Host: receiver reports how many bytes actually reached its sink
                const st = this.sendStates.get(message.transferId);
                if (st) {
                    st.acked = message.received;
                    if (st.ackWaiter) { const w = st.ackWaiter; st.ackWaiter = null; w(); }
                }
                break;
            }
            case 'transfer-abort': {
                // Host: receiver gave up — stop the send loop
                const st = this.sendStates.get(message.transferId);
                if (st) {
                    st.aborted = true;
                    if (st.ackWaiter) { const w = st.ackWaiter; st.ackWaiter = null; w(); }
                }
                break;
            }
            case 'transfer-error': {
                // Client: host couldn't serve the file
                const t = this.receiveState.active;
                if (t && t.transferId === message.transferId) {
                    this.failReceive(t, new Error(message.error || 'Host reported an error'));
                }
                break;
            }
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

    // ── LAN relay (WebKit receivers) ───────────────────────────────────────

    _hostBase() {
        if (!this.currentHostUrl) return '';
        return this.currentHostUrl.endsWith('/') ? this.currentHostUrl.slice(0, -1) : this.currentHostUrl;
    }

    async _relayAvailable(fileSize) {
        if (this._relayInfo === undefined) {
            try {
                const res = await fetch(`${this._hostBase()}/api/relay-info`);
                this._relayInfo = res.ok ? await res.json() : null;
            } catch (e) {
                this._relayInfo = null; // cloud mode / old server — no relay
            }
        }
        if (!this._relayInfo || !this._relayInfo.relay) return false;
        if (fileSize && this._relayInfo.free && this._relayInfo.free < fileSize * 1.1) {
            this.showToast('Server is low on disk space for relaying — using direct transfer', 'warning');
            return false;
        }
        return true;
    }

    // Host: upload the file to the LAN server so the receiver can download it
    // as a plain URL. XHR streams the File from disk and reports progress.
    _handleRelayRequest(peerId, message) {
        const { fileId, transferId } = message;
        const dc = this.dataChannels.get(peerId);
        const send = (obj) => {
            if (dc && dc.readyState === 'open') {
                try { dc.send(JSON.stringify(obj)); } catch (e) {}
            }
        };

        const file = this.files.get(fileId);
        if (!file) {
            send({ type: 'transfer-error', transferId, error: 'File is no longer shared by the host' });
            return;
        }

        console.log(`[Relay] Uploading ${file.name} (${this.formatFileSize(file.size)}) to the LAN server`);
        const url = `/api/relay-upload/${encodeURIComponent(transferId)}?name=${encodeURIComponent(file.name)}`;
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);

        let lastProgress = 0;
        xhr.upload.onprogress = (e) => {
            const now = Date.now();
            if (now - lastProgress > 500) {
                lastProgress = now;
                send({ type: 'relay-progress', transferId, uploaded: e.loaded, total: e.total || file.size });
            }
        };
        xhr.onload = () => {
            if (xhr.status === 200) {
                console.log(`[Relay] Upload complete: ${file.name}`);
                send({ type: 'relay-ready', transferId });
            } else {
                send({ type: 'transfer-error', transferId, error: `Relay upload failed (${xhr.status})` });
            }
        };
        xhr.onerror = () => {
            send({ type: 'transfer-error', transferId, error: 'Relay upload failed — is the server still running?' });
        };
        xhr.send(file);
    }

    // Client: staged file is ready — hand the URL to the browser's download
    // manager. Network downloads stream to disk natively on every platform,
    // iOS included, with progress in the browser's own downloads UI.
    _completeRelayReceive(message) {
        const transfer = this.receiveState.active;
        if (!transfer || transfer.transferId !== message.transferId || transfer.failed) return;
        if (transfer.watchdog) clearTimeout(transfer.watchdog);

        const url = `${this._hostBase()}/api/relay-download/${encodeURIComponent(transfer.transferId)}`;
        const a = document.createElement('a');
        a.href = url;
        a.download = transfer.fileName;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => a.remove(), 5000);

        console.log(`[Relay] Native download started: ${url}`);
        this._offerRelayCard(transfer.transferId, transfer.fileName, url);
        this.showToast(`${transfer.fileName} — check your browser's downloads`, 'success');

        this.receiveState.active = null;
        this.allowUnload();
        this._processReceiveQueue();
    }

    _offerRelayCard(transferId, fileName, url) {
        const el = document.getElementById(`progress-${transferId}`);
        if (!el) return;
        el.innerHTML = `
            <div class="progress-header">
                <span class="progress-filename">${this._escapeHtml(fileName)}</span>
                <span class="progress-percentage">✓</span>
            </div>
            <div class="progress-details"><span>Saving via your browser's downloads. Didn't start? Tap Download.</span></div>
            <div style="display:flex; gap:10px; margin-top:10px;">
                <a class="btn p2p-btn relay-retry-btn" href="${url}" download="${this._escapeHtml(fileName)}"
                   style="text-decoration:none; padding:10px 20px; border-radius:6px; font-weight:600;">Download</a>
                <button class="btn manual-save-dismiss" style="padding:10px 20px;">Done</button>
            </div>
        `;
        el.querySelector('.manual-save-dismiss').addEventListener('click', () => this.removeProgressUI(transferId));
        setTimeout(() => this.removeProgressUI(transferId), 15 * 60 * 1000);
    }

    // ── Sending files (host side) ──────────────────────────────────────────

    enqueueSend(peerId, fileId, transferId, offset = 0) {
        // A resume re-uses the transferId — stop any older send loop for it
        // (its channel is usually dead, but don't rely on that)
        const old = this.sendStates.get(transferId);
        if (old) {
            old.aborted = true;
            if (old.ackWaiter) { const w = old.ackWaiter; old.ackWaiter = null; w(); }
        }
        const q = this.sendQueues.get(peerId) || [];
        q.push({ fileId, transferId, offset });
        this.sendQueues.set(peerId, q);
        this._processSendQueue(peerId);
    }

    async _processSendQueue(peerId) {
        if (this.sendActive.has(peerId)) return;
        this.sendActive.add(peerId);
        this._acquireWakeLock(); // host phone must not sleep mid-send
        try {
            const q = this.sendQueues.get(peerId);
            while (q && q.length > 0) {
                const item = q.shift();
                try {
                    await this.sendFileToClient(peerId, item.fileId, item.transferId, item.offset || 0);
                } catch (e) {
                    console.error('[P2P] Send failed:', e);
                }
            }
        } finally {
            this.sendActive.delete(peerId);
            if (this.sendActive.size === 0) this._releaseWakeLock();
        }
    }

    async sendFileToClient(peerId, fileId, transferId, startOffset = 0) {
        const dataChannel = this.dataChannels.get(peerId);
        if (!dataChannel || dataChannel.readyState !== 'open') {
            console.error(`[P2P] No open data channel for peer: ${peerId}`);
            return;
        }

        const file = this.files.get(fileId);
        if (!file) {
            console.error(`[P2P] File not found: ${fileId}`);
            dataChannel.send(JSON.stringify({
                type: 'transfer-error', transferId,
                error: 'File is no longer shared by the host',
            }));
            return;
        }

        console.log(`[P2P] Sending ${file.name} (${this.formatFileSize(file.size)}) to ${peerId}` +
            (startOffset ? ` — resuming from ${this.formatFileSize(startOffset)}` : ''));

        dataChannel.send(JSON.stringify({
            type: 'file-meta',
            transferId,
            fileName: file.name,
            fileSize: file.size,
            fileType: file.type,
            offset: startOffset,
        }));

        const CHUNK_SIZE  = 64 * 1024;        // safe max message size on all browsers
        const BUFFER_HIGH = 4 * 1024 * 1024;  // pause when channel buffer exceeds this
        const BUFFER_LOW  = 1 * 1024 * 1024;  // resume threshold
        const MAX_UNACKED = 32 * 1024 * 1024; // never run further ahead of receiver's disk

        dataChannel.bufferedAmountLowThreshold = BUFFER_LOW;

        const state = { acked: startOffset, aborted: false, ackWaiter: null };
        this.sendStates.set(transferId, state);

        let offset = startOffset;
        let lastLog = startOffset;
        try {
            while (offset < file.size) {
                if (state.aborted) {
                    console.log(`[P2P] Transfer aborted by receiver: ${file.name}`);
                    return;
                }
                if (dataChannel.readyState !== 'open') {
                    throw new Error('Data channel closed during transfer');
                }

                if (dataChannel.bufferedAmount > BUFFER_HIGH) {
                    // Event-driven pause, with a timeout fallback for browsers
                    // that don't fire bufferedamountlow reliably
                    await new Promise((resolve) => {
                        const t = setTimeout(resolve, 500);
                        dataChannel.onbufferedamountlow = () => {
                            clearTimeout(t);
                            dataChannel.onbufferedamountlow = null;
                            resolve();
                        };
                    });
                    continue;
                }

                if (offset - state.acked > MAX_UNACKED) {
                    // Receiver's disk is behind — wait for a flow-ack
                    await new Promise((resolve, reject) => {
                        const t = setTimeout(() => {
                            state.ackWaiter = null;
                            reject(new Error('Receiver stopped responding (no flow-ack for 60s)'));
                        }, 60000);
                        state.ackWaiter = () => { clearTimeout(t); resolve(); };
                    });
                    continue;
                }

                const buf = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
                dataChannel.send(buf);
                offset += buf.byteLength;

                if (offset - lastLog >= 50 * 1024 * 1024) {
                    lastLog = offset;
                    console.log(`[P2P] Sending ${file.name}: ${Math.round((offset / file.size) * 100)}%`);
                }
            }

            dataChannel.send(JSON.stringify({ type: 'file-complete', transferId }));
            console.log(`[P2P] File transfer complete: ${file.name}`);
        } catch (err) {
            console.error(`[P2P] Error sending ${file.name}:`, err);
            if (dataChannel.readyState === 'open') {
                try {
                    dataChannel.send(JSON.stringify({ type: 'transfer-error', transferId, error: err.message }));
                } catch (e) {}
            }
        } finally {
            // A resume may have installed a newer state under the same id
            if (this.sendStates.get(transferId) === state) {
                this.sendStates.delete(transferId);
            }
        }
    }

    preventUnloadDuringTransfer() {
        // Add beforeunload handler to prevent accidental navigation
        if (!this.unloadHandler) {
            this.unloadHandler = (e) => {
                if (this.receiveState.active) {
                    const message = 'Download in progress! Are you sure you want to leave?';
                    e.preventDefault();
                    e.returnValue = message;
                    return message;
                }
            };
            window.addEventListener('beforeunload', this.unloadHandler);
        }
    }

    allowUnload() {
        // Remove beforeunload handler when no transfers are active
        if (this.unloadHandler && !this.receiveState.active) {
            window.removeEventListener('beforeunload', this.unloadHandler);
            this.unloadHandler = null;
        }
    }

    handleFileChunk(peerId, chunk) {
        const transfer = this.receiveState.active;
        if (!transfer || transfer.failed || !transfer.sink) return;

        const len = chunk.byteLength;
        transfer.receivedBytes += len;
        this._resetWatchdog(transfer);

        // Chain sink writes to preserve order; ack the sender only after the
        // sink actually accepted the bytes (end-to-end backpressure).
        transfer.writeChain = transfer.writeChain
            .then(() => transfer.sink.write(chunk))
            .then(() => {
                transfer.writtenBytes += len;
                if (transfer.writtenBytes - transfer.lastAckSent >= 1024 * 1024 ||
                    transfer.writtenBytes >= transfer.fileSize) {
                    transfer.lastAckSent = transfer.writtenBytes;
                    const dc = this.dataChannels.get(peerId);
                    if (dc && dc.readyState === 'open') {
                        dc.send(JSON.stringify({
                            type: 'flow-ack',
                            transferId: transfer.transferId,
                            received: transfer.writtenBytes,
                        }));
                    }
                }
            })
            .catch((err) => this.failReceive(transfer, err));

        // Throttle progress UI updates — per-chunk DOM writes hurt on mobile
        const now = Date.now();
        if (now - transfer.lastUiUpdate > 250 || transfer.receivedBytes >= transfer.fileSize) {
            transfer.lastUiUpdate = now;
            const progress = transfer.fileSize
                ? Math.min(100, Math.round((transfer.receivedBytes / transfer.fileSize) * 100))
                : 0;
            const elapsed = (now - transfer.startTime) / 1000;
            const speed = transfer.receivedBytes / Math.max(elapsed, 0.001);
            const remaining = (transfer.fileSize - transfer.receivedBytes) / Math.max(speed, 1);
            this.updateProgressUI(transfer.transferId, progress, speed, remaining);
        }
    }

    async completeFileReceive(peerId, message) {
        const transfer = this.receiveState.active;
        if (!transfer || transfer.transferId !== message.transferId || transfer.failed) return;
        if (transfer.watchdog) clearTimeout(transfer.watchdog);

        try {
            // Safari path: wait for pending Blob→ArrayBuffer conversions first,
            // then for every queued sink write, then finalize the file.
            await (this._blobChain || Promise.resolve());
            await transfer.writeChain;
            if (transfer.failed) return; // a write error already handled this transfer
            if (transfer.fileSize && transfer.receivedBytes !== transfer.fileSize) {
                throw new Error(`Incomplete: got ${this.formatFileSize(transfer.receivedBytes)} of ${this.formatFileSize(transfer.fileSize)}`);
            }
            const closeResult = await transfer.sink.close();

            console.log(`[P2P] Transfer complete: ${transfer.fileName} (${this.formatFileSize(transfer.receivedBytes)})`);
            if (closeResult === 'manual-save-offered') {
                // OPFS path: the card now shows save buttons — leave it up
                this.showToast(`${transfer.fileName} received — save it from the card below`, 'success');
            } else {
                this.showToast(`${transfer.fileName} saved!`, 'success');
                this.updateProgressUI(transfer.transferId, 100, transfer.receivedBytes / Math.max((Date.now() - transfer.startTime) / 1000, 0.001), 0);
                setTimeout(() => this.removeProgressUI(transfer.transferId), 1500);
            }
        } catch (error) {
            console.error('[P2P] Error completing file receive:', error);
            this.showToast(`Error saving ${transfer.fileName}: ${error.message}`, 'error');
            this.removeProgressUI(transfer.transferId);
        } finally {
            // Only clear if this transfer is still the active one — failReceive
            // may have already moved on to the next queued download
            if (this.receiveState.active === transfer) {
                this.receiveState.active = null;
                this.allowUnload();
                this._processReceiveQueue();
            }
        }
    }

    triggerDownload(blob, fileName) {
        // No extra Blob wrapping — that would double memory usage
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        // Keep the URL alive long enough for the browser to start the download,
        // then revoke to free memory
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 60000);
    }

    createProgressUI(transferId, fileName) {
        console.log(`[P2P] 🎨 Creating progress UI for ${fileName}, transferId: ${transferId}`);
        
        const progressContainer = document.createElement('div');
        progressContainer.id = `progress-${transferId}`;
        progressContainer.className = 'download-progress';
        progressContainer.innerHTML = `
            <div class="progress-header">
                <span class="progress-filename">${this._escapeHtml(fileName)}</span>
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
                            this.connectToHost(code.data);
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
        if (!mimeType) return '<span class="file-type-badge">FILE</span>';
        if (mimeType.startsWith('image/')) return '<span class="file-type-badge img">IMG</span>';
        if (mimeType.startsWith('video/')) return '<span class="file-type-badge vid">VID</span>';
        if (mimeType.startsWith('audio/')) return '<span class="file-type-badge aud">AUD</span>';
        if (mimeType.includes('pdf')) return '<span class="file-type-badge pdf">PDF</span>';
        if (mimeType.includes('text/') || mimeType.includes('document')) return '<span class="file-type-badge txt">TXT</span>';
        if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('tar')) return '<span class="file-type-badge zip">ZIP</span>';
        return '<span class="file-type-badge">FILE</span>';
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