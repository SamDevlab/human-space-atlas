import type { Cartesian3, Quaternion } from 'cesium'

export type ExplorationCameraMode = 'COCKPIT' | 'CHASE'

export interface FlightInput {
  forward: number
  strafe: number
  vertical: number
  yawRate: number
  pitchRate: number
  rollRate: number
  boost: boolean
  brake: boolean
}

export interface ShipState {
  position: Cartesian3
  velocity: Cartesian3
  orientation: Quaternion
  throttle: number
  angularVelocity: Cartesian3
  flightAssist: boolean
}

export interface ExplorationHudSnapshot {
  altitudeKm: number
  speedKmS: number
  cameraMode: ExplorationCameraMode
  flightAssist: boolean
  targetName: string | null
  targetDistanceKm: number | null
}
