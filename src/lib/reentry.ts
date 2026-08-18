import type { OmmRecord } from './types'

const EARTH_RADIUS_KM = 6378.137
const EARTH_MU_KM3_S2 = 398600.4418

export type ReentryAssessment = {
  perigeeKm: number | null
  apogeeKm: number | null
  semiMajorAxisKm: number | null
  status: 'decayed' | 'critical' | 'high' | 'elevated' | 'nominal'
  label: string
  reason: string
  decayDate: string | null
  bstar: number
  meanMotionDot: number
}

export function orbitalShapeFromMeanMotion(record: OmmRecord) {
  const meanMotion = Number(record.MEAN_MOTION)
  const eccentricity = Number(record.ECCENTRICITY)
  if (!Number.isFinite(meanMotion) || meanMotion <= 0 || !Number.isFinite(eccentricity) || eccentricity < 0 || eccentricity >= 1) {
    return { semiMajorAxisKm: null, perigeeKm: null, apogeeKm: null }
  }
  const radiansPerSecond = meanMotion * 2 * Math.PI / 86_400
  const semiMajorAxisKm = Math.cbrt(EARTH_MU_KM3_S2 / (radiansPerSecond * radiansPerSecond))
  const perigeeKm = semiMajorAxisKm * (1 - eccentricity) - EARTH_RADIUS_KM
  const apogeeKm = semiMajorAxisKm * (1 + eccentricity) - EARTH_RADIUS_KM
  return { semiMajorAxisKm, perigeeKm, apogeeKm }
}

/**
 * A transparent decay watch derived from public OMM elements. It deliberately
 * does not invent a reentry timestamp: atmospheric density, attitude,
 * manoeuvres, solar activity and covariance are not available here.
 */
export function assessReentry(record: OmmRecord): ReentryAssessment {
  const { semiMajorAxisKm, perigeeKm, apogeeKm } = orbitalShapeFromMeanMotion(record)
  const decayDate = typeof record.DECAY_DATE === 'string' && record.DECAY_DATE ? record.DECAY_DATE : null
  const bstar = Number.isFinite(Number(record.BSTAR)) ? Number(record.BSTAR) : 0
  const meanMotionDot = Number.isFinite(Number(record.MEAN_MOTION_DOT)) ? Number(record.MEAN_MOTION_DOT) : 0

  if (decayDate) {
    return {
      semiMajorAxisKm,
      perigeeKm,
      apogeeKm,
      status: 'decayed',
      label: 'DECAY REGISTRADO',
      reason: `O catálogo público informa DECAY_DATE ${decayDate.slice(0, 10)}.`,
      decayDate,
      bstar,
      meanMotionDot,
    }
  }

  if (perigeeKm === null) {
    return { semiMajorAxisKm, perigeeKm, apogeeKm, status: 'nominal', label: 'DADOS INSUFICIENTES', reason: 'Não foi possível derivar perigeu a partir do OMM atual.', decayDate, bstar, meanMotionDot }
  }

  if (perigeeKm < 120) return { semiMajorAxisKm, perigeeKm, apogeeKm, status: 'critical', label: 'DECAIMENTO CRÍTICO', reason: 'Perigeu derivado abaixo de 120 km; a órbita está profundamente dentro da região de arrasto atmosférico.', decayDate, bstar, meanMotionDot }
  if (perigeeKm < 180) return { semiMajorAxisKm, perigeeKm, apogeeKm, status: 'high', label: 'DECAIMENTO ALTO', reason: 'Perigeu derivado abaixo de 180 km. Reentrada pode tornar-se próxima, mas não é possível datá-la com segurança somente com OMM.', decayDate, bstar, meanMotionDot }
  if (perigeeKm < 250 || Math.abs(bstar) > 0.002 || meanMotionDot > 0.002) return { semiMajorAxisKm, perigeeKm, apogeeKm, status: 'elevated', label: 'MONITORAR ARRASTO', reason: 'Órbita baixa ou parâmetros de arrasto sugerem acompanhar novos elementos antes de inferir reentrada.', decayDate, bstar, meanMotionDot }
  return { semiMajorAxisKm, perigeeKm, apogeeKm, status: 'nominal', label: 'SEM ALERTA DE REENTRADA', reason: 'Os elementos atuais não indicam decaimento imediato. Isso não é uma previsão operacional.', decayDate, bstar, meanMotionDot }
}
