import { Cartesian3, Ellipsoid, Matrix3, Quaternion, Viewer } from 'cesium'

export const MIN_CAMERA_DISTANCE_METERS = 3_500
export const DEFAULT_CAMERA_DISTANCE_METERS = 7_500
export const MAX_CAMERA_DISTANCE_METERS = 50_000
export const MIN_CAMERA_PITCH = -Math.PI * 0.47
export const MAX_CAMERA_PITCH = Math.PI * 0.47
export const DEFAULT_CAMERA_PITCH = 0.28

export interface CameraOrbitState {
  yaw: number
  pitch: number
  distance: number
}

export function clampCameraPitch(pitch: number): number {
  return Math.max(MIN_CAMERA_PITCH, Math.min(MAX_CAMERA_PITCH, pitch))
}

export function clampCameraDistance(distance: number): number {
  return Math.max(MIN_CAMERA_DISTANCE_METERS, Math.min(MAX_CAMERA_DISTANCE_METERS, distance))
}

export function applyCameraOrbit(state: CameraOrbitState, deltaX: number, deltaY: number, sensitivity = 0.004): CameraOrbitState {
  return {
    yaw: state.yaw - deltaX * sensitivity,
    pitch: clampCameraPitch(state.pitch - deltaY * sensitivity),
    distance: state.distance,
  }
}

export function applyCameraZoom(state: CameraOrbitState, deltaY: number): CameraOrbitState {
  return { ...state, distance: clampCameraDistance(state.distance * Math.exp(deltaY * 0.001)) }
}

function damp(current: number, target: number, strength: number, deltaSeconds: number): number {
  return current + (target - current) * (1 - Math.exp(-strength * deltaSeconds))
}

export class ShipCameraRig {
  private readonly viewer: Viewer
  private actualPosition: Cartesian3 | null = null
  private actualUp: Cartesian3 | null = null
  private idleSeconds = 0
  private orbiting = false
  private entered = false

  readonly state: CameraOrbitState = { yaw: 0, pitch: DEFAULT_CAMERA_PITCH, distance: DEFAULT_CAMERA_DISTANCE_METERS }
  followStrength = 5.5
  lookAhead = 4_500
  rollInfluence = 0.28
  autoRecenterDelay = 2.2
  orbitSensitivity = 0.004

  constructor(viewer: Viewer) {
    this.viewer = viewer
  }

  enter(position: Cartesian3, orientation: Quaternion): void {
    this.state.yaw = 0
    this.state.pitch = DEFAULT_CAMERA_PITCH
    this.state.distance = DEFAULT_CAMERA_DISTANCE_METERS
    this.actualPosition = null
    this.actualUp = null
    this.idleSeconds = 0
    this.orbiting = false
    this.entered = true
    this.update(position, orientation, Cartesian3.ZERO, 0)
  }

  exit(): void {
    this.entered = false
    this.actualPosition = null
    this.actualUp = null
    this.orbiting = false
  }

  beginOrbit(): void {
    this.orbiting = true
    this.idleSeconds = 0
  }

  endOrbit(): void {
    this.orbiting = false
    this.idleSeconds = 0
  }

  orbit(deltaX: number, deltaY: number): void {
    const next = applyCameraOrbit(this.state, deltaX, deltaY, this.orbitSensitivity)
    this.state.yaw = next.yaw
    this.state.pitch = next.pitch
    this.idleSeconds = 0
  }

  zoom(deltaY: number): void {
    this.state.distance = applyCameraZoom(this.state, deltaY).distance
    this.idleSeconds = 0
  }

  recenter(): void {
    this.state.yaw = 0
    this.state.pitch = DEFAULT_CAMERA_PITCH
    this.idleSeconds = 0
  }

  isOrbiting(): boolean {
    return this.orbiting
  }

  getDistance(): number {
    return this.state.distance
  }

  update(position: Cartesian3, orientation: Quaternion, velocity: Cartesian3, deltaSeconds: number): void {
    if (!this.entered) return
    const dt = Math.max(0, Math.min(deltaSeconds, 0.1))
    if (!this.orbiting) {
      this.idleSeconds += dt
      if (this.idleSeconds > this.autoRecenterDelay) {
        this.state.yaw = damp(this.state.yaw, 0, 1.35, dt)
        this.state.pitch = damp(this.state.pitch, DEFAULT_CAMERA_PITCH, 1.35, dt)
      }
    }

    const rotation = Matrix3.fromQuaternion(orientation, new Matrix3())
    const forward = Matrix3.multiplyByVector(rotation, Cartesian3.UNIT_X, new Cartesian3())
    const right = Matrix3.multiplyByVector(rotation, Cartesian3.UNIT_Y, new Cartesian3())
    const shipUp = Matrix3.multiplyByVector(rotation, Cartesian3.UNIT_Z, new Cartesian3())
    const earthUp = Ellipsoid.WGS84.geodeticSurfaceNormal(position, new Cartesian3())
    const cosPitch = Math.cos(this.state.pitch)
    const orbitOffset = new Cartesian3()
    Cartesian3.add(orbitOffset, Cartesian3.multiplyByScalar(forward, -Math.cos(this.state.yaw) * cosPitch, new Cartesian3()), orbitOffset)
    Cartesian3.add(orbitOffset, Cartesian3.multiplyByScalar(right, Math.sin(this.state.yaw) * cosPitch, new Cartesian3()), orbitOffset)
    Cartesian3.add(orbitOffset, Cartesian3.multiplyByScalar(shipUp, Math.sin(this.state.pitch), new Cartesian3()), orbitOffset)
    Cartesian3.normalize(orbitOffset, orbitOffset)

    const desiredPosition = Cartesian3.add(position, Cartesian3.multiplyByScalar(orbitOffset, this.state.distance, new Cartesian3()), new Cartesian3())
    const speed = Cartesian3.magnitude(velocity)
    const desiredLookAhead = this.lookAhead + Math.min(speed * 0.35, 18_000)
    const lookTarget = Cartesian3.add(position, Cartesian3.multiplyByScalar(forward, desiredLookAhead, new Cartesian3()), new Cartesian3())
    const desiredDirection = Cartesian3.normalize(Cartesian3.subtract(lookTarget, desiredPosition, new Cartesian3()), new Cartesian3())
    const rollUp = Cartesian3.normalize(Cartesian3.lerp(earthUp, shipUp, this.rollInfluence, new Cartesian3()), new Cartesian3())
    const desiredRight = Cartesian3.normalize(Cartesian3.cross(desiredDirection, rollUp, new Cartesian3()), new Cartesian3())
    const desiredUp = Cartesian3.normalize(Cartesian3.cross(desiredRight, desiredDirection, new Cartesian3()), new Cartesian3())

    if (!this.actualPosition || !this.actualUp) {
      this.actualPosition = desiredPosition
      this.actualUp = desiredUp
    } else {
      const smoothing = 1 - Math.exp(-this.followStrength * Math.max(dt, 0.016))
      this.actualPosition = Cartesian3.lerp(this.actualPosition, desiredPosition, smoothing, this.actualPosition)
      this.actualUp = Cartesian3.normalize(Cartesian3.lerp(this.actualUp, desiredUp, smoothing, this.actualUp), this.actualUp)
    }
    const direction = Cartesian3.normalize(Cartesian3.subtract(lookTarget, this.actualPosition, new Cartesian3()), new Cartesian3())
    this.viewer.camera.setView({ destination: this.actualPosition, orientation: { direction, up: this.actualUp } })
  }
}
