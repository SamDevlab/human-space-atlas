import { Cartesian3, Cartographic, Ellipsoid } from 'cesium'
import { getShipBasis, MIN_ALTITUDE_METERS } from './flightModel'
import type { AutopilotMode, FlightInput, ShipState } from './types'

/** The explorer trails the target in a loose 100–120 km formation band. */
export const AUTOPILOT_STANDOFF_METERS = 110_000
const AUTOPILOT_APPROACH_SPEED_LIMIT = 550
const AUTOPILOT_HOLD_TIME_CONSTANT = 42
const AUTOPILOT_RELATIVE_DAMPING = 0.9
const AUTOPILOT_MAX_RADIAL_SPEED = 800
const AUTOPILOT_MIN_ALTITUDE_BUFFER = 80_000
const AUTOPILOT_ALTITUDE_GAIN = 0.02

interface GuidanceResult {
  input: Pick<FlightInput, 'throttleDelta' | 'yawRate' | 'pitchRate' | 'rollInput' | 'boost' | 'brake'>
  desiredVelocity: Cartesian3
  desiredForward: Cartesian3
  desiredPosition: Cartesian3
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

function clampMagnitude(vector: Cartesian3, maximum: number): Cartesian3 {
  const magnitude = Cartesian3.magnitude(vector)
  if (!Number.isFinite(magnitude) || magnitude <= maximum) return vector
  return Cartesian3.multiplyByScalar(vector, maximum / magnitude, vector)
}

function trailingDirection(state: ShipState, targetPosition: Cartesian3, targetVelocity: Cartesian3): Cartesian3 {
  // Use the tangential part of the target velocity so the formation point is
  // behind the orbiting object, not above or below it when the sampled TLE
  // velocity contains a small radial component.
  const targetNormal = safeDirection(targetPosition, Cartesian3.UNIT_Z)
  const radialVelocity = Cartesian3.dot(targetVelocity, targetNormal)
  const tangentialVelocity = Cartesian3.subtract(
    targetVelocity,
    Cartesian3.multiplyByScalar(targetNormal, radialVelocity, new Cartesian3()),
    new Cartesian3(),
  )
  if (Cartesian3.magnitude(tangentialVelocity) > 100) return safeDirection(tangentialVelocity, Cartesian3.UNIT_X)
  return safeDirection(
    Cartesian3.subtract(state.position, targetPosition, new Cartesian3()),
    getShipBasis(state.orientation).up,
  )
}

function trailingStandoffPoint(state: ShipState, targetPosition: Cartesian3, targetVelocity: Cartesian3): Cartesian3 {
  const directionOfTravel = trailingDirection(state, targetPosition, targetVelocity)
  return Cartesian3.subtract(
    targetPosition,
    Cartesian3.multiplyByScalar(directionOfTravel, AUTOPILOT_STANDOFF_METERS, new Cartesian3()),
    new Cartesian3(),
  )
}

function trailingStandoffVelocity(targetPosition: Cartesian3, targetVelocity: Cartesian3, targetPoint: Cartesian3): Cartesian3 {
  const targetRadiusSquared = Cartesian3.magnitudeSquared(targetPosition)
  if (!Number.isFinite(targetRadiusSquared) || targetRadiusSquared < 1) return targetVelocity.clone()

  // The trailing point is offset from the target by a rotating orbital frame.
  // Following only targetVelocity ignores that rotation and makes the probe
  // overshoot the formation point before correcting back through it.
  const orbitalAngularVelocity = Cartesian3.divideByScalar(
    Cartesian3.cross(targetPosition, targetVelocity, new Cartesian3()),
    targetRadiusSquared,
    new Cartesian3(),
  )
  const offset = Cartesian3.subtract(targetPoint, targetPosition, new Cartesian3())
  const offsetVelocity = Cartesian3.cross(orbitalAngularVelocity, offset, new Cartesian3())
  return Cartesian3.add(targetVelocity, offsetVelocity, new Cartesian3())
}

function rendezvousCorrection(state: ShipState, targetPoint: Cartesian3, targetVelocity: Cartesian3, mode: AutopilotMode): Cartesian3 {
  const positionError = Cartesian3.subtract(targetPoint, state.position, new Cartesian3())
  const relativeVelocity = Cartesian3.subtract(state.velocity, targetVelocity, new Cartesian3())
  const positionTimeConstant = mode === 'INTERCEPT' ? 24 : AUTOPILOT_HOLD_TIME_CONSTANT
  const desiredRelativeVelocity = Cartesian3.subtract(
    Cartesian3.divideByScalar(positionError, positionTimeConstant, new Cartesian3()),
    Cartesian3.multiplyByScalar(relativeVelocity, AUTOPILOT_RELATIVE_DAMPING, new Cartesian3()),
    new Cartesian3(),
  )
  const maximumRelativeSpeed = mode === 'INTERCEPT' ? 1_200 : AUTOPILOT_APPROACH_SPEED_LIMIT
  // This is a damped position/velocity servo. At the trailing point it asks
  // for exactly the target velocity, so the separation stays stable instead
  // of alternating between forward and reverse corrections.
  return clampMagnitude(desiredRelativeVelocity, maximumRelativeSpeed)
}

/**
 * Keep rendezvous guidance in a safe orbital corridor. A direct point-to-point
 * vector can otherwise turn a small horizontal intercept into a steep descent
 * toward the globe, especially while the target is moving in an Earth-fixed
 * frame. Tangential motion remains unconstrained; only radial motion is
 * rate-limited and prevented from crossing the safety floor.
 */
function constrainAltitudeVelocity(state: ShipState, targetPosition: Cartesian3, targetVelocity: Cartesian3, desiredVelocity: Cartesian3): Cartesian3 {
  const current = Cartographic.fromCartesian(state.position)
  const target = Cartographic.fromCartesian(targetPosition)
  if (!current || !target || !Number.isFinite(current.height) || !Number.isFinite(target.height)) return desiredVelocity

  const normal = Ellipsoid.WGS84.geodeticSurfaceNormal(state.position, new Cartesian3())
  const desiredRadial = Cartesian3.dot(desiredVelocity, normal)
  const targetRadial = Cartesian3.dot(targetVelocity, normal)
  const tangential = Cartesian3.subtract(desiredVelocity, Cartesian3.multiplyByScalar(normal, desiredRadial, new Cartesian3()), new Cartesian3())
  const altitudeError = target.height - current.height
  const altitudeCorrection = clamp(targetRadial + altitudeError * AUTOPILOT_ALTITUDE_GAIN, -AUTOPILOT_MAX_RADIAL_SPEED, AUTOPILOT_MAX_RADIAL_SPEED)
  const distance = Cartesian3.distance(state.position, targetPosition)
  // Close to the rendezvous ring, the radial component belongs to the
  // stand-off controller. Blending it out here would turn a braking command
  // into a descent toward the target and collapse the trailing separation.
  const standoffWeight = clamp((AUTOPILOT_STANDOFF_METERS * 1.5 - distance) / AUTOPILOT_STANDOFF_METERS, 0, 1)
  let radialSpeed = altitudeCorrection * (1 - standoffWeight) + desiredRadial * standoffWeight
  const safeFloor = Math.max(MIN_ALTITUDE_METERS + AUTOPILOT_MIN_ALTITUDE_BUFFER, target.height - 20_000)
  if (current.height <= safeFloor && radialSpeed < 0) radialSpeed = 0
  return Cartesian3.add(tangential, Cartesian3.multiplyByScalar(normal, radialSpeed, new Cartesian3()), new Cartesian3())
}

function targetPointForMode(state: ShipState, targetPosition: Cartesian3, targetVelocity: Cartesian3): Cartesian3 {
  // Keep one continuous reference point through INTERCEPT, APPROACH and HOLD.
  // Changing from a lead point to a trailing point at 80 km would create a
  // large artificial turn and is the source of the visible back-and-forth.
  return trailingStandoffPoint(state, targetPosition, targetVelocity)
}

export function computeAutopilotGuidance(state: ShipState, targetPosition: Cartesian3, targetVelocity: Cartesian3, mode: AutopilotMode): GuidanceResult {
  const basis = getShipBasis(state.orientation)
  const targetPoint = targetPointForMode(state, targetPosition, targetVelocity)
  const formationVelocity = trailingStandoffVelocity(targetPosition, targetVelocity, targetPoint)
  const positionError = Cartesian3.subtract(targetPoint, state.position, new Cartesian3())
  const distanceMeters = Cartesian3.distance(state.position, targetPosition)
  const relativeVelocity = Cartesian3.subtract(state.velocity, formationVelocity, new Cartesian3())
  const relativeSpeedMetersPerSecond = Cartesian3.magnitude(relativeVelocity)
  const positionDirection = safeDirection(positionError, basis.forward)
  const approachVelocity = rendezvousCorrection(state, targetPoint, formationVelocity, mode)
  const desiredVelocity = constrainAltitudeVelocity(
    state,
    targetPosition,
    formationVelocity,
    Cartesian3.add(formationVelocity, approachVelocity, new Cartesian3()),
  )
  const desiredVelocityMagnitude = Cartesian3.magnitude(desiredVelocity)
  if (desiredVelocityMagnitude > 14_000) Cartesian3.multiplyByScalar(desiredVelocity, 14_000 / desiredVelocityMagnitude, desiredVelocity)
  const velocityError = Cartesian3.subtract(desiredVelocity, state.velocity, new Cartesian3())
  // Point the attitude at the commanded orbital velocity, not at the tiny
  // residual velocity error. Near HOLD that error changes sign every frame
  // because of floating-point noise, which otherwise makes the ship hunt and
  // roll endlessly around the target.
  const desiredDirection = safeDirection(
    desiredVelocity,
    Cartesian3.magnitude(formationVelocity) > 1_000 ? safeDirection(formationVelocity, positionDirection) : positionDirection,
  )
  const forwardVelocityError = Cartesian3.dot(velocityError, basis.forward)
  const forwardAlignment = Cartesian3.dot(basis.forward, desiredDirection)
  const desiredSpeed = Cartesian3.magnitude(desiredVelocity)
  const speedError = desiredSpeed - Cartesian3.magnitude(state.velocity)

  const worldUp = safeDirection(state.position, basis.up)
  const rollReference = safeDirection(Cartesian3.subtract(
    worldUp,
    Cartesian3.multiplyByScalar(desiredDirection, Cartesian3.dot(worldUp, desiredDirection), new Cartesian3()),
    new Cartesian3(),
  ), basis.up)

  return {
    input: {
      throttleDelta: forwardAlignment > 0.15 && speedError > 220 ? 1 : speedError < -260 ? -1 : 0,
      yawRate: clamp(Cartesian3.dot(desiredDirection, basis.right) * 2.4, -1, 1),
      // Positive pitch rotates +X toward +Z in the Explorer frame. Match the
      // desired world-up component so an approach cannot steer into Earth.
      pitchRate: clamp(Cartesian3.dot(desiredDirection, basis.up) * 2.4, -1, 1),
      rollInput: clamp(-Cartesian3.dot(rollReference, basis.right) * 1.8, -1, 1),
      boost: mode === 'INTERCEPT' && distanceMeters > 120_000 && forwardAlignment > 0.7 && forwardVelocityError > 1_000,
      // HOLD uses the velocity controller below to converge on the target's
      // orbital velocity. Applying the flight-model brake here would fight
      // that correction and leave the explorer permanently under-speed.
      brake: mode !== 'HOLD' && speedError < -650,
    },
    desiredVelocity,
    desiredForward: desiredDirection,
    desiredPosition: targetPoint,
    distanceMeters,
    relativeSpeedMetersPerSecond,
    etaSeconds: relativeSpeedMetersPerSecond > 1 ? distanceMeters / relativeSpeedMetersPerSecond : null,
  }
}
