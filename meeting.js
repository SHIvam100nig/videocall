/**
 * Stegure Meeting - Core Logic
 */

// State
let myPeerId = null;
let peer = null;
let myStream = null;
let myScreenStream = null;
const peers = {};
let isHost = false;
let hostId = null;

// DOM Elements
const landingOverlay = document.getElementById('landing-overlay');
const meetingContainer = document.getElementById('meeting-container');
const videoGrid = document.getElementById('video-grid');
const videoTemplate = document.getElementById('video-tile-template');
const displayMeetingId = document.getElementById('display-meeting-id');
const meetingTimer = document.getElementById('meeting-timer');
const toastContainer = document.getElementById('toast-container');

// Controls
const btnMic = document.getElementById('btn-mic');
const btnVideo = document.getElementById('btn-video');
const btnScreen = document.getElementById('btn-screen');
const btnEnd = document.getElementById('btn-end');

const meetingIdInput = document.getElementById('meeting-id-input');
const joinBtn = document.getElementById('join-btn');
const createBtn = document.getElementById('create-btn');

// Auto-join from URL
window.addEventListener('load', () => {
    const params = new URLSearchParams(window.location.search);
    const roomId = params.get('room');
    if (roomId) {
        meetingIdInput.value = roomId;
        showToast('Click JOIN to start.', 'info');
    }
});

// --- Initialization & Event Listeners ---

joinBtn.addEventListener('click', () => {
    const id = meetingIdInput.value.trim();
    if (id) startMeeting(false, id);
    else showToast('Please enter a Meeting ID', 'error');
});

createBtn.addEventListener('click', () => {
    const newId = generateId();
    startMeeting(true, newId);
});

// Media Controls
btnMic.addEventListener('click', toggleAudio);
btnVideo.addEventListener('click', toggleVideo);
btnScreen.addEventListener('click', toggleScreenShare);
btnEnd.addEventListener('click', endCall);


// --- Core Meeting Logic ---

async function startMeeting(asHost, id) {
    showToast('Requesting Camera Access...', 'info');

    try {
        // Data Saver Mode: 360p, 15fps for stability on mobile data
        const constraints = {
            video: {
                width: { ideal: 480 },
                height: { ideal: 360 },
                frameRate: { ideal: 15, max: 20 },
                facingMode: "user"
            },
            audio: {
                echoCancellation: true,
                noiseSuppression: true
            }
        };

        myStream = await navigator.mediaDevices.getUserMedia(constraints);

        // Success!
        addVideoStream(myStream, 'Me', true);

        landingOverlay.classList.add('hidden');
        meetingContainer.classList.remove('hidden');
        startTimer();

        isHost = asHost;
        if (asHost) {
            hostId = id;
            myPeerId = id;
            displayMeetingId.innerText = id;
            initPeer(id);

            // Show WhatsApp Share Button for Host
            const waBtn = document.getElementById('whatsapp-share-btn');
            waBtn.classList.remove('hidden');
            waBtn.onclick = () => {
                const url = `${location.protocol}//${location.host}${location.pathname.replace('index.html', '')}?room=${id}`;
                const msg = `Join my secure video meeting: ${url}`;
                window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
            };

        } else {
            hostId = id;
            displayMeetingId.innerText = id;
            initPeer(null);
        }

    } catch (err) {
        console.error("Error accessing media:", err);

        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
            showPermissionModal(); // SHOW VISUAL GUIDE
        } else if (err.name === 'NotFoundError') {
            showToast('No Camera/Mic found.', 'error');
        } else if (err.name === 'NotReadableError') {
            showToast('Camera in use by another app!', 'error');
        } else {
            showToast('Media Error: ' + err.message, 'error');
        }
    }
}

function showPermissionModal() {
    // Check if modal already exists
    if (document.getElementById('permission-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'permission-modal';
    modal.innerHTML = `
        <div class="arrow-up">☝️</div>
        <div class="perm-instruction">
            <strong>Camera Blocked!</strong><br><br>
            1. Tap the 🔒 Lock Icon in URL bar.<br>
            2. Click "Permissions" or "Reset".<br>
            3. Refresh the page.
        </div>
        <button class="modal-btn" onclick="location.reload()">REFRESH PAGE</button>
    `;
    document.body.appendChild(modal);
}

function initPeer(customId) {
    const options = customId ? { host: '0.peerjs.com', port: 443, path: '/', secure: true } : undefined;

    if (customId) {
        peer = new Peer(customId);
    } else {
        peer = new Peer();
    }

    peer.on('open', (id) => {
        myPeerId = id;
        console.log('My Peer ID:', id);

        if (!isHost) {
            connectToHost(hostId);
        }
    });

    peer.on('call', (call) => {
        call.answer(myStream);

        // Ensure peer entry exists
        if (!peers[call.peer]) peers[call.peer] = {};
        peers[call.peer].call = call;

        call.on('stream', (userVideoStream) => {
            // Check ID to prevent duplicates
            if (!document.getElementById('video-' + call.peer)) {
                addVideoStream(userVideoStream, 'Peer', false, call.peer);
            }
        });

        call.on('close', () => removeVideoStream(call.peer));
        call.on('error', err => removeVideoStream(call.peer));
    });

    peer.on('connection', (conn) => {
        handleDataConnection(conn);
    });

    peer.on('error', (err) => {
        console.error('Peer error:', err);
        if (err.type === 'unavailable-id') {
            showToast('ID taken. Reloading...', 'error');
            setTimeout(() => location.reload(), 2000);
        } else if (err.type === 'peer-unavailable') {
            showToast('Waiting for Host...', 'warning');
        }
    });

    peer.on('disconnected', () => {
        showToast('Reconnecting...', 'warning');
        peer.reconnect();
    });
}

function connectToHost(destId) {
    const conn = peer.connect(destId);

    // Save connection immediately
    if (!peers[destId]) peers[destId] = {};
    peers[destId].conn = conn;

    setupConnectionListeners(conn);

    conn.on('open', () => {
        conn.send({ type: 'join-request', peerId: myPeerId });
    });

    callPeer(destId);
}

function callPeer(destId) {
    // 1. Media Call
    if (!peers[destId] || !peers[destId].call) {
        // Create placeholder if needed
        if (!peers[destId]) peers[destId] = {};

        // Add slight delay to avoid race conditions
        setTimeout(() => {
            const call = peer.call(destId, myStream);
            peers[destId].call = call; // Save call ref

            call.on('stream', (userVideoStream) => {
                // Only add if not already added (check ID-based selector)
                if (!document.getElementById('video-' + destId)) {
                    addVideoStream(userVideoStream, 'Peer', false, destId);
                }
            });

            call.on('close', () => removeVideoStream(destId));
            call.on('error', () => removeVideoStream(destId));
        }, 500);
    }

    // 2. Data Connection (Mesh Chat)
    // If we don't have a data connection to this peer yet, open one
    if (!peers[destId].conn) {
        const conn = peer.connect(destId);
        peers[destId].conn = conn;
        setupConnectionListeners(conn);
    }
}

// --- Data & Mesh Logic ---

function handleDataConnection(conn) {
    // Incoming connection
    // We need to wait for 'open' or data to know who it is, 
    // BUT PeerJS 'connection' event usually provides conn.peer immediately in metadata

    setupConnectionListeners(conn);
}

function setupConnectionListeners(conn) {
    conn.on('open', () => {
        // Connection established
        if (conn.peer) {
            if (!peers[conn.peer]) peers[conn.peer] = {};
            peers[conn.peer].conn = conn;
        }
    });

    conn.on('data', (data) => {
        // Ensure we map this connection to the peer if not already
        if (conn.peer) {
            if (!peers[conn.peer]) peers[conn.peer] = {};
            peers[conn.peer].conn = conn;
        }

        if (isHost && data.type === 'join-request') {
            const newJoinerId = data.peerId;
            // Map the connection specifically to the declared ID
            if (!peers[newJoinerId]) peers[newJoinerId] = {};
            peers[newJoinerId].conn = conn;

            const existingPeers = Object.keys(peers);
            conn.send({ type: 'peer-list', peers: existingPeers });

            // Notify others
            Object.values(peers).forEach(p => {
                if (p.conn && p.conn.open && p.conn.peer !== newJoinerId) {
                    p.conn.send({ type: 'user-joined', peerId: newJoinerId });
                }
            });
        }
        else {
            handleData(data);
        }
    });

    conn.on('close', () => {
        // Handle close
    });

    conn.on('error', (err) => console.error("Conn error:", err));
}

function handleData(data) {
    if (data.type === 'peer-list') {
        data.peers.forEach(pid => {
            if (pid !== myPeerId) callPeer(pid);
        });
    }
    else if (data.type === 'user-joined') {
        callPeer(data.peerId);
        showToast('New user joined!');
    }
}


// --- UI Functions ---

function addVideoStream(stream, name, isLocal, peerId) {
    if (peerId && document.getElementById('video-' + peerId)) return;

    const clone = videoTemplate.content.cloneNode(true);
    const tile = clone.querySelector('.video-tile');
    const video = clone.querySelector('video');
    const nameTag = clone.querySelector('.name-tag');

    video.srcObject = stream;
    nameTag.innerText = name;

    if (isLocal) {
        tile.classList.add('is-local');
        video.muted = true;
    } else {
        tile.id = 'video-' + peerId;
    }

    video.onloadedmetadata = () => video.play();
    videoGrid.appendChild(tile);
}

function removeVideoStream(peerId) {
    const tile = document.getElementById('video-' + peerId);
    if (tile) tile.remove();
    if (peers[peerId]) delete peers[peerId];
}

function generateId() {
    return 'Room-' + Math.floor(Math.random() * 9000 + 1000);
}

// --- Media Controls ---

function toggleAudio() {
    const audioTrack = myStream.getAudioTracks()[0];
    if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        btnMic.classList.toggle('active');
        const icon = btnMic.querySelector('i');
        icon.classList.toggle('ph-microphone');
        icon.classList.toggle('ph-microphone-slash');
    }
}

function toggleVideo() {
    const videoTrack = myStream.getVideoTracks()[0];
    if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        btnVideo.classList.toggle('active');
        const icon = btnVideo.querySelector('i');
        icon.classList.toggle('ph-video');
        icon.classList.toggle('ph-video-camera-slash');
    }
}

const btnPip = document.getElementById('btn-pip');
btnPip.addEventListener('click', togglePip);

async function togglePip() {
    try {
        if (document.pictureInPictureElement) {
            await document.exitPictureInPicture();
        } else {
            // Priority: First Remote Peer -> Screen Share -> My Video
            const videos = Array.from(document.querySelectorAll('video'));
            const remoteVideo = videos.find(v => !v.closest('.is-local'));
            const targetVideo = remoteVideo || videos[0]; // Fallback to self

            if (targetVideo && targetVideo.readyState >= 1) {
                await targetVideo.requestPictureInPicture();
            } else {
                showToast('No active video for PiP', 'warning');
            }
        }
    } catch (err) {
        console.error(err);
        showToast('PiP failed: ' + err.message, 'error');
    }
}

async function toggleScreenShare() {
    if (myScreenStream) {
        stopScreenShare();
        return;
    }
    try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        myScreenStream = stream;
        const videoTrack = myScreenStream.getVideoTracks()[0];
        videoTrack.onended = () => stopScreenShare();

        const localVideo = document.querySelector('.video-tile.is-local video');
        if (localVideo) localVideo.srcObject = myScreenStream;

        replaceTrackForPeers(videoTrack);
        btnScreen.classList.add('active');
    } catch (err) { console.error(err); }
}

function stopScreenShare() {
    if (!myScreenStream) return;
    myScreenStream.getTracks().forEach(t => t.stop());
    myScreenStream = null;

    const localVideo = document.querySelector('.video-tile.is-local video');
    if (localVideo) localVideo.srcObject = myStream;

    replaceTrackForPeers(myStream.getVideoTracks()[0]);
    btnScreen.classList.remove('active');
}

function replaceTrackForPeers(newVideoTrack) {
    Object.values(peers).forEach(p => {
        if (p.call && p.call.peerConnection) {
            const sender = p.call.peerConnection.getSenders().find(s => s.track.kind === 'video');
            if (sender) sender.replaceTrack(newVideoTrack);
        }
    });
}

function endCall() {
    if (peer) peer.destroy();
    location.reload();
}

function startTimer() {
    let seconds = 0;
    setInterval(() => {
        seconds++;
        const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
        const secs = (seconds % 60).toString().padStart(2, '0');
        meetingTimer.innerText = `${mins}:${secs}`;
    }, 1000);
}

function showToast(msg, type = 'info') {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerText = msg;
    if (type === 'error') toast.style.borderLeftColor = '#ff2a6d';
    if (type === 'warning') toast.style.borderLeftColor = '#f39c12';

    toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}

// Copy Link Logic
displayMeetingId.addEventListener('click', () => {
    const id = displayMeetingId.innerText;
    const url = `${location.protocol}//${location.host}${location.pathname.replace('index.html', '')}?room=${id}`;

    navigator.clipboard.writeText(url).then(() => {
        showToast('Invite Link Copied!');
    }).catch(() => {
        navigator.clipboard.writeText(id);
        showToast('ID Copied: ' + id);
    });
});

// --- Chat Logic (No Files) ---

// Chat UI Elements
const btnChat = document.getElementById('btn-chat');
const chatPanel = document.getElementById('chat-panel');
const closeChatBtn = document.getElementById('close-chat-btn');
const chatInput = document.getElementById('chat-input');
const btnSend = document.getElementById('btn-send');
const chatMessages = document.getElementById('chat-messages');
const unreadBadge = document.getElementById('unread-badge');

let unreadCount = 0;
let isChatOpen = false;

// UI Toggles
btnChat.addEventListener('click', toggleChat);
closeChatBtn.addEventListener('click', toggleChat);

function toggleChat() {
    isChatOpen = !isChatOpen;
    if (isChatOpen) {
        chatPanel.classList.remove('hidden');
        chatPanel.classList.add('open'); // For mobile animation
        unreadCount = 0;
        updateBadge();
        chatInput.focus();
    } else {
        chatPanel.classList.add('hidden');
        chatPanel.classList.remove('open');
    }
}

function updateBadge() {
    unreadBadge.innerText = unreadCount;
    if (unreadCount > 0) unreadBadge.classList.remove('hidden');
    else unreadBadge.classList.add('hidden');
}

// Sending Messages
btnSend.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendChatMessage();
});

function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!text) return;

    const msgData = {
        type: 'chat',
        sender: 'Me', // Ideally user's name if we had auth
        text: text,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    appendMessage(msgData, 'my-message');
    broadcastData(msgData);
    chatInput.value = '';
}

function appendMessage(data, type) {
    const div = document.createElement('div');
    div.className = `message ${type}`;

    // Create copy button functionality
    const uniqueId = 'msg-' + Date.now() + Math.random();

    div.innerHTML = `
        <span class="sender-name">${data.sender} ${data.time || ''}</span>
        <div class="message-content">
            <span id="${uniqueId}">${data.text}</span>
            <button class="copy-btn" onclick="window.copyText('${uniqueId}')" title="Copy">
                <i class="ph ph-copy"></i>
            </button>
        </div>
    `;

    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    if (!isChatOpen && type === 'peer-message') {
        unreadCount++;
        updateBadge();
        showToast(`New message from ${data.sender}`);
    }
}

// Global copy function
window.copyText = function (elementId) {
    const text = document.getElementById(elementId).innerText;
    navigator.clipboard.writeText(text).then(() => {
        showToast('Copied to clipboard!');
    }).catch(err => {
        showToast('Failed to copy', 'error');
    });
};

// Data Handling Extension
// Reuse existing handleData, just adding cases
const originalHandleData = handleData;

handleData = function (data) {
    if (data.type === 'chat') {
        appendMessage({
            sender: 'Peer', // Or data.sender if sent
            text: data.text,
            time: data.time
        }, 'peer-message');
    }
    else {
        // Delegate back to original handler for mesh logic
        if (originalHandleData) originalHandleData(data);
    }
};

function broadcastData(data) {
    Object.values(peers).forEach(p => {
        if (p.conn && p.conn.open) {
            p.conn.send(data);
        }
    });
}
