// When a map fails to come up, say so on the page instead of leaving it on "Loading…": an error
// thrown while a map starts (Vue's error hook), an unhandled error or rejection, or the WebGL
// context lost (phones drop it when memory runs short), or a page still on "Loading…" after 40 s,
// shows a note at the foot of the page with what happened and a button to reload. With ?debug in the URL, the console's errors and warnings
// are listed there too, so a phone can show what went wrong.

type Entry = { kind: string; text: string }

export default defineNuxtPlugin((nuxtApp) => {
  const debug = new URLSearchParams(location.search).has('debug')
  const entries: Entry[] = []
  let box: HTMLDivElement | undefined
  let list: HTMLOListElement | undefined
  let shown = false

  const ensure = () => {
    if (box) return
    box = document.createElement('div')
    box.setAttribute('role', 'alert')
    box.style.cssText = [
      'position:fixed',
      'left:8px',
      'right:8px',
      'bottom:8px',
      'z-index:1000',
      'max-height:45vh',
      'overflow:auto',
      'padding:10px 12px',
      'font:12px/1.45 ui-monospace,Menlo,monospace',
      'color:#fff',
      'background:rgba(20,10,10,0.92)',
      'border:1px solid #c55',
      'border-radius:10px',
      'display:none',
    ].join(';')
    const head = document.createElement('div')
    head.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:6px;font-weight:700'
    head.textContent = 'The map ran into trouble.'
    const reload = document.createElement('button')
    reload.textContent = 'Reload'
    reload.style.cssText = 'margin-left:auto;padding:4px 10px;border:0;border-radius:6px;background:#fff;color:#222;font-weight:700'
    reload.onclick = () => location.reload()
    const close = document.createElement('button')
    close.textContent = '×'
    close.setAttribute('aria-label', 'Close')
    close.style.cssText = 'padding:2px 8px;border:0;border-radius:6px;background:transparent;color:#fff;font-size:16px'
    close.onclick = () => {
      box!.style.display = 'none'
      shown = false
    }
    head.append(reload, close)
    list = document.createElement('ol')
    list.style.cssText = 'margin:0;padding-left:18px;word-break:break-word'
    box.append(head, list)
    document.body.appendChild(box)
  }

  const add = (kind: string, text: string, show: boolean) => {
    const e = { kind, text: text.slice(0, 400) }
    if (entries.some((x) => x.kind === e.kind && x.text === e.text)) return
    entries.push(e)
    if (!show && !debug) return
    ensure()
    const li = document.createElement('li')
    li.textContent = `[${e.kind}] ${e.text}`
    list!.appendChild(li)
    if (show || debug) {
      box!.style.display = 'block'
      shown = true
    }
  }
  const describe = (x: unknown) => (x instanceof Error ? `${x.name}: ${x.message}` : String(x))

  // Errors thrown while a map's component starts (its async onMounted): Vue reports them here
  nuxtApp.hook('vue:error', (err) => add('error', describe(err), true))
  window.addEventListener('error', (e) => add('error', describe(e.error ?? e.message), true))
  window.addEventListener('unhandledrejection', (e) => add('rejection', describe(e.reason), true))
  // A canvas losing its WebGL context (events don't bubble: listen in the capture phase)
  document.addEventListener('webglcontextlost', () => add('webgl', 'The WebGL context was lost (often: the device ran short of memory).', true), true)

  if (debug) {
    for (const level of ['error', 'warn'] as const) {
      const orig = console[level].bind(console)
      console[level] = (...args: unknown[]) => {
        orig(...args)
        add(level, args.map(describe).join(' '), false)
      }
    }
    add('info', `${navigator.userAgent} · dpr ${devicePixelRatio} · ${innerWidth}×${innerHeight} · cores ${navigator.hardwareConcurrency ?? '?'}`, false)
  }

  // Still loading long after the page came up: something hung without a word
  let watch = 0
  nuxtApp.hook('page:finish', () => {
    clearTimeout(watch)
    const path = location.pathname
    watch = window.setTimeout(() => {
      if (location.pathname === path && document.querySelector('.loading')) add('timeout', `Still loading after 40 s (${path}).`, true)
    }, 40_000)
  })

  // A new page starts with a clean slate (unless debugging, which keeps the whole trail)
  nuxtApp.hook('page:start', () => {
    if (debug || !box || !shown) return
    box.style.display = 'none'
    shown = false
    list!.replaceChildren()
    entries.length = 0
  })
})
