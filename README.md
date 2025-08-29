# VS Code LangChain Tools

This project provides 4 powerful LangChain tools for VS Code workspace file management operations.

## Tools Overview

### 1. Create File or Folder Tool (`create_file_or_folder`)
Creates new files or folders in your VS Code workspace.

**Parameters:**
- `path` (string): The relative or absolute path where to create the file or folder
- `type` (enum): Either "file" or "folder"
- `content` (string, optional): Content to write to the file (only used when type is 'file')

**Example:**
```typescript
await createFileOrFolderTool.func({
  path: "./src/components",
  type: "folder"
});

await createFileOrFolderTool.func({
  path: "./src/index.js",
  type: "file",
  content: "console.log('Hello World!');"
});
```

### 2. List Files Tool (`list_files`)
Lists all files and directories in a specified path.

**Parameters:**
- `path` (string, default: "."): The path to list files from
- `recursive` (boolean, default: false): Whether to list files recursively
- `showHidden` (boolean, default: false): Whether to show hidden files

**Example:**
```typescript
await listFilesTool.func({
  path: "./src",
  recursive: true,
  showHidden: false
});
```

### 3. Read File Tool (`read_file`)
Reads the content of a file in the workspace.

**Parameters:**
- `path` (string): The path to the file to read
- `encoding` (string, default: "utf8"): File encoding

**Example:**
```typescript
await readFileTool.func({
  path: "./package.json",
  encoding: "utf8"
});
```

### 4. Edit File Tool (`edit_file`)
Edits the content of an existing file.

**Parameters:**
- `path` (string): The path to the file to edit
- `content` (string): The new content to write
- `mode` (enum, default: "overwrite"): Either "overwrite" or "append"
- `createIfNotExists` (boolean, default: false): Create the file if it doesn't exist

**Example:**
```typescript
await editFileTool.func({
  path: "./src/config.js",
  content: "module.exports = { version: '1.0.0' };",
  mode: "overwrite",
  createIfNotExists: true
});
```

## Setup

1. Install dependencies:
```bash
npm install @langchain/core @langchain/google-genai zod
```

2. Import the tools:
```typescript
import { vscodeTools } from "./tools/vscode-tools";
// Or import individual tools:
import { createFileOrFolderTool, listFilesTool, readFileTool, editFileTool } from "./tools/vscode-tools";
```

## Usage with LangChain Agent

```typescript
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { AgentExecutor, createToolCallingAgent } from "@langchain/langgraph/prebuilt";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { vscodeTools } from "./tools/vscode-tools";

const model = new ChatGoogleGenerativeAI({
  modelName: "gemini-pro",
  apiKey: process.env.GOOGLE_API_KEY,
});

const prompt = ChatPromptTemplate.fromMessages([
  ["system", "You are a helpful assistant that can manage files and folders in VS Code workspace."],
  ["human", "{input}"],
  ["placeholder", "{agent_scratchpad}"],
]);

const agent = createToolCallingAgent({
  llm: model,
  tools: vscodeTools,
  prompt,
});

const agentExecutor = new AgentExecutor({
  agent,
  tools: vscodeTools,
});

// Use the agent
const result = await agentExecutor.invoke({
  input: "Create a new React component file called Button.jsx in the components folder"
});
```

## Direct Tool Usage

You can also use the tools directly without an LLM:

```typescript
import { vscodeTools } from "./tools/vscode-tools";

// Create a folder
const result = await vscodeTools[0].func({
  path: "./new-folder",
  type: "folder"
});

console.log(result);
```

## Features

- ✅ **Cross-platform**: Works on Windows, macOS, and Linux
- ✅ **Type-safe**: Full TypeScript support with Zod schema validation
- ✅ **Error handling**: Comprehensive error messages and validation
- ✅ **Flexible paths**: Supports both relative and absolute paths
- ✅ **Rich output**: Detailed information about file operations
- ✅ **Recursive operations**: List files recursively in directories
- ✅ **Multiple edit modes**: Overwrite or append to files
- ✅ **Auto-creation**: Create directories automatically when needed

## Running the Example

To test the tools:

```bash
npm run dev:tsx
```

This will run the direct tool usage examples and create a test folder with sample files.

## Environment Setup

Make sure to set your Google API key if using with Gemini:

```bash
# Set environment variable
export GOOGLE_API_KEY=your_api_key_here
```

Or create a `.env` file:
```
GOOGLE_API_KEY=your_api_key_here
```
