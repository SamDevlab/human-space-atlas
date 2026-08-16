import { Cartesian3 } from 'cesium'
import { getShipBasis } from './flightModel'
import type { AutopilotMode, FlightInput, ShipState } from './types'

export const AUTOPILOT_STANDOFF_METERS = 10_000

interface GuidanceResult {
  input: Pick<FlightInput, 'throttleDelta' | 'yawRate' | 'pitchRate' | 'rollInput' | 'boost' | 'brake'>
  distanceMeters: number
  relativeSpeedMetersPerSecond: number
  etaSeconds: number | null
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function safeDirection(vector: Cartesian3, fallback: Cartesian3): Cartesian3 {
  const magnitude = Cartesian3.magnitude(vector)
  if (!Number.isFinite(magnitude) || magnitude < 0.001) return fallback.clone()
  return Cartesian3.divideByScalar(vector, magnitude, new Cartesian3())
}

function targetPointForMode(state: ShipState, targetPosition: Cartesian3, targetVelocity: Cartesian3, mode: AutopilotMode): Cartesian3 {
  if (mode === 'HOLD') {
    const offset = Cartesian3.subtract(state.position, targetPosition, new Cartesian3())
    const direction = safeDirection(offset, getShipBasis(state.orientation).up)
    return Cartesian3.add(targetPosition, Cartesian3.multiplyByScalar(direction, AUTOPILOT_STANDOFF_METERS, new Cartesian3()), new Cartesian3())
  }

  const distance = Cartesian3.distance(state.position, targetPosition)
  if (mode === 'INTERCEPT') {
    const leadSeconds = clamp(distance / 20_000, 8, 60)
    return Cartesian3.add(targetPosition, Cartesian3.multiplyByScalar(targetVelocity, leadSeconds, new Cartesian3()), new Cartesian3())
  }

  const offset = Cartesian3.subtract(state.position, targetPosition, new Cartesian3())
  const direction = safeDirection(offset, getShipBasis(state.orientation).up)
  return Cartesian3.add(targetPosition, Cartesian3.multiplyByScalar(direction, AUTOPILOT_STANDOFF_METERS, new Cartesian3()), new Cartesian3())
}

export function computeAutopilotGuidance(state: ShipState, targetPosition: Cartesian3, targetVelocity: Cartesian3, mode: AutopilotMode): GuidanceResult {
  const basis = getShipBasis(state.orientation)
  const targetPoint = targetPointForMode(state, targetPosition, targetVelocity, mode)
  const positionError = Cartesian3.subtract(targetPoint, state.position, new Cartesian3())
  const distanceMeters = Cartesian3.distance(state.position, targetPosition)
  const relativeVelocity = Cartesian3.subtract(state.velocity, targetVelocity, new Cartesian3())
  const relativeSpeedMetersPerSecond = Cartesian3.magnitude(relativeVelocity)
  const desiredDirection = safeDirection(positionError, basis.forward)
  const desiredSpeed = mode === 'INTERCEPT'
    ? clamp(distanceMeters * 0.25, 500, 12_000)
    : clamp(Math.max(0, distanceMeters - AUTOPILOT_STANDOFF_METERS) * 0.2, 0, 2_500)
  const speedAlongForward = Cartesian3.dot(relativeVelocity, basis.forward)
  const forwardAlignment = Cartesian3.dot(basis.forward, desiredDirection)

  const worldUp = safeDirection(state.position, basis.up)
  const rollReference = safeDirection(Cartesian3.subtract(
    worldUp,
    Cartesian3.multiplyByScalar(desiredDirection, Cartesian3.dot(worldUp, desiredDirection), new Cartesian3()),
    new Cartesian3(),
  ), basis.up)

  return {
    input: {
      throttleDelta: forwardAlignment > 0.2 && speedAlongForward < desiredSpeed - 80 ? 1 : speedAlongForward > desiredSpeed + 120 ? -1 : 0,
      yawRate: clamp(Cartesian3.dot(desiredDirection, basis.right) * 2.4, -1, 1),
      pitchRate: clamp(-Cartesian3.dot(desiredDirection, basis.up) * 2.4, -1, 1),
      rollInput: clamp(-Cartesian3.dot(rollReference, basis.right) * 1.8, -1, 1),
      boost: mode === 'INTERCEPT' && distanceMeters > 120_000 && forwardAlignment > 0.7,
      brake: (mode !== 'INTERCEPT' && relativeSpeedMetersPerSecond > Math.max(400, desiredSpeed + 120)) || mode === 'HOLD' && relativeSpeedMetersPerSecond > 80,
    },
    distanceMeters,
    relativeSpeedMetersPerSecond,
    etaSeconds: relativeSpeedMetersPerSecond > 1 ? distanceMeters / relativeSpeedMetersPerSecond : null,
  }
}
