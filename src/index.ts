#!/usr/bin/env node
/**
 * iOS Simulator MCP App Server
 * Provides live simulator preview panel with controls
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { exec } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { startServer, PORT } from "./http-server.js";

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Server instance
const server = new Server(
  {
    name: "ios-simulator-panel",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// Utility: Execute simctl command
async function simctl(args: string[]): Promise<string> {
  const { stdout } = await execAsync(`xcrun simctl ${args.join(" ")}`);
  return stdout.trim();
}

// List available simulators
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
          runtime: runtime.replace("com.apple.CoreSimulator.SimRuntime.", ""),
        });
      }
    }
  }

  return simulators;
}

// Get booted simulator
async function getBootedSimulator() {
  const sims = await listSimulators();
  return sims.find(s => s.state === "Booted");
}

// Take screenshot and return base64
async function takeScreenshot(udid: string): Promise<string> {
  const tmpFile = `/tmp/sim-screenshot-${Date.now()}.png`;
  await simctl(["io", udid, "screenshot", tmpFile]);

  const buffer = await readFile(tmpFile);
  return buffer.toString("base64");
}

// Get device info
async function getDeviceInfo(udid: string) {
  const output = await simctl(["list", "devices", "-j"]);
  const data = JSON.parse(output);

  for (const [runtime, devices] of Object.entries(data.devices)) {
    for (const device of devices as any[]) {
      if (device.udid === udid) {
        return {
          udid: device.udid,
          name: device.name,
          state: device.state,
          runtime: runtime.replace("com.apple.CoreSimulator.SimRuntime.", ""),
          isAvailable: device.isAvailable,
          deviceTypeIdentifier: device.deviceTypeIdentifier,
        };
      }
    }
  }
  return null;
}

// Register tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "simulator_open_panel",
      description: "Open iOS Simulator live preview panel with controls",
      inputSchema: {
        type: "object",
        properties: {
          udid: {
            type: "string",
            description: 'Simulator UDID or "booted" for currently running simulator',
          },
        },
      },
      _meta: {
        "ui/resourceUri": "ui://simulator-panel/index.html",
      },
    },
    {
      name: "simulator_list",
      description: "List all available iOS simulators",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "simulator_boot",
      description: "Boot an iOS simulator",
      inputSchema: {
        type: "object",
        properties: {
          udid: {
            type: "string",
            description: "Simulator UDID",
          },
        },
        required: ["udid"],
      },
    },
    {
      name: "simulator_shutdown",
      description: "Shutdown a running simulator",
      inputSchema: {
        type: "object",
        properties: {
          udid: {
            type: "string",
            description: 'Simulator UDID or "booted"',
          },
        },
        required: ["udid"],
      },
    },
    {
      name: "simulator_screenshot",
      description: "Take screenshot of simulator",
      inputSchema: {
        type: "object",
        properties: {
          udid: {
            type: "string",
            description: 'Simulator UDID or "booted"',
          },
        },
      },
    },
    {
      name: "simulator_home",
      description: "Press home button",
      inputSchema: {
        type: "object",
        properties: {
          udid: {
            type: "string",
            description: 'Simulator UDID or "booted"',
          },
        },
      },
    },
    {
      name: "simulator_rotate",
      description: "Rotate simulator orientation",
      inputSchema: {
        type: "object",
        properties: {
          udid: {
            type: "string",
            description: 'Simulator UDID or "booted"',
          },
          direction: {
            type: "string",
            enum: ["left", "right"],
            description: "Rotation direction",
          },
        },
        required: ["direction"],
      },
    },
    {
      name: "simulator_install_app",
      description: "Install an app (.app bundle) to simulator",
      inputSchema: {
        type: "object",
        properties: {
          udid: {
            type: "string",
            description: 'Simulator UDID or "booted"',
          },
          appPath: {
            type: "string",
            description: "Path to .app bundle",
          },
        },
        required: ["appPath"],
      },
    },
    {
      name: "simulator_launch_app",
      description: "Launch an installed app by bundle ID",
      inputSchema: {
        type: "object",
        properties: {
          udid: {
            type: "string",
            description: 'Simulator UDID or "booted"',
          },
          bundleId: {
            type: "string",
            description: "App bundle identifier (e.g. com.apple.Maps)",
          },
        },
        required: ["bundleId"],
      },
    },
    {
      name: "simulator_uninstall_app",
      description: "Uninstall an app from simulator",
      inputSchema: {
        type: "object",
        properties: {
          udid: {
            type: "string",
            description: 'Simulator UDID or "booted"',
          },
          bundleId: {
            type: "string",
            description: "App bundle identifier",
          },
        },
        required: ["bundleId"],
      },
    },
    {
      name: "simulator_open_url",
      description: "Open a URL or deep link in simulator",
      inputSchema: {
        type: "object",
        properties: {
          udid: {
            type: "string",
            description: 'Simulator UDID or "booted"',
          },
          url: {
            type: "string",
            description: "URL to open (http://, https://, or custom scheme)",
          },
        },
        required: ["url"],
      },
    },
    {
      name: "simulator_start_recording",
      description: "Start screen recording video",
      inputSchema: {
        type: "object",
        properties: {
          udid: {
            type: "string",
            description: 'Simulator UDID or "booted"',
          },
          outputPath: {
            type: "string",
            description: "Path to save video file (.mov)",
          },
        },
        required: ["outputPath"],
      },
    },
    {
      name: "simulator_stop_recording",
      description: "Stop current screen recording",
      inputSchema: {
        type: "object",
        properties: {
          udid: {
            type: "string",
            description: 'Simulator UDID or "booted"',
          },
        },
      },
    },
    {
      name: "simulator_push_notification",
      description: "Send a push notification to simulator",
      inputSchema: {
        type: "object",
        properties: {
          udid: {
            type: "string",
            description: 'Simulator UDID or "booted"',
          },
          bundleId: {
            type: "string",
            description: "Target app bundle ID",
          },
          payload: {
            type: "object",
            description: "APNs payload (aps dictionary)",
          },
        },
        required: ["bundleId", "payload"],
      },
    },
    {
      name: "simulator_set_location",
      description: "Set simulator GPS location",
      inputSchema: {
        type: "object",
        properties: {
          udid: {
            type: "string",
            description: 'Simulator UDID or "booted"',
          },
          latitude: {
            type: "number",
            description: "Latitude (-90 to 90)",
          },
          longitude: {
            type: "number",
            description: "Longitude (-180 to 180)",
          },
        },
        required: ["latitude", "longitude"],
      },
    },
    {
      name: "simulator_get_status",
      description: "Get simulator current status",
      inputSchema: {
        type: "object",
        properties: {
          udid: {
            type: "string",
            description: 'Simulator UDID or "booted"',
          },
        },
      },
    },
    {
      name: "simulator_get_device_info",
      description: "Get detailed device information",
      inputSchema: {
        type: "object",
        properties: {
          udid: {
            type: "string",
            description: 'Simulator UDID or "booted"',
          },
        },
      },
    },
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "simulator_open_panel": {
        let udid = args?.udid as string || "booted";

        if (udid === "booted") {
          const booted = await getBootedSimulator();
          if (!booted) {
            return {
              content: [{
                type: "text",
                text: "No simulator is currently booted. Please boot a simulator first.",
              }],
            };
          }
          udid = booted.udid;
        }

        // Start HTTP server
        await startServer();

        const screenshot = await takeScreenshot(udid);
        const url = `http://localhost:${PORT}/browser.html`;

        return {
          content: [{
            type: "text",
            text: `Opening iOS Simulator Panel in browser at ${url}`,
          }],
          _meta: {
            screenshot,
            udid,
            openUrl: url,
          },
        };
      }

      case "simulator_list": {
        const sims = await listSimulators();
        return {
          content: [{
            type: "text",
            text: JSON.stringify(sims, null, 2),
          }],
        };
      }

      case "simulator_boot": {
        const udid = args?.udid as string;
        await simctl(["boot", udid]);
        return {
          content: [{
            type: "text",
            text: `Simulator ${udid} booted successfully`,
          }],
        };
      }

      case "simulator_shutdown": {
        let udid = args?.udid as string || "booted";
        await simctl(["shutdown", udid]);
        return {
          content: [{
            type: "text",
            text: `Simulator shut down successfully`,
          }],
        };
      }

      case "simulator_screenshot": {
        let udid = args?.udid as string || "booted";

        if (udid === "booted") {
          const booted = await getBootedSimulator();
          if (!booted) throw new Error("No booted simulator");
          udid = booted.udid;
        }

        const screenshot = await takeScreenshot(udid);
        return {
          content: [{
            type: "text",
            text: `Screenshot captured (${screenshot.length} bytes base64)`,
          }],
          _meta: { screenshot },
        };
      }

      case "simulator_home": {
        let udid = args?.udid as string || "booted";

        try {
          // Try keyboard shortcut Cmd+Shift+H (requires accessibility permissions)
          await execAsync(`osascript -e 'tell application "System Events" to keystroke "h" using {command down, shift down}'`);
          return {
            content: [{
              type: "text",
              text: "Home button pressed",
            }],
          };
        } catch (error: any) {
          // If accessibility permissions are not granted, provide instructions
          if (error.message.includes("not allowed to send keystrokes")) {
            return {
              content: [{
                type: "text",
                text: `⚠️ Accessibility permissions required to press Home button.

To enable:
1. Open System Settings → Privacy & Security → Accessibility
2. Find and enable "Claude" or "Terminal" (depending on how you're running this)

Alternative: You can manually press Cmd+Shift+H while the Simulator window is focused.`,
              }],
            };
          }
          throw error;
        }
      }

      case "simulator_rotate": {
        let udid = args?.udid as string || "booted";
        const direction = args?.direction as string;

        try {
          // Use keyboard shortcut Cmd+Left/Right to rotate
          const key = direction === "left" ? "123" : "124"; // 123 = left arrow, 124 = right arrow
          await execAsync(`osascript -e 'tell application "System Events" to key code ${key} using {command down}'`);
          return {
            content: [{
              type: "text",
              text: `Rotated ${direction}`,
            }],
          };
        } catch (error: any) {
          // If accessibility permissions are not granted, provide instructions
          if (error.message.includes("not allowed to send keystrokes")) {
            return {
              content: [{
                type: "text",
                text: `⚠️ Accessibility permissions required to rotate simulator.

To enable:
1. Open System Settings → Privacy & Security → Accessibility
2. Find and enable "Claude" or "Terminal" (depending on how you're running this)

Alternative: You can manually press Cmd+${direction === "left" ? "Left" : "Right"} Arrow while the Simulator window is focused.`,
              }],
            };
          }
          throw error;
        }
      }

      case "simulator_install_app": {
        let udid = args?.udid as string || "booted";
        const appPath = args?.appPath as string;

        if (udid === "booted") {
          const booted = await getBootedSimulator();
          if (!booted) throw new Error("No booted simulator");
          udid = booted.udid;
        }

        await simctl(["install", udid, appPath]);
        return {
          content: [{
            type: "text",
            text: `App installed successfully: ${appPath}`,
          }],
        };
      }

      case "simulator_launch_app": {
        let udid = args?.udid as string || "booted";
        const bundleId = args?.bundleId as string;

        if (udid === "booted") {
          const booted = await getBootedSimulator();
          if (!booted) throw new Error("No booted simulator");
          udid = booted.udid;
        }

        await simctl(["launch", udid, bundleId]);
        return {
          content: [{
            type: "text",
            text: `App launched: ${bundleId}`,
          }],
        };
      }

      case "simulator_uninstall_app": {
        let udid = args?.udid as string || "booted";
        const bundleId = args?.bundleId as string;

        if (udid === "booted") {
          const booted = await getBootedSimulator();
          if (!booted) throw new Error("No booted simulator");
          udid = booted.udid;
        }

        await simctl(["uninstall", udid, bundleId]);
        return {
          content: [{
            type: "text",
            text: `App uninstalled: ${bundleId}`,
          }],
        };
      }

      case "simulator_open_url": {
        let udid = args?.udid as string || "booted";
        const url = args?.url as string;

        if (udid === "booted") {
          const booted = await getBootedSimulator();
          if (!booted) throw new Error("No booted simulator");
          udid = booted.udid;
        }

        await simctl(["openurl", udid, url]);
        return {
          content: [{
            type: "text",
            text: `Opened URL: ${url}`,
          }],
        };
      }

      case "simulator_start_recording": {
        let udid = args?.udid as string || "booted";
        const outputPath = args?.outputPath as string;

        if (udid === "booted") {
          const booted = await getBootedSimulator();
          if (!booted) throw new Error("No booted simulator");
          udid = booted.udid;
        }

        // Start recording in background
        execAsync(`xcrun simctl io ${udid} recordVideo "${outputPath}" &`);
        return {
          content: [{
            type: "text",
            text: `Recording started. Output will be saved to: ${outputPath}\nUse simulator_stop_recording to stop.`,
          }],
        };
      }

      case "simulator_stop_recording": {
        // Stop recording by sending SIGINT to the recordVideo process
        try {
          await execAsync(`pkill -INT -f "simctl io.*recordVideo"`);
          return {
            content: [{
              type: "text",
              text: "Recording stopped successfully",
            }],
          };
        } catch (error: any) {
          return {
            content: [{
              type: "text",
              text: "No active recording found or recording already stopped",
            }],
          };
        }
      }

      case "simulator_push_notification": {
        let udid = args?.udid as string || "booted";
        const bundleId = args?.bundleId as string;
        const payload = args?.payload as any;

        if (udid === "booted") {
          const booted = await getBootedSimulator();
          if (!booted) throw new Error("No booted simulator");
          udid = booted.udid;
        }

        // Write payload to temp file
        const tmpFile = `/tmp/push-${Date.now()}.json`;
        const { writeFile } = await import("fs/promises");
        await writeFile(tmpFile, JSON.stringify(payload));

        await simctl(["push", udid, bundleId, tmpFile]);
        return {
          content: [{
            type: "text",
            text: `Push notification sent to ${bundleId}`,
          }],
        };
      }

      case "simulator_set_location": {
        let udid = args?.udid as string || "booted";
        const latitude = args?.latitude as number;
        const longitude = args?.longitude as number;

        if (udid === "booted") {
          const booted = await getBootedSimulator();
          if (!booted) throw new Error("No booted simulator");
          udid = booted.udid;
        }

        await simctl(["location", udid, "set", latitude.toString(), longitude.toString()]);
        return {
          content: [{
            type: "text",
            text: `Location set to: ${latitude}, ${longitude}`,
          }],
        };
      }

      case "simulator_get_status": {
        let udid = args?.udid as string || "booted";

        if (udid === "booted") {
          const booted = await getBootedSimulator();
          if (!booted) {
            return {
              content: [{
                type: "text",
                text: "No simulator is currently booted",
              }],
            };
          }
          udid = booted.udid;
        }

        const info = await getDeviceInfo(udid);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              udid,
              state: info?.state || "Unknown",
              isAvailable: info?.isAvailable || false,
            }, null, 2),
          }],
        };
      }

      case "simulator_get_device_info": {
        let udid = args?.udid as string || "booted";

        if (udid === "booted") {
          const booted = await getBootedSimulator();
          if (!booted) throw new Error("No booted simulator");
          udid = booted.udid;
        }

        const info = await getDeviceInfo(udid);
        if (!info) throw new Error("Device not found");

        return {
          content: [{
            type: "text",
            text: JSON.stringify(info, null, 2),
          }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return {
      content: [{
        type: "text",
        text: `Error: ${error.message}`,
      }],
      isError: true,
    };
  }
});

// Register UI resources
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: "ui://simulator-panel/index.html",
      mimeType: "text/html",
      name: "iOS Simulator Panel",
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;

  if (uri === "ui://simulator-panel/index.html") {
    const htmlPath = join(__dirname, "ui", "index.html");
    const html = await readFile(htmlPath, "utf-8");

    return {
      contents: [{
        uri,
        mimeType: "text/html",
        text: html,
      }],
    };
  }

  throw new Error(`Unknown resource: ${uri}`);
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("iOS Simulator Panel MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
