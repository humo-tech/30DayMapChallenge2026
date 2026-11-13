// The world's ocean waves as a fluid (waveFluidSim.ts), for Navara: run over what's in view and
// shown on a shell over the sea (see waveField.ts).
import type { MeshConfigWithSelectiveEffect } from '@navaramap/three'
import { WaveDomainMeshDesc } from './waveField'
import { WaveFluidSim, type FluidParams, type WaveFluidOptions } from './waveFluidSim'
import type { WaveGrid } from './waveSim'

export type WaveFluidConfig = MeshConfigWithSelectiveEffect & { waveFluid?: WaveFluidOptions & { grid?: WaveGrid } }

export class WaveFluidMeshDesc extends WaveDomainMeshDesc<WaveFluidConfig, WaveFluidSim> {
  protected override createSim(): WaveFluidSim {
    const { grid, ...options } = this.config.waveFluid ?? {}
    if (!grid) throw new Error('waveFluid.grid is required')
    return new WaveFluidSim(grid, options)
  }

  /** Tunable as it runs */
  get params(): FluidParams {
    return this.sim!.params
  }
}
