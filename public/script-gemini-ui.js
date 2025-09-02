class GeminiAgentsUI {
  constructor() {
    this.chatMessages = document.getElementById("chatMessages");
    this.chatInput = document.getElementById("chatInput");
    this.sendBtn = document.getElementById("sendBtn");
    this.stopBtn = document.getElementById("stopBtn");
    this.refreshBtn = document.getElementById("refreshBtn");
    this.fileTree = document.getElementById("fileTree");
    this.statusText = document.getElementById("statusText");
    this.iterationCount = document.getElementById("iterationCount");
    this.memoryCount = document.getElementById("memoryCount");

    // API Key elements
    this.apiKeyBtn = document.getElementById("apiKeyBtn");
    this.apiKeyModal = document.getElementById("apiKeyModal");
    this.apiKeyInput = document.getElementById("apiKeyInput");
    this.apiKeyStatus = document.getElementById("apiKeyStatus");
    this.saveApiKeyBtn = document.getElementById("saveApiKey");
    this.clearApiKeyBtn = document.getElementById("clearApiKey");
    this.modalClose = document.getElementById("modalClose");

    this.isProcessing = false;
    this.iterations = 0;
    this.memory = 0;
    this.apiKey = localStorage.getItem("gemini-api-key") || "";
    this.currentReader = null; // To store the reader for cancellation

    this.initializeEventListeners();
    this.loadFileTree();
    this.addWelcomeMessage();
    this.updateApiKeyButton();
  }

  initializeEventListeners() {
    this.sendBtn.addEventListener("click", () => this.sendMessage());
    this.stopBtn.addEventListener("click", () => this.stopProcessing());
    this.chatInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });
    this.refreshBtn.addEventListener("click", () => this.loadFileTree());

    // API Key modal events
    this.apiKeyBtn.addEventListener("click", () => this.showApiKeyModal());
    this.modalClose.addEventListener("click", () => this.hideApiKeyModal());
    this.saveApiKeyBtn.addEventListener("click", () => this.saveApiKey());
    this.clearApiKeyBtn.addEventListener("click", () => this.clearApiKey());

    // Close modal when clicking outside
    this.apiKeyModal.addEventListener("click", (e) => {
      if (e.target === this.apiKeyModal) {
        this.hideApiKeyModal();
      }
    });
  }

  updateApiKeyButton() {
    if (this.apiKey) {
      this.apiKeyBtn.textContent = "🔑 API Key Configured";
      this.apiKeyBtn.classList.add("configured");
    } else {
      this.apiKeyBtn.textContent = "🔑 Configure API Key";
      this.apiKeyBtn.classList.remove("configured");
    }
  }

  showApiKeyModal() {
    this.apiKeyInput.value = this.apiKey ? "••••••••••••••••" : "";
    this.apiKeyStatus.textContent = "";
    this.apiKeyStatus.className = "api-key-status";
    this.apiKeyModal.style.display = "flex";
    if (!this.apiKey) {
      this.apiKeyInput.focus();
    }
  }

  hideApiKeyModal() {
    this.apiKeyModal.style.display = "none";
  }

  saveApiKey() {
    const apiKey = this.apiKeyInput.value.trim();

    if (!apiKey || apiKey === "••••••••••••••••") {
      this.apiKeyStatus.textContent = "Please enter a valid API key";
      this.apiKeyStatus.className = "api-key-status error";
      return;
    }

    // Basic validation - Gemini API keys typically start with "AIza"
    if (!apiKey.startsWith("AIza") || apiKey.length < 35) {
      this.apiKeyStatus.textContent =
        'Invalid API key format. Gemini API keys should start with "AIza"';
      this.apiKeyStatus.className = "api-key-status error";
      return;
    }

    this.apiKey = apiKey;
    localStorage.setItem("gemini-api-key", apiKey);
    this.apiKeyStatus.textContent = "API key saved successfully!";
    this.apiKeyStatus.className = "api-key-status success";
    this.updateApiKeyButton();

    // Clear and reload welcome message
    this.chatMessages.innerHTML = "";
    this.addWelcomeMessage();

    setTimeout(() => {
      this.hideApiKeyModal();
    }, 1500);
  }

  clearApiKey() {
    this.apiKey = "";
    localStorage.removeItem("gemini-api-key");
    this.apiKeyInput.value = "";
    this.apiKeyStatus.textContent = "API key cleared";
    this.apiKeyStatus.className = "api-key-status success";
    this.updateApiKeyButton();

    // Clear and reload welcome message
    this.chatMessages.innerHTML = "";
    this.addWelcomeMessage();

    setTimeout(() => {
      this.hideApiKeyModal();
    }, 1500);
  }

  addWelcomeMessage() {
    const welcomeText = this.apiKey
      ? '🤖 Assistant:\n\nMulti-Agent System with Persistent Memory is ready!\n\nI can help you create files, manage your project structure, and execute complex coding tasks. My memory persists across requests, so I remember our conversation and previous work.\n\nSpecial Commands:\n• "status" - Show tool usage statistics\n• "memory" - Display current memory contents\n• "clear" - Clear memory and start fresh\n\nTry asking me to create a complete project or component!'
      : '🤖 Assistant:\n\n⚠️ **API Key Required**\n\nTo use the AI assistant, you need to configure your Google Gemini API key first.\n\n🔑 Click the "Configure API Key" button in the top-right corner to get started.\n\nOnce configured, I can help you create files, manage your project structure, and execute complex coding tasks!';

    this.addMessage("assistant", "🤖 Assistant:", welcomeText);
  }

  async sendMessage() {
    const message = this.chatInput.value.trim();
    if (!message || this.isProcessing) return;

    // Check if API key is configured
    if (!this.apiKey) {
      this.addMessage(
        "system",
        "❌ Error:",
        "Please configure your Gemini API key first. Click the 🔑 Configure API Key button in the header."
      );
      return;
    }

    // Add user message
    this.addMessage("user", "👤 You:", message);
    this.chatInput.value = "";

    // Set processing state
    this.setProcessing(true);
    this.addLoadingMessage();

    try {
      // Send to backend API with API key
      const response = await fetch("/api/process", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gemini-API-Key": this.apiKey,
        },
        body: JSON.stringify({ message }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      // Handle streaming response
      const reader = response.body.getReader();
      this.currentReader = reader; // Store reader for cancellation
      const decoder = new TextDecoder();

      this.removeLoadingMessage();
      let currentMessage = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              this.handleStreamData(data);
            } catch (e) {
              console.log("Parse error:", e);
            }
          }
        }
      }
    } catch (error) {
      console.error("Error:", error);
      this.removeLoadingMessage();
      this.addMessage(
        "system",
        "❌ Error:",
        `Failed to process request: ${error.message}`
      );
    } finally {
      this.currentReader = null; // Clear reader reference
      this.setProcessing(false);
    }
  }

  handleStreamData(data) {
    switch (data.type) {
      case "planning_start":
        this.updateStatus("Creating structured plan...");
        this.addMessage(
          "system",
          "📋 Planner:",
          "Starting to create a detailed plan for your request..."
        );
        break;

      case "plan_created":
        if (data.requiresApproval) {
          this.updateStatus("Plan created - awaiting your approval...");
          this.showPlanForEditing(data.plan);
        } else {
          this.updateStatus("Plan approved, beginning execution...");
          this.addMessage("system", "📋 Plan Approved:", data.plan);
        }
        break;

      case "plan_exists":
        this.updateStatus("Using existing plan, beginning execution...");
        this.addMessage("system", "📋 Existing Plan:", data.plan);
        break;

      case "plan_approved":
        this.updateStatus("Plan approved, beginning execution...");
        this.addMessage("system", "✅ Plan:", data.message);
        break;

      case "plan_edited":
        this.updateStatus("Plan updated, beginning execution...");
        this.addMessage("system", "📝 Plan Updated:", data.plan);
        break;

      case "iteration_start":
        this.iterations = data.iteration;
        this.updateStatus(`Processing iteration ${data.iteration}...`);
        this.updateIterationCount(data.iteration);
        this.addMessage(
          "system",
          "🔄 System:",
          `Starting iteration ${data.iteration}`
        );
        break;

      case "agent_start":
        let agentIcon = "⚡";
        let agentAction = "working";

        if (data.agent === "planner") {
          agentIcon = "📋";
          agentAction = "planning";
        } else if (data.agent === "analyst") {
          agentIcon = "🧠";
          agentAction = "analyzing";
        } else if (data.agent === "executor") {
          agentIcon = "⚡";
          agentAction = "executing";
        }

        this.addMessage(
          "system",
          `${agentIcon} ${data.agent}:`,
          `${data.agent} is ${agentAction}...`
        );
        break;

      case "tool_execution":
        this.addMessage(
          "system",
          "🔧 Tool:",
          `Executing ${data.tool} with args: ${JSON.stringify(
            data.args,
            null,
            2
          )}`
        );
        break;

      case "tool_result":
        this.addMessage(
          "system",
          "✅ Result:",
          data.result.substring(0, 200) +
            (data.result.length > 200 ? "..." : "")
        );
        break;

      case "agent_response":
        let responseIcon = "⚡";
        if (data.agent === "planner") {
          responseIcon = "📋";
        } else if (data.agent === "analyst") {
          responseIcon = "🧠";
        } else if (data.agent === "executor") {
          responseIcon = "⚡";
        }

        this.addMessage(
          "assistant",
          `${responseIcon} ${data.agent}:`,
          data.response
        );
        break;

      case "memory_update":
        this.memory = data.count;
        this.updateMemoryCount(data.count);
        break;

      case "plan_completed":
        this.updateStatus("Plan completed successfully!");
        this.addMessage("system", "🎯 Plan Complete:", data.message);
        break;

      case "task_complete":
        this.updateStatus("Task completed");
        this.addMessage(
          "system",
          "✅ Complete:",
          "Task has been completed successfully!"
        );
        this.loadFileTree(); // Refresh file tree
        break;

      case "error":
        this.addMessage("system", "❌ Error:", data.message);
        break;

      case "status_info":
        this.addMessage(
          "system",
          "📊 Status:",
          `Analyst tools used: ${data.analystToolUsage}, Executor tools used: ${data.executorToolUsage}, Memory entries: ${data.memoryEntries}`
        );
        break;

      case "memory_dump":
        this.addMessage("system", "🧠 Memory:", data.content);
        break;

      case "memory_cleared":
        this.addMessage("system", "🗑️ Clear:", data.message);
        this.updateMemoryCount(0);
        break;

      case "plan_cleared":
        this.addMessage("system", "🧹 Plan Cleared:", data.message);
        break;
    }
  }

  addMessage(type, sender, content) {
    const messageDiv = document.createElement("div");
    messageDiv.className = `message ${type}`;

    const headerDiv = document.createElement("div");
    headerDiv.className = "message-header";
    headerDiv.textContent = sender;

    const contentDiv = document.createElement("div");
    contentDiv.className = "message-content";
    contentDiv.textContent = content;

    messageDiv.appendChild(headerDiv);
    messageDiv.appendChild(contentDiv);

    this.chatMessages.appendChild(messageDiv);
    this.scrollToBottom();
  }

  addLoadingMessage() {
    const messageDiv = document.createElement("div");
    messageDiv.className = "message assistant loading";
    messageDiv.id = "loading-message";

    const headerDiv = document.createElement("div");
    headerDiv.className = "message-header";
    headerDiv.textContent = "🤖 Assistant:";

    const contentDiv = document.createElement("div");
    contentDiv.className = "loading-indicator";
    contentDiv.innerHTML = `
            Multi-Agent System is analyzing your request...
            <div class="loading-dots">
                <span></span>
                <span></span>
                <span></span>
            </div>
        `;

    messageDiv.appendChild(headerDiv);
    messageDiv.appendChild(contentDiv);

    this.chatMessages.appendChild(messageDiv);
    this.scrollToBottom();
  }

  removeLoadingMessage() {
    const loadingMessage = document.getElementById("loading-message");
    if (loadingMessage) {
      loadingMessage.remove();
    }
  }

  setProcessing(processing) {
    this.isProcessing = processing;
    this.sendBtn.disabled = processing;
    this.chatInput.disabled = processing;

    if (processing) {
      this.updateStatus("Processing...");
      this.sendBtn.textContent = "Processing...";
      this.stopBtn.style.display = "flex";
    } else {
      this.updateStatus("Ready");
      this.sendBtn.innerHTML =
        '<span>Send</span><span class="send-icon">↗️</span>';
      this.stopBtn.style.display = "none";
    }
  }

  stopProcessing() {
    if (this.currentReader) {
      try {
        this.currentReader.cancel();
      } catch (e) {
        console.log("Reader cancellation error:", e);
      }
    }

    this.setProcessing(false);
    this.removeLoadingMessage();
    this.addMessage(
      "system",
      "🛑 Stopped:",
      "Processing has been stopped by user request."
    );
  }

  updateStatus(status) {
    this.statusText.textContent = status;
  }

  updateIterationCount(count) {
    this.iterationCount.textContent = count;
  }

  updateMemoryCount(count) {
    this.memoryCount.textContent = count;
  }

  scrollToBottom() {
    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
  }

  async loadFileTree() {
    try {
      const response = await fetch("/api/files");
      if (!response.ok) throw new Error("Failed to load files");

      const files = await response.json();
      this.renderFileTree(files);
    } catch (error) {
      console.error("Error loading file tree:", error);
      this.fileTree.innerHTML =
        '<div style="color: #ff6b6b; padding: 16px;">Error loading files</div>';
    }
  }

  renderFileTree(files, container = this.fileTree, level = 0) {
    if (level === 0) {
      container.innerHTML = "";
    }

    files.forEach((file) => {
      const fileDiv = document.createElement("div");
      fileDiv.className = `file-item ${file.type}`;
      if (level > 0) {
        fileDiv.style.marginLeft = `${level * 16}px`;
      }

      const icon = file.type === "folder" ? "📁" : "📄";
      const size = file.size ? ` (${file.size})` : "";

      fileDiv.innerHTML = `<span>${icon}</span><span>${file.name}${size}</span>`;

      container.appendChild(fileDiv);

      if (file.children && file.children.length > 0) {
        this.renderFileTree(file.children, container, level + 1);
      }
    });
  }

  showPlanForEditing(plan) {
    // Create plan editing interface
    const planDiv = document.createElement("div");
    planDiv.className = "plan-editor";
    planDiv.innerHTML = `
      <div class="plan-editor-content">
        <h3>📋 Review & Edit Plan</h3>
        <p>Please review the plan below. You can edit it or approve as-is:</p>
        <textarea id="planEditor" class="plan-textarea" rows="15">${plan}</textarea>
        <div class="plan-buttons">
          <button id="approvePlan" class="approve-btn">✅ Approve Plan</button>
          <button id="editPlan" class="edit-btn">📝 Execute Edited Plan</button>
        </div>
      </div>
    `;

    // Add to chat
    this.chatMessages.appendChild(planDiv);
    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;

    // Add event listeners
    document.getElementById("approvePlan").addEventListener("click", () => {
      this.approvePlan();
      planDiv.remove();
    });

    document.getElementById("editPlan").addEventListener("click", () => {
      const editedPlan = document.getElementById("planEditor").value;
      this.executeEditedPlan(editedPlan);
      planDiv.remove();
    });
  }

  async approvePlan() {
    this.setProcessing(true);
    this.addLoadingMessage();

    try {
      const response = await fetch("/api/process", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gemini-API-Key": this.apiKey,
        },
        body: JSON.stringify({
          message: "Proceed with approved plan",
          planEdit: { action: "approve" },
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      // Handle streaming response
      const reader = response.body.getReader();
      this.currentReader = reader;
      const decoder = new TextDecoder();

      this.removeLoadingMessage();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              this.handleStreamData(data);
            } catch (e) {
              console.log("Parse error:", e);
            }
          }
        }
      }
    } catch (error) {
      console.error("Error:", error);
      this.removeLoadingMessage();
      this.addMessage(
        "system",
        "❌ Error:",
        `Failed to approve plan: ${error.message}`
      );
    } finally {
      this.currentReader = null;
      this.setProcessing(false);
    }
  }

  async executeEditedPlan(editedPlan) {
    this.setProcessing(true);
    this.addLoadingMessage();

    try {
      const response = await fetch("/api/process", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gemini-API-Key": this.apiKey,
        },
        body: JSON.stringify({
          message: "Proceed with edited plan",
          planEdit: {
            action: "edit",
            editedPlan: editedPlan,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      // Handle streaming response
      const reader = response.body.getReader();
      this.currentReader = reader;
      const decoder = new TextDecoder();

      this.removeLoadingMessage();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              this.handleStreamData(data);
            } catch (e) {
              console.log("Parse error:", e);
            }
          }
        }
      }
    } catch (error) {
      console.error("Error:", error);
      this.removeLoadingMessage();
      this.addMessage(
        "system",
        "❌ Error:",
        `Failed to execute edited plan: ${error.message}`
      );
    } finally {
      this.currentReader = null;
      this.setProcessing(false);
    }
  }
}

// Initialize the UI when the page loads
document.addEventListener("DOMContentLoaded", () => {
  new GeminiAgentsUI();
});
