// WebSocket connection
let ws;
let isConnected = false;

// DOM elements
const chatMessages = document.getElementById("chat-messages");
const chatInput = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");
const fileTree = document.getElementById("file-tree");
const refreshBtn = document.getElementById("refresh-tree");

// Initialize the application
function init() {
  connectWebSocket();
  setupEventListeners();
  loadFileTree();
}

// WebSocket connection
function connectWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}`;

  ws = new WebSocket(wsUrl);

  ws.onopen = function () {
    isConnected = true;
    console.log("Connected to WebSocket");
    updateConnectionStatus(true);
  };

  ws.onmessage = function (event) {
    const data = JSON.parse(event.data);
    handleWebSocketMessage(data);
  };

  ws.onclose = function () {
    isConnected = false;
    console.log("WebSocket connection closed");
    updateConnectionStatus(false);
    // Attempt to reconnect after 3 seconds
    setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = function (error) {
    console.error("WebSocket error:", error);
    updateConnectionStatus(false);
  };
}

// Handle WebSocket messages
function handleWebSocketMessage(data) {
  switch (data.type) {
    case "response":
      addAssistantMessage(data.content);
      break;
    case "investigation":
      addInvestigationMessage(data.content);
      break;
    case "tool_execution":
      addToolExecutionMessage(data.tool, data.result);
      break;
    case "error":
      addErrorMessage(data.message);
      break;
    case "file_tree":
      updateFileTree(data.tree);
      break;
  }
}

// Setup event listeners
function setupEventListeners() {
  // Send message on button click
  sendBtn.addEventListener("click", sendMessage);

  // Send message on Enter key
  chatInput.addEventListener("keypress", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Refresh file tree
  refreshBtn.addEventListener("click", loadFileTree);
}

// Send message to the assistant
function sendMessage() {
  const message = chatInput.value.trim();
  if (!message || !isConnected) return;

  // Add user message to chat
  addUserMessage(message);

  // Clear input and disable send button
  chatInput.value = "";
  setSendButtonState(false);

  // Send message via WebSocket
  ws.send(
    JSON.stringify({
      type: "chat",
      message: message,
    })
  );
}

// Add user message to chat
function addUserMessage(message) {
  const messageDiv = document.createElement("div");
  messageDiv.className = "message user-message";
  messageDiv.innerHTML = `
        <div class="message-content">
            <strong>👤 You:</strong> ${escapeHtml(message)}
        </div>
    `;
  chatMessages.appendChild(messageDiv);
  scrollToBottom();
}

// Add assistant message to chat
function addAssistantMessage(content) {
  const messageDiv = document.createElement("div");
  messageDiv.className = "message assistant-message";
  messageDiv.innerHTML = `
        <div class="message-content">
            <strong>🤖 Assistant:</strong> ${escapeHtml(content)}
        </div>
    `;
  chatMessages.appendChild(messageDiv);
  scrollToBottom();
  setSendButtonState(true);
}

// Add investigation message from thinker agent
function addInvestigationMessage(content) {
  const messageDiv = document.createElement("div");
  messageDiv.className = "message investigation-message";
  messageDiv.innerHTML = `
        <div class="message-content">
            <strong>🕵️ Investigative Thinker:</strong> ${escapeHtml(content)}
        </div>
    `;
  chatMessages.appendChild(messageDiv);
  scrollToBottom();
}

// Add tool execution message
function addToolExecutionMessage(toolName, result) {
  const messageDiv = document.createElement("div");
  messageDiv.className = "message assistant-message";
  messageDiv.innerHTML = `
        <div class="message-content">
            <div class="tool-execution">
                <strong>🔧 Tool Executed:</strong> ${toolName}<br>
                <strong>📋 Result:</strong> ${escapeHtml(result)}
            </div>
        </div>
    `;
  chatMessages.appendChild(messageDiv);
  scrollToBottom();

  // Refresh file tree after file operations
  if (
    ["create_file_or_folder", "move_file_or_folder", "edit_file"].includes(
      toolName
    )
  ) {
    setTimeout(loadFileTree, 500);
  }
}

// Add error message
function addErrorMessage(error) {
  const messageDiv = document.createElement("div");
  messageDiv.className = "message assistant-message";
  messageDiv.innerHTML = `
        <div class="message-content">
            <strong>❌ Error:</strong> ${escapeHtml(error)}
        </div>
    `;
  chatMessages.appendChild(messageDiv);
  scrollToBottom();
  setSendButtonState(true);
}

// Load file tree
async function loadFileTree() {
  try {
    const response = await fetch("/api/file-tree");
    const data = await response.json();
    updateFileTree(data.tree);
  } catch (error) {
    console.error("Error loading file tree:", error);
    fileTree.innerHTML =
      '<div style="color: red;">Error loading file tree</div>';
  }
}

// Update file tree display
function updateFileTree(tree) {
  fileTree.innerHTML = renderDirectoryTree(tree);
}

// Render directory tree recursively
function renderDirectoryTree(items, indent = 0) {
  let html = "";

  for (const item of items) {
    const indentStyle = `margin-left: ${indent * 20}px`;
    const icon = item.type === "directory" ? "📁" : "📄";
    const className =
      item.type === "directory" ? "tree-item folder" : "tree-item file";

    html += `
            <div class="${className}" style="${indentStyle}" title="${item.path}">
                ${icon} ${item.name}
            </div>
        `;

    if (item.type === "directory" && item.children) {
      html += renderDirectoryTree(item.children, indent + 1);
    }
  }

  return html;
}

// Utility functions
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function scrollToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function setSendButtonState(enabled) {
  sendBtn.disabled = !enabled;
  sendBtn.innerHTML = enabled ? "Send 📤" : '<div class="loading"></div>';
}

function updateConnectionStatus(connected) {
  // You can add a connection status indicator here if needed
  setSendButtonState(connected);
}

// Initialize the app when DOM is loaded
document.addEventListener("DOMContentLoaded", init);
