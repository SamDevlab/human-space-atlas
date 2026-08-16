import type { Cartesian3, Quaternion } from 'cesium'

export type ExplorationCameraMode = 'THIRD_PERSON'

export interface FlightInput {
  throttleDelta: number
  strafe: number
  vertical: number
  yawRate: number
  pitchRate: number
  rollInput: number
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
  boostActive: boolean
}

export interface TargetIndicatorSnapshot {
  x: number
  y: number
  angle: number
  edge: boolean
}

export interface FlightDebugSnapshot {
  mouseDx: number
  mouseDy: number
  yawRate: number
  pitchRate: number
  rollRate: number
  throttle: number
  velocity: Cartesian3
  forward: Cartesian3
  orientation: Quaternion
  pointerLock: boolean
}

export interface ExplorationHudSnapshot {
  altitudeKm: number
  speedKmS: number
  throttle: number
  cameraMode: ExplorationCameraMode
  cameraDistanceMeters: number
  cameraOrbiting: boolean
  flightAssist: boolean
  boostActive: boolean
  lowAltitude: boolean
  targetName: string | null
  targetDistanceKm: number | null
  targetIndicator: TargetIndicatorSnapshot | null
  debugFlight: FlightDebugSnapshot
}
