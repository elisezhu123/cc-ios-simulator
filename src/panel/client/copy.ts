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
  /** The picker's placeholder while nothing streams. */
  pickDevice: string
  booted: string
  switching: string
  captureFailed: string
  actionFailed: string
  /** The picker group of connected iPhones/iPads (WebDriverAgent running). */
  realDevices: string
  /** Suffix of a real device in the picker. */
  realDevice: string
  /** Placeholder when the shown iPhone has no running WebDriverAgent. */
  noWda: string
  annotate: string
  annotateTools: Record<'pen' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'text', string>
  /** Names of ANNOTATE_COLORS, in order. */
  annotateColors: string[]
  undo: string
  redo: string
  clear: string
  close: string
  addToChat: string
  annotationAdded: string
  annotationAddedCopied: string
  annotationFailed: string
}

/** The device actions WebDriverAgent can run on a real device. */
export const REAL_DEVICE_ACTION_IDS: readonly DeviceActionId[] = ['lock', 'unlock', 'siri']

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
  pickDevice: 'Pick a simulator…',
  booted: 'booted',
  switching: 'switching…',
  captureFailed: 'Screenshot failed',
  actionFailed: 'Action failed',
  realDevices: 'iPhone / iPad (WebDriverAgent)',
  realDevice: 'real device',
  noWda: 'WebDriverAgent is not running on this iPhone — start it with ios_real_start_wda, or pick a simulator above.',
  annotate: 'Annotate a screenshot',
  annotateTools: { pen: 'Pen', line: 'Line', arrow: 'Arrow', rect: 'Box', ellipse: 'Ellipse', text: 'Text' },
  annotateColors: ['Red', 'Blue', 'Green', 'Black', 'White'],
  undo: 'Undo',
  redo: 'Redo',
  clear: 'Clear',
  close: 'Close',
  addToChat: 'Add to chat',
  annotationAdded: 'Added — ask Claude to look at it (ios_sim_annotation)',
  annotationAddedCopied: 'Added and copied — paste it into the chat, or ask Claude to look at it (ios_sim_annotation)',
  annotationFailed: 'Could not add the annotation',
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
  pickDevice: '选择模拟器…',
  booted: '已启动',
  switching: '切换中…',
  captureFailed: '截图失败',
  actionFailed: '操作失败',
  realDevices: 'iPhone / iPad（WebDriverAgent）',
  realDevice: '真机',
  noWda: '这台 iPhone 上的 WebDriverAgent 没有运行——用 ios_real_start_wda 启动，或在上方选择模拟器。',
  annotate: '标注截图',
  annotateTools: { pen: '画笔', line: '直线', arrow: '箭头', rect: '矩形', ellipse: '椭圆', text: '文字' },
  annotateColors: ['红', '蓝', '绿', '黑', '白'],
  undo: '撤销',
  redo: '重做',
  clear: '清空',
  close: '关闭',
  addToChat: '添加到对话',
  annotationAdded: '已添加——让 Claude 查看（ios_sim_annotation）',
  annotationAddedCopied: '已添加并复制——可直接粘贴到对话，或让 Claude 查看（ios_sim_annotation）',
  annotationFailed: '添加标注失败',
}

export function copyFor(language: string | undefined): PanelCopy {
  return (language ?? '').toLowerCase().startsWith('zh') ? ZH : EN
}
