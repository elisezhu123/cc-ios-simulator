// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/client/copy.ts (strings)
/**
 * Panel copy in English and Chinese (strings from dsh-ios src/client/copy.ts
 * where they exist), picked from navigator.language.
 * @module ios-simulator/panel/client/copy
 */

export type DeviceActionId = 'app-switcher' | 'lock' | 'unlock' | 'shake' | 'siri' | 'action-button' | 're-center'

export interface PanelCopy {
  language: 'en' | 'zh'
  title: string
  connecting: string
  live: string
  offline: string
  noDevice: string
  home: string
  homeHint: string
  screenshot: string
  rotate: string
  refresh: string
  deviceActions: string
  actions: Record<DeviceActionId, string>
  size: string
  frame: string
  frameStyles: Record<'none' | 'bezel' | 'device', string>
  picker: string
  booted: string
  switching: string
  captureFailed: string
  actionFailed: string
}

const EN: PanelCopy = {
  language: 'en',
  title: 'iOS Simulator',
  connecting: 'connecting…',
  live: 'live',
  offline: 'offline',
  noDevice: 'No live simulator — boot one with ios_sim_boot, or pick a device above.',
  home: 'Home',
  homeHint: 'Home · double-click for the app switcher',
  screenshot: 'Screenshot',
  rotate: 'Rotate',
  refresh: 'Refresh',
  deviceActions: 'Device actions…',
  actions: {
    'app-switcher': 'App Switcher',
    lock: 'Lock',
    unlock: 'Unlock',
    shake: 'Shake',
    siri: 'Siri',
    'action-button': 'Action Button',
    're-center': 'Re-center window',
  },
  size: 'Simulator display size',
  frame: 'Simulator frame style',
  frameStyles: { none: 'Frameless', bezel: 'Bezel', device: 'Device' },
  picker: 'Simulator device',
  booted: 'booted',
  switching: 'switching…',
  captureFailed: 'Screenshot failed',
  actionFailed: 'Action failed',
}

const ZH: PanelCopy = {
  language: 'zh',
  title: 'iOS 模拟器',
  connecting: '连接中…',
  live: '实时',
  offline: '离线',
  noDevice: '没有实时画面——用 ios_sim_boot 启动一台模拟器，或在上方选择设备。',
  home: '回到桌面',
  homeHint: '回到桌面 · 双击打开后台 App',
  screenshot: '截图',
  rotate: '旋转',
  refresh: '刷新',
  deviceActions: '设备操作…',
  actions: {
    'app-switcher': '后台 App',
    lock: '锁屏',
    unlock: '解锁',
    shake: '摇一摇',
    siri: 'Siri',
    'action-button': 'Action 按钮',
    're-center': '窗口重新居中',
  },
  size: '模拟器显示大小',
  frame: '模拟器边框样式',
  frameStyles: { none: '无框', bezel: '边框', device: '真机框' },
  picker: '模拟器设备',
  booted: '已启动',
  switching: '切换中…',
  captureFailed: '截图失败',
  actionFailed: '操作失败',
}

export function copyFor(language: string | undefined): PanelCopy {
  return (language ?? '').toLowerCase().startsWith('zh') ? ZH : EN
}
