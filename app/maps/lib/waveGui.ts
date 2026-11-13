// Day 12's parameter panel (lil-gui, shown with ?gui=1), for either map: what both looks share,
// then the look shown's own, each with a line on what it does.
import GUI, { type Controller } from 'lil-gui'
import type { CrestParams } from './waveCrestSim'
import type { FluidParams } from './waveFluidSim'
import { PHASE_SPEED } from './waveSim'
import type { StreamParams } from './waveStreamSim'

export const MODES = { fluid: 'Fluid', stream: 'Streamlines', crests: 'Crests' } as const
export type Mode = keyof typeof MODES

export type WaveGuiOptions = {
  fluid: FluidParams
  stream: StreamParams
  crests: CrestParams
  /** Sets both looks' crest speed */
  setSpeed: (x: number) => void
  /** The bloom's strength and how to set it, where the map has one */
  bloom?: { strength: number; set: (x: number) => void }
  /** The look shown, and a way to hear when it changes */
  mode: () => Mode
  onMode: (f: (m: Mode) => void) => void
}

export function waveGui(container: HTMLElement | undefined, o: WaveGuiOptions): GUI {
  const gui = new GUI({ container, title: 'Parameters', width: 300 })
  const hint = (c: Controller, text: string) => {
    const el = document.createElement('div')
    el.className = 'hint'
    el.textContent = text
    c.domElement.classList.add('has-hint')
    c.domElement.append(el)
    return c
  }
  const shared = { speed: PHASE_SPEED, bloom: o.bloom?.strength ?? 0 }
  const both = gui.addFolder('Waves')
  hint(both.add(shared, 'speed', 0.005, 0.2, 0.005).name('crest speed').onChange(o.setSpeed), '波の峰が進む速さ（両モード）。インク・航跡はその半分で流れる')
  if (o.bloom) hint(both.add(shared, 'bloom', 0, 2, 0.05).onChange(o.bloom.set), '明るいところの光のにじみ')

  const fluid = gui.addFolder('Fluid')
  const f = o.fluid
  hint(fluid.add(f, 'stir', 0, 100, 1), '荒れた海で渦を起こす力。上げると渦が強く大きくなる')
  hint(fluid.add(f, 'pull', 0.1, 5, 0.1), '渦がかき混ぜの力に追いつく速さ。上げると反応が早い')
  hint(fluid.add(f, 'curl', 0, 50, 1).name('curl (confinement)'), '小さな渦を増幅する。上げると細かい巻き込みが増える')
  hint(fluid.add(f, 'pressureIterations', 1, 60, 1).name('pressure iterations'), '圧力計算の反復回数。下げると軽いが、渦の形が崩れる')
  hint(fluid.add(f, 'velocityDissipation', 0, 1, 0.01).name('eddy dissipation'), '渦の減衰。上げると渦がすぐ消える')
  hint(fluid.add(f, 'relax', 0.05, 2, 0.05).name('dye relax'), 'インクがその場の色に戻る速さ。下げると色が遠くまで流れる')
  hint(fluid.add(f, 'plumes', 0, 4, 0.05), '斑の中で余分に足すインク。上げると濃淡の帯がくっきりする')
  hint(fluid.add(f, 'flatness', 0.01, 0.3, 0.005).name('relief flatness'), '陰影の起伏。下げるほど凹凸が深くなる')
  hint(fluid.add(f, 'light', 0, 1.5, 0.05), '光の当たる面の明るさ')
  hint(fluid.add(f, 'glint', 0, 1, 0.05), '水面の照り返しの強さ')

  const stream = gui.addFolder('Streamlines')
  const st = o.stream
  hint(stream.add(st, 'fade', 0.2, 6, 0.1).name('wake fade (s)'), '航跡が薄れるまでの時間。上げると筋が長くなる')
  hint(stream.add(st, 'lifeMin', 0.5, 10, 0.5).name('life min (s)'), '峰が生まれ変わるまでの寿命（最短）')
  hint(stream.add(st, 'lifeMax', 0.5, 15, 0.5).name('life max (s)'), '峰が生まれ変わるまでの寿命（最長）')
  hint(stream.add(st, 'brightness', 0.005, 0.2, 0.005), '峰 1 つが航跡に足す明るさ')
  hint(stream.add(st, 'pointSize', 1, 4, 0.25).name('crest size'), '峰の点の大きさ。上げると筋が太くなる')
  hint(stream.add(st, 'glow', 0, 2, 0.05), '嵐の海域での航跡の明るさ')

  const crests = gui.addFolder('Crests')
  const c = o.crests
  hint(crests.add(c, 'size', 6, 80, 1), '「^」の大きさ（周期 10 秒のとき）。周期が長いほど大きくなる')
  hint(crests.add(c, 'brightness', 0, 3, 0.05), '「^」の明るさ')
  hint(crests.add(c, 'pace', 0.05, 1.5, 0.05), '「^」が進む速さ（crest speed に対する倍率）。下げるとゆったり流れる')
  hint(crests.add(c, 'lifeMin', 0.5, 10, 0.5).name('life min (s)'), '「^」が生まれ変わるまでの寿命（最短）')
  hint(crests.add(c, 'lifeMax', 0.5, 15, 0.5).name('life max (s)'), '「^」が生まれ変わるまでの寿命（最長）')
  hint(crests.add(c, 'tail', 0, 1, 0.01).name('tail (s)'), '「^」の後ろに残る尾の長さ。上げると流れの筋が長くなる')

  const showFolders = (m: Mode) => {
    fluid.show(m === 'fluid')
    stream.show(m === 'stream')
    crests.show(m === 'crests')
  }
  showFolders(o.mode())
  o.onMode(showFolders)
  // Back to the defaults: every controller to where it started
  hint(gui.add({ reset: () => gui.reset() }, 'reset'), 'すべて既定値に戻す')
  return gui
}
