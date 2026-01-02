// main.js – PeerJS File Transfer Application
// High-performance, Resilient Logic:
// 1. Connectivity: Watchdog timer, Auto-reconnect, Public STUN servers
// 2. Firehose Transfer: 16KB chunks, 1024 window, Cumulative ACKs
// 3. Dual-Channel: Persistent signaling, temporary file pipes

// --------------- Configuration & Constants ---------------
const PEER_CONFIG = {
  debug: 1,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' }
    ]
  }
};

const CONNECTION_WATCHDOG_MS = 15000; // 15 seconds to connect or die
const RECONNECT_BASE_DELAY = 1000;
const CHUNK_SIZE = 16 * 1024; // 16KB - Sweet spot for WebRTC
const MAX_WINDOW_SIZE = 1024; // Allow ~16MB in flight
const ACK_INTERVAL = 16; // Send ACK every 16 chunks to reduce CPU load

// --------------- PeerJS + UI helpers ---------------
function getPeerIdFromURL() {
  const url = new URL(window.location.href);
  return url.searchParams.get("join");
}
function show(elem) { if (elem) elem.classList.remove("hidden"); }
function hide(elem) { if (elem) elem.classList.add("hidden"); }
const USER_COLORS = [
  "#1859bb", "#267c26", "#a12c3a", "#8c2cb1", "#b17a2c", "#308898", "#cb482a", "#1f7272", "#b12c8c"
];
function usernameColor(name) {
  if (!name) return "#888";
  let hash = 0;
  for (let i = 0; i < name.length; ++i) hash = (hash * 31 + name.charCodeAt(i)) & 0xffffffff;
  return USER_COLORS[Math.abs(hash) % USER_COLORS.length];
}

// --------------- State ---------------
let peer = null;
let myPeerId = null;
let joinPeerId = getPeerIdFromURL();
let isHost = false;
let mesh = {};                // pid → { conn, status, backoff, lastPing, reconnectTimer, watchdogTimer }
let myUsername = "";
let peerUsernames = {};        // pid → username
let assignedNames = {};
let userCount = 0;
let fileTransferHistory = []; // History for file messages only
let knownMsgIds = new Set();
let hostStatusOverrides = null;
const fileTransfers = {}; // State for ongoing file transfers
let encryptionKeys = {}; // fileMsgId -> CryptoKey
let preSessionFiles = []; // To store files selected before starting a session
let isHostSessionClosed = false; // Flag to track if host explicitly closed session


// --------------- DOM refs ---------------
const startBtn            = document.getElementById("startBtn");
const sessionInfoSection  = document.getElementById("sessionInfoSection");
const linkSection         = document.getElementById("linkSection");
const joinLinkA           = document.getElementById("joinLink");
const qrcodeDiv           = document.getElementById("qrcode");
const qrContainer         = document.getElementById("qrContainer");
const usernameSection     = document.getElementById("usernameSection");
const usernameForm        = document.getElementById("usernameForm");
const usernameInput       = document.getElementById("usernameInput");
const peersSection        = document.getElementById("peersSection");
const peersList           = document.getElementById("peersList");
const copyLinkBtn         = document.getElementById("copyLinkBtn");
const fileTransferSection = document.getElementById("fileTransferSection");
const fileBtn             = document.getElementById("fileBtn");
const fileInput           = document.getElementById("fileInput");
const fileMessagesArea    = document.getElementById("fileMessagesArea");
const sessionInfoHeader = document.getElementById("sessionInfoHeader");
const sessionInfoContent = document.getElementById("sessionInfoContent");
const toggleSessionInfoBtn = document.getElementById("toggleSessionInfoBtn");
const connectedPeerName = document.getElementById("connectedPeerName");
const connectionStatusOverlay = document.getElementById("connection-status-overlay");


// Username helpers
function assignDefaultUsernameToPeer(pid) {
  if (pid === myPeerId && isHost) { assignedNames[pid] = "Host"; return "Host"; }
  if (assignedNames[pid]) return assignedNames[pid];
  userCount += 1;
  const uname = "Participant " + userCount;
  assignedNames[pid] = uname;
  return uname;
}
function assignHostName() {
  assignedNames[myPeerId] = "Host";
  peerUsernames[myPeerId] = "Host";
  myUsername = "Host";
  usernameInput.value = myUsername;
}

// --------------- UI Feedback (Animation) ---------------
/**
 * Triggers a subtle, full-screen pulse animation for connection status changes.
 * @param {'connect' | 'disconnect'} type - The type of event.
 */
function triggerConnectionAnimation(type) {
  if (!connectionStatusOverlay) return;
  const className = type === 'connect' ? 'animate-connect' : 'animate-disconnect';

  // Remove any existing animation classes to reset
  connectionStatusOverlay.classList.remove('animate-connect', 'animate-disconnect');

  // We use a timeout to allow the browser to remove the class before adding it again,
  // which is necessary to re-trigger the animation.
  setTimeout(() => {
    connectionStatusOverlay.classList.add(className);
  }, 10);

  // Remove the class after the animation is done
  setTimeout(() => {
    connectionStatusOverlay.classList.remove(className);
  }, 2200); // Must match the animation duration in CSS
}

// --------------- File Message UI ---------------
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function addFileMessage({ fileMsgId, fileName, fileSize, senderId, username, encrypted = false }) {
  if (!fileMessagesArea) return;
  if (fileMessagesArea.querySelector(`[data-file-msg-id="${fileMsgId}"]`)) return;

  const isSender = senderId === myPeerId;
  const div = document.createElement('div');
  div.className = 'message-tile file ' + (isSender ? 'outgoing' : 'incoming');
  div.dataset.fileMsgId = fileMsgId;
  div.setAttribute('data-file-msg-id', fileMsgId);
  div.innerHTML = `
    <div class="file-tile-content">
        <div class="message-header">
            <span class="message-user-dot" style="background:${usernameColor(username)};"></span>
            <span class="message-username" style="color:${usernameColor(username)};">${username}</span>
        </div>
        <div class="file-meta-row">
            <span class="material-icons file-icon">insert_drive_file</span>
            <span class="file-name" title="${fileName}">${fileName}</span>
            <span class="file-size">${formatFileSize(fileSize)} ${encrypted ? '<span class="material-icons" style="font-size:16px; margin-left:4px;" title="Encrypted">lock</span>' : ''}</span>
        </div>
        <div class="file-progress-bar hidden"><div class="file-progress-bar-inner"></div></div>
        <div class="file-status-msg" style="font-size:0.92em;"></div>
    </div>
    <div class="file-tile-actions">
      ${!isSender ? `
      <button class="file-download-link icon-btn" title="Download" aria-label="Download">
        <span class="material-icons">download</span>
      </button>` : ''}
      ${isSender ? `
      <button class="file-delete-btn icon-btn" title="Delete" aria-label="Delete">
        <span class="material-icons">delete</span>
      </button>` : ''}
      <button class="file-cancel-link icon-btn hidden" title="Cancel" aria-label="Cancel">
        <span class="material-icons">cancel</span>
      </button>
    </div>
  `;
  fileMessagesArea.appendChild(div);
  fileMessagesArea.scrollTop = fileMessagesArea.scrollHeight;
}

function updateFileTileUI(tile, { status, progress, error, reason }) {
  const downloadBtn = tile.querySelector('.file-download-link');
  const cancelBtn = tile.querySelector('.file-cancel-link');
  const progressBar = tile.querySelector('.file-progress-bar');
  const progressInner = tile.querySelector('.file-progress-bar-inner');
  const statusMsg = tile.querySelector('.file-status-msg');

  if (status === 'downloading') {
    if (downloadBtn) {
        downloadBtn.disabled = true;
        downloadBtn.classList.add('hidden');
    }
    cancelBtn.classList.remove('hidden');
    progressBar.classList.remove('hidden');
    progressInner.style.width = Math.round(progress * 100) + '%';
    statusMsg.textContent = '⬇️ Receiving file...';
  } else if (status === 'completed') {
    if (downloadBtn) {
        downloadBtn.disabled = false;
        downloadBtn.classList.remove('hidden');
    }
    cancelBtn.classList.add('hidden');
    progressBar.classList.add('hidden');
    statusMsg.textContent = '✅ File saved';
  } else if (status === 'canceled') {
    if (downloadBtn) {
        downloadBtn.disabled = false;
        downloadBtn.classList.remove('hidden');
    }
    cancelBtn.classList.add('hidden');
    progressBar.classList.add('hidden');
    if (reason === 'user') statusMsg.textContent = '❌ You canceled';
    else if (reason === 'sender') statusMsg.textContent = '🚫 Peer canceled';
    else if (reason === 'connection') statusMsg.textContent = '⚠️ Connection dropped';
    else if (error) statusMsg.textContent = '❗ Error: ' + error;
    else statusMsg.textContent = '❌ Canceled';
  } else {
    if (downloadBtn) {
        downloadBtn.disabled = false;
        downloadBtn.classList.remove('hidden');
    }
    cancelBtn.classList.add('hidden');
    progressBar.classList.add('hidden');
    statusMsg.textContent = '';
  }
}

// --------------- Peer List UI ---------------
function getPeerStatus(pid) {
  if (isHost) {
    if (pid === myPeerId) return "connected";
    const entry = mesh[pid];
    if (!entry) return "disconnected";
    if (entry.status === "disconnected") return "disconnected";
    if (entry.conn && entry.conn.open) return "connected";
    return "disconnected";
  }
  if (hostStatusOverrides) {
    if (pid === joinPeerId) return hostStatusOverrides[pid] || "disconnected";
    return hostStatusOverrides[pid] || "disconnected";
  }
  const entry = mesh[pid];
  if (entry && entry.status === "connecting") return "connecting";
  if (pid === joinPeerId && window._hostSessionEnded) return "session_ended";
  return "disconnected";
}

function updatePeersList() {
  const list = peersList;
  if (!list) return;

  // --- SPECIAL HANDLING FOR PEERS (Non-Host) ---
  // If we are a peer and we are disconnected or the host closed session
  if (!isHost && joinPeerId) {
    const hostStatus = getPeerStatus(joinPeerId);

    // CASE 1: Host explicitly closed session
    if (isHostSessionClosed) {
        list.innerHTML = `
            <li style="justify-content: center; color: var(--status-disconnected); font-weight: 500;">
                ❌ Host closed the session
            </li>
        `;
        connectedPeerName.textContent = "Session Ended";
        show(peersSection);
        if (sessionInfoSection) sessionInfoSection.classList.remove("collapsed");
        return; // Stop processing normal list
    }

    // CASE 2: Disconnected (Network error / Timeout)
    if (hostStatus === 'disconnected' || hostStatus === 'offline') {
        list.innerHTML = `
            <li style="flex-direction: column; height: auto; gap: 8px; padding: 16px;">
                <span style="color: var(--status-disconnected); font-weight: 500;">
                    ⚠️ You have been disconnected
                </span>
                <button id="manualReconnectBtn" class="primary-btn" style="height: 32px; font-size: 13px; width: 100%;">
                    Reconnect
                </button>
            </li>
        `;

        // Bind the reconnect button
        // We use setTimeout to ensure the element is in DOM
        setTimeout(() => {
            const btn = document.getElementById('manualReconnectBtn');
            if (btn) {
                btn.onclick = () => {
                    btn.textContent = 'Reconnecting...';
                    btn.disabled = true;
                    // Reset backoff and try immediately
                    if (mesh[joinPeerId]) mesh[joinPeerId].backoff = 0;
                    tryConnectTo(joinPeerId, 0);
                };
            }
        }, 0);

        connectedPeerName.textContent = "Offline";
        show(peersSection);
        if (sessionInfoSection) sessionInfoSection.classList.remove("collapsed");
        return; // Stop processing normal list
    }
  }

  // --- STANDARD LIST RENDERING (Host or Connected Peer) ---
  const entries = Object.entries(peerUsernames);
  const hostPid = isHost ? myPeerId : joinPeerId;
  const hostEntry = entries.find(([pid, _]) => pid === hostPid);
  const peerEntries = entries.filter(([pid, _]) => pid !== hostPid);

  peerEntries.sort((a, b) => {
    const mA = /^Participant (\d+)$/.exec(a[1]);
    const mB = /^Participant (\d+)$/.exec(b[1]);
    if (mA && mB) return Number(mA[1]) - Number(mB[1]);
    if (mA) return -1;
    if (mB) return 1;
    return a[1].localeCompare(b[1], undefined, { numeric: true });
  });

  list.innerHTML = "";
  if (hostEntry) {
    const [pid, uname] = hostEntry;
    let status = getPeerStatus(pid);
    if (!isHost && !hostStatusOverrides && pid === joinPeerId) status = "connecting";
    // Check if actually connected to host locally
    if(!isHost && pid === joinPeerId && mesh[pid] && mesh[pid].status === 'connected') status = 'connected';

    let statusText =
      status === "connected" ? "Connected" :
      status === "connecting" ? "Connecting..." :
      status === "session_ended" ? "Session Ended" : "Offline";
    let statusClass = status;
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="peer-color-dot" style="background:${usernameColor(uname)};"></span>
      <span class="peer-username">${uname}</span>
      <span class="peer-status ${statusClass}">${statusText}</span>`;
    list.appendChild(li);
  }
  peerEntries.forEach(([pid, uname]) => {
    let status = getPeerStatus(pid);
    let statusText =
      status === "connected" ? "Connected" :
      status === "connecting" ? "Connecting..." :
      status === "session_ended" ? "Session Ended" : "Offline";
    let statusClass = status;
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="peer-color-dot" style="background:${usernameColor(uname)};"></span>
      <span class="peer-username">${uname}</span>
      <span class="peer-status ${statusClass}">${statusText}</span>`;
    list.appendChild(li);
  });

  let hasActiveConnection = false;

  if (isHost) {
    const connectedPeersCount = Object.keys(mesh).filter(pid => mesh[pid].status === "connected" && pid !== myPeerId).length;
    if (connectedPeersCount > 0) {
      connectedPeerName.textContent = `${connectedPeersCount} active`;
      show(peersSection);
      hasActiveConnection = true;
    } else {
      connectedPeerName.textContent = "Waiting for connections...";
      hide(peersSection);
      hasActiveConnection = false;
    }
  } else {
    if (getPeerStatus(joinPeerId) === "connected") {
      connectedPeerName.textContent = peerUsernames[joinPeerId] || "Host";
      show(peersSection);
      hasActiveConnection = true;
    } else {
      connectedPeerName.textContent = "Offline";
      hide(peersSection);
      hasActiveConnection = false;
    }
  }

  // NOTE: Auto-expand when no connection logic is handled here
  // But we want to auto-CLOSE when connected. That logic is inside setupConnHandlers -> conn.on('open')
}

function getAllStatuses() {
  const m = {};
  Object.keys(peerUsernames).forEach(pid => (m[pid] = getPeerStatus(pid)));
  return m;
}

function broadcastUserListWithStatus() {
  if (!isHost) return;
  const payload = { type: "userlist", users: { ...peerUsernames }, statuses: getAllStatuses() };
  Object.values(mesh).forEach(ent => {
    if (ent.conn && ent.conn.open && ent.status === "connected") {
      try { ent.conn.send(payload); } catch (_) {}
    }
  });
}

function toggleSessionInfo() {
  sessionInfoSection.classList.toggle("collapsed");
}
if (toggleSessionInfoBtn) toggleSessionInfoBtn.addEventListener("click", toggleSessionInfo);


// --------------- Networking ---------------
function broadcastData(msg, exceptPeerId = null) {
  Object.entries(mesh).forEach(([pid, ent]) => {
    if (pid === exceptPeerId) return;
    if (ent.conn && ent.conn.open && ent.status === "connected") {
      try { ent.conn.send(msg); } catch (_) {}
    }
  });
  if (msg && msg.type === 'file') {
    if (!fileTransferHistory.find(m => m.type === 'file' && m.fileMsgId === msg.fileMsgId)) {
      fileTransferHistory.push(msg);
    }
  }
}

function sendHistoryToPeer(conn) {
  if (conn && conn.open) {
    try {
      const historyWithFileType = fileTransferHistory.map(msg => {
        if (msg.fileMsgId) {
          let newMsg = { ...msg };
          if (!newMsg.type) newMsg.type = 'file';
          if (!newMsg.msgId) newMsg.msgId = `filemsg-${newMsg.fileMsgId}`;
          return newMsg;
        }
        return msg;
      });
      conn.send({ type: "history", files: historyWithFileType });
    } catch (_) {}
  }
}

// --------------- Connection handlers ---------------
async function setupConnHandlers(conn, pid, isIncoming) {
  const entry = mesh[pid];
  if (!entry) return; // Should exist from tryConnectTo or incoming handler

  entry.conn = conn;
  if (conn._setupDone) return;
  conn._setupDone = true;

  // Clear watchdog if it exists
  if (entry.watchdogTimer) {
      clearTimeout(entry.watchdogTimer);
      entry.watchdogTimer = null;
  }

  conn.on("open", async () => {
    entry.status = "connected";
    entry.backoff = RECONNECT_BASE_DELAY; // Reset backoff
    if (entry.reconnectTimer) { clearTimeout(entry.reconnectTimer); entry.reconnectTimer = null; }
    entry.lastPing = Date.now();
    isHostSessionClosed = false; // Reset close flag on new connection

    if (!peerUsernames[pid]) peerUsernames[pid] = assignDefaultUsernameToPeer(pid);
    else assignDefaultUsernameToPeer(pid);

    // Update List & UI
    updatePeersList();
    show(fileTransferSection);

    // Trigger animation
    triggerConnectionAnimation('connect');

    // FORCE CLOSE THE SESSION INFO PANEL AFTER CONNECTION IS ESTABLISHED
    // We add a small delay to ensure UI updates are processed first
    setTimeout(() => {
        if (sessionInfoSection && !sessionInfoSection.classList.contains("collapsed")) {
            sessionInfoSection.classList.add("collapsed");
        }
    }, 500);

    if (isHost) {
      if (Object.keys(peerUsernames).length === 1) assignHostName();
      if (pid !== myPeerId) {
        conn.send({
          type: "assignName",
          username: peerUsernames[pid],
          peerId: pid,
          allStatuses: getAllStatuses()
        });
      }

      if (preSessionFiles.length > 0) {
        fileMessagesArea.innerHTML = '';
        const filesToSend = [...preSessionFiles];
        preSessionFiles = [];
        const sendPromises = filesToSend.map(file => sendFile(file));
        await Promise.all(sendPromises);
      }

      broadcastUserListWithStatus();
      sendHistoryToPeer(conn);
    } else {
      if (myUsername && conn.open) {
        conn.send({ type: "username", username: myUsername, reqUserList: true });
      }
    }
  });

  function handleDisconnect() {
    entry.status = "disconnected";
    if (hostStatusOverrides) hostStatusOverrides[pid] = "disconnected";
    if (pid === joinPeerId && !isHost) {
      window._hostSessionEnded = true;
      hostStatusOverrides = null;
      triggerConnectionAnimation('disconnect');
    }
    updatePeersList();
    if (isHost) broadcastUserListWithStatus();
    scheduleReconnect(pid);
    triggerConnectionAnimation('disconnect');
  }

  conn.on("close", handleDisconnect);
  conn.on("error", handleDisconnect);
  conn.on("data", data => {
    entry.lastPing = Date.now();
    if (data && data.type === "ping") { conn.send({ type: "pong" }); return; }
    if (data && data.type === "pong") return;
    onDataReceived(data, pid, conn);
  });
}

/**
 * Robust connection attempt with Watchdog and Auto-Reconnect.
 */
function tryConnectTo(pid, backoff = 1000) {
  if (pid === myPeerId) return;

  const entry = mesh[pid] || (mesh[pid] = {});
  if (entry.status === "connected" || (entry.conn && entry.conn.open)) return;

  // Watchdog: If we are stuck in 'connecting' for 15s, kill it and retry.
  if (entry.status === "connecting") {
      // Already connecting, do nothing, let the existing watchdog handle it.
      return;
  }

  console.log(`Attempting connection to ${pid}... (Backoff: ${backoff}ms)`);
  entry.status = "connecting";
  updatePeersList();

  const conn = peer.connect(pid, { reliable: true });
  entry.conn = conn;

  // Set Watchdog
  entry.watchdogTimer = setTimeout(() => {
      if (entry.status === "connecting") {
          console.warn(`Connection to ${pid} timed out (Watchdog). Retrying...`);
          if (conn) conn.close();
          entry.status = "disconnected";
          updatePeersList();
          scheduleReconnect(pid);
      }
  }, CONNECTION_WATCHDOG_MS);

  setupConnHandlers(conn, pid, false);
}

function scheduleReconnect(pid) {
  const entry = mesh[pid];
  if (!entry || entry.reconnectTimer) return;
  // Increase backoff exponentially
  entry.backoff = Math.min((entry.backoff || RECONNECT_BASE_DELAY) * 1.5, 20000);

  console.log(`Scheduling reconnect to ${pid} in ${entry.backoff}ms`);
  entry.reconnectTimer = setTimeout(() => {
    entry.reconnectTimer = null;
    tryConnectTo(pid, entry.backoff);
  }, entry.backoff);
}

// --------------- Data handling ---------------
async function onDataReceived(data, fromPid, conn) {
  if (data && data.type === "assignName" && data.username && data.peerId) {
    if (data.peerId === myPeerId) {
      myUsername = data.username;
      usernameInput.value = myUsername;
    }
    peerUsernames[data.peerId] = data.username;
    assignedNames[data.peerId] = data.username;
    updatePeersList();
    return;
  }
  if (data && data.type === "userlist" && data.users) {
    peerUsernames = { ...data.users };
    hostStatusOverrides = data.statuses || null;
    updatePeersList();
    return;
  }
  if (data && data.type === "username" && typeof data.username === "string") {
    const pid = data.peerId || fromPid;
    const newName = data.username.substring(0, 20);
    peerUsernames[pid] = newName;
    assignedNames[pid] = newName;
    updatePeersList();
    if (isHost) broadcastUserListWithStatus();
    return;
  }
  if (data && data.type === "history" && Array.isArray(data.files)) {
    let addedFile = false;
    for (const msg of data.files) {
      if (msg && msg.fileMsgId && !msg.msgId) msg.msgId = `filemsg-${msg.fileMsgId}`;
      if (msg && msg.msgId && !knownMsgIds.has(msg.msgId)) {
        knownMsgIds.add(msg.msgId);
        if (msg.type === 'file') {
          if (!fileTransferHistory.find(m => m.type === 'file' && m.fileMsgId === msg.fileMsgId)) {
            fileTransferHistory.push(msg);
            addedFile = true;
            if (msg.encrypted && msg.encryptionKey) {
                try {
                    const importedKey = await importKey(new Uint8Array(msg.encryptionKey));
                    encryptionKeys[msg.fileMsgId] = importedKey;
                } catch (e) {
                    console.error("Failed to import encryption key from history:", e);
                }
            }
          }
        }
      }
    }
    if (addedFile) renderFileTransferHistory();
    return;
  }
  if (data && data.type === 'goodbye' && data.peerId) {
    const pid = data.peerId;
    if (mesh[pid]) mesh[pid].status = 'disconnected';
    if (hostStatusOverrides) hostStatusOverrides[pid] = 'disconnected';

    // Explicitly handle Host closure
    if (!isHost && pid === joinPeerId) {
        isHostSessionClosed = true;
        // Optional: cancel pending reconnects
        if (mesh[pid] && mesh[pid].reconnectTimer) {
             clearTimeout(mesh[pid].reconnectTimer);
             mesh[pid].reconnectTimer = null;
        }
    }

    updatePeersList();
    if (isHost) broadcastUserListWithStatus();
    triggerConnectionAnimation('disconnect');
    return;
  }
  if (data && data.type === 'file-delete' && data.fileMsgId) {
    const fileMsgId = data.fileMsgId;
    const tile = fileMessagesArea.querySelector(`[data-file-msg-id="${fileMsgId}"]`);
    if (tile) tile.remove();
    fileTransferHistory = fileTransferHistory.filter(msg => msg.fileMsgId !== fileMsgId);
    return;
  }
  if (data && data.type === 'file') {
    await handleFileMessage(data);
    return;
  }
}

function renderFileTransferHistory() {
  if (!fileMessagesArea) return;
  fileMessagesArea.innerHTML = "";
  fileTransferHistory.forEach(msg => {
    if (msg.type === 'file') {
      addFileMessage(msg);
    }
  });
}

window.addEventListener('unload', () => {
  broadcastData({ type: 'goodbye', peerId: myPeerId });
});

function startKeepAlive() {
  setInterval(() => {
    Object.entries(mesh).forEach(([pid, entry]) => {
      if (entry.status === "connected" && entry.conn && entry.conn.open) {
        try { entry.conn.send({ type: "ping" }); } catch (_) {}
      }
      if (Date.now() - (entry.lastPing || 0) > 5000 && entry.status === "connected") {
        if (hostStatusOverrides) hostStatusOverrides[pid] = 'disconnected';
        entry.status = "disconnected";
        updatePeersList();
        if (isHost) broadcastUserListWithStatus();
        scheduleReconnect(pid);
        triggerConnectionAnimation('disconnect');
      }
    });
    if (isHost && myPeerId) updatePeersList();
  }, 2000);
}

// --------------- Event Listeners ---------------
startBtn.addEventListener("click", () => {
  startBtn.disabled = true;
  hide(startBtn);
  show(sessionInfoSection);
  sessionInfoSection.classList.remove("collapsed");
  isHost = true;
  peerUsernames = {};
  assignedNames = {};
  userCount = 0;
  peer = new Peer(undefined, PEER_CONFIG); // Use robust config

  peer.on("open", id => {
    myPeerId = id;
    show(usernameSection);
    assignHostName();
    const url = `${window.location.origin}${window.location.pathname}?join=${encodeURIComponent(id)}`;
    joinLinkA.href = url;
    joinLinkA.textContent = url;
    show(linkSection);
    show(qrContainer);
    qrcodeDiv.innerHTML = '';
    new QRCode(qrcodeDiv, {
      text: url,
      width: 180,
      height: 180,
      colorDark: "#000000",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M,
      margin: 2
    });
    peer.on("connection", conn => {
      const pid = conn.peer;
      // Identify if this is a file transfer channel or main channel
      if (conn.metadata && conn.metadata.action === 'download') {
          handleFileDownloadConnection(conn);
      } else {
          mesh[pid] = { conn, status: "connecting", backoff: RECONNECT_BASE_DELAY, lastPing: Date.now() };
          show(peersSection);
          setupConnHandlers(conn, pid, true);
      }
    });
    peer.on("error", err => console.error("PeerJS error:", err));
  });
  startKeepAlive();
});

function joinMesh() {
  show(sessionInfoSection);
  sessionInfoSection.classList.remove("collapsed");
  peer = new Peer(undefined, PEER_CONFIG); // Use robust config

  peer.on("open", id => {
    myPeerId = id;
    show(usernameSection);
    show(peersSection);
    show(linkSection);
    hide(qrContainer);
    const url = `${window.location.origin}${window.location.pathname}?join=${encodeURIComponent(joinPeerId)}`;
    joinLinkA.href = url;
    joinLinkA.textContent = url;

    tryConnectTo(joinPeerId, RECONNECT_BASE_DELAY);
  });

  peer.on("connection", conn => {
    const pid = conn.peer;
     if (conn.metadata && conn.metadata.action === 'download') {
         handleFileDownloadConnection(conn);
     } else {
         mesh[pid] = { conn, status: "connecting", backoff: RECONNECT_BASE_DELAY, lastPing: Date.now() };
         setupConnHandlers(conn, pid, true);
     }
  });
  peer.on("error", err => {
      console.error("PeerJS error:", err);
      // If error is fatal/disconnect, try to reconnect to host
      if (err.type === 'peer-unavailable' || err.type === 'disconnected') {
           scheduleReconnect(joinPeerId);
      }
  });
  startKeepAlive();
}

if (joinPeerId) {
  joinMesh();
  hide(fileTransferSection);
}

usernameForm.addEventListener("submit", e => {
  e.preventDefault();
  const val = usernameInput.value.trim();
  if (!val) { usernameInput.value = myUsername; return; }
  myUsername = val.substring(0, 20);
  usernameInput.value = myUsername;
  peerUsernames[myPeerId] = myUsername;
  assignedNames[myPeerId] = myUsername;
  updatePeersList();
  broadcastData({ type: "username", username: myUsername, peerId: myPeerId });
  if (isHost) broadcastUserListWithStatus();
});

// --------------- Crypto Utility Functions ---------------
async function generateAesGcmKey() {
  return await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

async function encryptData(key, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV is standard for GCM
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv },
    key,
    data
  );
  return { encryptedData: new Uint8Array(encrypted), iv: iv };
}

async function decryptData(key, encryptedData, iv) {
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv },
    key,
    encryptedData
  );
  return new Uint8Array(decrypted);
}

async function exportKey(key) {
  return await crypto.subtle.exportKey("raw", key);
}

async function importKey(rawKey) {
  return await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

// --------------- File Transfer Logic (The "Firehose") ---------------

function renderPreSessionFiles() {
    if (!fileMessagesArea) return;
    fileMessagesArea.innerHTML = '';
    if (preSessionFiles.length === 0) {
        hide(startBtn);
        return;
    }
    preSessionFiles.forEach((file, index) => {
        const div = document.createElement('div');
        div.className = 'message-tile file';
        div.innerHTML = `
            <div class="file-tile-content">
                <div class="file-meta-row">
                    <span class="material-icons file-icon">insert_drive_file</span>
                    <span class="file-name" title="${file.name}">${file.name}</span>
                    <span class="file-size">${formatFileSize(file.size)}</span>
                </div>
            </div>
            <div class="file-tile-actions">
                <button class="remove-file-btn icon-btn" data-index="${index}" title="Remove file" aria-label="Remove file">
                    <span class="material-icons">delete</span>
                </button>
            </div>
        `;
        fileMessagesArea.appendChild(div);
    });
    fileMessagesArea.querySelectorAll('.remove-file-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const indexToRemove = parseInt(e.currentTarget.dataset.index, 10);
            preSessionFiles.splice(indexToRemove, 1);
            renderPreSessionFiles();
        });
    });
    show(startBtn);
}

async function sendFile(file) {
  if (!file) return;

  const fileMsgId = `${myPeerId}-${Date.now()}-${Math.random().toString(16).slice(2,8)}`;
  const encryptionKey = await generateAesGcmKey();
  const exportedKey = await exportKey(encryptionKey);
  encryptionKeys[fileMsgId] = encryptionKey;

  const msg = {
    type: 'file',
    fileMsgId,
    fileName: file.name,
    fileSize: file.size,
    senderId: myPeerId,
    username: myUsername,
    encrypted: true,
    encryptionKey: Array.from(new Uint8Array(exportedKey))
  };

  addFileMessage(msg);
  if (!fileTransfers[fileMsgId]) fileTransfers[fileMsgId] = {};
  // Store file for sending logic later
  fileTransfers[fileMsgId][myPeerId] = { file, status: 'ready', progress: 0 };

  if (!fileTransferHistory.find(m => m.fileMsgId === fileMsgId)) {
    fileTransferHistory.push(msg);
  }
  broadcastData(msg);
}

fileBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async e => {
  const files = e.target.files;
  if (!files || files.length === 0) return;

  if (!peer) {
    for (const file of files) preSessionFiles.push(file);
    renderPreSessionFiles();
  } else {
    const sendPromises = Array.from(files).map(file => sendFile(file));
    await Promise.all(sendPromises);
  }
  fileInput.value = '';
});

async function handleFileMessage(msg) {
  if (!fileTransferHistory.find(m => m.type === 'file' && m.fileMsgId === msg.fileMsgId)) {
    fileTransferHistory.push(msg);
  }
  if (msg.encrypted && msg.encryptionKey) {
    try {
      const importedKey = await importKey(new Uint8Array(msg.encryptionKey));
      encryptionKeys[msg.fileMsgId] = importedKey;
    } catch (e) {
      console.error("Failed to import encryption key:", e);
      displayMessageBox('Error', `Failed to import encryption key for file: ${msg.fileName}. Cannot download.`);
      return;
    }
  }

  if (!fileTransfers[msg.fileMsgId]) fileTransfers[msg.fileMsgId] = {};
  if (!fileTransfers[msg.fileMsgId][myPeerId]) {
    fileTransfers[msg.fileMsgId][myPeerId] = { status: 'ready', progress: 0 };
  }
  addFileMessage(msg);
  if (!window.streamSaver) {
    const tile = fileMessagesArea.querySelector(`[data-file-msg-id="${msg.fileMsgId}"]`);
    if (tile) {
      updateFileTileUI(tile, { status: 'canceled', progress: 0, error: 'streamSaver.js not loaded. Please reload.' });
    }
  }
}

fileMessagesArea.addEventListener('click', async function(e) {
  const downloadBtn = e.target.closest('.file-download-link');
  const cancelBtn = e.target.closest('.file-cancel-link');
  const deleteBtn = e.target.closest('.file-delete-btn');
  const tile = e.target.closest('.message-tile.file');

  if (!tile) return;

  const fileMsgId = tile.dataset.fileMsgId;

  if (downloadBtn) {
    if (!window.streamSaver) {
      displayMessageBox('Error', 'File download requires streamSaver.js. Please reload the page.');
      return;
    }
    startFileDownload(tile, fileMsgId);
  } else if (cancelBtn) {
    cancelFileDownload(tile, fileMsgId);
  } else if (deleteBtn) {
      displayMessageBox('Confirm Delete', 'This will remove the file for all participants. Are you sure?', true)
        .then(confirmed => {
            if (confirmed) {
                tile.remove();
                fileTransferHistory = fileTransferHistory.filter(msg => msg.fileMsgId !== fileMsgId);
                broadcastData({ type: 'file-delete', fileMsgId });
            }
        });
  }
});

// --------------- High-Speed Send Logic ---------------
function handleFileDownloadConnection(conn) {
    let activeSender = { canceled: false };

    conn.on('data', async data => {
        if (data && data.type === 'file-request' && data.fileMsgId) {
            const fileMsgId = data.fileMsgId;
            const fileTransferState = fileTransfers[fileMsgId]?.[myPeerId];

            if (!fileTransferState || !fileTransferState.file) {
                conn.send({ type: 'file-error', error: 'File not found locally', fileMsgId });
                conn.close();
                return;
            }

            const file = fileTransferState.file;
            const encryptionKey = encryptionKeys[fileMsgId];
            if (!encryptionKey) {
                conn.send({ type: 'file-error', error: 'Missing encryption key', fileMsgId });
                conn.close();
                return;
            }

            // --- The Firehose Loop ---
            conn.send({ type: 'file-start', fileSize: file.size });

            let offset = 0;
            let chunkId = 0;
            let lastAckedChunkId = -1;
            let lastCheckedBufferedAmount = 0;

            // Handle ACKs (Cumulative)
            // Listen for control messages on this specific connection
            const ackListener = (msg) => {
                 if (msg.type === 'chunk-ack') {
                     lastAckedChunkId = Math.max(lastAckedChunkId, msg.chunkId);
                 } else if (msg.type === 'file-cancel') {
                     activeSender.canceled = true;
                 }
            };

            // We need a way to hook into the data listener we are currently in.
            // Since PeerJS 'data' event is persistent, we can't easily add a second listener just for this scope.
            // Instead, we will assume the client is sending ACKs and we check them.
            // IMPORTANT: In this simplified "firehose" logic, we rely on the main listener for ACKs.
            // BUT, this is a dedicated connection. So we can re-assign on('data')?
            // PeerJS supports multiple listeners. Let's add one.
            conn.on('data', ackListener);

            try {
                while (offset < file.size && !activeSender.canceled) {
                    // 1. Backpressure Check
                    if (conn.dataChannel.bufferedAmount > 8 * 1024 * 1024) { // 8MB buffer limit
                        await new Promise(r => setTimeout(r, 50));
                        continue;
                    }

                    // 2. Window Check
                    if (chunkId - lastAckedChunkId > MAX_WINDOW_SIZE) {
                         // Too many un-acked chunks. Wait briefly.
                         await new Promise(r => setTimeout(r, 10));
                         continue;
                    }

                    // 3. Read & Encrypt
                    const slice = file.slice(offset, offset + CHUNK_SIZE);
                    const chunkBuffer = await slice.arrayBuffer();

                    // Encrypt
                    const { encryptedData, iv } = await encryptData(encryptionKey, chunkBuffer);

                    // 4. Send
                    conn.send({
                        type: 'file-chunk',
                        chunkId: chunkId,
                        data: encryptedData,
                        iv: Array.from(iv)
                    });

                    offset += CHUNK_SIZE;
                    chunkId++;
                }

                if (!activeSender.canceled) {
                    conn.send({ type: 'file-end' });
                }

            } catch (err) {
                console.error("Send error:", err);
                conn.send({ type: 'file-error', error: err.message });
            } finally {
                // Cleanup
                setTimeout(() => {
                    if (conn.open) conn.close();
                }, 5000); // Give time for 'file-end' to arrive
            }
        } else if (data && data.type === 'file-cancel') {
            activeSender.canceled = true;
            conn.close();
        }
    });
}

// --------------- High-Speed Download Logic ---------------
async function startFileDownload(tile, fileMsgId) {
  const fileMsg = fileTransferHistory.find(m => m.type === 'file' && m.fileMsgId === fileMsgId);
  if (!fileMsg) {
    updateFileTileUI(tile, { status: 'canceled', error: 'Metadata missing' });
    return;
  }

  // --- DUAL CHANNEL: Open separate connection for download ---
  const conn = peer.connect(fileMsg.senderId, {
      reliable: true,
      metadata: { action: 'download', fileMsgId: fileMsgId }
  });

  const transferState = {
      conn: conn,
      controller: new AbortController(),
      status: 'downloading'
  };

  fileTransfers[fileMsgId] = fileTransfers[fileMsgId] || {};
  fileTransfers[fileMsgId][myPeerId] = transferState;

  updateFileTileUI(tile, { status: 'downloading', progress: 0 });

  conn.on('open', async () => {
      conn.send({ type: 'file-request', fileMsgId });
  });

  // StreamSaver setup
  const fileStream = streamSaver.createWriteStream(fileMsg.fileName, { size: fileMsg.fileSize });
  const writer = fileStream.getWriter();

  let receivedBytes = 0;
  let expectedBytes = fileMsg.fileSize;
  let lastChunkId = -1;

  conn.on('data', async data => {
      if (transferState.status !== 'downloading') return;

      if (data.type === 'file-chunk') {
          try {
              // Decrypt
              const iv = new Uint8Array(data.iv);
              const encrypted = new Uint8Array(data.data);
              const decrypted = await decryptData(encryptionKeys[fileMsgId], encrypted, iv);

              await writer.write(decrypted);
              receivedBytes += decrypted.byteLength;
              lastChunkId = data.chunkId;

              // Update UI
              updateFileTileUI(tile, { status: 'downloading', progress: receivedBytes / expectedBytes });

              // Cumulative ACK
              if (data.chunkId % ACK_INTERVAL === 0) {
                  conn.send({ type: 'chunk-ack', chunkId: data.chunkId });
              }

          } catch (e) {
              console.error("Write/Decrypt error:", e);
              abortDownload("Write Error", 'error');
          }
      } else if (data.type === 'file-end') {
          // Send final ACK
          conn.send({ type: 'chunk-ack', chunkId: lastChunkId });
          await writer.close();
          transferState.status = 'completed';
          updateFileTileUI(tile, { status: 'completed', progress: 1 });
          setTimeout(() => conn.close(), 1000);
      } else if (data.type === 'file-error') {
          abortDownload(data.error, 'sender');
      }
  });

  conn.on('close', () => {
      if (transferState.status === 'downloading') {
          abortDownload('Connection closed unexpectedly', 'connection');
      }
  });

  function abortDownload(msg, reason) {
      if (transferState.status !== 'downloading') return;
      transferState.status = 'canceled';
      transferState.controller.abort();
      writer.abort().catch(()=>{});
      conn.close();
      updateFileTileUI(tile, { status: 'canceled', error: msg, reason: reason });
  }

  // Hook up cancel button logic
  transferState.cancel = () => {
      if (conn.open) conn.send({ type: 'file-cancel' });
      abortDownload('Canceled by you', 'user');
  };
}

function cancelFileDownload(tile, fileMsgId) {
  const transfer = fileTransfers[fileMsgId]?.[myPeerId];
  if (transfer && transfer.cancel) {
    transfer.cancel();
  }
}

// Custom message box
function displayMessageBox(title, message, isConfirm = false) {
    return new Promise(resolve => {
        const existingBox = document.getElementById('customMessageBox');
        if (existingBox) existingBox.remove();

        const messageBox = document.createElement('div');
        messageBox.id = 'customMessageBox';
        messageBox.style.cssText = `
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            background: var(--card); border: 1px solid var(--border); border-radius: 16px;
            padding: 20px; box-shadow: 0 4px 8px rgba(0,0,0,0.2); z-index: 10000;
            max-width: 90%; width: 320px; text-align: center; color: var(--text);
        `;

        const buttonsHtml = isConfirm
            ? `<button id="messageBoxConfirmBtn" class="primary-btn" style="margin-right: 8px; background: var(--status-disconnected); color: var(--text);">Delete</button>
               <button id="messageBoxCancelBtn" class="primary-btn send-file-btn">Cancel</button>`
            : `<button id="messageBoxCloseBtn" class="primary-btn" style="margin-top:15px;">OK</button>`;

        messageBox.innerHTML = `
            <h3 style="margin-top:0; color: var(--text);">${title}</h3>
            <p style="margin: 10px 0 20px;">${message}</p>
            <div>${buttonsHtml}</div>
        `;

        document.body.appendChild(messageBox);

        if (isConfirm) {
            document.getElementById('messageBoxConfirmBtn').addEventListener('click', () => { messageBox.remove(); resolve(true); });
            document.getElementById('messageBoxCancelBtn').addEventListener('click', () => { messageBox.remove(); resolve(false); });
        } else {
            document.getElementById('messageBoxCloseBtn').addEventListener('click', () => { messageBox.remove(); resolve(true); });
        }
    });
}

// Copy join link
if (copyLinkBtn && joinLinkA) {
  copyLinkBtn.addEventListener('click', () => {
    const link = joinLinkA.href;
    if (link && link !== '#') {
        navigator.clipboard.writeText(link).then(() => {
          const originalIcon = copyLinkBtn.innerHTML;
          copyLinkBtn.innerHTML = '<span class="material-icons" style="color:#4CAF50">check</span>';
          setTimeout(() => { copyLinkBtn.innerHTML = originalIcon; }, 1500);
        }).catch(() => {});
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  renderFileTransferHistory();
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/service-worker.js').catch(err => console.error('SW failed:', err));
    });
  }
});