// The world's ocean waves as their crests (waveCrestSim.ts), for Navara: shown on a shell over
// the sea (see waveField.ts).
import type { MeshConfigWithSelectiveEffect } from '@navaramap/three'
import { WaveDomainMeshDesc } from './waveField'
import { WaveCrestSim, type CrestParams } from './waveCrestSim'
import type { WaveGrid } from './waveSim'

export type WaveCrestConfig = MeshConfigWithSelectiveEffect & { waveCrest?: { grid?: WaveGrid } }

export class WaveCrestMeshDesc extends WaveDomainMeshDesc<WaveCrestConfig, WaveCrestSim> {
  protected override createSim(): WaveCrestSim {
    const grid = this.config.waveCrest?.grid
    if (!grid) throw new Error('waveCrest.grid is required')
    return new WaveCrestSim(grid)
  }

  /** Tunable as it runs */
  get params(): CrestParams {
    return this.sim!.params
  }
}
