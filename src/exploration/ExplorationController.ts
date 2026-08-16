import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Ellipsoid,
  Matrix3,
  Quaternion,
  Viewer,
} from 'cesium'
import { createShipState, formatDistanceKm, getShipBasis, integrateShip, LOW_ALTITUDE_WARNING_METERS } from './flightModel'
import { ShipCameraRig } from './ShipCameraRig'
import { ShipVisual } from './ShipVisual'
import { AUTOPILOT_STANDOFF_METERS, computeAutopilotGuidance } from './autopilot'
import { combineAngularInput, resolveKeyboardAngularInput, resolveMouseAngularInput } from './explorationInput'
import type { AutopilotMode, ExplorationCameraMode, ExplorationHudSnapshot, FlightInput, ShipState, TargetIndicatorSnapshot } from './types'

interface ControllerOptions {
  onHudUpdate: (snapshot: ExplorationHudSnapshot) => void
  onExit: () => void
  onOpenNavigation: () => void
  onControlsActivity: () => void
}

const DEFAULT_SPAWN = Cartesian3.fromDegrees(-18, 18, 800_000)
const SPAWN_OFFSET = 50_000
const CAMERA_MODE: ExplorationCameraMode = 'THIRD_PERSON'

export class ExplorationController {
  private readonly viewer: Viewer
  private readonly options: ControllerOptions
  private readonly canvas: HTMLCanvasElement
  private readonly cameraRig: ShipCameraRig
  private readonly shipVisual: ShipVisual
  private state: ShipState | null = null
  private targetPosition: Cartesian3 | null = null
  private targetVelocity = Cartesian3.ZERO.clone()
  private targetName: string | null = null
  private autopilotMode: AutopilotMode = 'OFF'
  private active = false
  private frameHandle = 0
  private lastFrame = 0
  private lastHud = 0
  private readonly keys = new Set<string>()
  private mouseCaptured = false
  private steeringCaptured = false
  private cameraOrbiting = false
  private mouseX = 0
  private mouseY = 0
  private lastPointerX = 0
  private lastPointerY = 0
  private lastMouseDx = 0
  private lastMouseDy = 0
  private steeringSensitivity = 1

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!this.active) return
    if (event.code === 'Escape') {
      event.preventDefault()
      if (this.mouseCaptured || this.steeringCaptured || document.pointerLockElement === this.canvas) this.releaseMouse()
      else this.options.onExit()
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
      this.options.onControlsActivity()
    }
    this.keys.add(event.code)
  }

  private readonly onKeyUp = (event: KeyboardEvent) => { this.keys.delete(event.code) }

  private readonly onMouseDown = (event: MouseEvent) => {
    if (!this.active) return
    if (event.button === 1) {
      event.preventDefault()
      this.cameraOrbiting = true
      this.cameraRig.beginOrbit()
      this.options.onControlsActivity()
      return
    }
    if (event.button === 0 || event.button === 2) {
      this.steeringCaptured = true
      this.lastPointerX = event.clientX
      this.lastPointerY = event.clientY
      this.mouseCaptured = event.button === 0
      if (event.button === 0) this.canvas.requestPointerLock?.()
      this.options.onControlsActivity()
    }
  }

  private readonly onMouseUp = (event: MouseEvent) => {
    if (event.button === 1) {
      this.cameraOrbiting = false
      this.cameraRig.endOrbit()
    }
    if ((event.button === 0 || event.button === 2) && document.pointerLockElement !== this.canvas) {
      this.mouseCaptured = false
      this.steeringCaptured = false
    }
  }

  private readonly onMouseMove = (event: MouseEvent) => {
    if (!this.active) return
    if (this.cameraOrbiting) {
      this.cameraRig.orbit(event.movementX, event.movementY)
      return
    }
    if (!this.steeringCaptured && document.pointerLockElement !== this.canvas) return
    const fallbackDx = event.clientX - this.lastPointerX
    const fallbackDy = event.clientY - this.lastPointerY
    const dx = event.movementX || fallbackDx
    const dy = event.movementY || fallbackDy
    this.mouseX += dx
    this.mouseY += dy
    this.lastPointerX = event.clientX
    this.lastPointerY = event.clientY
  }

  private readonly onWheel = (event: WheelEvent) => {
    if (!this.active) return
    event.preventDefault()
    this.cameraRig.zoom(event.deltaY)
    this.options.onControlsActivity()
  }

  private readonly onPointerLockChange = () => {
    if (document.pointerLockElement !== this.canvas && !this.steeringCaptured) this.mouseCaptured = false
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
  }

  isActive(): boolean { return this.active }

  enter(targetPosition: Cartesian3 | null, targetName: string | null, targetVelocity: Cartesian3 | null = null): void {
    if (this.active) return
    this.active = true
    this.targetPosition = targetPosition?.clone() ?? null
    this.targetVelocity = targetVelocity?.clone() ?? Cartesian3.ZERO.clone()
    this.targetName = targetName
    this.autopilotMode = 'OFF'
    const spawn = this.spawnPosition(targetPosition)
    this.state = createShipState(spawn, this.createTangentOrientation(spawn))
    this.shipVisual.setVisible(true)
    this.bindInput()
    this.cameraRig.enter(this.state.position, this.state.orientation)
    this.lastFrame = performance.now()
    this.lastHud = 0
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
    this.cameraRig.exit()
    if (this.savedCamera) this.viewer.camera.setView({ destination: this.savedCamera.position, orientation: { direction: this.savedCamera.direction, up: this.savedCamera.up } })
    this.viewer.scene.screenSpaceCameraController.enableInputs = this.savedInputs
    this.state = null
    this.targetPosition = null
    this.targetVelocity = Cartesian3.ZERO.clone()
    this.targetName = null
    this.autopilotMode = 'OFF'
  }

  destroy(): void {
    this.exit()
    this.shipVisual.destroy(this.viewer)
  }

  setTarget(position: Cartesian3 | null, name: string | null, velocity: Cartesian3 | null = null): void {
    this.targetPosition = position?.clone() ?? null
    this.targetVelocity = velocity?.clone() ?? Cartesian3.ZERO.clone()
    this.targetName = name
    if (!this.targetPosition) this.autopilotMode = 'OFF'
  }

  engageAutopilot(): void {
    if (this.active && this.targetPosition) this.autopilotMode = 'INTERCEPT'
  }

  cancelAutopilot(): void {
    this.autopilotMode = 'OFF'
  }

  setSteeringSensitivity(value: number): void {
    this.steeringSensitivity = Math.max(0.25, Math.min(2, value))
  }

  setCameraSensitivity(value: number): void {
    this.cameraRig.orbitSensitivity = 0.004 * Math.max(0.25, Math.min(2, value))
  }

  private savedCamera: { position: Cartesian3; direction: Cartesian3; up: Cartesian3 } | null = null
  private savedInputs = true

  private readonly frame = (now: number) => {
    if (!this.active || !this.state) return
    const dt = Math.max(0, Math.min((now - this.lastFrame) / 1000, 0.1))
    this.lastFrame = now
    const input = this.readInput(dt)
    this.state = integrateShip(this.state, input, dt)
    this.shipVisual.update(this.state.position, this.state.orientation, { throttle: this.state.throttle, boost: this.state.boostActive })
    this.cameraRig.update(this.state.position, this.state.orientation, this.state.velocity, dt)
    this.emitHud(now)
    this.frameHandle = requestAnimationFrame(this.frame)
  }

  private readInput(dt: number): FlightInput {
    const mouseDx = this.mouseX
    const mouseDy = this.mouseY
    const angularInput = combineAngularInput(resolveKeyboardAngularInput(this.keys), resolveMouseAngularInput(mouseDx, mouseDy, dt, this.steeringSensitivity))
    this.lastMouseDx = mouseDx
    this.lastMouseDy = mouseDy
    this.mouseX = 0
    this.mouseY = 0
    const manualInput: FlightInput = {
      throttleDelta: (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0),
      strafe: (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0),
      vertical: (this.keys.has('Space') ? 1 : 0) - (this.keys.has('ControlLeft') || this.keys.has('ControlRight') ? 1 : 0),
      yawRate: angularInput.yawRate,
      pitchRate: angularInput.pitchRate,
      rollInput: angularInput.rollInput,
      boost: this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'),
      brake: this.keys.has('KeyX'),
    }
    const manualOverride = Math.abs(mouseDx) > 1 || Math.abs(mouseDy) > 1 || ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'Space', 'ControlLeft', 'ControlRight', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight', 'KeyX'].some((key) => this.keys.has(key))
    if (this.autopilotMode === 'OFF' || !this.targetPosition || manualOverride) {
      if (manualOverride) this.autopilotMode = 'OFF'
      return manualInput
    }

    this.updateAutopilotMode()
    const guidance = computeAutopilotGuidance(this.state!, this.targetPosition, this.targetVelocity, this.autopilotMode)
    return { ...manualInput, ...guidance.input, strafe: 0, vertical: 0 }
  }

  private updateAutopilotMode(): void {
    if (!this.state || !this.targetPosition || this.autopilotMode === 'OFF') return
    const distance = Cartesian3.distance(this.state.position, this.targetPosition)
    const relativeSpeed = Cartesian3.magnitude(Cartesian3.subtract(this.state.velocity, this.targetVelocity, new Cartesian3()))
    if (this.autopilotMode === 'INTERCEPT' && distance <= 80_000) this.autopilotMode = 'APPROACH'
    else if (this.autopilotMode === 'APPROACH' && distance <= AUTOPILOT_STANDOFF_METERS * 1.25 && relativeSpeed < 350) this.autopilotMode = 'HOLD'
    else if (this.autopilotMode === 'HOLD' && distance > 30_000) this.autopilotMode = 'APPROACH'
  }

  private emitHud(now: number): void {
    if (!this.state || now - this.lastHud < 100 && now !== this.lastFrame) return
    this.lastHud = now
    const cartographic = Cartographic.fromCartesian(this.state.position)
    const targetDistanceKm = this.targetPosition ? Cartesian3.distance(this.state.position, this.targetPosition) / 1000 : null
    const basis = getShipBasis(this.state.orientation)
    const relativeSpeedKmS = this.targetPosition ? Cartesian3.magnitude(Cartesian3.subtract(this.state.velocity, this.targetVelocity, new Cartesian3())) / 1000 : null
    const guidance = this.targetPosition && this.autopilotMode !== 'OFF' ? computeAutopilotGuidance(this.state, this.targetPosition, this.targetVelocity, this.autopilotMode) : null
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
      autopilot: {
        mode: this.autopilotMode,
        targetName: this.targetName,
        distanceKm: targetDistanceKm,
        relativeSpeedKmS,
        etaSeconds: guidance?.etaSeconds ?? null,
      },
      debugFlight: {
        mouseDx: this.lastMouseDx,
        mouseDy: this.lastMouseDy,
        yawRate: this.state.angularVelocity.y,
        pitchRate: this.state.angularVelocity.x,
        rollRate: this.state.angularVelocity.z,
        throttle: this.state.throttle,
        velocity: this.state.velocity.clone(),
        forward: basis.forward,
        orientation: this.state.orientation.clone(),
        pointerLock: document.pointerLockElement === this.canvas,
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
    if (!target) return DEFAULT_SPAWN.clone()
    const radial = Cartesian3.normalize(target, new Cartesian3())
    const targetRadius = Cartesian3.magnitude(target)
    const safeRadius = Math.max(targetRadius + SPAWN_OFFSET, Ellipsoid.WGS84.maximumRadius + 150_000)
    return Cartesian3.multiplyByScalar(radial, safeRadius, new Cartesian3())
  }

  private createTangentOrientation(position: Cartesian3): Quaternion {
    const up = Ellipsoid.WGS84.geodeticSurfaceNormal(position, new Cartesian3())
    const forward = Cartesian3.normalize(Cartesian3.cross(Cartesian3.UNIT_Z, up, new Cartesian3()), new Cartesian3())
    const right = Cartesian3.normalize(Cartesian3.cross(up, forward, new Cartesian3()), new Cartesian3())
    const basis = new Matrix3()
    Matrix3.setColumn(basis, 0, forward, basis)
    Matrix3.setColumn(basis, 1, right, basis)
    Matrix3.setColumn(basis, 2, up, basis)
    return Quaternion.fromRotationMatrix(basis, new Quaternion())
  }

  private bindInput(): void {
    this.savedCamera = { position: this.viewer.camera.position.clone(), direction: this.viewer.camera.direction.clone(), up: this.viewer.camera.up.clone() }
    this.savedInputs = this.viewer.scene.screenSpaceCameraController.enableInputs
    this.viewer.scene.screenSpaceCameraController.enableInputs = false
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('mousemove', this.onMouseMove)
    window.addEventListener('mouseup', this.onMouseUp)
    window.addEventListener('pointerlockchange', this.onPointerLockChange)
    this.canvas.addEventListener('mousedown', this.onMouseDown)
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false })
    this.canvas.addEventListener('contextmenu', this.onContextMenu)
  }

  private unbindInput(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('mousemove', this.onMouseMove)
    window.removeEventListener('mouseup', this.onMouseUp)
    window.removeEventListener('pointerlockchange', this.onPointerLockChange)
    this.canvas.removeEventListener('mousedown', this.onMouseDown)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('contextmenu', this.onContextMenu)
    this.keys.clear()
    this.steeringCaptured = false
    this.cameraOrbiting = false
    this.cameraRig.endOrbit()
  }

  private releaseMouse(): void {
    this.mouseCaptured = false
    this.steeringCaptured = false
    if (document.pointerLockElement === this.canvas) document.exitPointerLock?.()
  }
}

export { formatDistanceKm }
export type { ExplorationHudSnapshot }
