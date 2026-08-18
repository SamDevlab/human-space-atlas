import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Ellipsoid,
  Matrix3,
  Quaternion,
  Viewer,
} from 'cesium'
import { createShipState, formatDistanceKm, getShipBasis, LOW_ALTITUDE_WARNING_METERS } from './flightModel'
import { ShipCameraRig } from './ShipCameraRig'
import { ShipVisual } from './ShipVisual'
import { ExploreCloudSystem } from './ExploreCloudSystem'
import { AuroraSystem } from './AuroraSystem'
import { NightSideSystem } from './NightSideSystem'
import { computeOrbitalLighting } from './OrbitalLighting'
import type { ExplorationCameraMode, ExplorationCameraPreset, ExplorationHudSnapshot, ShipState, TargetIndicatorSnapshot } from './types'

interface ControllerOptions {
  onHudUpdate: (snapshot: ExplorationHudSnapshot) => void
  onExit: () => void
  onOpenNavigation: () => void
  onControlsActivity: () => void
}

const DEFAULT_SPAWN = Cartesian3.fromDegrees(-18, 18, 800_000)
const DEFAULT_CRUISE_THROTTLE = 0.18
const DEFAULT_CRUISE_SPEED = 260
const CAMERA_MODE: ExplorationCameraMode = 'THIRD_PERSON'
// The catalog updates its propagated state periodically. The presentation
// envelope bridges those samples so following a satellite never looks like a
// teleport, while the followed object's position/velocity remain authoritative.
const PRESENTATION_POSITION_FOLLOW = 16
const PRESENTATION_ORIENTATION_FOLLOW = 12
const TARGET_SAMPLE_MAX_AGE_SECONDS = 0.75
const CLOUD_SETTINGS_POLL_MS = 750
const CINEMATIC_LIGHTING_POLL_MS = 120

export class ExplorationController {
  private readonly viewer: Viewer
  private readonly options: ControllerOptions
  private readonly canvas: HTMLCanvasElement
  private readonly cameraRig: ShipCameraRig
  private readonly shipVisual: ShipVisual
  private readonly exploreCloudSystem: ExploreCloudSystem
  private readonly auroraSystem: AuroraSystem
  private readonly nightSideSystem: NightSideSystem
  private state: ShipState | null = null
  private targetPosition: Cartesian3 | null = null
  private targetPositionGoal: Cartesian3 | null = null
  private targetVelocity = Cartesian3.ZERO.clone()
  private targetVelocityGoal = Cartesian3.ZERO.clone()
  private targetName: string | null = null
  private active = false
  private frameHandle = 0
  private lastFrame = 0
  private lastHud = 0
  private cameraOrbiting = false
  private lastMouseX = 0
  private lastMouseY = 0
  private presentationPosition: Cartesian3 | null = null
  private presentationOrientation: Quaternion | null = null
  private targetSampleAt = 0
  private exploreCloudsRunning = false
  private lastCloudSettingsCheck = 0
  private lastLightingUpdate = 0

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!this.active) return
    if (event.code === 'Escape') {
      event.preventDefault()
      this.options.onExit()
      return
    }
    if (event.code === 'KeyR' && !event.repeat) {
      event.preventDefault()
      this.cameraRig.recenter()
      this.options.onControlsActivity()
      return
    }
    if (event.code === 'KeyF' && !event.repeat) {
      event.preventDefault()
      this.releaseMouse()
      this.options.onOpenNavigation()
      return
    }
    if (['Space', 'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyX', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.code)) {
      event.preventDefault()
      return
    }
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    if (!this.active) return
    // In Explore, pressing and dragging either primary or middle mouse is
    // dedicated to orbiting the camera around the spacecraft.
    if (event.button === 0 || event.button === 1) {
      event.preventDefault()
      this.cameraOrbiting = true
      this.lastMouseX = event.clientX
      this.lastMouseY = event.clientY
      this.canvas.setPointerCapture?.(event.pointerId)
      this.cameraRig.beginOrbit()
      this.options.onControlsActivity()
      return
    }
  }

  private readonly onPointerUp = (event: PointerEvent) => {
    if (this.cameraOrbiting) {
      this.cameraOrbiting = false
      this.lastMouseX = event.clientX
      this.lastMouseY = event.clientY
      this.cameraRig.endOrbit()
      if (this.canvas.hasPointerCapture?.(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId)
    }
  }

  private readonly onPointerMove = (event: PointerEvent) => {
    if (!this.active) return
    if (this.cameraOrbiting) {
      const deltaX = event.movementX || event.clientX - this.lastMouseX
      const deltaY = event.movementY || event.clientY - this.lastMouseY
      this.lastMouseX = event.clientX
      this.lastMouseY = event.clientY
      this.cameraRig.orbit(deltaX, deltaY)
      return
    }
  }

  private readonly onWheel = (event: WheelEvent) => {
    if (!this.active) return
    event.preventDefault()
    this.cameraRig.zoom(event.deltaY)
    this.options.onControlsActivity()
  }

  private readonly onContextMenu = (event: MouseEvent) => {
    if (this.active) event.preventDefault()
  }

  constructor(viewer: Viewer, options: ControllerOptions) {
    this.viewer = viewer
    this.options = options
    this.canvas = viewer.scene.canvas
    this.cameraRig = new ShipCameraRig(viewer)
    this.shipVisual = new ShipVisual(viewer)
    this.exploreCloudSystem = new ExploreCloudSystem(viewer)
    this.auroraSystem = new AuroraSystem(viewer)
    this.nightSideSystem = new NightSideSystem(viewer)
  }

  isActive(): boolean { return this.active }

  enter(targetPosition: Cartesian3 | null, targetName: string | null, targetVelocity: Cartesian3 | null = null): void {
    if (this.active) return
    this.active = true
    this.targetPosition = targetPosition?.clone() ?? null
    this.targetPositionGoal = targetPosition?.clone() ?? null
    this.targetVelocity = targetVelocity?.clone() ?? Cartesian3.ZERO.clone()
    this.targetVelocityGoal = this.targetVelocity.clone()
    this.targetSampleAt = performance.now()
    this.targetName = targetName
    const spawn = this.spawnPosition(targetPosition)
    const initialState = createShipState(spawn, this.createFollowOrientation(spawn, this.targetVelocity))
    const initialForward = getShipBasis(initialState.orientation).forward
    const followingTarget = Boolean(targetPosition)
    const orbitalVelocity = followingTarget
      ? this.targetVelocity.clone()
      : Cartesian3.multiplyByScalar(initialForward, DEFAULT_CRUISE_SPEED, new Cartesian3())
    this.state = {
      ...initialState,
      throttle: followingTarget ? 0 : DEFAULT_CRUISE_THROTTLE,
      velocity: orbitalVelocity,
    }
    this.presentationPosition = null
    this.presentationOrientation = null
    this.shipVisual.setVisible(true)
    this.bindInput()
    this.cameraRig.enter(this.state.position, this.state.orientation)
    this.lastFrame = performance.now()
    this.lastHud = 0
    this.lastCloudSettingsCheck = 0
    this.lastLightingUpdate = 0
    this.syncExploreCloudSettings(true)
    this.auroraSystem.start()
    this.nightSideSystem.start()
    this.updateCinematicLighting(performance.now(), true)
    this.frameHandle = requestAnimationFrame(this.frame)
    this.emitHud(performance.now())
  }

  exit(): void {
    if (!this.active) return
    this.active = false
    cancelAnimationFrame(this.frameHandle)
    this.unbindInput()
    this.releaseMouse()
    this.shipVisual.setVisible(false)
    this.exploreCloudSystem.stop()
    this.exploreCloudsRunning = false
    this.auroraSystem.stop()
    this.nightSideSystem.stop()
    this.resetCinematicLighting()
    this.cameraRig.exit()
    if (this.savedCamera) this.viewer.camera.setView({ destination: this.savedCamera.position, orientation: { direction: this.savedCamera.direction, up: this.savedCamera.up } })
    this.viewer.scene.screenSpaceCameraController.enableInputs = this.savedInputs
    this.state = null
    this.targetPosition = null
    this.targetPositionGoal = null
    this.targetVelocity = Cartesian3.ZERO.clone()
    this.targetVelocityGoal = Cartesian3.ZERO.clone()
    this.targetName = null
    this.presentationPosition = null
    this.presentationOrientation = null
    this.targetSampleAt = 0
  }

  destroy(): void {
    this.exit()
    this.nightSideSystem.destroy()
    this.auroraSystem.destroy()
    this.exploreCloudSystem.destroy()
    this.shipVisual.destroy(this.viewer)
  }

  setTarget(position: Cartesian3 | null, name: string | null, velocity: Cartesian3 | null = null): void {
    const nextPosition = position?.clone() ?? null
    const targetChanged = this.targetName !== name
    const nextVelocity = velocity?.clone() ?? Cartesian3.ZERO.clone()
    this.targetPositionGoal = nextPosition
    this.targetPosition = nextPosition?.clone() ?? null
    this.targetVelocityGoal = nextVelocity
    this.targetVelocity = nextVelocity.clone()
    this.targetSampleAt = performance.now()
    this.targetName = name
    if (this.state && nextPosition && targetChanged) {
      this.state.position = nextPosition.clone()
      this.state.velocity = nextVelocity.clone()
      this.state.throttle = 0
      this.state.orientation = this.createFollowOrientation(nextPosition, nextVelocity)
      this.presentationPosition = nextPosition.clone()
      this.presentationOrientation = this.state.orientation.clone()
      this.cameraRig.enter(this.state.position, this.state.orientation)
    } else if (this.state && !nextPosition) {
      this.state.velocity = Cartesian3.ZERO.clone()
      this.state.throttle = 0
    }
  }

  setCameraSensitivity(value: number): void {
    this.cameraRig.orbitSensitivity = 0.004 * Math.max(0.25, Math.min(2, value))
  }

  setCameraPreset(preset: ExplorationCameraPreset): void {
    this.cameraRig.setPreset(preset)
  }

  private savedCamera: { position: Cartesian3; direction: Cartesian3; up: Cartesian3 } | null = null
  private savedInputs = true

  private readonly frame = (now: number) => {
    if (!this.active || !this.state) return
    const frameDelta = Math.max(0, Math.min((now - this.lastFrame) / 1000, 0.1))
    this.lastFrame = now
    this.syncToTarget(now)
    if (now - this.lastCloudSettingsCheck >= CLOUD_SETTINGS_POLL_MS) {
      this.lastCloudSettingsCheck = now
      this.syncExploreCloudSettings(false)
    }
    this.updateCinematicLighting(now)
    const interpolatedPosition = this.state.position
    const interpolatedOrientation = this.state.orientation
    const presentationSmoothing = 1 - Math.exp(-PRESENTATION_POSITION_FOLLOW * Math.max(frameDelta, 1 / 120))
    const orientationSmoothing = 1 - Math.exp(-PRESENTATION_ORIENTATION_FOLLOW * Math.max(frameDelta, 1 / 120))
    if (!this.presentationPosition || !this.presentationOrientation) {
      this.presentationPosition = interpolatedPosition.clone()
      this.presentationOrientation = interpolatedOrientation.clone()
    } else {
      Cartesian3.lerp(this.presentationPosition, interpolatedPosition, presentationSmoothing, this.presentationPosition)
      Quaternion.slerp(this.presentationOrientation, interpolatedOrientation, orientationSmoothing, this.presentationOrientation)
    }
    this.shipVisual.update(this.presentationPosition, this.presentationOrientation, { throttle: this.state.throttle, boost: this.state.boostActive })
    this.cameraRig.update(this.presentationPosition, this.presentationOrientation, this.state.velocity, frameDelta)
    this.emitHud(now)
    this.frameHandle = requestAnimationFrame(this.frame)
  }

  private syncExploreCloudSettings(forceStart: boolean): void {
    if (!this.active) return
    const enabled = localStorage.getItem('human-space-atlas.clouds-enabled') !== '0'
    const shadowsEnabled = localStorage.getItem('human-space-atlas.cloud-shadows-enabled') !== '0'
    const savedOpacity = Number(localStorage.getItem('human-space-atlas.cloud-opacity-v3'))
    const opacity = Number.isFinite(savedOpacity) ? Math.min(1, Math.max(0, savedOpacity)) : 0.75

    if (!enabled) {
      if (this.exploreCloudsRunning) this.exploreCloudSystem.stop()
      this.exploreCloudsRunning = false
      return
    }

    if (!this.exploreCloudsRunning || forceStart) {
      this.exploreCloudsRunning = true
      void this.exploreCloudSystem.start(opacity, shadowsEnabled).catch((error) => {
        this.exploreCloudsRunning = false
        console.warn('[Human Space Atlas] NASA Explore cloud field unavailable', error)
      })
      return
    }

    this.exploreCloudSystem.setOpacity(opacity)
    this.exploreCloudSystem.setShadowsEnabled(shadowsEnabled)
  }

  private updateCinematicLighting(now: number, force = false): void {
    if (!this.state || this.viewer.isDestroyed()) return
    if (!force && now - this.lastLightingUpdate < CINEMATIC_LIGHTING_POLL_MS) return
    this.lastLightingUpdate = now

    const lighting = computeOrbitalLighting(this.viewer.clock.currentTime, this.state.position)
    const sunlight = Math.max(0, Math.min(1, lighting.sunlight))
    const eclipse = 1 - sunlight
    const twilight = Math.exp(-Math.pow((sunlight - 0.5) / 0.2, 2))

    const skyAtmosphere = this.viewer.scene.skyAtmosphere
    if (skyAtmosphere) {
      skyAtmosphere.atmosphereLightIntensity = 66 + twilight * 58 - eclipse * 22
      skyAtmosphere.brightnessShift = 0.02 + twilight * 0.12 - eclipse * 0.035
      skyAtmosphere.saturationShift = 0.1 + twilight * 0.2 - eclipse * 0.06
    }
    const globe = this.viewer.scene.globe
    globe.atmosphereLightIntensity = 18 + twilight * 14 - eclipse * 5
    globe.atmosphereBrightnessShift = 0.025 + twilight * 0.075 - eclipse * 0.01
    globe.atmosphereSaturationShift = 0.1 + twilight * 0.12 - eclipse * 0.035
    globe.lambertDiffuseMultiplier = 1.08 - eclipse * 0.22 + twilight * 0.08
    if (this.viewer.scene.sun) this.viewer.scene.sun.glowFactor = 1.25 + twilight * 2.1
    if (this.viewer.shadowMap) this.viewer.shadowMap.darkness = 0.28 + eclipse * 0.18

    this.nightSideSystem.update(this.state.position, now)
    this.viewer.scene.requestRender()
  }

  private resetCinematicLighting(): void {
    if (this.viewer.isDestroyed()) return
    const skyAtmosphere = this.viewer.scene.skyAtmosphere
    if (skyAtmosphere) {
      skyAtmosphere.atmosphereLightIntensity = 72
      skyAtmosphere.brightnessShift = 0.035
      skyAtmosphere.saturationShift = 0.12
    }
    const globe = this.viewer.scene.globe
    globe.atmosphereLightIntensity = 20
    globe.atmosphereBrightnessShift = 0.035
    globe.atmosphereSaturationShift = 0.12
    globe.lambertDiffuseMultiplier = 1.12
    if (this.viewer.scene.sun) this.viewer.scene.sun.glowFactor = 1.35
    if (this.viewer.shadowMap) this.viewer.shadowMap.darkness = 0.3
  }

  private syncToTarget(now: number): void {
    if (!this.state || !this.targetPositionGoal) return
    // Explore is a synchronized observation mode: the probe does not fly to
    // the object or orbit a point near it. The catalog is sampled every few
    // hundred milliseconds, so advance between samples using the propagated
    // velocity instead of holding one point and then stepping to the next.
    // This keeps both the probe and the camera continuous at render-frame rate.
    const sampleAge = this.targetSampleAt > 0
      ? Math.max(0, Math.min(TARGET_SAMPLE_MAX_AGE_SECONDS, (now - this.targetSampleAt) / 1000))
      : 0
    const predictedOffset = Cartesian3.multiplyByScalar(this.targetVelocityGoal, sampleAge, new Cartesian3())
    this.state.position = Cartesian3.add(this.targetPositionGoal, predictedOffset, new Cartesian3())
    this.state.velocity = this.targetVelocityGoal.clone()
    this.state.throttle = 0
    this.state.orientation = this.createFollowOrientation(this.state.position, this.state.velocity)
  }

  private emitHud(now: number): void {
    if (!this.state || now - this.lastHud < 100 && now !== this.lastFrame) return
    this.lastHud = now
    const cartographic = Cartographic.fromCartesian(this.state.position)
    const targetDistanceKm = this.targetPosition ? Cartesian3.distance(this.state.position, this.targetPosition) / 1000 : null
    const basis = getShipBasis(this.state.orientation)
    this.options.onHudUpdate({
      altitudeKm: cartographic?.height ? Math.max(0, cartographic.height / 1000) : 0,
      speedKmS: Cartesian3.magnitude(this.state.velocity) / 1000,
      throttle: this.state.throttle,
      cameraMode: CAMERA_MODE,
      cameraDistanceMeters: this.cameraRig.getDistance(),
      cameraOrbiting: this.cameraRig.isOrbiting(),
      flightAssist: this.state.flightAssist,
      boostActive: this.state.boostActive,
      lowAltitude: Boolean(cartographic && cartographic.height < LOW_ALTITUDE_WARNING_METERS),
      targetName: this.targetName,
      targetDistanceKm,
      targetIndicator: this.targetPosition ? this.getTargetIndicator(this.targetPosition) : null,
      debugFlight: {
        mouseDx: 0,
        mouseDy: 0,
        yawRate: this.state.angularVelocity.y,
        pitchRate: this.state.angularVelocity.x,
        rollRate: this.state.angularVelocity.z,
        throttle: this.state.throttle,
        velocity: this.state.velocity.clone(),
        forward: basis.forward,
        orientation: this.state.orientation.clone(),
        pointerLock: false,
      },
    })
  }

  private getTargetIndicator(target: Cartesian3): TargetIndicatorSnapshot {
    const width = this.canvas.clientWidth || this.canvas.width
    const height = this.canvas.clientHeight || this.canvas.height
    const centerX = width / 2
    const centerY = height / 2
    const projected = this.viewer.scene.cartesianToCanvasCoordinates(target, new Cartesian2())
    const margin = 78
    if (projected && projected.x >= margin && projected.x <= width - margin && projected.y >= margin && projected.y <= height - margin) {
      return { x: projected.x, y: projected.y, angle: 0, edge: false }
    }
    let dx = (projected?.x ?? centerX + this.viewer.camera.right.x * 100) - centerX
    let dy = (projected?.y ?? centerY - this.viewer.camera.up.y * 100) - centerY
    if (Math.abs(dx) + Math.abs(dy) < 1) { dx = 1; dy = 0 }
    const edgeRadiusX = Math.max(40, (width - margin * 2) / 2)
    const edgeRadiusY = Math.max(40, (height - margin * 2) / 2)
    const scale = Math.min(edgeRadiusX / Math.abs(dx), edgeRadiusY / Math.abs(dy || 0.0001))
    return { x: centerX + dx * scale, y: centerY + dy * scale, angle: Math.atan2(dy, dx), edge: true }
  }

  private spawnPosition(target: Cartesian3 | null): Cartesian3 {
    return target?.clone() ?? DEFAULT_SPAWN.clone()
  }

  private createFollowOrientation(position: Cartesian3, velocity: Cartesian3): Quaternion {
    const up = Ellipsoid.WGS84.geodeticSurfaceNormal(position, new Cartesian3())
    const radialVelocity = Cartesian3.multiplyByScalar(up, Cartesian3.dot(velocity, up), new Cartesian3())
    const tangentialVelocity = Cartesian3.subtract(velocity, radialVelocity, new Cartesian3())
    const fallbackForward = Cartesian3.cross(Cartesian3.UNIT_Z, up, new Cartesian3())
    const forward = Cartesian3.magnitude(tangentialVelocity) > 0.001
      ? Cartesian3.normalize(tangentialVelocity, new Cartesian3())
      : this.createTangentForward(fallbackForward)
    let right = Cartesian3.cross(up, forward, new Cartesian3())
    if (Cartesian3.magnitude(right) < 0.001) right = Cartesian3.cross(up, Cartesian3.UNIT_X, new Cartesian3())
    Cartesian3.normalize(right, right)
    const correctedUp = Cartesian3.normalize(Cartesian3.cross(forward, right, new Cartesian3()), new Cartesian3())
    const basis = new Matrix3()
    Matrix3.setColumn(basis, 0, forward, basis)
    Matrix3.setColumn(basis, 1, right, basis)
    Matrix3.setColumn(basis, 2, correctedUp, basis)
    return Quaternion.fromRotationMatrix(basis, new Quaternion())
  }

  private createTangentForward(vector: Cartesian3): Cartesian3 {
    if (Cartesian3.magnitude(vector) > 0.001) return Cartesian3.normalize(vector, new Cartesian3())
    return Cartesian3.UNIT_X.clone()
  }

  private bindInput(): void {
    this.savedCamera = { position: this.viewer.camera.position.clone(), direction: this.viewer.camera.direction.clone(), up: this.viewer.camera.up.clone() }
    this.savedInputs = this.viewer.scene.screenSpaceCameraController.enableInputs
    this.viewer.scene.screenSpaceCameraController.enableInputs = false
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('pointercancel', this.onPointerUp)
    this.canvas.addEventListener('pointerdown', this.onPointerDown)
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false })
    this.canvas.addEventListener('contextmenu', this.onContextMenu)
  }

  private unbindInput(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('pointercancel', this.onPointerUp)
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('contextmenu', this.onContextMenu)
    this.cameraOrbiting = false
    this.cameraRig.endOrbit()
  }

  private releaseMouse(): void {
    this.cameraOrbiting = false
    this.cameraRig.endOrbit()
    if (document.pointerLockElement === this.canvas) document.exitPointerLock?.()
  }
}

export { formatDistanceKm }
export type { ExplorationHudSnapshot }
