import {
  Cartesian3,
  Cartographic,
  Color,
  Ellipsoid,
  Matrix3,
  PointPrimitiveCollection,
  Quaternion,
  Viewer,
} from 'cesium'
import { createShipState, integrateShip } from './flightModel'
import type { ExplorationCameraMode, ExplorationHudSnapshot, FlightInput, ShipState } from './types'

interface ControllerOptions {
  onHudUpdate: (snapshot: ExplorationHudSnapshot) => void
  onExit: () => void
}

const DEFAULT_SPAWN = Cartesian3.fromDegrees(-18, 18, 800_000)
const SPAWN_OFFSET = 50_000
const CHASE_DISTANCE = 450_000
const CHASE_HEIGHT = 130_000

export class ExplorationController {
  private readonly viewer: Viewer
  private readonly options: ControllerOptions
  private readonly canvas: HTMLCanvasElement
  private readonly points: PointPrimitiveCollection
  private readonly shipPoint
  private state: ShipState | null = null
  private targetPosition: Cartesian3 | null = null
  private targetName: string | null = null
  private cameraMode: ExplorationCameraMode = 'COCKPIT'
  private active = false
  private frameHandle = 0
  private lastFrame = 0
  private lastHud = 0
  private readonly keys = new Set<string>()
  private mouseCaptured = false
  private mouseX = 0
  private mouseY = 0
  private earthFacing = true
  private savedCamera: { position: Cartesian3; direction: Cartesian3; up: Cartesian3 } | null = null
  private savedInputs = true

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!this.active) return
    if (['Space', 'Control', 'Shift', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyX'].includes(event.code)) event.preventDefault()
    if (event.code === 'KeyC' && !event.repeat) { this.cameraMode = this.cameraMode === 'COCKPIT' ? 'CHASE' : 'COCKPIT'; return }
    if (event.code === 'Escape') { this.releaseMouse(); return }
    this.earthFacing = false
    this.keys.add(event.code)
  }

  private readonly onKeyUp = (event: KeyboardEvent) => { this.keys.delete(event.code) }

  private readonly onMouseDown = () => {
    if (!this.active) return
    this.mouseCaptured = true
    this.canvas.requestPointerLock?.()
  }

  private readonly onMouseUp = () => { if (document.pointerLockElement !== this.canvas) this.mouseCaptured = false }

  private readonly onMouseMove = (event: MouseEvent) => {
    if (!this.active || (!this.mouseCaptured && document.pointerLockElement !== this.canvas)) return
    this.mouseX += event.movementX
    this.mouseY += event.movementY
    if (event.movementX !== 0 || event.movementY !== 0) this.earthFacing = false
  }

  constructor(viewer: Viewer, options: ControllerOptions) {
    this.viewer = viewer
    this.options = options
    this.canvas = viewer.scene.canvas
    this.points = viewer.scene.primitives.add(new PointPrimitiveCollection())
    this.shipPoint = this.points.add({ position: DEFAULT_SPAWN, pixelSize: 12, color: Color.ORANGE, outlineColor: Color.WHITE, outlineWidth: 2, show: false })
  }

  isActive(): boolean { return this.active }

  enter(targetPosition: Cartesian3 | null, targetName: string | null): void {
    if (this.active) return
    this.active = true
    this.targetPosition = targetPosition?.clone() ?? null
    this.targetName = targetName
    this.cameraMode = 'COCKPIT'
    this.earthFacing = true
    this.savedCamera = { position: this.viewer.camera.position.clone(), direction: this.viewer.camera.direction.clone(), up: this.viewer.camera.up.clone() }
    this.savedInputs = this.viewer.scene.screenSpaceCameraController.enableInputs
    this.viewer.scene.screenSpaceCameraController.enableInputs = false
    const spawn = this.spawnPosition(targetPosition)
    const orientation = this.createEarthFacingOrientation(spawn)
    this.state = createShipState(spawn, orientation)
    this.shipPoint.show = false
    this.bindInput()
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
    this.shipPoint.show = false
    if (this.savedCamera) this.viewer.camera.setView({ destination: this.savedCamera.position, orientation: { direction: this.savedCamera.direction, up: this.savedCamera.up } })
    this.viewer.scene.screenSpaceCameraController.enableInputs = this.savedInputs
    this.state = null
    this.targetPosition = null
    this.targetName = null
  }

  destroy(): void {
    this.exit()
    this.viewer.scene.primitives.remove(this.points)
  }

  setTarget(position: Cartesian3 | null, name: string | null): void {
    this.targetPosition = position?.clone() ?? null
    this.targetName = name
  }

  private readonly frame = (now: number) => {
    if (!this.active || !this.state) return
    const dt = Math.max(0, Math.min((now - this.lastFrame) / 1000, 0.1))
    this.lastFrame = now
    const input = this.readInput(dt)
    this.state = integrateShip(this.state, input, dt)
    this.shipPoint.position = this.state.position
    this.shipPoint.show = this.cameraMode === 'CHASE'
    this.updateCamera()
    this.emitHud(now)
    this.frameHandle = requestAnimationFrame(this.frame)
  }

  private readInput(dt: number): FlightInput {
    const yawRate = this.mouseX * 0.002 / Math.max(dt, 0.016)
    const pitchRate = -this.mouseY * 0.002 / Math.max(dt, 0.016)
    this.mouseX = 0
    this.mouseY = 0
    return {
      forward: (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0),
      strafe: (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0),
      vertical: (this.keys.has('Space') ? 1 : 0) - (this.keys.has('ControlLeft') || this.keys.has('ControlRight') ? 1 : 0),
      yawRate,
      pitchRate,
      rollRate: (this.keys.has('KeyE') ? 1 : 0) - (this.keys.has('KeyQ') ? 1 : 0),
      boost: this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'),
      brake: this.keys.has('KeyX'),
    }
  }

  private updateCamera(): void {
    if (!this.state) return
    if (this.earthFacing) {
      const earthDirection = Cartesian3.normalize(Cartesian3.negate(this.state.position, new Cartesian3()), new Cartesian3())
      const right = Cartesian3.normalize(Cartesian3.cross(earthDirection, Cartesian3.UNIT_Z, new Cartesian3()), new Cartesian3())
      const earthUp = Cartesian3.normalize(Cartesian3.cross(right, earthDirection, new Cartesian3()), new Cartesian3())
      if (this.cameraMode === 'COCKPIT') {
        this.viewer.camera.setView({ destination: this.state.position, orientation: { direction: earthDirection, up: earthUp } })
      } else {
        const radial = Cartesian3.normalize(this.state.position, new Cartesian3())
        const chasePosition = Cartesian3.add(this.state.position, Cartesian3.multiplyByScalar(radial, CHASE_DISTANCE, new Cartesian3()), new Cartesian3())
        this.viewer.camera.setView({ destination: chasePosition, orientation: { direction: Cartesian3.normalize(Cartesian3.negate(chasePosition, new Cartesian3()), new Cartesian3()), up: earthUp } })
      }
      return
    }
    const rotation = Matrix3.fromQuaternion(this.state.orientation, new Matrix3())
    const forward = Matrix3.multiplyByVector(rotation, Cartesian3.UNIT_X, new Cartesian3())
    const up = Matrix3.multiplyByVector(rotation, Cartesian3.UNIT_Z, new Cartesian3())
    if (this.cameraMode === 'COCKPIT') {
      this.viewer.camera.setView({ destination: this.state.position, orientation: { direction: forward, up } })
      return
    }
    const chasePosition = Cartesian3.add(this.state.position, Cartesian3.multiplyByScalar(forward, -CHASE_DISTANCE, new Cartesian3()), new Cartesian3())
    Cartesian3.add(chasePosition, Cartesian3.multiplyByScalar(up, CHASE_HEIGHT, new Cartesian3()), chasePosition)
    const direction = Cartesian3.normalize(Cartesian3.subtract(this.state.position, chasePosition, new Cartesian3()), new Cartesian3())
    this.viewer.camera.setView({ destination: chasePosition, orientation: { direction, up } })
  }

  private emitHud(now: number): void {
    if (!this.state || now - this.lastHud < 100 && now !== this.lastFrame) return
    this.lastHud = now
    const cartographic = Cartographic.fromCartesian(this.state.position)
    const targetDistanceKm = this.targetPosition ? Cartesian3.distance(this.state.position, this.targetPosition) / 1000 : null
    this.options.onHudUpdate({ altitudeKm: cartographic?.height ? Math.max(0, cartographic.height / 1000) : 0, speedKmS: Cartesian3.magnitude(this.state.velocity) / 1000, cameraMode: this.cameraMode, flightAssist: this.state.flightAssist, targetName: this.targetName, targetDistanceKm })
  }

  private spawnPosition(target: Cartesian3 | null): Cartesian3 {
    if (!target) return DEFAULT_SPAWN.clone()
    const radial = Cartesian3.normalize(target, new Cartesian3())
    const targetRadius = Cartesian3.magnitude(target)
    const safeRadius = Math.max(targetRadius + SPAWN_OFFSET, Ellipsoid.WGS84.maximumRadius + 150_000)
    return Cartesian3.multiplyByScalar(radial, safeRadius, new Cartesian3())
  }

  private createEarthFacingOrientation(position: Cartesian3): Quaternion {
    const forward = Cartesian3.normalize(Cartesian3.negate(position, new Cartesian3()), new Cartesian3())
    const right = Cartesian3.normalize(Cartesian3.cross(forward, Cartesian3.UNIT_Z, new Cartesian3()), new Cartesian3())
    const up = Cartesian3.normalize(Cartesian3.cross(right, forward, new Cartesian3()), new Cartesian3())
    const basis = new Matrix3()
    Matrix3.setColumn(basis, 0, forward, basis)
    Matrix3.setColumn(basis, 1, right, basis)
    Matrix3.setColumn(basis, 2, up, basis)
    return Quaternion.fromRotationMatrix(basis, new Quaternion())
  }

  private bindInput(): void {
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    this.canvas.addEventListener('mousedown', this.onMouseDown)
    this.canvas.addEventListener('mouseup', this.onMouseUp)
    window.addEventListener('mousemove', this.onMouseMove)
  }

  private unbindInput(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    this.canvas.removeEventListener('mousedown', this.onMouseDown)
    this.canvas.removeEventListener('mouseup', this.onMouseUp)
    window.removeEventListener('mousemove', this.onMouseMove)
    this.keys.clear()
  }

  private releaseMouse(): void {
    this.mouseCaptured = false
    if (document.pointerLockElement === this.canvas) document.exitPointerLock?.()
  }
}

export type { ExplorationHudSnapshot }
