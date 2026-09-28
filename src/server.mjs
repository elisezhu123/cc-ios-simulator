import express from 'express';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3456;

let currentUdid = null;
let recordingProcess = null;

// Serve static files
app.use(express.static(join(__dirname, 'ui')));

// Check if simctl is working
let simctlWorking = true;
function checkSimctl() {
  try {
    execSync('xcrun simctl help', { encoding: 'utf8', stdio: 'pipe' });
    return true;
  } catch (error) {
    return false;
  }
}

// Get booted simulator
function getBootedSimulator() {
  if (!simctlWorking) return null;

  try {
    const result = execSync('xcrun simctl list devices booted --json', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const data = JSON.parse(result);

    for (const runtime in data.devices) {
      const devices = data.devices[runtime];
      const booted = devices.find(d => d.state === 'Booted');
      if (booted) {
        return booted.udid;
      }
    }
  } catch (error) {
    console.error('Error getting booted simulator:', error.message);
    simctlWorking = false;
  }
  return null;
}

// Generate a placeholder SVG image
function generatePlaceholderSVG() {
  return `<svg width="390" height="844" xmlns="http://www.w3.org/2000/svg">
    <rect width="390" height="844" fill="#1d1d1f"/>
    <text x="195" y="400" font-family="-apple-system, sans-serif" font-size="16" fill="#86868b" text-anchor="middle">Simulator Stream</text>
    <text x="195" y="430" font-family="-apple-system, sans-serif" font-size="12" fill="#86868b" text-anchor="middle">simctl not available</text>
    <text x="195" y="450" font-family="-apple-system, sans-serif" font-size="11" fill="#666" text-anchor="middle">IOSurface kernel service limit reached</text>
  </svg>`;
}

// Get simulator screenshot
app.get('/api/screen', (req, res) => {
  try {
    if (!simctlWorking) {
      // Return a placeholder SVG image
      res.type('svg').send(generatePlaceholderSVG());
      return;
    }

    const udid = currentUdid || getBootedSimulator();
    if (!udid) {
      res.type('svg').send(generatePlaceholderSVG());
      return;
    }

    const tmpFile = `/tmp/sim-screenshot-${Date.now()}.png`;
    execSync(`xcrun simctl io ${udid} screenshot ${tmpFile}`);

    const image = fs.readFileSync(tmpFile);
    fs.unlinkSync(tmpFile);

    res.type('png').send(image);
  } catch (error) {
    console.error('Screenshot error:', error);
    res.type('svg').send(generatePlaceholderSVG());
  }
});

// Take screenshot and save
app.get('/api/screenshot', (req, res) => {
  try {
    const udid = currentUdid || getBootedSimulator();
    if (!udid) {
      return res.status(404).json({ error: 'No simulator booted' });
    }

    const filename = `screenshot-${Date.now()}.png`;
    const filepath = join(process.env.HOME, 'Desktop', filename);
    execSync(`xcrun simctl io ${udid} screenshot "${filepath}"`);

    res.json({ success: true, path: filepath });
  } catch (error) {
    console.error('Screenshot error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Press home button
app.post('/api/home', (req, res) => {
  try {
    const udid = currentUdid || getBootedSimulator();
    if (!udid) {
      return res.status(404).json({ error: 'No simulator booted' });
    }

    execSync(`xcrun simctl io ${udid} sendKeyEvent home`);
    res.json({ success: true });
  } catch (error) {
    console.error('Home button error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start recording
app.post('/api/record/start', (req, res) => {
  try {
    const udid = currentUdid || getBootedSimulator();
    if (!udid) {
      return res.status(404).json({ error: 'No simulator booted' });
    }

    const filename = `recording-${Date.now()}.mp4`;
    const filepath = join(process.env.HOME, 'Desktop', filename);

    recordingProcess = spawn('xcrun', ['simctl', 'io', udid, 'recordVideo', filepath]);

    res.json({ success: true, path: filepath });
  } catch (error) {
    console.error('Recording start error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Stop recording
app.post('/api/record/stop', (req, res) => {
  try {
    if (recordingProcess) {
      recordingProcess.kill('SIGINT');
      recordingProcess = null;
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Recording stop error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Shutdown simulator
app.post('/api/shutdown', (req, res) => {
  try {
    const udid = currentUdid || getBootedSimulator();
    if (!udid) {
      return res.status(404).json({ error: 'No simulator booted' });
    }

    execSync(`xcrun simctl shutdown ${udid}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Shutdown error:', error);
    res.status(500).json({ error: error.message });
  }
});

// List simulators
app.get('/api/simulators', (req, res) => {
  if (!simctlWorking) {
    // Return mock data when simctl is not working
    return res.json({
      simulators: [
        {
          name: 'iPhone 18 Pro',
          udid: 'mock-udid-1',
          state: 'Booted',
          runtime: 'iOS 27.0'
        },
        {
          name: 'iPhone 18 Pro Max',
          udid: 'mock-udid-2',
          state: 'Shutdown',
          runtime: 'iOS 27.0'
        }
      ],
      mock: true,
      message: 'simctl not available - showing mock data'
    });
  }

  try {
    const result = execSync('xcrun simctl list devices available --json', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const data = JSON.parse(result);

    const simulators = [];
    for (const runtime in data.devices) {
      const devices = data.devices[runtime];
      devices.forEach(device => {
        if (device.isAvailable) {
          simulators.push({
            name: device.name,
            udid: device.udid,
            state: device.state,
            runtime: runtime.replace('com.apple.CoreSimulator.SimRuntime.', '').replace(/-/g, ' ')
          });
        }
      });
    }

    res.json({ simulators });
  } catch (error) {
    console.error('List simulators error:', error.message);
    simctlWorking = false;

    // Return mock data on error
    res.json({
      simulators: [
        {
          name: 'iPhone 18 Pro',
          udid: 'mock-udid-1',
          state: 'Booted',
          runtime: 'iOS 27.0'
        },
        {
          name: 'iPhone 18 Pro Max',
          udid: 'mock-udid-2',
          state: 'Shutdown',
          runtime: 'iOS 27.0'
        }
      ],
      mock: true,
      message: 'simctl not available - showing mock data'
    });
  }
});

// Boot simulator
app.post('/api/boot/:udid', (req, res) => {
  try {
    const { udid } = req.params;
    execSync(`xcrun simctl boot ${udid}`);
    currentUdid = udid;
    res.json({ success: true });
  } catch (error) {
    console.error('Boot error:', error);
    res.status(500).json({ error: error.message });
  }
});

const server = app.listen(PORT, () => {
  console.log(`iOS Simulator Panel server running at http://localhost:${PORT}`);

  // Check if simctl is working
  simctlWorking = checkSimctl();

  if (!simctlWorking) {
    console.warn('⚠️  simctl is not working (IOSurface kernel service limit reached)');
    console.warn('⚠️  Running in mock mode - UI will be displayed but simulator control is disabled');
  } else {
    currentUdid = getBootedSimulator();
    if (currentUdid) {
      console.log(`Connected to booted simulator: ${currentUdid}`);
    }
  }
});

// Keep the process running
process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  if (recordingProcess) {
    recordingProcess.kill('SIGINT');
  }
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
