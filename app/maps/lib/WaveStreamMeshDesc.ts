// The world's ocean waves as streamlines (waveStreamSim.ts), for Navara: run over what's in view
// and shown on a shell over the sea (see waveField.ts).
import type { MeshConfigWithSelectiveEffect } from '@navaramap/three'
import { WaveDomainMeshDesc } from './waveField'
import { WaveStreamSim, type StreamParams, type WaveStreamOptions } from './waveStreamSim'
import type { WaveGrid } from './waveSim'

export type WaveStreamConfig = MeshConfigWithSelectiveEffect & { waveStream?: WaveStreamOptions & { grid?: WaveGrid } }

export class WaveStreamMeshDesc extends WaveDomainMeshDesc<WaveStreamConfig, WaveStreamSim> {
  protected override createSim(): WaveStreamSim {
    const { grid, ...options } = this.config.waveStream ?? {}
    if (!grid) throw new Error('waveStream.grid is required')
    return new WaveStreamSim(grid, options)
  }

  /** Tunable as it runs */
  get params(): StreamParams {
    return this.sim!.params
  }
}
