/**
 * Shared tool-result helpers: JSON text plus an optional image block, one
 * error prefix per tool, and the device summary every result carries.
 * @module ios-simulator/tools/result
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { ModelImage } from '../screenshot.js'
import type { SimulatorDevice } from '../simctl.js'

export const UDID_PARAM = z.string().optional()
  .describe('Simulator udid or device name (tools that support it also take a connected iPhone/iPad from '
    + 'ios_sim_devices.realDevices). Default: the streamed device, else the newest-runtime booted iPhone.')

export interface DeviceSummary {
  udid: string
  name: string
  runtime: string
  state: string
}

export function deviceSummary(device: SimulatorDevice, state: string = device.state): DeviceSummary {
  return { udid: device.udid, name: device.name, runtime: device.runtime, state }
}

export function jsonResult(value: unknown, image?: ModelImage): CallToolResult {
  const content: CallToolResult['content'] = [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  if (image !== undefined) content.push({ type: 'image', data: image.data, mimeType: image.mimeType })
  return { content }
}

export function errorResult(tool: string, error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error)
  return {
    content: [{ type: 'text', text: message.startsWith(`${tool}:`) ? message : `${tool}: ${message}` }],
    isError: true,
  }
}

export async function runTool(tool: string, body: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await body()
  } catch (error) {
    return errorResult(tool, error)
  }
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
