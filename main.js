// main.js – PeerJS File Transfer Application
// This file integrates PeerJS logic with the file transfer features and manages UI.

// The theme logic has been moved to theme.js to be shared across all pages.

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
let mesh = {};                // pid → { conn, status, backoff, lastPing }
let myUsername = "";
let peerUsernames = {};        // pid → username
let assignedNames = {};
let userCount = 0;
let fileTransferHistory = []; // History for file messages only
let knownMsgIds = new Set();
let hostStatusOverrides = null;
const fileTransfers = {}; // State for ongoing file transfers
let encryptionKeys = {}; // Stores CryptoKey objects for sending, or imported keys for receiving (fileMsgId -> CryptoKey)
let preSessionFiles = []; // To store files selected before starting a session


// --------------- DOM refs ---------------
const startBtn            = document.getElementById("startBtn");
const startSection        = document.getElementById("startSection"); // This section is removed from HTML but ref is kept to avoid errors if logic expects it
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
const connectionStatusOverlay = document.getElementById("connection-status-overlay");
// New DOM references for collapsible session info
const sessionInfoHeader = document.getElementById("sessionInfoHeader");
const sessionInfoContent = document.getElementById("sessionInfoContent");
const toggleSessionInfoBtn = document.getElementById("toggleSessionInfoBtn");
const connectedPeerName = document.getElementById("connectedPeerName");


// Username helpers
function assignDefaultUsernameToPeer(pid) {
  if (pid === myPeerId && isHost) { assignedNames[pid] = "Host"; return "Host"; }
  if (assignedNames[pid]) return assignedNames[pid];
  userCount += 1;
  const uname = "Peer " + userCount;
  assignedNames[pid] = uname;
  return uname;
}
function assignHostName() {
  assignedNames[myPeerId] = "Host";
  peerUsernames[myPeerId] = "Host";
  myUsername = "Host";
  usernameInput.value = myUsername;
}

// --------------- UI Feedback ---------------
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
/**
 * Formats file size in bytes into a human-readable string (KB, MB, GB).
 * @param {number} bytes The file size in bytes.
 * @returns {string} Formatted file size.
 */
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

/**
 * Adds a file message tile to the UI.
 * @param {object} options - File message details.
 * @param {string} options.fileMsgId - Unique ID for the file message.
 * @param {string} options.fileName - Name of the file.
 * @param {number} options.fileSize - Size of the file in bytes.
 * @param {string} options.senderId - Peer ID of the sender.
 * @param {string} options.username - Username of the sender.
 * @param {boolean} [options.encrypted=false] - Whether the file is encrypted.
 */
function addFileMessage({ fileMsgId, fileName, fileSize, senderId, username, encrypted = false }) {
  if (!fileMessagesArea) return;
  // Prevent duplicate messages
  if (fileMessagesArea.querySelector(`[data-file-msg-id="${fileMsgId}"]`)) return;

  const isSender = senderId === myPeerId;
  const div = document.createElement('div');
  div.className = 'message-tile file ' + (isSender ? 'outgoing' : 'incoming');
  div.dataset.fileMsgId = fileMsgId; // Store file message ID for easy lookup
  div.setAttribute('data-file-msg-id', fileMsgId); // Also set as attribute for CSS selectors
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
  fileMessagesArea.scrollTop = fileMessagesArea.scrollHeight; // Scroll to bottom
}


/**
 * Updates the UI of a specific file transfer tile.
 * @param {HTMLElement} tile - The file message tile DOM element.
 * @param {object} options - Update details.
 * @param {string} options.status - Current status ('downloading', 'completed', 'canceled', 'ready').
 * @param {number} [options.progress] - Progress as a float (0 to 1).
 * @param {string} [options.error] - Error message if transfer failed.
 * @param {string} [options.reason] - Reason for cancellation ('user', 'sender', 'connection').
 */
function updateFileTileUI(tile, { status, progress, error, reason }) {
  const downloadBtn = tile.querySelector('.file-download-link');
  const cancelBtn = tile.querySelector('.file-cancel-link');
  const progressBar = tile.querySelector('.file-progress-bar');
  const progressInner = tile.querySelector('.file-progress-bar-inner');
  const statusMsg = tile.querySelector('.file-status-msg');

  if (status === 'downloading') {
    if (downloadBtn) {
        downloadBtn.disabled = true;
        downloadBtn.classList.add('hidden'); // Hide download button while downloading
    }
    cancelBtn.classList.remove('hidden');
    progressBar.classList.remove('hidden');
    progressInner.style.width = Math.round(progress * 100) + '%';
    statusMsg.textContent = '⬇️ Downloading...';
  } else if (status === 'completed') {
    if (downloadBtn) {
        downloadBtn.disabled = false; // Allow re-downloading
        downloadBtn.classList.remove('hidden');
    }
    cancelBtn.classList.add('hidden');
    progressBar.classList.add('hidden');
    statusMsg.textContent = '✅ Download complete';
  } else if (status === 'canceled') {
    if (downloadBtn) {
        downloadBtn.disabled = false;
        downloadBtn.classList.remove('hidden'); // Show download button when cancelled
    }
    cancelBtn.classList.add('hidden');
    progressBar.classList.add('hidden');
    if (reason === 'user') {
      statusMsg.textContent = '❌ Canceled by you';
    } else if (reason === 'sender') {
      statusMsg.textContent = '🚫 Sender canceled the transfer';
    } else if (reason === 'connection') {
      statusMsg.textContent = '⚠️ Connection lost before completion';
    } else if (error) {
      statusMsg.textContent = '❗ Failed: ' + error;
    } else {
      statusMsg.textContent = '❌ Canceled';
    }
  } else { // 'ready' or initial state
    if (downloadBtn) {
        downloadBtn.disabled = false;
        downloadBtn.classList.remove('hidden'); // Ensure download button is visible in ready state
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
  // If we have explicit status info from host, use it
  if (hostStatusOverrides) {
    if (pid === joinPeerId) return hostStatusOverrides[pid] || "disconnected";
    return hostStatusOverrides[pid] || "disconnected";
  }
  // If we are still connecting, show connecting
  const entry = mesh[pid];
  if (entry && entry.status === "connecting") return "connecting";
  // Only show session ended if we know for sure (after disconnect event)
  if (pid === joinPeerId && window._hostSessionEnded) return "session_ended";
  return "disconnected";
}

function updatePeersList() {
  const list = peersList;
  if (!list) return;

  const entries = Object.entries(peerUsernames);
  const hostPid = isHost ? myPeerId : joinPeerId;
  const hostEntry = entries.find(([pid, _]) => pid === hostPid);
  const peerEntries = entries.filter(([pid, _]) => pid !== hostPid);

  peerEntries.sort((a, b) => {
    const mA = /^Peer (\d+)$/.exec(a[1]);
    const mB = /^Peer (\d+)$/.exec(b[1]);
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
    let statusText =
      status === "connected" ? "Connected" :
      status === "connecting" ? "Connecting..." :
      status === "session_ended" ? "Session Ended" :
      "Disconnected";
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
      status === "session_ended" ? "Session Ended" :
      "Disconnected";
    let statusClass = status;
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="peer-color-dot" style="background:${usernameColor(uname)};"></span>
      <span class="peer-username">${uname}</span>
      <span class="peer-status ${statusClass}">${statusText}</span>`;
    list.appendChild(li);
  });

  // Update the connected peer name in the collapsed header and show/hide peers section
  if (isHost) {
    const connectedPeersCount = Object.keys(mesh).filter(pid => mesh[pid].status === "connected" && pid !== myPeerId).length;
    if (connectedPeersCount > 0) {
      connectedPeerName.textContent = `${connectedPeersCount} peer${connectedPeersCount !== 1 ? 's' : ''}`;
      show(peersSection);
    } else {
      connectedPeerName.textContent = "No peers";
      hide(peersSection);
    }
  } else {
    // For peers, if connected to host, show host's name, otherwise 'Disconnected'
    if (getPeerStatus(joinPeerId) === "connected") {
      connectedPeerName.textContent = peerUsernames[joinPeerId] || "Host";
      show(peersSection);
    } else {
      connectedPeerName.textContent = "Disconnected";
      hide(peersSection);
    }
  }
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

// Function to handle the collapsing/expanding of session info
function toggleSessionInfo() {
  sessionInfoSection.classList.toggle("collapsed");
}

// Add event listener for the toggle button
if (toggleSessionInfoBtn) {
  toggleSessionInfoBtn.addEventListener("click", toggleSessionInfo);
}


// --------------- Networking ---------------
/**
 * Broadcasts data to all connected peers, optionally excluding one.
 * @param {object} msg - The message object to send.
 * @param {string} [exceptPeerId=null] - Optional peer ID to exclude from broadcast.
 */
function broadcastData(msg, exceptPeerId = null) {
  Object.entries(mesh).forEach(([pid, ent]) => {
    if (pid === exceptPeerId) return;
    if (ent.conn && ent.conn.open && ent.status === "connected") {
      try { ent.conn.send(msg); } catch (_) {}
    }
  });
  // If the message is a file message, add it to history if not already present
  if (msg && msg.type === 'file') {
    if (!fileTransferHistory.find(m => m.type === 'file' && m.fileMsgId === msg.fileMsgId)) {
      fileTransferHistory.push(msg);
    }
  }
}

/**
 * Sends the current file transfer history to a newly connected peer.
 * @param {PeerJS.DataConnection} conn - The data connection to send history to.
 */
function sendHistoryToPeer(conn) {
  if (conn && conn.open) {
    try {
      // Ensure all file messages in fileTransferHistory have type: 'file' and a msgId
      const historyWithFileType = fileTransferHistory.map(msg => {
        if (msg.fileMsgId) {
          let newMsg = { ...msg };
          if (!newMsg.type) newMsg.type = 'file';
          if (!newMsg.msgId) newMsg.msgId = `filemsg-${newMsg.fileMsgId}`;
          return newMsg;
        }
        return msg;
      });
      conn.send({
        type: "history",
        files: historyWithFileType,
      });
    } catch (_) {}
  }
}

// --------------- Connection handlers ---------------
let originalSetupConnHandlers; // Declare globally or in a scope accessible to both

/**
 * Sets up event handlers for a PeerJS DataConnection.
 * This function is patched to include file transfer specific message handling.
 * @param {PeerJS.DataConnection} conn - The PeerJS DataConnection object.
 * @param {string} pid - The peer ID connected.
 * @param {boolean} isIncoming - True if this is an incoming connection, false if outgoing.
 */
async function setupConnHandlers(conn, pid, isIncoming) {
  const entry = (mesh[pid] = mesh[pid] || { status: "connecting", backoff: 1000, lastPing: Date.now() });
  entry.conn = conn;
  if (conn._setupDone) return; // Prevent double setup
  conn._setupDone = true;

  conn.on("open", async () => { // Make this handler async
    // Collapse the session info section when a peer connects
    if (!sessionInfoSection.classList.contains("collapsed")) {
      sessionInfoSection.classList.add("collapsed");
    }

    entry.status = "connected";
    entry.backoff = 1000; // Reset backoff on successful connection
    entry.lastPing = Date.now();
    if (!peerUsernames[pid]) peerUsernames[pid] = assignDefaultUsernameToPeer(pid);
    else assignDefaultUsernameToPeer(pid); // Ensure userCount is correct
    updatePeersList(); // Update the list when a peer connects
    show(fileTransferSection); // Show file transfer section on successful connection FOR ALL USERS

    // Trigger animation when a new peer joins
    triggerConnectionAnimation('connect');

    if (isHost) {
      if (Object.keys(peerUsernames).length === 1) assignHostName(); // Assign host name if first peer
      if (pid !== myPeerId) {
        // Send assigned name to the connected peer
        conn.send({
          type: "assignName",
          username: peerUsernames[pid],
          peerId: pid,
          allStatuses: getAllStatuses()
        });
      }

      // NEW: Process any files selected before the session started
      if (preSessionFiles.length > 0) {
        fileMessagesArea.innerHTML = ''; // Clear the pre-session file list from UI
        const filesToSend = [...preSessionFiles];
        preSessionFiles = []; // Clear the array

        // Concurrently process and send all pre-session files
        const sendPromises = filesToSend.map(file => sendFile(file));
        await Promise.all(sendPromises);
      }

      broadcastUserListWithStatus(); // Inform all peers about updated user list
      sendHistoryToPeer(conn); // Send file transfer history to the new peer
    } else {
      // If not host, send own username to the host
      if (myUsername && conn.open) {
        conn.send({ type: "username", username: myUsername, reqUserList: true });
      }
    }
  });

  function handleDisconnect() {
    entry.status = "disconnected";
    if (hostStatusOverrides) hostStatusOverrides[pid] = "disconnected";
    if (pid === joinPeerId && !isHost) {
      // If host disconnected and we are a peer, mark session as ended
      window._hostSessionEnded = true;
      hostStatusOverrides = null;
      updatePeersList(); // Update the list when a peer disconnects
      triggerConnectionAnimation('disconnect'); // Trigger animation on host disconnect
      return;
    }
    updatePeersList(); // Update the list when a peer disconnects
    if (isHost) broadcastUserListWithStatus(); // Inform other peers about disconnect
    scheduleReconnect(pid); // Attempt to reconnect
    triggerConnectionAnimation('disconnect'); // Trigger animation on peer disconnect
  }
  conn.on("close", handleDisconnect);
  conn.on("error", handleDisconnect);
  conn.on("data", data => {
    entry.lastPing = Date.now(); // Reset ping timer
    if (data && data.type === "ping") { conn.send({ type: "pong" }); return; }
    if (data && data.type === "pong") return;
    onDataReceived(data, pid, conn); // Pass data to general handler
  });
}

/**
 * Attempts to establish a connection to a specific peer.
 * @param {string} pid - The peer ID to connect to.
 * @param {number} [backoff=1000] - Initial backoff delay for reconnects.
 */
function tryConnectTo(pid, backoff = 1000) {
  if (pid === myPeerId) return; // Don't connect to self
  const entry = mesh[pid] || (mesh[pid] = {});
  if (entry.status === "connected" || (entry.conn && entry.conn.open)) return; // Already connected
  const conn = peer.connect(pid, { reliable: true }); // Create new connection
  Object.assign(entry, { conn, status: "connecting", backoff, lastPing: Date.now() });
  updatePeersList();
  setupConnHandlers(conn, pid, false); // Set up handlers for outgoing connection
}

/**
 * Schedules a reconnect attempt for a disconnected peer.
 * @param {string} pid - The peer ID to reconnect.
 */
function scheduleReconnect(pid) {
  const entry = mesh[pid];
  if (!entry || entry.reconnect) return; // Already scheduled or no entry
  entry.backoff = Math.min((entry.backoff || 1000) * 2, 30000); // Exponential backoff, max 30s
  entry.reconnect = setTimeout(() => {
    entry.reconnect = null;
    tryConnectTo(pid, entry.backoff);
  }, entry.backoff);
}

// --------------- Data handling ---------------
/**
 * Handles incoming data messages from peers.
 * @param {object} data - The received data object.
 * @param {string} fromPid - The peer ID that sent the data.
 * @param {PeerJS.DataConnection} conn - The data connection the data was received on.
 */
async function onDataReceived(data, fromPid, conn) { // Made async for handleFileMessage
  // Handle peer name assignment
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
  // Handle user list updates from host
  if (data && data.type === "userlist" && data.users) {
    peerUsernames = { ...data.users };
    hostStatusOverrides = data.statuses || null;
    updatePeersList();
    return;
  }
  // Handle username broadcast from peers
  if (data && data.type === "username" && typeof data.username === "string") {
    const pid = data.peerId || fromPid;
    const newName = data.username.substring(0, 20); // Truncate username
    peerUsernames[pid] = newName;
    assignedNames[pid] = newName;
    updatePeersList();
    if (isHost) broadcastUserListWithStatus(); // Host re-broadcasts updated list
    return;
  }
  // Handle history synchronization (for new peers joining)
  if (data && data.type === "history" && Array.isArray(data.files)) {
    let addedFile = false;
    for (const msg of data.files) { // Use for...of with await
      if (msg && msg.fileMsgId && !msg.msgId) msg.msgId = `filemsg-${msg.fileMsgId}`; // Ensure msgId for file messages
      if (msg && msg.msgId && !knownMsgIds.has(msg.msgId)) {
        knownMsgIds.add(msg.msgId);
        if (msg.type === 'file') {
          // Only add if not already in history
          if (!fileTransferHistory.find(m => m.type === 'file' && m.fileMsgId === msg.fileMsgId)) {
            fileTransferHistory.push(msg);
            addedFile = true;
            // Also process the key if it's an encrypted file
            if (msg.encrypted && msg.encryptionKey) {
                try {
                    const importedKey = await importKey(new Uint8Array(msg.encryptionKey));
                    encryptionKeys[msg.fileMsgId] = importedKey;
                } catch (e) {
                    console.error("Failed to import encryption key from history:", e);
                    // Decide how to handle this error: maybe mark file as un-downloadable
                }
            }
          }
        }
      }
    }
    if (addedFile) renderFileTransferHistory(); // Re-render if new file messages were added
    return;
  }
  // Handle goodbye messages (peer disconnecting gracefully)
  if (data && data.type === 'goodbye' && data.peerId) {
    const pid = data.peerId;
    if (mesh[pid]) mesh[pid].status = 'disconnected';
    if (hostStatusOverrides) hostStatusOverrides[pid] = 'disconnected';
    updatePeersList();
    if (isHost) broadcastUserListWithStatus();
    triggerConnectionAnimation('disconnect'); // Trigger animation on graceful disconnect
    return;
  }
  // Handle file deletion broadcast
  if (data && data.type === 'file-delete' && data.fileMsgId) {
    const fileMsgId = data.fileMsgId;
    const tile = fileMessagesArea.querySelector(`[data-file-msg-id="${fileMsgId}"]`);
    if (tile) {
      tile.remove();
    }
    fileTransferHistory = fileTransferHistory.filter(msg => msg.fileMsgId !== fileMsgId);
    return;
  }
  // Handle incoming file metadata messages
  if (data && data.type === 'file') {
    await handleFileMessage(data); // Await this call
    return;
  }
  // File transfer protocol messages (handled by patched setupConnHandlers directly)
  if (data && data.type === 'file-request' || data.type === 'file-chunk' ||
      data.type === 'file-end' || data.type === 'file-error' ||
      data.type === 'file-cancel' || data.type === 'chunk-ack' || data.type === 'file-complete') {
    return;
  }
}

/**
 * Renders all file messages from `fileTransferHistory` to the UI.
 */
function renderFileTransferHistory() {
  if (!fileMessagesArea) return;
  fileMessagesArea.innerHTML = ""; // Clear existing messages
  fileTransferHistory.forEach(msg => {
    if (msg.type === 'file') {
      addFileMessage(msg);
    }
  });
}

// --------------- Goodbye on unload ---------------
window.addEventListener('unload', () => {
  broadcastData({ type: 'goodbye', peerId: myPeerId });
});

// --------------- Keep-alive ---------------
/**
 * Periodically sends ping messages to connected peers and checks for timeouts.
 * Attempts to reconnect to unresponsive peers.
 */
function startKeepAlive() {
  setInterval(() => {
    Object.entries(mesh).forEach(([pid, entry]) => {
      if (entry.status === "connected" && entry.conn && entry.conn.open) {
        try { entry.conn.send({ type: "ping" }); } catch (_) {} // Send ping
      }
      // If no ping received for a while, mark as disconnected and try reconnect
      if (Date.now() - (entry.lastPing || 0) > 4000 && entry.status === "connected") {
        if (hostStatusOverrides) hostStatusOverrides[pid] = 'disconnected';
        entry.status = "disconnected";
        updatePeersList();
        if (isHost) broadcastUserListWithStatus();
        scheduleReconnect(pid);
        triggerConnectionAnimation('disconnect'); // Trigger animation on unexpected disconnect
      }
    });
    if (isHost && myPeerId) updatePeersList(); // Host updates its own list
  }, 1500); // Check every 1.5 seconds
}

// --------------- Event Listeners ---------------
startBtn.addEventListener("click", () => {
  startBtn.disabled = true;
  hide(startBtn);
  show(sessionInfoSection);
  sessionInfoSection.classList.remove("collapsed"); // Start expanded
  isHost = true;
  peerUsernames = {};
  assignedNames = {};
  userCount = 0;
  peer = new Peer(undefined, { debug: 2 }); // Initialize PeerJS as host

  peer.on("open", id => {
    myPeerId = id;
    show(usernameSection);
    assignHostName();
    const url = `${window.location.origin}${window.location.pathname}?join=${encodeURIComponent(id)}`;
    joinLinkA.href = url;
    joinLinkA.textContent = url;
    show(linkSection);
    show(qrContainer);
    // Generate QR code for join link
    qrcodeDiv.innerHTML = ''; // Clear previous QR code
    new QRCode(qrcodeDiv, {
      text: url,
      width: 180,
      height: 180,
      colorDark: "#000000",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M,
      margin: 2
    });
    // Listen for incoming connections
    peer.on("connection", conn => {
      const pid = conn.peer;
      mesh[pid] = { conn, status: "connecting", backoff: 1000, lastPing: Date.now() };
      show(peersSection);
      setupConnHandlers(conn, pid, true); // Set up handlers for incoming connection
    });
    peer.on("error", err => console.error("PeerJS error:", err));
  });
  startKeepAlive();
});

/**
 * Initiates joining a PeerJS mesh as a peer (not host).
 */
function joinMesh() {
  hide(startSection); // startSection doesn't exist, but this is safe
  show(sessionInfoSection);
  sessionInfoSection.classList.remove("collapsed"); // Start expanded
  peer = new Peer(undefined, { debug: 2 }); // Initialize PeerJS as peer

  peer.on("open", id => {
    myPeerId = id;
    show(usernameSection);
    show(peersSection);
    show(linkSection);
    hide(qrContainer); // Hide QR code for peers
    const url = `${window.location.origin}${window.location.pathname}?join=${encodeURIComponent(joinPeerId)}`;
    joinLinkA.href = url;
    joinLinkA.textContent = url;

    // Connect to the host
    const conn = peer.connect(joinPeerId, { reliable: true });
    mesh[joinPeerId] = { conn, status: "connecting", backoff: 1000, lastPing: Date.now() };
    setupConnHandlers(conn, joinPeerId, false); // Set up handlers for outgoing connection to host
  });
  // Listen for other incoming connections (e.g., from other peers in the mesh)
  peer.on("connection", conn => {
    const pid = conn.peer;
    mesh[pid] = { conn, status: "connecting", backoff: 1000, lastPing: Date.now() };
    setupConnHandlers(conn, pid, true); // Set up handlers for incoming connection
  });
  peer.on("error", err => console.error("PeerJS error:", err));
  startKeepAlive();
}

// Automatically join mesh if 'join' parameter is present in URL
if (joinPeerId) {
  joinMesh();
  hide(fileTransferSection); // Peers joining shouldn't see the file selection until connected
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
  // Broadcast username change to all peers
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
  const iv = crypto.getRandomValues(new Uint8Array(16));
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

// --------------- File Transfer Logic ---------------

/**
 * Renders the list of files selected before the session starts.
 */
function renderPreSessionFiles() {
    if (!fileMessagesArea) return;
    fileMessagesArea.innerHTML = ''; // Clear the area first

    if (preSessionFiles.length === 0) {
        hide(startBtn);
        return;
    }

    preSessionFiles.forEach((file, index) => {
        const div = document.createElement('div');
        div.className = 'message-tile file'; // Use same base class
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

    // Add event listeners for the remove buttons
    fileMessagesArea.querySelectorAll('.remove-file-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const indexToRemove = parseInt(e.currentTarget.dataset.index, 10);
            preSessionFiles.splice(indexToRemove, 1); // Remove from array
            renderPreSessionFiles(); // Re-render the list
        });
    });

    show(startBtn);
}


/**
 * Processes a single file for sending: creates metadata, updates UI, and broadcasts.
 * @param {File} file The file object to send.
 */
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
    encryptionKey: Array.from(new Uint8Array(exportedKey)),
    ivSize: 16
  };

  addFileMessage(msg); // Add the proper transfer tile
  if (!fileTransfers[fileMsgId]) fileTransfers[fileMsgId] = {};
  fileTransfers[fileMsgId][myPeerId] = { file, status: 'ready', progress: 0, controller: null };

  // Add to history only if it's not a duplicate
  if (!fileTransferHistory.find(m => m.fileMsgId === fileMsgId)) {
    fileTransferHistory.push(msg);
  }
  broadcastData(msg);
}

// Event listener for the file selection button (triggers hidden file input)
fileBtn.addEventListener('click', () => fileInput.click());

// Event listener for when files are selected in the input
fileInput.addEventListener('change', async e => {
  const files = e.target.files;
  if (!files || files.length === 0) return;

  if (!peer) { // --- Case 1: Session NOT started yet ---
    for (const file of files) {
      preSessionFiles.push(file);
    }
    renderPreSessionFiles();
  } else { // --- Case 2: Session is ALREADY active ---
    const sendPromises = Array.from(files).map(file => sendFile(file));
    await Promise.all(sendPromises);
  }
  fileInput.value = ''; // Clear the input for next selection
});

/**
 * Handles an incoming file metadata message.
 * This function is called when a peer sends information about a file they want to share.
 * @param {object} msg - The file metadata message.
 */
async function handleFileMessage(msg) { // Made async here
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
    fileTransfers[msg.fileMsgId][myPeerId] = { status: 'ready', progress: 0, controller: null };
  }
  addFileMessage(msg); // Add the file message tile to the UI
  if (!window.streamSaver) {
    const tile = fileMessagesArea.querySelector(`[data-file-msg-id="${msg.fileMsgId}"]`);
    if (tile) {
      updateFileTileUI(tile, { status: 'canceled', progress: 0, error: 'streamSaver.js not loaded. Please reload or contact the host.' });
      displayMessageBox('Error', 'File download requires streamSaver.js. Please reload the page or contact the host.');
    }
  }
}

// Event delegation for download/cancel buttons on file message tiles
fileMessagesArea.addEventListener('click', async function(e) {
  const downloadBtn = e.target.closest('.file-download-link');
  const cancelBtn = e.target.closest('.file-cancel-link');
  const deleteBtn = e.target.closest('.file-delete-btn');
  const tile = e.target.closest('.message-tile.file');

  if (!tile) return;

  const fileMsgId = tile.dataset.fileMsgId;

  if (downloadBtn) {
    if (!window.streamSaver) {
      updateFileTileUI(tile, { status: 'canceled', progress: 0, error: 'streamSaver.js not loaded' });
      displayMessageBox('Error', 'File download requires streamSaver.js. Please reload the page or contact the host.');
      return;
    }
    startFileDownload(tile, fileMsgId);
  } else if (cancelBtn) {
    cancelFileDownload(tile, fileMsgId);
  } else if (deleteBtn) {
      displayMessageBox('Confirm Delete', 'This will remove the file for all participants. Are you sure?', true)
        .then(confirmed => {
            if (confirmed) {
                // Remove from local UI
                tile.remove();
                // Remove from history
                fileTransferHistory = fileTransferHistory.filter(msg => msg.fileMsgId !== fileMsgId);
                // Broadcast deletion
                broadcastData({ type: 'file-delete', fileMsgId });
            }
        });
  }
});

// Store original setupConnHandlers to patch it for file transfer
originalSetupConnHandlers = setupConnHandlers;

/**
 * Patched setupConnHandlers to include file transfer data handling.
 * This function intercepts file-related messages on a data connection.
 */
setupConnHandlers = function(conn, pid, isIncoming) {
  originalSetupConnHandlers(conn, pid, isIncoming); // Call the original function first

  let activeFileSenders = {}; // Track active file send operations for this specific connection

  conn.on('data', async data => {
    if (data && data.type === 'file-request' && data.fileMsgId) {
      const fileMsgId = data.fileMsgId;
      const fileTransferState = fileTransfers[fileMsgId]?.[myPeerId];
      const fileMsg = findFileMsgInHistory(fileMsgId);

      if (!fileTransferState || !fileTransferState.file) {
        conn.send({ type: 'file-error', error: 'File not found', fileMsgId });
        conn.close();
        return;
      }

      const file = fileTransferState.file;
      const isEncrypted = fileMsg && fileMsg.encrypted;
      const encryptionKey = isEncrypted ? encryptionKeys[fileMsgId] : null;

      if (isEncrypted && !encryptionKey) {
          console.error(`Encryption key not found for encrypted file ${fileMsgId}`);
          conn.send({ type: 'file-error', error: 'Encryption key missing on sender side', fileMsgId });
          conn.close();
          return;
      }

      const chunkSize = 1024 * 1024;
      const windowSize = 4;
      let offset = 0;
      let canceled = false;
      let awaitingAcks = 0;
      let chunkAckMap = {};
      let retriesMap = {};
      let maxRetries = 5;
      let ackTimeouts = {};

      activeFileSenders[fileMsgId] = () => { canceled = true; };

      let fileTransferControlListener = d => {
        if (d && d.type === 'file-cancel' && d.fileMsgId === fileMsgId) {
          canceled = true;
          conn.close();
        }
        if (d && d.type === 'chunk-ack' && d.fileMsgId === fileMsgId && typeof d.chunkId === 'number') {
          if (!chunkAckMap[d.chunkId]) {
            chunkAckMap[d.chunkId] = true;
            awaitingAcks--;
            if (ackTimeouts[d.chunkId]) {
              clearTimeout(ackTimeouts[d.chunkId]);
              delete ackTimeouts[d.chunkId];
            }
          }
        }
        if (d && d.type === 'file-complete' && d.fileMsgId === fileMsgId) {
          conn.close();
        }
      };
      conn.on('data', fileTransferControlListener);

      let chunkId = 0;
      while (offset < file.size && !canceled) {
        while (awaitingAcks >= windowSize && !canceled) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        if (canceled) break;

        const slice = file.slice(offset, offset + chunkSize);
        const chunkBuffer = await slice.arrayBuffer();

        let dataToSend = chunkBuffer;
        let iv = null;

        if (isEncrypted && encryptionKey) {
            try {
                const encryptedResult = await encryptData(encryptionKey, chunkBuffer);
                dataToSend = encryptedResult.encryptedData;
                iv = encryptedResult.iv;
            } catch (e) {
                console.error("Encryption failed for chunk:", e);
                conn.send({ type: 'file-error', error: 'Encryption failed: ' + e.message, fileMsgId });
                conn.close();
                canceled = true;
                break;
            }
        }

        conn.send({ type: 'file-chunk', data: dataToSend, chunkId, fileMsgId, iv: iv ? Array.from(iv) : null });
        awaitingAcks++;
        retriesMap[chunkId] = 0;

        ackTimeouts[chunkId] = setTimeout(function retryChunk() {
          if (!chunkAckMap[chunkId] && !canceled) {
            retriesMap[chunkId]++;
            if (retriesMap[chunkId] > maxRetries) {
              conn.send({ type: 'file-error', error: 'Receiver not responding', fileMsgId });
              conn.close();
              canceled = true;
            } else {
              conn.send({ type: 'file-chunk', data: dataToSend, chunkId, fileMsgId, iv: iv ? Array.from(iv) : null });
              ackTimeouts[chunkId] = setTimeout(retryChunk, 7000);
            }
          }
        }, 7000);

        offset += chunkSize;
        chunkId++;
      }

      while (awaitingAcks > 0 && !canceled) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      if (!canceled) {
        conn.send({ type: 'file-end', fileMsgId });
      }

      setTimeout(() => { conn.close(); }, 10000);

    } else if (data && data.type === 'file-cancel' && data.fileMsgId) {
      if (activeFileSenders[data.fileMsgId]) {
        activeFileSenders[data.fileMsgId]();
        delete activeFileSenders[data.fileMsgId];
      }
      conn.close();
    }
  });
};

/**
 * Initiates the download process for a file.
 * @param {HTMLElement} tile - The file message tile DOM element.
 * @param {string} fileMsgId - The unique ID of the file message.
 */
async function startFileDownload(tile, fileMsgId) {
  if (!fileTransfers[fileMsgId]) fileTransfers[fileMsgId] = {};

  if (fileTransfers[fileMsgId][myPeerId] && fileTransfers[fileMsgId][myPeerId].controller) {
    fileTransfers[fileMsgId][myPeerId].controller.abort();
  }

  fileTransfers[fileMsgId][myPeerId] = {
    status: 'downloading',
    progress: 0,
    controller: new AbortController(),
    conn: null,
    cancel: null
  };

  updateFileTileUI(tile, { status: 'downloading', progress: 0 });

  const fileMsg = findFileMsgInHistory(fileMsgId);
  if (!fileMsg) {
    updateFileTileUI(tile, { status: 'canceled', progress: 0, error: 'File metadata not found in history.' });
    return;
  }

  const senderId = fileMsg.senderId;
  const conn = peer.connect(senderId, { reliable: true, metadata: { fileMsgId, action: 'download' } });
  fileTransfers[fileMsgId][myPeerId].conn = conn;

  conn.on('open', () => {
    conn.send({ type: 'file-request', fileMsgId });
  });

  let fileWriter, received = 0, total = fileMsg.fileSize;
  let streamSaver = window.streamSaver;

  if (!streamSaver) {
    updateFileTileUI(tile, { status: 'canceled', progress: 0, error: 'streamSaver.js not loaded' });
    displayMessageBox('Error', 'File download requires streamSaver.js. Please reload the page or contact the host.');
    conn.close();
    return;
  }

  let writableStream = streamSaver.createWriteStream(fileMsg.fileName, { size: total });
  fileWriter = writableStream.getWriter();

  let downloadAborted = false;
  let chunkAckTimeout = null;

  function sendAck(chunkId) {
    if (conn.open) conn.send({ type: 'chunk-ack', fileMsgId, chunkId });
  }

  function sendFileComplete() {
    if (conn.open) conn.send({ type: 'file-complete', fileMsgId });
  }

  function abortDownload(errorMsg, reason) {
    if (downloadAborted) return;
    downloadAborted = true;

    const transfer = fileTransfers[fileMsgId]?.[myPeerId];
    if (transfer) {
      transfer.controller.abort();
    }

    // Only send cancel message to peer if it was a local user cancellation
    if (reason === 'user' && conn && conn.open) {
        conn.send({ type: 'file-cancel', fileMsgId });
    }

    if (fileWriter) fileWriter.abort().catch(()=>{}); // Aborting might throw an error if stream is already closed, ignore it.
    updateFileTileUI(tile, { status: 'canceled', progress: received / total, error: errorMsg, reason });
    if (conn && conn.open) conn.close();
  }

  fileWriter.closed.catch(err => {
      if (!downloadAborted) {
          console.log("Download stream aborted, likely by user cancelling save dialog.", err);
          abortDownload("Canceled", "user");
      }
  });

  conn.on('data', async chunk => {
    const transfer = fileTransfers[fileMsgId]?.[myPeerId];
    if (!transfer || transfer.controller.signal.aborted || downloadAborted) {
      if(!downloadAborted) abortDownload('Aborted', 'user');
      return;
    }

    if (chunk.type === 'file-chunk' && chunk.data) {
      try {
        let dataToWrite = new Uint8Array(chunk.data);

        if (fileMsg.encrypted && encryptionKeys[fileMsgId] && chunk.iv) {
            try {
                const importedKey = encryptionKeys[fileMsgId];
                const iv = new Uint8Array(chunk.iv);
                dataToWrite = await decryptData(importedKey, dataToWrite, iv);
            } catch (e) {
                console.error("Decryption failed for chunk:", e);
                abortDownload('Decryption failed: ' + e.message, 'error');
                return;
            }
        }

        await fileWriter.write(dataToWrite);
        received += dataToWrite.byteLength;
        transfer.progress = received / total;
        updateFileTileUI(tile, { status: 'downloading', progress: transfer.progress });
        sendAck(chunk.chunkId);

        if (chunkAckTimeout) clearTimeout(chunkAckTimeout);
        chunkAckTimeout = setTimeout(() => {
          abortDownload('Timeout waiting for next chunk', 'connection');
        }, 20000);

      } catch (e) {
        abortDownload('Write error: ' + e.message, 'error');
      }
    } else if (chunk.type === 'file-end') {
      try {
        if(chunkAckTimeout) clearTimeout(chunkAckTimeout);
        await fileWriter.close();
        updateFileTileUI(tile, { status: 'completed', progress: 1 });
        if (transfer) transfer.status = 'completed';
        sendFileComplete();
        setTimeout(() => conn.close(), 1000);
      } catch (e) {
        abortDownload('File close error: ' + e.message, 'error');
      }
    } else if (chunk.type === 'file-error') {
      abortDownload(chunk.error || 'Sender error', 'sender');
    }
  });

  conn.on('close', () => {
    const transfer = fileTransfers[fileMsgId]?.[myPeerId];
    if (transfer && !downloadAborted && transfer.status === 'downloading') {
      updateFileTileUI(tile, { status: 'canceled', progress: received / total, reason: 'connection' });
    }
  });

  if (fileTransfers[fileMsgId][myPeerId]) {
    fileTransfers[fileMsgId][myPeerId].cancel = () => {
        abortDownload('Canceled by you', 'user');
    };
  }
}

/**
 * Cancels an ongoing file download.
 * @param {HTMLElement} tile - The file message tile DOM element.
 * @param {string} fileMsgId - The unique ID of the file message.
 */
function cancelFileDownload(tile, fileMsgId) {
  if (fileTransfers[fileMsgId] && fileTransfers[fileMsgId][myPeerId] && fileTransfers[fileMsgId][myPeerId].cancel) {
    fileTransfers[fileMsgId][myPeerId].cancel();
  }
}

/**
 * Finds a file message in the `fileTransferHistory` by its ID.
 * @param {string} fileMsgId - The unique ID of the file message.
 * @returns {object|undefined} The file message object if found, otherwise undefined.
 */
function findFileMsgInHistory(fileMsgId) {
  return fileTransferHistory.find(m => m.type === 'file' && m.fileMsgId === fileMsgId);
}

// Custom message box function (replaces alert)
function displayMessageBox(title, message, isConfirm = false) {
    // Return a promise that resolves with true (for OK/Confirm) or false (for Cancel)
    return new Promise(resolve => {
        const existingBox = document.getElementById('customMessageBox');
        if (existingBox) existingBox.remove();

        const messageBox = document.createElement('div');
        messageBox.id = 'customMessageBox';
        messageBox.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: var(--card);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 20px;
            box-shadow: 0 4px 8px rgba(0,0,0,0.2);
            z-index: 10000;
            max-width: 90%;
            width: 320px;
            text-align: center;
            color: var(--text);
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

        const confirmBtn = document.getElementById('messageBoxConfirmBtn');
        const cancelBtn = document.getElementById('messageBoxCancelBtn');
        const closeBtn = document.getElementById('messageBoxCloseBtn');

        if (isConfirm) {
            confirmBtn.addEventListener('click', () => {
                messageBox.remove();
                resolve(true);
            });
            cancelBtn.addEventListener('click', () => {
                messageBox.remove();
                resolve(false);
            });
        } else {
            closeBtn.addEventListener('click', () => {
                messageBox.remove();
                resolve(true);
            });
        }
    });
}


// Copy join link functionality
if (copyLinkBtn && joinLinkA) {
  copyLinkBtn.addEventListener('click', () => {
    const link = joinLinkA.href;
    if (link && link !== '#') {
        navigator.clipboard.writeText(link).then(() => {
          copyLinkBtn.title = 'Copied!';
          const icon = copyLinkBtn.querySelector('.material-icons');
          if (icon) {
            icon.textContent = 'check';
            icon.style.color = '#267c26';
            setTimeout(() => {
              icon.textContent = 'content_copy';
              icon.style.color = '';
              copyLinkBtn.title = 'Copy link';
            }, 1200);
          }
        }).catch(err => {
          console.error('Failed to copy to clipboard, using fallback:', err);
          const tempInput = document.createElement('input');
          tempInput.value = link;
          document.body.appendChild(tempInput);
          tempInput.select();
          document.execCommand('copy');
          document.body.removeChild(tempInput);
          const icon = copyLinkBtn.querySelector('.material-icons');
          if (icon) {
            icon.textContent = 'check';
            setTimeout(() => { icon.textContent = 'content_copy'; }, 1200);
          }
        });
    }
  });
}

// Initial render of file transfer history on load
document.addEventListener('DOMContentLoaded', () => {
  renderFileTransferHistory();

  // Register the service worker for PWA offline capabilities
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/service-worker.js')
        .then(registration => {
          console.log('Service Worker registered with scope:', registration.scope);
        })
        .catch(err => {
          console.error('Service Worker registration failed:', err);
        });
    });
  }
});
