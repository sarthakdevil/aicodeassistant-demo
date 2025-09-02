import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { runGeminiAgentsAPI } from './gemini-agents-api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

interface EventStream {
  write: (data: any) => void;
  end: () => void;
}

interface FileItem {
  name: string;
  type: 'file' | 'folder';
  size?: string;
  children?: FileItem[];
}

// API endpoint for processing messages
app.post('/api/process', async (req, res) => {
    try {
        const { message, planEdit } = req.body;
        const apiKey = req.headers['x-gemini-api-key'] as string;
        
        // Validate API key
        if (!apiKey) {
            res.status(400).json({ error: 'Gemini API key is required. Please configure your API key in the frontend.' });
            return;
        }
        
        // Set up Server-Sent Events
        res.writeHead(200, {
            'Content-Type': 'text/plain',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });

        // Create event stream
        const eventStream: EventStream = {
            write: (data: any) => {
                res.write(`data: ${JSON.stringify(data)}\n\n`);
            },
            end: () => {
                res.end();
            }
        };

        // Process the message with the Gemini agents
        await runGeminiAgentsAPI(message, eventStream, apiKey, planEdit);
        
    } catch (error: unknown) {
        console.error('API Error:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        res.status(500).json({ error: errorMessage });
    }
});

// API endpoint for file tree
app.get('/api/files', async (req, res) => {
    try {
        const files = getFilteredFileTree('.');
        res.json(files);
    } catch (error: unknown) {
        console.error('File tree error:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        res.status(500).json({ error: errorMessage });
    }
});

function getFilteredFileTree(dirPath: string = '.'): FileItem[] {
    const files: FileItem[] = [];
    
    // Directories and files to exclude
    const excludePatterns = [
        'node_modules',
        '.git',
        'build'
    ];
    
    try {
        const absolutePath = path.isAbsolute(dirPath) 
            ? dirPath 
            : path.join(process.cwd(), dirPath);

        if (!fs.existsSync(absolutePath)) {
            return files;
        }

        const entries = fs.readdirSync(absolutePath, { withFileTypes: true });
        
        for (const entry of entries) {
            // Skip hidden files
            if (entry.name.startsWith('.') && !['README.md', 'LICENSE'].includes(entry.name)) {
                continue;
            }
            
            // Skip excluded patterns
            const shouldExclude = excludePatterns.some(pattern => 
                entry.name.toLowerCase().includes(pattern.toLowerCase())
            );
            
            if (shouldExclude) {
                continue;
            }
            
            const fullPath = path.join(absolutePath, entry.name);
            
            if (entry.isDirectory()) {
                const children = getFilteredFileTree(fullPath);
                files.push({
                    name: entry.name,
                    type: 'folder',
                    children: children
                });
            } else {
                const stats = fs.statSync(fullPath);
                const size = `${(stats.size / 1024).toFixed(1)}KB`;
                files.push({
                    name: entry.name,
                    type: 'file',
                    size: size
                });
            }
        }
    } catch (error) {
        console.error('Error reading directory:', error);
    }
    
    return files;
}

// Start server
app.listen(port, () => {
    console.log(`🚀 Gemini Agents UI Server running at http://localhost:${port}`);
    console.log(`📁 Serving files from: ${path.join(__dirname, '../public')}`);
});

export { app };
