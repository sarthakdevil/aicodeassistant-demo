import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";

// Tool 1: Create File or Folder
export const createFileOrFolderTool = new DynamicStructuredTool({
  name: "create_file_or_folder",
  description: "Create a new file or folder in the VS Code workspace. Specify whether to create a file or folder using the 'type' parameter.",
  schema: z.object({
    path: z.string().describe("The relative or absolute path where to create the file or folder"),
    type: z.enum(["file", "folder"]).describe("Whether to create a file or folder"),
    content: z.string().optional().describe("Content to write to the file (only used when type is 'file')")
  }),
  func: async ({ path: targetPath, type, content = "" }: { path: string; type: "file" | "folder"; content?: string }) => {
    try {
      const absolutePath = path.isAbsolute(targetPath)
        ? targetPath 
        : path.join(process.cwd(), targetPath);

      if (type === "folder") {
        // Create directory
        fs.mkdirSync(absolutePath, { recursive: true });
        return `Successfully created folder: ${absolutePath}`;
      } else {
        // Create file
        const dirPath = path.dirname(absolutePath);
        
        // Ensure directory exists
        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true });
        }
        
        // Create file with content
        fs.writeFileSync(absolutePath, content, 'utf8');
        return `Successfully created file: ${absolutePath}`;
      }
    } catch (error) {
      return `Error creating ${type}: ${error}`;
    }
  }
});

// Tool 2: List Files and Directories
export const listFilesTool = new DynamicStructuredTool({
  name: "list_files",
  description: "List all files and directories in a specified path within the VS Code workspace",
  schema: z.object({
    path: z.string().default(".").describe("The path to list files from (defaults to current directory)"),
    recursive: z.boolean().default(false).describe("Whether to list files recursively"),
    showHidden: z.boolean().default(false).describe("Whether to show hidden files (starting with .)")
  }),
  func: async ({ path: targetPath = ".", recursive = false, showHidden = false }: { path?: string; recursive?: boolean; showHidden?: boolean }) => {
    try {
      const absolutePath = path.isAbsolute(targetPath) 
        ? targetPath 
        : path.join(process.cwd(), targetPath);

      if (!fs.existsSync(absolutePath)) {
        return `Path does not exist: ${absolutePath}`;
      }

      const listDirectory = (dirPath: string, level: number = 0): string[] => {
        const items: string[] = [];
        const indent = "  ".repeat(level);
        
        try {
          const entries = fs.readdirSync(dirPath, { withFileTypes: true });
          
          for (const entry of entries) {
            // Skip hidden files if not requested
            if (!showHidden && entry.name.startsWith('.')) {
              continue;
            }

            const fullPath = path.join(dirPath, entry.name);
            const relativePath = path.relative(process.cwd(), fullPath);
            
            if (entry.isDirectory()) {
              items.push(`${indent}📁 ${entry.name}/`);
              if (recursive) {
                items.push(...listDirectory(fullPath, level + 1));
              }
            } else {
              const stats = fs.statSync(fullPath);
              const size = `${(stats.size / 1024).toFixed(1)}KB`;
              items.push(`${indent}📄 ${entry.name} (${size})`);
            }
          }
        } catch (error) {
          items.push(`${indent}❌ Error reading directory: ${error}`);
        }
        
        return items;
      };

      const result = listDirectory(absolutePath);
      return `Files and directories in ${absolutePath}:\n${result.join('\n')}`;
    } catch (error) {
      return `Error listing files: ${error}`;
    }
  }
});

// Tool 3: Read File Content
export const readFileTool = new DynamicStructuredTool({
  name: "read_file",
  description: "Read the content of a file in the VS Code workspace",
  schema: z.object({
    path: z.string().describe("The path to the file to read"),
    encoding: z.string().default("utf8").describe("File encoding (defaults to utf8)")
  }),
  func: async ({ path: filePath, encoding = "utf8" }: { path: string; encoding?: string }) => {
    try {
      const absolutePath = path.isAbsolute(filePath) 
        ? filePath 
        : path.join(process.cwd(), filePath);

      if (!fs.existsSync(absolutePath)) {
        return `File does not exist: ${absolutePath}`;
      }

      const stats = fs.statSync(absolutePath);
      if (stats.isDirectory()) {
        return `Path is a directory, not a file: ${absolutePath}`;
      }

      const content = fs.readFileSync(absolutePath, encoding as BufferEncoding);
      const fileSize = `${(stats.size / 1024).toFixed(1)}KB`;
      const lineCount = content.split('\n').length;
      
      return `File: ${absolutePath}\nSize: ${fileSize}\nLines: ${lineCount}\n\nContent:\n${content}`;
    } catch (error) {
      return `Error reading file: ${error}`;
    }
  }
});

// Tool 4: Edit File Content
export const editFileTool = new DynamicStructuredTool({
  name: "edit_file",
  description: "Edit the content of an existing file in the VS Code workspace. Can replace entire content or append to file.",
  schema: z.object({
    path: z.string().describe("The path to the file to edit"),
    content: z.string().describe("The new content to write to the file"),
    mode: z.enum(["overwrite", "append"]).default("overwrite").describe("Whether to overwrite the file or append to it"),
    createIfNotExists: z.boolean().default(false).describe("Create the file if it doesn't exist")
  }),
  func: async ({ path: filePath, content, mode = "overwrite", createIfNotExists = false }: { path: string; content: string; mode?: "overwrite" | "append"; createIfNotExists?: boolean }) => {
    try {
      const absolutePath = path.isAbsolute(filePath) 
        ? filePath 
        : path.join(process.cwd(), filePath);

      // Check if file exists
      if (!fs.existsSync(absolutePath)) {
        if (createIfNotExists) {
          // Create directory if it doesn't exist
          const dirPath = path.dirname(absolutePath);
          if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
          }
        } else {
          return `File does not exist: ${absolutePath}. Use createIfNotExists: true to create it.`;
        }
      }

      // Check if it's a directory
      if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory()) {
        return `Path is a directory, not a file: ${absolutePath}`;
      }

      let finalContent = content;
      
      if (mode === "append" && fs.existsSync(absolutePath)) {
        const existingContent = fs.readFileSync(absolutePath, 'utf8');
        finalContent = existingContent + content;
      }

      // Write the content
      fs.writeFileSync(absolutePath, finalContent, 'utf8');
      
      const stats = fs.statSync(absolutePath);
      const fileSize = `${(stats.size / 1024).toFixed(1)}KB`;
      const lineCount = finalContent.split('\n').length;
      
      return `Successfully ${mode === "overwrite" ? "overwrote" : "appended to"} file: ${absolutePath}\nNew size: ${fileSize}\nNew line count: ${lineCount}`;
    } catch (error) {
      return `Error editing file: ${error}`;
    }
  }
});

// Tool 5: Move File or Folder
export const moveFileOrFolderTool = new DynamicStructuredTool({
  name: "move_file_or_folder",
  description: "Move or rename a file or folder in the VS Code workspace. Can move files/folders to different directories or rename them.",
  schema: z.object({
    sourcePath: z.string().describe("The current path of the file or folder to move"),
    destinationPath: z.string().describe("The new path where the file or folder should be moved to"),
    createDestinationDir: z.boolean().default(false).describe("Whether to create the destination directory if it doesn't exist")
  }),
  func: async ({ sourcePath, destinationPath, createDestinationDir = false }: { sourcePath: string; destinationPath: string; createDestinationDir?: boolean }) => {
    try {
      const absoluteSourcePath = path.isAbsolute(sourcePath) 
        ? sourcePath 
        : path.join(process.cwd(), sourcePath);
      
      const absoluteDestinationPath = path.isAbsolute(destinationPath) 
        ? destinationPath 
        : path.join(process.cwd(), destinationPath);

      // Check if source exists
      if (!fs.existsSync(absoluteSourcePath)) {
        return `Source path does not exist: ${absoluteSourcePath}`;
      }

      // Check if destination directory exists, create if needed
      const destinationDir = path.dirname(absoluteDestinationPath);
      if (!fs.existsSync(destinationDir)) {
        if (createDestinationDir) {
          fs.mkdirSync(destinationDir, { recursive: true });
        } else {
          return `Destination directory does not exist: ${destinationDir}. Use createDestinationDir: true to create it.`;
        }
      }

      // Check if destination already exists
      if (fs.existsSync(absoluteDestinationPath)) {
        return `Destination already exists: ${absoluteDestinationPath}`;
      }

      // Get file/folder info before moving
      const stats = fs.statSync(absoluteSourcePath);
      const isDirectory = stats.isDirectory();
      const fileSize = isDirectory ? "N/A" : `${(stats.size / 1024).toFixed(1)}KB`;

      // Move the file or folder
      fs.renameSync(absoluteSourcePath, absoluteDestinationPath);
      
      return `Successfully moved ${isDirectory ? 'folder' : 'file'}: ${absoluteSourcePath} -> ${absoluteDestinationPath}${!isDirectory ? `\nSize: ${fileSize}` : ''}`;
    } catch (error: any) {
      return `Error moving file/folder: ${error.message}`;
    }
  }
});

// Tool 6: Search File Content
export const searchInFilesTool = new DynamicStructuredTool({
  name: "search_in_files",
  description: "Search for specific text or patterns across files in the workspace. Useful for finding functions, classes, imports, or specific code patterns.",
  schema: z.object({
    searchTerm: z.string().describe("The text or pattern to search for"),
    fileExtensions: z.array(z.string()).optional().describe("Filter by file extensions (e.g., ['.ts', '.js', '.json'])"),
    directory: z.string().default(".").describe("Directory to search in (defaults to current directory)"),
    caseSensitive: z.boolean().default(false).describe("Whether the search should be case sensitive"),
    maxResults: z.number().default(50).describe("Maximum number of matches to return")
  }),
  func: async ({ searchTerm, fileExtensions, directory = ".", caseSensitive = false, maxResults = 50 }: { 
    searchTerm: string; 
    fileExtensions?: string[]; 
    directory?: string; 
    caseSensitive?: boolean; 
    maxResults?: number 
  }) => {
    try {
      const absolutePath = path.isAbsolute(directory) 
        ? directory 
        : path.join(process.cwd(), directory);

      if (!fs.existsSync(absolutePath)) {
        return `Directory does not exist: ${absolutePath}`;
      }

      const results: string[] = [];
      let resultCount = 0;

      const searchInDirectory = (dirPath: string) => {
        if (resultCount >= maxResults) return;

        try {
          const entries = fs.readdirSync(dirPath, { withFileTypes: true });
          
          for (const entry of entries) {
            if (resultCount >= maxResults) break;

            const fullPath = path.join(dirPath, entry.name);
            
            if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
              searchInDirectory(fullPath);
            } else if (entry.isFile()) {
              // Check file extension filter
              if (fileExtensions && fileExtensions.length > 0) {
                const ext = path.extname(entry.name);
                if (!fileExtensions.includes(ext)) continue;
              }

              try {
                const content = fs.readFileSync(fullPath, 'utf8');
                const searchText = caseSensitive ? searchTerm : searchTerm.toLowerCase();
                const fileContent = caseSensitive ? content : content.toLowerCase();
                
                if (fileContent.includes(searchText)) {
                  const lines = content.split('\n');
                  const relativePath = path.relative(process.cwd(), fullPath);
                  
                  // Find matching lines
                  const matchingLines: string[] = [];
                  lines.forEach((line, index) => {
                    const checkLine = caseSensitive ? line : line.toLowerCase();
                    if (checkLine.includes(searchText)) {
                      matchingLines.push(`  Line ${index + 1}: ${line.trim()}`);
                    }
                  });

                  if (matchingLines.length > 0) {
                    results.push(`📄 ${relativePath}:\n${matchingLines.slice(0, 5).join('\n')}`);
                    resultCount++;
                  }
                }
              } catch (error) {
                // Skip files that can't be read as text
              }
            }
          }
        } catch (error) {
          // Skip directories that can't be read
        }
      };

      searchInDirectory(absolutePath);

      if (results.length === 0) {
        return `No matches found for "${searchTerm}" in ${absolutePath}`;
      }

      return `Found ${results.length} files containing "${searchTerm}":\n\n${results.join('\n\n')}`;
    } catch (error) {
      return `Error searching files: ${error}`;
    }
  }
});

// Terminal execution tool
export const executeInTerminalTool = new DynamicStructuredTool({
  name: "execute_in_terminal",
  description: "Execute a command in the terminal and return the output",
  schema: z.object({
    command: z.string().describe("The command to execute in the terminal"),
    workingDirectory: z.string().optional().describe("The working directory to execute the command in (optional)")
  }),
  func: async (input: { command: string; workingDirectory?: string }) => {
    const { command, workingDirectory } = input;
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      
      const options: any = {};
      if (workingDirectory) {
        options.cwd = workingDirectory;
      }
      
      const { stdout, stderr } = await execAsync(command, options);
      
      if (stderr) {
        return `Command executed with errors:\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`;
      }
      
      return `Command executed successfully:\n${stdout}`;
    } catch (error: any) {
      return `Error executing command: ${error.message}`;
    }
  }
});

// Export all tools as an array for easy use
export const vscodeTools = [
  createFileOrFolderTool,
  listFilesTool,
  readFileTool,
  editFileTool,
  moveFileOrFolderTool,
  searchInFilesTool,
  executeInTerminalTool
];
