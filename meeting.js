/**
 * Stegure Meeting - Core Logic
 */

// State
let myPeerId = null;
let peer = null;
let myStream = null;
let myScreenStream = null;
const peers = {}; // Keep track of active calls: { peerId: { call, conn, videoEl } }
let isHost = false;
let hostId = null; // If I am joiner, who is host?

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
        // Optional: Auto-click join?
        // Let's just fill it and let user click JOIN to ensure interaction/permissions
        showToast('Room ID loaded from link. Click JOIN.', 'info');
    }
});

// --- Initialization & Event Listeners ---

joinBtn.addEventListener('click', () => {
    const id = meetingIdInput.value.trim();
    if (id) startMeeting(false, id);
    else showToast('Please enter a Meeting ID', 'error');
});

createBtn.addEventListener('click', () => {
    const newId = generateId(); // 'Steg-' + Math.random()...
    startMeeting(true, newId);
});

// Media Controls
btnMic.addEventListener('click', toggleAudio);
btnVideo.addEventListener('click', toggleVideo);
btnScreen.addEventListener('click', toggleScreenShare);
btnEnd.addEventListener('click', endCall);


// --- Core Meeting Logic ---

async function startMeeting(asHost, id) {
    try {
        // 1. Get Local Stream
        myStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true
        });

        // 2. Add Myself to Grid
        addVideoStream(myStream, 'Me', true);

        // 3. UI Transition
        landingOverlay.classList.add('hidden');
        meetingContainer.classList.remove('hidden');
        startTimer();

        // 4. Initialize Peer
        isHost = asHost;
        if (asHost) {
            hostId = id;
            myPeerId = id;
            displayMeetingId.innerText = id;
            initPeer(id);
        } else {
            // Joiner: Generate random temp ID (null lets PeerJS generate one)
            // But we need to connect TO 'id'
            hostId = id;
            displayMeetingId.innerText = id;
            initPeer(null);
        }

    } catch (err) {
        console.error("Error accessing media:", err);
        showToast('Error accessing Camera/Microphone. Allow permissions.', 'error');
    }
}

function initPeer(customId) {
    // Only pass ID if it's the host creating a specific room ID
    const options = customId ? { host: '0.peerjs.com', port: 443, path: '/', secure: true } : undefined;

    // Note: If customId is passed, use it. If null, PeerJS generates one.
    if (customId) {
        peer = new Peer(customId);
    } else {
        peer = new Peer();
    }

    peer.on('open', (id) => {
        myPeerId = id;
        console.log('My Peer ID:', id);

        if (!isHost) {
            // I am a Joiner, connect to Host
            connectToHost(hostId);
        } else {
            showToast('Meeting Created. Share ID: ' + id);
        }
    });

    peer.on('call', (call) => {
        // Answer incoming calls automatically
        console.log('Incoming call from:', call.peer);
        call.answer(myStream);

        const videoEl = document.createElement('div'); // Placeholder, managed in addVideoStream

        call.on('stream', (userVideoStream) => {
            if (!peers[call.peer]) {
                addVideoStream(userVideoStream, 'Peer ' + call.peer.substr(0, 4), false, call.peer);
                peers[call.peer] = { call: call }; // Register call
            }
        });

        call.on('close', () => {
            removeVideoStream(call.peer);
        });

        call.on('error', err => {
            console.error('Call error:', err);
            removeVideoStream(call.peer);
        });
    });

    peer.on('connection', (conn) => {
        // Data connection handling (for Mesh Coordination)
        handleDataConnection(conn);
    });

    peer.on('error', (err) => {
        console.error('Peer error:', err);
        if (err.type === 'unavailable-id') {
            showToast('Meeting ID already taken. Try another.', 'error');
            setTimeout(() => location.reload(), 2000);
        } else if (err.type === 'peer-unavailable') {
            showToast('Peer not found. Check ID or Host is offline.', 'error');
        } else {
            showToast('Connection Error: ' + err.type, 'error');
        }
    });

    peer.on('disconnected', () => {
        showToast('Disconnected from signaling server. Reconnecting...', 'warning');
        peer.reconnect();
    });
}

function connectToHost(destId) {
    // 1. Open Data Connection to Host to announce presence
    const conn = peer.connect(destId);

    conn.on('open', () => {
        // Send join request
        conn.send({ type: 'join-request', peerId: myPeerId });
    });

    conn.on('data', (data) => handleData(data));
    conn.on('error', (err) => console.error("Conn error:", err));

    // Also, normally the Host or other peers will CALL ME once they know I exist.
    // Or, I can call the Host directly now.
    callPeer(destId);
}

function callPeer(destId) {
    if (peers[destId]) return; // Already connected

    const call = peer.call(destId, myStream);

    call.on('stream', (userVideoStream) => {
        if (!peers[destId]) { // Double check
            addVideoStream(userVideoStream, 'Peer ' + destId.substr(0, 4), false, destId);
            peers[destId] = { call: call };
        }
    });

    call.on('close', () => {
        removeVideoStream(destId);
    });
}

// --- Mesh Logic (Data connections) ---

function handleDataConnection(conn) {
    conn.on('data', (data) => {
        // Host Logic: When someone joins, tell everyone else
        if (isHost && data.type === 'join-request') {
            const newJoinerId = data.peerId;

            // 1. Tell new user about existing peers
            const existingPeers = Object.keys(peers);
            conn.send({ type: 'peer-list', peers: existingPeers }); // Send list to new guy

            // 2. Tell existing peers about new user
            Object.values(peers).forEach(p => {
                if (p.conn) p.conn.send({ type: 'user-joined', peerId: newJoinerId });
            });

            // 3. Save connection for future broadcasts
            if (!peers[newJoinerId]) peers[newJoinerId] = {};
            peers[newJoinerId].conn = conn;
        }
        else {
            handleData(data); // Normal handling
        }
    });
}

function handleData(data) {
    // Joiner Logic
    if (data.type === 'peer-list') {
        // Connect to everyone in the list
        data.peers.forEach(pid => {
            if (pid !== myPeerId) callPeer(pid);
        });
    }
    else if (data.type === 'user-joined') {
        // Someone new joined the mesh, call them!
        callPeer(data.peerId);
    }
}


// --- UI Functions ---

function addVideoStream(stream, name, isLocal, peerId) {
    if (peerId && document.getElementById('video-' + peerId)) return; // Already exists

    const clone = videoTemplate.content.cloneNode(true);
    const tile = clone.querySelector('.video-tile');
    const video = clone.querySelector('video');
    const nameTag = clone.querySelector('.name-tag');

    video.srcObject = stream;
    nameTag.innerText = name;

    if (isLocal) {
        tile.classList.add('is-local');
        video.muted = true; // Mute local video to prevent feedback/echo
    } else {
        tile.id = 'video-' + peerId;
    }

    video.addEventListener('loadedmetadata', () => {
        video.play();
    });

    videoGrid.appendChild(tile);
    recalcGrid();
}

function removeVideoStream(peerId) {
    const tile = document.getElementById('video-' + peerId);
    if (tile) tile.remove();
    if (peers[peerId]) delete peers[peerId];
    recalcGrid();
    showToast('Peer disconnected');
}

function recalcGrid() {
    // Handled by CSS Grid usually, but we can adjust if needed
    // meeting.css uses grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
}

function generateId() {
    return 'Room-' + Math.floor(Math.random() * 10000);
}

// --- Media Control Handlers ---

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
    // If already sharing screen, switch back to cam
    if (myScreenStream) {
        stopScreenShare();
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        myScreenStream = stream;

        const videoTrack = myScreenStream.getVideoTracks()[0];

        // Listen for user clicking "Stop Sharing" on system UI
        videoTrack.onended = () => stopScreenShare();

        // Local Preview
        const localVideoTile = document.querySelector('.video-tile.is-local video');
        if (localVideoTile) localVideoTile.srcObject = myScreenStream;

        // Replace track for all peers
        replaceTrackForPeers(videoTrack);

        btnScreen.classList.add('active');

    } catch (err) {
        console.error("Screen share cancel/error", err);
    }
}

function stopScreenShare() {
    if (!myScreenStream) return;

    // Stop screen tracks
    myScreenStream.getTracks().forEach(track => track.stop());
    myScreenStream = null;

    // Switch back to camera
    const webcamTrack = myStream.getVideoTracks()[0];
    const localVideoTile = document.querySelector('.video-tile.is-local video');
    if (localVideoTile) localVideoTile.srcObject = myStream;

    replaceTrackForPeers(webcamTrack);

    btnScreen.classList.remove('active');
}

function replaceTrackForPeers(newVideoTrack) {
    Object.values(peers).forEach(p => {
        if (p.call && p.call.peerConnection) {
            const sender = p.call.peerConnection.getSenders().find(s => s.track.kind === 'video');
            if (sender) {
                sender.replaceTrack(newVideoTrack);
            }
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
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        meetingTimer.innerText = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }, 1000);
}

function showToast(msg, type = 'info') {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerText = msg;
    if (type === 'error') toast.style.borderLeftColor = '#ff2a6d';

    toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}

// Copy Invite Link
displayMeetingId.addEventListener('click', () => {
    const id = displayMeetingId.innerText;
    const protocol = location.protocol;
    const host = location.host;
    const path = location.pathname.replace('index.html', ''); // Clean path

    // Construct simplified URL
    const url = `${protocol}//${host}${path}?room=${id}`;

    navigator.clipboard.writeText(url).then(() => {
        showToast('Invite Link Copied! Share this URL.');
    }).catch(() => {
        // Fallback if clipboard fails (rare)
        navigator.clipboard.writeText(id);
        showToast('Meeting ID Copied (Link copy failed)');
    });
});

function helperTextOrVal(txt) { return txt; }
