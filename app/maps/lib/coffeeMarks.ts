// Day 13's coffee marks, drawn on a canvas into PNG data URLs for Navara's billboards: a pin
// with a cup of coffee, steaming, on it; once the shop has been gone into, the pin turns dark
// roast and the cup has a tick.

const W = 96
const H = 116
const R = 44

function pin(fill: string, rim: string): CanvasRenderingContext2D & { canvas: HTMLCanvasElement } {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const c = canvas.getContext('2d')!
  const cx = W / 2
  const cy = R + 3
  // A round head and a point below, where it stands on the map
  c.beginPath()
  c.arc(cx, cy, R, Math.PI * 0.78, Math.PI * 0.22)
  c.lineTo(cx, H - 2)
  c.closePath()
  c.fillStyle = fill
  c.fill()
  c.lineWidth = 4
  c.strokeStyle = rim
  c.stroke()
  return c as CanvasRenderingContext2D & { canvas: HTMLCanvasElement }
}

function cup(c: CanvasRenderingContext2D, body: string, coffee: string, steam: string | null) {
  const cx = W / 2
  const top = 44
  // Saucer
  c.fillStyle = body
  c.beginPath()
  c.ellipse(cx, top + 30, 28, 5, 0, 0, Math.PI * 2)
  c.fill()
  // Cup: wide at the rim, round at the bottom
  c.beginPath()
  c.moveTo(cx - 22, top)
  c.lineTo(cx + 22, top)
  c.bezierCurveTo(cx + 22, top + 20, cx + 14, top + 27, cx, top + 27)
  c.bezierCurveTo(cx - 14, top + 27, cx - 22, top + 20, cx - 22, top)
  c.fill()
  // Handle
  c.lineWidth = 5
  c.strokeStyle = body
  c.beginPath()
  c.ellipse(cx + 24, top + 9, 7, 7, 0, -Math.PI * 0.6, Math.PI * 0.6)
  c.stroke()
  // The coffee in it
  c.fillStyle = coffee
  c.beginPath()
  c.ellipse(cx, top + 1, 19, 3.5, 0, 0, Math.PI * 2)
  c.fill()
  if (!steam) return
  c.strokeStyle = steam
  c.lineWidth = 4
  c.lineCap = 'round'
  for (const dx of [-9, 0, 9]) {
    c.beginPath()
    c.moveTo(cx + dx, top - 6)
    c.bezierCurveTo(cx + dx - 6, top - 12, cx + dx + 6, top - 18, cx + dx, top - 25)
    c.stroke()
  }
}

/** The mark of a shop not yet been in, and of one that has */
export function coffeeMarks(): { fresh: string; visited: string } {
  const fresh = pin('#fff6e8', '#6b3f22')
  cup(fresh, '#6b3f22', '#c98a4b', '#b07a50')

  const visited = pin('#4a2c1a', '#2b180d')
  cup(visited, '#e9d6bf', '#8a5a34', null)
  // A tick over the cup
  visited.strokeStyle = '#8fd17a'
  visited.lineWidth = 7
  visited.lineCap = 'round'
  visited.lineJoin = 'round'
  visited.beginPath()
  visited.moveTo(W / 2 - 13, 28)
  visited.lineTo(W / 2 - 3, 37)
  visited.lineTo(W / 2 + 15, 17)
  visited.stroke()

  return { fresh: fresh.canvas.toDataURL('image/png'), visited: visited.canvas.toDataURL('image/png') }
}
