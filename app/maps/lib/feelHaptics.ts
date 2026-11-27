// Day 28: buzzes in the hand. Android's browsers vibrate for as long as asked (navigator.vibrate);
// Safari on iOS has no vibrate, but since iOS 18 toggling a switch (<input type="checkbox"
// switch>) taps the Taptic Engine once, so there every buzz is that one tap. Desktops do nothing.

export class Haptics {
  private label?: HTMLLabelElement
  private lastAt = 0
  readonly canVibrate = typeof navigator !== 'undefined' && 'vibrate' in navigator

  constructor(host: HTMLElement) {
    if (this.canVibrate) return
    const label = document.createElement('label')
    label.setAttribute('aria-hidden', 'true')
    label.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.setAttribute('switch', '')
    input.tabIndex = -1
    label.appendChild(input)
    host.appendChild(label)
    this.label = label
  }

  /** A buzz of `ms` milliseconds (or as near as the device can) */
  buzz(ms: number) {
    const now = performance.now()
    // No more than one every 30 ms, or they run together into a hum
    if (now - this.lastAt < 30) return
    this.lastAt = now
    if (this.canVibrate) navigator.vibrate(Math.max(1, Math.round(ms)))
    else this.label?.click()
  }

  /** A pattern: on, off, on, … (ms) */
  pattern(p: number[]) {
    if (this.canVibrate) navigator.vibrate(p)
    else this.buzz(p[0] ?? 10)
  }

  stop() {
    if (this.canVibrate) navigator.vibrate(0)
  }

  dispose() {
    this.stop()
    this.label?.remove()
  }
}
