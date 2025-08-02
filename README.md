# NIMFILE - Secure Peer-to-Peer File Transfer

![NIMFILE Logo](/assets/icon.png)

NIMFILE is an open-source, privacy-focused platform for secure peer-to-peer file transfers directly between devices using WebRTC technology.

## Key Features

- 🔒 **End-to-End Encrypted** - Files transfer directly between peers without intermediate servers
- ⚡ **Fast Transfers** - Leverages WebRTC for optimal speed based on your connection
- 📦 **No Size Limits** - Transfer files of any size (limited only by device storage)
- 🌐 **Cross-Platform** - Works on desktop and mobile browsers
- 🆓 **Open Source** - Transparent codebase licensed under MIT

## How It Works

1. Host creates a transfer session and shares the link
2. Recipient joins using the shared link or QR code
3. Files transfer directly between devices with encryption
4. Connection closes automatically when complete

## Technologies Used

- PeerJS for WebRTC connections
- StreamSaver.js for efficient file downloads
- QRCode.js for generating shareable QR codes
- Material Icons for UI elements

## Installation

No installation required! Simply visit the [live website](https://thegandabherunda.github.io/NimFile/) to start using NIMFILE.

For local development:

```bash
git clone https://github.com/ProjectSolutus/NimFile.git
cd nimfile
# Open index.html in your browser

