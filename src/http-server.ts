/**
 * HTTP Server for iOS Simulator Panel UI
 * Serves the UI and provides WebSocket + REST API for real-time simulator control
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

const PORT = 3456;

app.use(express.json());
app.use(express.static(join(__dirname, 'ui')));

// Utility: Execute simctl command
async function simctl(args: string[]): Promise<string> {
  const { stdout } = await execAsync(`xcrun simctl ${args.join(" ")}`);
  return stdout.trim();
}

// List all available simulators
async function listSimulators() {
  const output = await simctl(["list", "devices", "available", "-j"]);
  const data = JSON.parse(output);

  const simulators: any[] = [];
  for (const [runtime, devices] of Object.entries(data.devices)) {
    for (const device of devices as any[]) {
      if (device.isAvailable) {
        simulators.push({
          udid: device.udid,
          name: device.name,
          state: device.state,
          runtime: runtime.replace("com.apple.CoreSimulator.SimRuntime.", "").replace(/-/g, " "),
        });
      }
    }
  }

  return simulators;
}

// Get booted simulator
async function getBootedSimulator() {
  const sims = await listSimulators();
  return sims.find(s => s.state === "Booted") || null;
}

// Take screenshot and return base64
async function takeScreenshot(udid: string): Promise<string> {
  const tmpFile = `/tmp/sim-screenshot-${Date.now()}.png`;
  await simctl(["io", udid, "screenshot", tmpFile]);
  const buffer = await readFile(tmpFile);
  await unlink(tmpFile);
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

// Video recording state
let recordingProcess: any = null;
let recordingFile: string | null = null;

// WebSocket connections
const clients = new Set<WebSocket>();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.error('WebSocket client connected');

  ws.on('close', () => {
    clients.delete(ws);
    console.error('WebSocket client disconnected');
  });

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());
      await handleWebSocketMessage(ws, data);
    } catch (error: any) {
      ws.send(JSON.stringify({ error: error.message }));
    }
  });
});

// Broadcast to all connected clients
function broadcast(data: any) {
  const message = JSON.stringify(data);
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Handle WebSocket messages
async function handleWebSocketMessage(ws: WebSocket, data: any) {
  const { action, payload } = data;

  switch (action) {
    case 'get_simulators': {
      const simulators = await listSimulators();
      ws.send(JSON.stringify({ type: 'simulators_list', simulators }));
      break;
    }

    case 'get_current': {
      const sim = await getBootedSimulator();
      ws.send(JSON.stringify({ type: 'current_simulator', simulator: sim }));
      break;
    }

    case 'switch_device': {
      const { udid } = payload;

      // Shutdown current booted simulator
      try {
        await simctl(["shutdown", "booted"]);
      } catch (e) {
        // Ignore if no simulator is booted
      }

      // Boot new simulator
      await simctl(["boot", udid]);

      // Wait a bit for boot
      await new Promise(resolve => setTimeout(resolve, 2000));

      const sim = await getBootedSimulator();
      broadcast({ type: 'device_switched', simulator: sim });
      break;
    }

    case 'take_screenshot': {
      const sim = await getBootedSimulator();
      if (!sim) throw new Error("No booted simulator");

      const screenshot = await takeScreenshot(sim.udid);
      ws.send(JSON.stringify({ type: 'screenshot_taken', screenshot }));
      break;
    }

    case 'press_home': {
      await execAsync(`osascript -e 'tell application "System Events" to keystroke "h" using {command down, shift down}'`);
      broadcast({ type: 'home_pressed' });
      break;
    }

    case 'show_keyboard': {
      await execAsync(`osascript -e 'tell application "System Events" to keystroke "k" using {command down}'`);
      broadcast({ type: 'keyboard_toggled' });
      break;
    }

    case 'start_recording': {
      const sim = await getBootedSimulator();
      if (!sim) throw new Error("No booted simulator");

      recordingFile = `/tmp/sim-recording-${Date.now()}.mov`;

      // Start recording using simctl
      recordingProcess = exec(`xcrun simctl io ${sim.udid} recordVideo ${recordingFile}`);

      broadcast({ type: 'recording_started' });
      break;
    }

    case 'stop_recording': {
      if (recordingProcess && recordingFile) {
        // Send SIGINT to stop recording gracefully
        recordingProcess.kill('SIGINT');

        // Wait for the file to be written
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Read the video file
        if (existsSync(recordingFile)) {
          const buffer = await readFile(recordingFile);
          const videoData = `data:video/quicktime;base64,${buffer.toString("base64")}`;

          ws.send(JSON.stringify({
            type: 'recording_stopped',
            video: videoData,
            filename: `simulator-recording-${Date.now()}.mov`
          }));

          // Clean up
          await unlink(recordingFile);
        }

        recordingProcess = null;
        recordingFile = null;
      }
      break;
    }

    case 'rotate_left': {
      await execAsync(`osascript -e 'tell application "System Events" to key code 123 using {command down}'`);
      broadcast({ type: 'rotated', direction: 'left' });
      break;
    }

    case 'rotate_right': {
      await execAsync(`osascript -e 'tell application "System Events" to key code 124 using {command down}'`);
      broadcast({ type: 'rotated', direction: 'right' });
      break;
    }

    case 'shutdown': {
      await simctl(["shutdown", "booted"]);
      broadcast({ type: 'simulator_shutdown' });
      break;
    }

    case 'get_stream_frame': {
      // Get a fresh screenshot for live streaming
      const sim = await getBootedSimulator();
      if (sim) {
        const screenshot = await takeScreenshot(sim.udid);
        ws.send(JSON.stringify({ type: 'stream_frame', screenshot }));
      }
      break;
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

// REST API endpoints (for backward compatibility)
app.get('/api/simulators', async (req, res) => {
  try {
    const simulators = await listSimulators();
    res.json(simulators);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/simulator', async (req, res) => {
  try {
    const sim = await getBootedSimulator();
    if (!sim) {
      return res.status(404).json({ error: "No booted simulator" });
    }
    res.json(sim);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/screenshot', async (req, res) => {
  try {
    const sim = await getBootedSimulator();
    if (!sim) {
      return res.status(404).json({ error: "No booted simulator" });
    }
    const screenshot = await takeScreenshot(sim.udid);
    res.json({ screenshot });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
let serverInstance: any = null;

export function startServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    if (serverInstance) {
      resolve(PORT);
      return;
    }

    serverInstance = httpServer.listen(PORT, () => {
      console.error(`iOS Simulator Panel running on http://localhost:${PORT}`);
      console.error(`WebSocket server ready for connections`);
      resolve(PORT);
    }).on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} already in use`);
        resolve(PORT);
      } else {
        reject(err);
      }
    });
  });
}

export function stopServer() {
  if (serverInstance) {
    serverInstance.close();
    serverInstance = null;
  }
}

export { PORT };
