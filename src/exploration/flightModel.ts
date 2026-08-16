import { Cartesian3, Cartographic, Ellipsoid, Matrix3, Quaternion } from 'cesium'
import type { FlightInput, ShipState } from './types'

export const MIN_ALTITUDE_METERS = 120_000
export const MAX_SPEED_METERS_PER_SECOND = 50_000
const ACCELERATION = 120
const BOOST_MULTIPLIER = 4
const ASSIST_DAMPING = 0.12

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
  return { position: position.clone(), velocity: Cartesian3.ZERO.clone(), orientation: orientation.clone(), throttle: 0, angularVelocity: Cartesian3.ZERO.clone(), flightAssist: true }
}

export function integrateShip(state: ShipState, input: FlightInput, deltaSeconds: number): ShipState {
  const dt = Math.max(0, Math.min(deltaSeconds, 0.1))
  if (dt === 0) return state

  const rotation = Matrix3.fromQuaternion(state.orientation, new Matrix3())
  const forward = Matrix3.multiplyByVector(rotation, Cartesian3.UNIT_X, new Cartesian3())
  const right = Matrix3.multiplyByVector(rotation, Cartesian3.UNIT_Y, new Cartesian3())
  const up = Matrix3.multiplyByVector(rotation, Cartesian3.UNIT_Z, new Cartesian3())
  let orientation = rotateAroundAxis(state.orientation, up, input.yawRate * dt)
  orientation = rotateAroundAxis(orientation, right, input.pitchRate * dt)
  orientation = rotateAroundAxis(orientation, forward, input.rollRate * dt)

  const thrust = new Cartesian3()
  Cartesian3.add(thrust, Cartesian3.multiplyByScalar(forward, input.forward, thrust), thrust)
  Cartesian3.add(thrust, Cartesian3.multiplyByScalar(right, input.strafe, new Cartesian3()), thrust)
  Cartesian3.add(thrust, Cartesian3.multiplyByScalar(up, input.vertical, new Cartesian3()), thrust)
  if (Cartesian3.magnitudeSquared(thrust) > 1) Cartesian3.normalize(thrust, thrust)
  const acceleration = ACCELERATION * (input.boost ? BOOST_MULTIPLIER : 1)
  let velocity = Cartesian3.add(state.velocity, Cartesian3.multiplyByScalar(thrust, acceleration * dt, new Cartesian3()), new Cartesian3())
  if (input.brake) velocity = Cartesian3.multiplyByScalar(velocity, Math.exp(-2.8 * dt), velocity)
  else if (state.flightAssist) velocity = Cartesian3.multiplyByScalar(velocity, Math.exp(-ASSIST_DAMPING * dt), velocity)
  if (Cartesian3.magnitude(velocity) > MAX_SPEED_METERS_PER_SECOND) Cartesian3.normalize(velocity, velocity), Cartesian3.multiplyByScalar(velocity, MAX_SPEED_METERS_PER_SECOND, velocity)
  const position = Cartesian3.add(state.position, Cartesian3.multiplyByScalar(velocity, dt, new Cartesian3()), new Cartesian3())
  const safe = clampToEarthBoundary(position, velocity)
  return { ...state, position: safe.position, velocity: safe.velocity, orientation, throttle: Math.min(1, Cartesian3.magnitude(thrust)), angularVelocity: new Cartesian3(input.pitchRate, input.yawRate, input.rollRate) }
}

export function formatDistanceKm(distanceKm: number | null): string {
  if (distanceKm === null) return '—'
  return distanceKm >= 100 ? `${distanceKm.toFixed(0)} km` : `${distanceKm.toFixed(1)} km`
}
