import { Cartesian3, Ellipsoid, Matrix3, Quaternion, Viewer } from 'cesium'
import { getShipBasis } from './flightModel'
import type { ExplorationCameraPreset } from './types'

export const MIN_CAMERA_DISTANCE_METERS = 2_800
export const DEFAULT_CAMERA_DISTANCE_METERS = 5_200
export const MAX_CAMERA_DISTANCE_METERS = 50_000
export const MIN_CAMERA_PITCH = -Math.PI * 0.47
export const MAX_CAMERA_PITCH = Math.PI * 0.47
export const DEFAULT_CAMERA_PITCH = 0.18

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

function normalizeOrFallback(vector: Cartesian3, fallback: Cartesian3, result = new Cartesian3()): Cartesian3 {
  const magnitude = Cartesian3.magnitude(vector)
  if (!Number.isFinite(magnitude) || magnitude < 0.0001) return Cartesian3.clone(fallback, result)
  return Cartesian3.divideByScalar(vector, magnitude, result)
}

function stableCameraUp(direction: Cartesian3, rollUp: Cartesian3, fallback: Cartesian3, result = new Cartesian3(), projectedUp = new Cartesian3()): Cartesian3 {
  Cartesian3.multiplyByScalar(direction, Cartesian3.dot(rollUp, direction), projectedUp)
  Cartesian3.subtract(rollUp, projectedUp, projectedUp)
  const up = normalizeOrFallback(projectedUp, fallback, result)
  return Cartesian3.dot(up, fallback) >= 0 ? up : Cartesian3.negate(up, up)
}

export class ShipCameraRig {
  private readonly viewer: Viewer
  private actualPosition: Cartesian3 | null = null
  private actualUp: Cartesian3 | null = null
  private actualLookAhead: number | null = null
  private actualLookTarget: Cartesian3 | null = null
  private followOrientation = Quaternion.IDENTITY.clone()
  private orbiting = false
  private cameraDetached = false
  private entered = false
  private cinematicEnabled = true
  private cinematicPhase = 0
  private cinematicHoldSeconds = 0
  // The default composition is persistent. Explore keeps the planet dominant
  // (roughly 70% Earth / 30% open space) until the user deliberately changes
  // the camera. Recenter restores this canonical composition.
  private earthFocusActive = false
  private referenceForward = Cartesian3.UNIT_X.clone()
  private referenceRight = Cartesian3.UNIT_Y.clone()
  private referenceUp = Cartesian3.UNIT_Z.clone()
  private latestForward = Cartesian3.UNIT_X.clone()
  private latestRight = Cartesian3.UNIT_Y.clone()
  private latestUp = Cartesian3.UNIT_Z.clone()
  private readonly targetFrame = new Matrix3()
  private readonly orbitOffset = new Cartesian3()
  private readonly orbitForward = new Cartesian3()
  private readonly orbitRight = new Cartesian3()
  private readonly orbitUp = new Cartesian3()
  private readonly earthUp = new Cartesian3()
  private readonly earthwardForward = new Cartesian3()
  private readonly earthwardDown = new Cartesian3()
  private readonly earthwardDirection = new Cartesian3()
  private readonly earthwardTarget = new Cartesian3()
  private readonly desiredPosition = new Cartesian3()
  private readonly desiredLookTarget = new Cartesian3()
  private readonly normalLookTarget = new Cartesian3()
  private readonly lookAheadOffset = new Cartesian3()
  private readonly rollBlend = new Cartesian3()
  private readonly rollUp = new Cartesian3()
  private readonly currentDirection = new Cartesian3()
  private readonly desiredUp = new Cartesian3()
  private readonly blendedUp = new Cartesian3()
  private readonly finalDirection = new Cartesian3()
  private readonly projectedUp = new Cartesian3()

  readonly state: CameraOrbitState = { yaw: 0, pitch: DEFAULT_CAMERA_PITCH, distance: DEFAULT_CAMERA_DISTANCE_METERS }
  followStrength = 3.6
  orientationFollowStrength = 2.2
  lookAhead = 420
  rollInfluence = 0.1
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
    this.actualLookAhead = null
    this.actualLookTarget = null
    this.followOrientation = orientation.clone()
    this.orbiting = false
    this.cameraDetached = false
    this.cinematicPhase = 0
    this.cinematicHoldSeconds = 0
    this.earthFocusActive = true
    this.entered = true
    this.update(position, orientation, Cartesian3.ZERO, 0)
  }

  exit(): void {
    this.entered = false
    this.actualPosition = null
    this.actualUp = null
    this.actualLookAhead = null
    this.actualLookTarget = null
    this.orbiting = false
    this.cameraDetached = false
    this.cinematicPhase = 0
    this.cinematicHoldSeconds = 0
    this.earthFocusActive = false
  }

  beginOrbit(): void {
    this.orbiting = true
    this.cameraDetached = true
    this.earthFocusActive = false
    this.cinematicHoldSeconds = 12
    this.referenceForward = this.latestForward.clone()
    this.referenceRight = this.latestRight.clone()
    this.referenceUp = this.latestUp.clone()
  }

  endOrbit(): void {
    this.orbiting = false
  }

  orbit(deltaX: number, deltaY: number): void {
    this.earthFocusActive = false
    const next = applyCameraOrbit(this.state, deltaX, deltaY, this.orbitSensitivity)
    this.state.yaw = next.yaw
    this.state.pitch = next.pitch
    this.cinematicHoldSeconds = Math.max(this.cinematicHoldSeconds, 8)
  }

  zoom(deltaY: number): void {
    this.earthFocusActive = false
    this.state.distance = applyCameraZoom(this.state, deltaY).distance
    this.cinematicHoldSeconds = Math.max(this.cinematicHoldSeconds, 8)
  }

  recenter(): void {
    this.state.yaw = 0
    this.state.pitch = DEFAULT_CAMERA_PITCH
    this.state.distance = DEFAULT_CAMERA_DISTANCE_METERS
    this.cameraDetached = false
    this.orbiting = false
    this.earthFocusActive = true
    this.cinematicHoldSeconds = 0
  }

  setPreset(preset: ExplorationCameraPreset): void {
    this.cameraDetached = false
    this.orbiting = false
    this.earthFocusActive = false
    this.cinematicHoldSeconds = 3
    if (preset === 'ASTRONAUT') {
      this.state.distance = 3_400
      this.state.pitch = 0.06
      this.lookAhead = 120
      this.rollInfluence = 0.04
      return
    }
    if (preset === 'ORBIT') {
      this.state.distance = 13_000
      this.state.pitch = 0.22
      this.lookAhead = 360
      this.rollInfluence = 0.08
      return
    }
    this.state.distance = DEFAULT_CAMERA_DISTANCE_METERS
    this.state.pitch = DEFAULT_CAMERA_PITCH
    this.lookAhead = 420
    this.rollInfluence = 0.1
  }

  setCinematicMode(enabled: boolean): void {
    this.cinematicEnabled = enabled
    this.cinematicHoldSeconds = enabled ? 2 : 0
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
    this.cinematicHoldSeconds = Math.max(0, this.cinematicHoldSeconds - dt)
    const cinematicActive = this.cinematicEnabled
      && !this.earthFocusActive
      && !this.orbiting
      && !this.cameraDetached
      && this.cinematicHoldSeconds <= 0
    if (cinematicActive) this.cinematicPhase += dt

    const shipBasis = getShipBasis(orientation)
    const targetFrame = this.targetFrame
    Matrix3.setColumn(targetFrame, 0, shipBasis.forward, targetFrame)
    Matrix3.setColumn(targetFrame, 1, shipBasis.right, targetFrame)
    Matrix3.setColumn(targetFrame, 2, shipBasis.up, targetFrame)
    const targetFollowOrientation = Quaternion.fromRotationMatrix(targetFrame, new Quaternion())
    const orientationSmoothing = 1 - Math.exp(-this.orientationFollowStrength * Math.max(dt, 0.016))
    if (!this.actualPosition) this.followOrientation = targetFollowOrientation
    else Quaternion.slerp(this.followOrientation, targetFollowOrientation, orientationSmoothing, this.followOrientation)
    const followedBasis = getShipBasis(this.followOrientation)
    this.latestForward = followedBasis.forward
    this.latestRight = followedBasis.right
    this.latestUp = followedBasis.up
    const forward = this.cameraDetached ? this.referenceForward : followedBasis.forward
    const right = this.cameraDetached ? this.referenceRight : followedBasis.right
    const shipUp = this.cameraDetached ? this.referenceUp : followedBasis.up

    const cinematicYaw = cinematicActive ? Math.sin(this.cinematicPhase * 0.11) * 0.16 : 0
    const cinematicPitch = cinematicActive ? Math.sin(this.cinematicPhase * 0.071 + 1.7) * 0.025 : 0
    const cinematicDistanceScale = cinematicActive ? 1 + Math.sin(this.cinematicPhase * 0.053 + 0.8) * 0.028 : 1
    const effectiveYaw = this.state.yaw + cinematicYaw
    const effectivePitch = clampCameraPitch(this.state.pitch + cinematicPitch)
    const effectiveDistance = clampCameraDistance(this.state.distance * cinematicDistanceScale)

    const cosPitch = Math.cos(effectivePitch)
    const orbitOffset = this.orbitOffset
    Cartesian3.multiplyByScalar(forward, -Math.cos(effectiveYaw) * cosPitch, this.orbitForward)
    Cartesian3.multiplyByScalar(right, Math.sin(effectiveYaw) * cosPitch, this.orbitRight)
    Cartesian3.multiplyByScalar(shipUp, Math.sin(effectivePitch), this.orbitUp)
    Cartesian3.add(this.orbitForward, this.orbitRight, orbitOffset)
    Cartesian3.add(orbitOffset, this.orbitUp, orbitOffset)
    Cartesian3.normalize(orbitOffset, orbitOffset)

    const desiredPosition = Cartesian3.add(position, Cartesian3.multiplyByScalar(orbitOffset, effectiveDistance, this.lookAheadOffset), this.desiredPosition)
    const speed = Cartesian3.magnitude(velocity)
    const desiredLookAhead = this.lookAhead + Math.min(speed * 0.01, 500)
    const lookAheadSmoothing = 1 - Math.exp(-3.5 * Math.max(dt, 0.016))
    this.actualLookAhead = this.actualLookAhead === null
      ? desiredLookAhead
      : this.actualLookAhead + (desiredLookAhead - this.actualLookAhead) * lookAheadSmoothing

    const earthUp = Ellipsoid.WGS84.geodeticSurfaceNormal(position, this.earthUp)
    const normalLookTarget = this.normalLookTarget
    if (this.cameraDetached) Cartesian3.clone(position, normalLookTarget)
    else {
      Cartesian3.multiplyByScalar(forward, this.actualLookAhead, this.lookAheadOffset)
      Cartesian3.add(position, this.lookAheadOffset, normalLookTarget)
    }

    const desiredLookTarget = this.desiredLookTarget
    if (this.earthFocusActive && !this.cameraDetached) {
      // Persistent default Explore composition: point about 29 degrees below
      // the local horizon. At ordinary LEO heights this keeps roughly 70% of
      // the frame occupied by Earth and about 30% open to the limb/space.
      // It remains locked to this composition while the tracked orbital point
      // moves. Any deliberate orbit/zoom/preset releases the lock; R restores it.
      Cartesian3.multiplyByScalar(forward, 0.88, this.earthwardForward)
      Cartesian3.multiplyByScalar(earthUp, -0.48, this.earthwardDown)
      Cartesian3.add(this.earthwardForward, this.earthwardDown, this.earthwardDirection)
      normalizeOrFallback(this.earthwardDirection, Cartesian3.negate(earthUp, this.earthwardDown), this.earthwardDirection)
      Cartesian3.multiplyByScalar(this.earthwardDirection, 120_000, this.lookAheadOffset)
      Cartesian3.add(position, this.lookAheadOffset, this.earthwardTarget)
      Cartesian3.clone(this.earthwardTarget, desiredLookTarget)
    } else {
      Cartesian3.clone(normalLookTarget, desiredLookTarget)
    }

    const rollUp = this.rollUp
    if (this.cameraDetached) Cartesian3.clone(earthUp, rollUp)
    else {
      Cartesian3.lerp(earthUp, shipUp, this.rollInfluence, this.rollBlend)
      normalizeOrFallback(this.rollBlend, earthUp, rollUp)
    }

    if (!this.actualPosition || !this.actualUp) {
      this.actualPosition = desiredPosition.clone()
      this.actualLookTarget = desiredLookTarget.clone()
      Cartesian3.subtract(this.actualLookTarget, desiredPosition, this.currentDirection)
      const initialDirection = normalizeOrFallback(this.currentDirection, forward, this.finalDirection)
      this.actualUp = stableCameraUp(initialDirection, rollUp, earthUp, new Cartesian3(), this.projectedUp)
    } else {
      const smoothing = 1 - Math.exp(-this.followStrength * Math.max(dt, 0.016))
      this.actualPosition = Cartesian3.lerp(this.actualPosition, desiredPosition, smoothing, this.actualPosition)
      this.actualLookTarget = Cartesian3.lerp(this.actualLookTarget ?? desiredLookTarget, desiredLookTarget, smoothing, this.actualLookTarget ?? new Cartesian3())
      Cartesian3.subtract(this.actualLookTarget, this.actualPosition, this.currentDirection)
      const currentDirection = normalizeOrFallback(this.currentDirection, forward, this.finalDirection)
      const desiredUp = stableCameraUp(currentDirection, rollUp, this.actualUp, this.desiredUp, this.projectedUp)
      const blendedUp = Cartesian3.lerp(this.actualUp, desiredUp, smoothing, this.blendedUp)
      this.actualUp = normalizeOrFallback(blendedUp, desiredUp, this.actualUp)
    }
    Cartesian3.subtract(this.actualLookTarget ?? desiredLookTarget, this.actualPosition, this.currentDirection)
    const direction = normalizeOrFallback(this.currentDirection, forward, this.finalDirection)
    this.viewer.camera.setView({ destination: this.actualPosition, orientation: { direction, up: this.actualUp } })
  }
}
