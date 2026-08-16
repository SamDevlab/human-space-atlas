import { Cartesian3, Cartographic, Ellipsoid, Matrix3, Quaternion } from 'cesium'
import type { FlightInput, ShipState } from './types'

export const MIN_ALTITUDE_METERS = 120_000
export const LOW_ALTITUDE_WARNING_METERS = 200_000
export const MAX_SPEED_METERS_PER_SECOND = 50_000
export const MAX_ANGULAR_SPEED_RADIANS_PER_SECOND = 1.8
export const THROTTLE_RATE_PER_SECOND = 0.75

const ACCELERATION = 220
const LATERAL_ACCELERATION = 150
const BOOST_MULTIPLIER = 3.2
const BRAKE_DAMPING = 1.8
const ASSIST_DAMPING = 0.018
const ANGULAR_ACCELERATION = 2.8
const ROLL_ACCELERATION = 3.6
const MAX_ROLL_RATE = 2.2

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function approach(current: number, target: number, maxDelta: number): number {
  if (Math.abs(target - current) <= maxDelta) return target
  return current + Math.sign(target - current) * maxDelta
}

function rotateAroundAxis(orientation: Quaternion, axis: Cartesian3, radians: number): Quaternion {
  if (radians === 0) return orientation.clone()
  const delta = Quaternion.fromAxisAngle(axis, radians, new Quaternion())
  return Quaternion.normalize(Quaternion.multiply(delta, orientation, new Quaternion()), new Quaternion())
}

function clampToEarthBoundary(position: Cartesian3, velocity: Cartesian3): { position: Cartesian3; velocity: Cartesian3 } {
  const cartographic = Cartographic.fromCartesian(position)
  if (!cartographic || cartographic.height >= MIN_ALTITUDE_METERS) return { position, velocity }
  cartographic.height = MIN_ALTITUDE_METERS
  const safePosition = Cartographic.toCartesian(cartographic, Ellipsoid.WGS84, new Cartesian3())
  const normal = Ellipsoid.WGS84.geodeticSurfaceNormal(safePosition, new Cartesian3())
  const inwardSpeed = Cartesian3.dot(velocity, normal)
  const safeVelocity = inwardSpeed < 0
    ? Cartesian3.subtract(velocity, Cartesian3.multiplyByScalar(normal, inwardSpeed, new Cartesian3()), new Cartesian3())
    : velocity
  return { position: safePosition, velocity: safeVelocity }
}

export function createShipState(position: Cartesian3, orientation = Quaternion.IDENTITY): ShipState {
  return {
    position: position.clone(),
    velocity: Cartesian3.ZERO.clone(),
    orientation: orientation.clone(),
    throttle: 0,
    angularVelocity: Cartesian3.ZERO.clone(),
    flightAssist: true,
    boostActive: false,
  }
}

export function integrateShip(state: ShipState, input: FlightInput, deltaSeconds: number): ShipState {
  const dt = clamp(deltaSeconds, 0, 0.1)
  if (dt === 0) return state

  const rotation = Matrix3.fromQuaternion(state.orientation, new Matrix3())
  const forward = Matrix3.multiplyByVector(rotation, Cartesian3.UNIT_X, new Cartesian3())
  const right = Matrix3.multiplyByVector(rotation, Cartesian3.UNIT_Y, new Cartesian3())
  const up = Matrix3.multiplyByVector(rotation, Cartesian3.UNIT_Z, new Cartesian3())

  let throttle = clamp(state.throttle + clamp(input.throttleDelta, -1, 1) * THROTTLE_RATE_PER_SECOND * dt, -1, 1)
  if (input.brake) throttle = approach(throttle, 0, 1.8 * dt)

  const desiredAngularVelocity = new Cartesian3(
    clamp(input.pitchRate, -1, 1) * MAX_ANGULAR_SPEED_RADIANS_PER_SECOND,
    clamp(input.yawRate, -1, 1) * MAX_ANGULAR_SPEED_RADIANS_PER_SECOND,
    clamp(input.rollInput, -1, 1) * MAX_ROLL_RATE,
  )
  const angularVelocity = new Cartesian3(
    approach(state.angularVelocity.x, desiredAngularVelocity.x, ANGULAR_ACCELERATION * dt),
    approach(state.angularVelocity.y, desiredAngularVelocity.y, ANGULAR_ACCELERATION * dt),
    approach(state.angularVelocity.z, desiredAngularVelocity.z, ROLL_ACCELERATION * dt),
  )

  let orientation = rotateAroundAxis(state.orientation, up, angularVelocity.y * dt)
  orientation = rotateAroundAxis(orientation, right, angularVelocity.x * dt)
  orientation = rotateAroundAxis(orientation, forward, angularVelocity.z * dt)

  const thrust = new Cartesian3()
  Cartesian3.add(thrust, Cartesian3.multiplyByScalar(forward, throttle * ACCELERATION, new Cartesian3()), thrust)
  Cartesian3.add(thrust, Cartesian3.multiplyByScalar(right, input.strafe * LATERAL_ACCELERATION, new Cartesian3()), thrust)
  Cartesian3.add(thrust, Cartesian3.multiplyByScalar(up, input.vertical * LATERAL_ACCELERATION, new Cartesian3()), thrust)
  if (input.boost) Cartesian3.multiplyByScalar(thrust, BOOST_MULTIPLIER, thrust)

  let velocity = Cartesian3.add(state.velocity, Cartesian3.multiplyByScalar(thrust, dt, new Cartesian3()), new Cartesian3())
  if (input.brake) velocity = Cartesian3.multiplyByScalar(velocity, Math.exp(-BRAKE_DAMPING * dt), velocity)
  else if (state.flightAssist) velocity = Cartesian3.multiplyByScalar(velocity, Math.exp(-ASSIST_DAMPING * dt), velocity)
  if (Cartesian3.magnitude(velocity) > MAX_SPEED_METERS_PER_SECOND) {
    Cartesian3.normalize(velocity, velocity)
    Cartesian3.multiplyByScalar(velocity, MAX_SPEED_METERS_PER_SECOND, velocity)
  }

  const position = Cartesian3.add(state.position, Cartesian3.multiplyByScalar(velocity, dt, new Cartesian3()), new Cartesian3())
  const safe = clampToEarthBoundary(position, velocity)
  return {
    ...state,
    position: safe.position,
    velocity: safe.velocity,
    orientation,
    throttle,
    angularVelocity,
    boostActive: input.boost && Cartesian3.magnitude(thrust) > 0,
  }
}

export function formatDistanceKm(distanceKm: number | null): string {
  if (distanceKm === null) return '—'
  if (distanceKm < 1) return `${(distanceKm * 1000).toFixed(0)} m`
  return distanceKm >= 100 ? `${distanceKm.toFixed(0)} km` : `${distanceKm.toFixed(1)} km`
}
