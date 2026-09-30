/** Accessibility-tree fixtures for the UI-automation tests (iPhone 17 Pro: 402×874 points). */
import type { AxeElement } from '../../src/uitree-backend.js'

type Frame = AxeElement['frame']

export function node(type: string, frame: Frame, fields: Partial<Omit<AxeElement, 'type' | 'frame'>> = {}): AxeElement {
  return { type, frame, children: [], ...fields }
}

/** A Settings-like screen: a list of cells mirroring their label onto child text, one off-screen, one disabled. */
export function settingsTree(): AxeElement[] {
  const row = (label: string, y: number, extra: Partial<AxeElement> = {}): AxeElement =>
    node('Cell', { x: 0, y, w: 402, h: 52 }, {
      label,
      ...extra,
      children: [node('StaticText', { x: 60, y: y + 14, w: 200, h: 24 }, { label })],
    })
  return [node('Application', { x: 0, y: 0, w: 402, h: 874 }, {
    label: 'Settings',
    pid: 42,
    children: [
      node('Heading', { x: 16, y: 60, w: 200, h: 40 }, { label: '设置' }),
      row('General', 200, { identifier: 'com.apple.settings.general' }),
      row('Accessibility', 252),
      row('Privacy & Security', 304, { enabled: false }),
      row('General Info', 1200),
      node('Button', { x: 330, y: 60, w: 60, h: 40 }, { label: 'Edit', identifier: 'edit' }),
      node('Button', { x: 20, y: 800, w: 60, h: 40 }, { label: 'Edit Profile' }),
    ],
  })]
}

/** A feed: three aggregated cells whose labels carry counters, no child controls. */
export function feedTree(counts: Array<[number, number]> = [[57, 18], [3, 1], [1200, 32000]]): AxeElement[] {
  return [node('Application', { x: 0, y: 0, w: 402, h: 874 }, {
    label: 'Feed',
    children: counts.map(([replies, likes], index) => node('Cell', { x: 0, y: 100 + index * 150, w: 402, h: 150 }, {
      label: `Post ${index + 1}. ${replies} 回复。${likes} 喜欢`,
    })),
  })]
}
