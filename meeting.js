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

        call.on('stream', (userVideoStream) => {
            if (!peers[call.peer]) {
                addVideoStream(userVideoStream, 'Peer', false, call.peer);
                peers[call.peer] = { call: call };
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
            // Optional retry logic could go here
        }
    });

    peer.on('disconnected', () => {
        showToast('Reconnecting...', 'warning');
        peer.reconnect();
    });
}

function connectToHost(destId) {
    const conn = peer.connect(destId);
    conn.on('open', () => {
        conn.send({ type: 'join-request', peerId: myPeerId });
    });
    conn.on('data', (data) => handleData(data));

    callPeer(destId);
}

function callPeer(destId) {
    if (peers[destId]) return;

    // Add slight delay to avoid race conditions in mesh
    setTimeout(() => {
        const call = peer.call(destId, myStream);

        call.on('stream', (userVideoStream) => {
            if (!peers[destId]) {
                addVideoStream(userVideoStream, 'Peer', false, destId);
                peers[destId] = { call: call };
            }
        });

        call.on('close', () => removeVideoStream(destId));
    }, 500);
}

// --- Mesh Logic ---

function handleDataConnection(conn) {
    conn.on('data', (data) => {
        if (isHost && data.type === 'join-request') {
            const newJoinerId = data.peerId;
            const existingPeers = Object.keys(peers);
            conn.send({ type: 'peer-list', peers: existingPeers });

            Object.values(peers).forEach(p => {
                if (p.conn) p.conn.send({ type: 'user-joined', peerId: newJoinerId });
            });

            if (!peers[newJoinerId]) peers[newJoinerId] = {};
            peers[newJoinerId].conn = conn;
        }
        else {
            handleData(data);
        }
    });
}

function handleData(data) {
    if (data.type === 'peer-list') {
        data.peers.forEach(pid => {
            if (pid !== myPeerId) callPeer(pid);
        });
    }
    else if (data.type === 'user-joined') {
        callPeer(data.peerId);
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
