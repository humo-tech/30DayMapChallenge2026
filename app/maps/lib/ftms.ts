// A smart trainer over Web Bluetooth (Chrome): the Fitness Machine Service (FTMS) for power,
// cadence and speed, and for setting the slope it should ride; or, failing that, a power meter
// over the Cycling Power Service (read only).

const FTMS = 0x1826
const INDOOR_BIKE_DATA = 0x2ad2
const CONTROL_POINT = 0x2ad9
const CYCLING_POWER = 0x1818
const CYCLING_POWER_MEASUREMENT = 0x2a63

// Just the slice of the Web Bluetooth API used here (lib.dom doesn't type it)
interface Characteristic extends EventTarget {
  value?: DataView
  startNotifications(): Promise<Characteristic>
  writeValueWithResponse(value: BufferSource): Promise<void>
}
interface Service {
  getCharacteristic(uuid: number): Promise<Characteristic>
}
interface Device extends EventTarget {
  name?: string
  gatt?: {
    connected: boolean
    connect(): Promise<{ getPrimaryService(uuid: number): Promise<Service> }>
    disconnect(): void
  }
}
interface Bluetooth {
  requestDevice(options: { filters: { services: number[] }[]; optionalServices?: number[] }): Promise<Device>
}

export interface TrainerData {
  power?: number // W
  cadence?: number // rpm
  speed?: number // km/h
}

export const hasWebBluetooth = () => typeof navigator !== 'undefined' && 'bluetooth' in navigator

// FTMS Indoor Bike Data: a flags word, then only the fields it flags, in order
function parseIndoorBikeData(view: DataView): TrainerData {
  const flags = view.getUint16(0, true)
  const out: TrainerData = {}
  let i = 2
  if (!(flags & 0x0001)) {
    out.speed = view.getUint16(i, true) / 100
    i += 2
  }
  if (flags & 0x0002) i += 2 // average speed
  if (flags & 0x0004) {
    out.cadence = view.getUint16(i, true) / 2
    i += 2
  }
  if (flags & 0x0008) i += 2 // average cadence
  if (flags & 0x0010) i += 3 // total distance
  if (flags & 0x0020) i += 2 // resistance level
  if (flags & 0x0040) out.power = view.getInt16(i, true)
  return out
}

// Cycling Power Measurement: flags, then instantaneous power (no cadence without crank maths)
const parseCyclingPower = (view: DataView): TrainerData => ({ power: view.getInt16(2, true) })

export class Trainer {
  name = ''
  /** Whether the trainer takes the slope (FTMS), or only reports power */
  controllable = false
  onData?: (data: TrainerData) => void
  onDisconnect?: () => void

  private device?: Device
  private control?: Characteristic
  private writing = false
  private pendingGrade?: number
  private sentGrade = Number.NaN

  async connect() {
    const bluetooth = (navigator as unknown as { bluetooth: Bluetooth }).bluetooth
    const device = await bluetooth.requestDevice({
      filters: [{ services: [FTMS] }, { services: [CYCLING_POWER] }],
      optionalServices: [FTMS, CYCLING_POWER],
    })
    this.device = device
    this.name = device.name ?? 'Trainer'
    device.addEventListener('gattserverdisconnected', () => this.onDisconnect?.())
    const server = await device.gatt!.connect()

    const ftms = await server.getPrimaryService(FTMS).catch(() => undefined)
    if (ftms) {
      const data = await ftms.getCharacteristic(INDOOR_BIKE_DATA)
      data.addEventListener('characteristicvaluechanged', () => this.onData?.(parseIndoorBikeData(data.value!)))
      await data.startNotifications()
      const control = await ftms.getCharacteristic(CONTROL_POINT).catch(() => undefined)
      if (control) {
        // The control point answers by indication; it has to be on before anything is written
        await control.startNotifications()
        await control.writeValueWithResponse(new Uint8Array([0x00])) // Request Control
        await control.writeValueWithResponse(new Uint8Array([0x07])) // Start or Resume
        this.control = control
        this.controllable = true
      }
      return
    }
    const cps = await server.getPrimaryService(CYCLING_POWER)
    const measurement = await cps.getCharacteristic(CYCLING_POWER_MEASUREMENT)
    measurement.addEventListener('characteristicvaluechanged', () => this.onData?.(parseCyclingPower(measurement.value!)))
    await measurement.startNotifications()
  }

  /**
   * The slope to ride, in %. Writes go one at a time; while one is in flight only the latest
   * slope waits, and changes under 0.1% aren't sent at all.
   */
  setGrade(percent: number) {
    if (!this.control) return
    const rounded = Math.round(percent * 10) / 10
    if (rounded === this.sentGrade && this.pendingGrade === undefined) return
    this.pendingGrade = rounded
    if (!this.writing) void this.flush()
  }

  private async flush() {
    this.writing = true
    while (this.pendingGrade !== undefined && this.control) {
      const grade = this.pendingGrade
      this.pendingGrade = undefined
      if (grade === this.sentGrade) continue
      // Set Indoor Bike Simulation Parameters: wind (0.001 m/s), grade (0.01%),
      // rolling resistance (0.0001) and wind resistance coefficient (0.01 kg/m)
      const msg = new DataView(new ArrayBuffer(7))
      msg.setUint8(0, 0x11)
      msg.setInt16(1, 0, true)
      msg.setInt16(3, Math.round(grade * 100), true)
      msg.setUint8(5, 40) // Crr 0.004
      msg.setUint8(6, 20) // 0.5 · ρ · CdA ≈ 0.20 kg/m
      try {
        await this.control.writeValueWithResponse(msg)
        this.sentGrade = grade
      } catch {
        // A busy trainer drops a write now and then; the next slope change tries again
      }
    }
    this.writing = false
  }

  disconnect() {
    this.control = undefined
    this.device?.gatt?.disconnect()
  }
}
