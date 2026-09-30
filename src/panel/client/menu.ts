/**
 * Drop-down menus for the panel's menu bar (device picker, Device, Debug):
 * sections, separators, check marks, shortcut hints and hover submenus. The
 * items are rebuilt on every open, so they always reflect the current state.
 * @module ios-simulator/panel/client/menu
 */

import { icon } from './icons.js'

export interface MenuItem {
  label: string
  /** Second, dimmer line (a runtime under a device name). */
  detail?: string
  shortcut?: string
  checked?: boolean
  disabled?: boolean
  run?: () => void
  submenu?: () => MenuEntry[]
}

export type MenuEntry = MenuItem | { separator: true } | { section: string; dot?: boolean }

const CHECK = icon('check', 18)
const CHEVRON = icon('chevronRight', 16)

let openMenu: Menu | undefined

/** Close whichever menu is open. */
export function closeMenus(): void {
  openMenu?.close()
}

document.addEventListener('pointerdown', event => {
  if (openMenu !== undefined && !openMenu.contains(event.target as Node)) openMenu.close()
})
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeMenus()
})
window.addEventListener('blur', () => closeMenus())

export class Menu {
  readonly #anchor: HTMLElement
  readonly #build: () => MenuEntry[]
  readonly #root = document.createElement('div')
  #sub: HTMLDivElement | undefined

  constructor(anchor: HTMLElement, build: () => MenuEntry[]) {
    this.#anchor = anchor
    this.#build = build
    this.#root.className = 'menu-popover'
    this.#root.setAttribute('role', 'menu')
    this.#root.hidden = true
    document.body.append(this.#root)
    anchor.setAttribute('aria-haspopup', 'menu')
    anchor.addEventListener('click', () => {
      if (openMenu === this) this.close()
      else this.open()
    })
    // Sliding across the menu bar with one menu open opens the next, like a native menu bar.
    anchor.addEventListener('pointerenter', () => {
      if (openMenu !== undefined && openMenu !== this) this.open()
    })
  }

  get isOpen(): boolean {
    return openMenu === this
  }

  contains(node: Node): boolean {
    return this.#anchor.contains(node) || this.#root.contains(node) || (this.#sub?.contains(node) ?? false)
  }

  open(): void {
    openMenu?.close()
    openMenu = this
    this.#fill(this.#root, this.#build())
    this.#root.hidden = false
    this.#anchor.classList.add('open')
    const box = this.#anchor.getBoundingClientRect()
    this.#root.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - this.#root.offsetWidth - 8))}px`
    this.#root.style.top = `${box.bottom + 4}px`
  }

  close(): void {
    if (openMenu === this) openMenu = undefined
    this.#root.hidden = true
    this.#closeSub()
    this.#anchor.classList.remove('open')
  }

  #closeSub(): void {
    this.#sub?.remove()
    this.#sub = undefined
    for (const row of this.#root.querySelectorAll('.menu-item.expanded')) row.classList.remove('expanded')
  }

  #fill(container: HTMLElement, entries: MenuEntry[]): void {
    container.replaceChildren()
    for (const entry of entries) {
      if ('separator' in entry) {
        const line = document.createElement('div')
        line.className = 'menu-separator'
        container.append(line)
        continue
      }
      if ('section' in entry) {
        const heading = document.createElement('div')
        heading.className = 'menu-section'
        heading.textContent = entry.section
        if (entry.dot === true) heading.insertAdjacentHTML('beforeend', '<span class="menu-dot"></span>')
        container.append(heading)
        continue
      }
      container.append(this.#row(entry, container === this.#root))
    }
  }

  #row(item: MenuItem, topLevel: boolean): HTMLButtonElement {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'menu-item'
    row.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemcheckbox')
    if (item.checked !== undefined) row.setAttribute('aria-checked', String(item.checked))
    row.disabled = item.disabled === true
    const text = document.createElement('span')
    text.className = 'menu-label'
    text.textContent = item.label
    if (item.detail !== undefined) {
      const detail = document.createElement('span')
      detail.className = 'menu-detail'
      detail.textContent = item.detail
      text.append(detail)
    }
    row.append(text)
    if (item.shortcut !== undefined) {
      const hint = document.createElement('kbd')
      hint.textContent = item.shortcut
      row.append(hint)
    }
    if (item.checked === true) row.insertAdjacentHTML('beforeend', `<span class="menu-check">${CHECK}</span>`)
    if (item.submenu !== undefined) row.insertAdjacentHTML('beforeend', `<span class="menu-chevron">${CHEVRON}</span>`)
    const submenu = item.submenu
    if (submenu !== undefined) {
      const show = (): void => {
        if (row.disabled) return
        this.#closeSub()
        row.classList.add('expanded')
        const sub = document.createElement('div')
        sub.className = 'menu-popover submenu'
        sub.setAttribute('role', 'menu')
        this.#fill(sub, submenu())
        document.body.append(sub)
        this.#sub = sub
        const box = row.getBoundingClientRect()
        const left = box.right + 4 + sub.offsetWidth > window.innerWidth - 8 ? box.left - sub.offsetWidth - 4 : box.right + 4
        sub.style.left = `${Math.max(8, left)}px`
        sub.style.top = `${Math.max(8, box.top - 6)}px`
      }
      row.addEventListener('pointerenter', show)
      row.addEventListener('click', show)
    } else {
      if (topLevel) row.addEventListener('pointerenter', () => this.#closeSub())
      row.addEventListener('click', () => {
        this.close()
        item.run?.()
      })
    }
    return row
  }
}
