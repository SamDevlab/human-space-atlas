export type CatalogGroup = 'stations' | 'active' | 'starlink' | 'gps-ops'

export interface OmmRecord {
  OBJECT_NAME: string
  OBJECT_ID?: string
  EPOCH: string
  MEAN_MOTION: number
  ECCENTRICITY: number
  INCLINATION: number
  RA_OF_ASC_NODE: number
  ARG_OF_PERICENTER: number
  MEAN_ANOMALY: number
  EPHEMERIS_TYPE?: number
  CLASSIFICATION_TYPE?: string
  NORAD_CAT_ID: number
  ELEMENT_SET_NO?: number
  REV_AT_EPOCH?: number
  BSTAR: number
  MEAN_MOTION_DOT: number
  MEAN_MOTION_DDOT: number
  OBJECT_TYPE?: string
  RCS_SIZE?: string
  COUNTRY_CODE?: string
  LAUNCH_DATE?: string
  SITE?: string
  DECAY_DATE?: string | null
  [key: string]: string | number | null | undefined
}

export interface CatalogResponse {
  source: 'celestrak'
  group: CatalogGroup
  fetchedAt: string
  cache: 'hit' | 'miss'
  objects: OmmRecord[]
}

export interface OrbitState {
  latitudeDeg: number
  longitudeDeg: number
  altitudeKm: number
  speedKmS: number
}
