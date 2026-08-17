import { useEffect, useMemo, useRef } from 'react'
import {
  Cartesian3,
  Cartesian2,
  ArcGISTiledElevationTerrainProvider,
  Color,
  ColorMaterialProperty,
  ConstantProperty,
  ClassificationType,
  createWorldTerrainAsync,
  Ellipsoid,
  EllipsoidGeometry,
  EllipsoidTerrainProvider,
  Entity,
  GeometryInstance,
  HeightReference,
  ImageryLayer,
  Ion,
  JulianDate,
  LabelCollection,
  LabelStyle,
  Material,
  MaterialAppearance,
  Matrix3,
  Matrix4,
  NearFarScalar,
  PointPrimitiveCollection,
  Primitive,
  SampledPositionProperty,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  ShadowMode,
  TerrainProvider,
  Viewer,
  VelocityOrientationProperty,
} from 'cesium'
import { discoverMapStyles } from '../lib/mapStyles'
import { createNasaCloudProvider, createNasaCloudTexture, preloadNasaCloudTexture, createNasaNightLightsProvider, NASA_GIBS_CLOUD_OBSERVATION_DATE } from '../lib/earthLayers'
import { eventColor } from '../lib/earthEvents'
import type { EarthEvent } from '../lib/earthEvents'
import type { OmmRecord } from '../lib/types'
import type { AircraftState } from '../lib/airTraffic'
import { createSatrec, sampleOrbit, toCesiumHeightMeters } from '../lib/orbit'
import type { WorkerCommand, WorkerResult } from '../workers/orbitProtocol'
import { shouldApplyPositionResult } from '../workers/workerState'
import { ExplorationController } from '../exploration/ExplorationController'
import type { ExplorationCameraPreset, ExplorationHudSnapshot } from '../exploration/types'
import { createHighResolutionSpaceSkyBox } from '../lib/spaceBackground'

interface GlobeProps {
  objects: OmmRecord[]
  simulatedAt: Date
  selectedId: number | null
  onSelect: (catalogId: number | null) => void
  onPerformance?: (metric: { workerMs: number; applyMs: number; transferBytes: number; pending: number }) => void
  homeRequest?: number
  mapStyle?: string
  cloudsEnabled?: boolean
  cloudOpacity?: number
  cloudShadowsEnabled?: boolean
  atmosphereEnabled?: boolean
  terrainEnabled?: boolean
  orbitsEnabled?: boolean
  satelliteTrailsEnabled?: boolean
  onCloudError?: () => void
  onTerrainLoading?: (loading: boolean) => void
  aircraftEnabled?: boolean
  aircraftRoutesEnabled?: boolean
  aircraftStates?: AircraftState[]
  selectedAircraftId?: string | null
  onAircraftSelect?: (aircraftId: string | null) => void
  earthEvents?: EarthEvent[]
  earthEventsEnabled?: boolean
  eventCategories?: string[]
  onEarthEventSelect?: (eventId: string | null) => void
  eventViewRequest?: number
  eventViewPosition?: Cartesian3 | null
  onMapStyleError?: () => void
  onMapStyleLoading?: (loading: boolean) => void
  explorationActive?: boolean
  targetPosition?: Cartesian3 | null
  targetVelocity?: Cartesian3 | null
  targetName?: string | null
  onExplorationHud?: (snapshot: ExplorationHudSnapshot) => void
  onExitExplore?: () => void
  onOpenExploreNav?: () => void
  onExploreActivity?: () => void
  explorationCameraSensitivity?: number
  explorationCameraPreset?: ExplorationCameraPreset
}

const POINT_SIZE = 5
// The orbit worker receives a new simulated sample every 500 ms. Keeping the
// render interpolation slightly longer than that interval prevents a visible
// stop/start seam when the next sample arrives.
const SATELLITE_INTERPOLATION_MS = 720
const CLOUD_DRIFT_RADIANS_PER_SECOND = 0.0009
const CLOUD_SHADOW_DRIFT_RADIANS_PER_SECOND = 0.00082
const ARC_GIS_TERRAIN_URL = 'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer'
const AIRCRAFT_PREDICTION_SECONDS = 15
const AIRCRAFT_ROUTE_RETENTION_MS = 5 * 60 * 1000
const AIRCRAFT_ICON = `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="#ffd39a" d="M31 2h2l4 25 20 12v4L37 39l-2 21h-6l-2-21L7 43v-4l20-12z"/><path fill="#fff2d8" d="M31 8h2v45h-2z"/></svg>')}`

type AircraftVisual = {
  entity: Entity
  route: Entity
  position: SampledPositionProperty
}

type AircraftTrackPoint = {
  timestamp: number
  position: Cartesian3
}

function predictAircraftPosition(state: AircraftState, seconds: number) {
  const latitudeRadians = state.latitudeDeg * Math.PI / 180
  const trackRadians = (state.trueTrackDeg ?? 0) * Math.PI / 180
  const distanceMeters = state.velocityMetersPerSecond * seconds
  const earthRadiusMeters = 6_371_000
  const nextLatitude = state.latitudeDeg + (distanceMeters * Math.cos(trackRadians) / earthRadiusMeters) * 180 / Math.PI
  const nextLongitude = state.longitudeDeg + (distanceMeters * Math.sin(trackRadians) / Math.max(earthRadiusMeters * Math.cos(latitudeRadians), 1)) * 180 / Math.PI
  const nextAltitude = Math.max(500, state.altitudeMeters + state.verticalRateMetersPerSecond * seconds)
  return Cartesian3.fromDegrees(nextLongitude, nextLatitude, nextAltitude)
}

export function Globe({ objects, simulatedAt, selectedId, onSelect, onPerformance, homeRequest = 0, mapStyle = 'satellite', cloudsEnabled = true, cloudOpacity = 0.55, cloudShadowsEnabled = true, atmosphereEnabled = true, terrainEnabled = true, orbitsEnabled = true, satelliteTrailsEnabled = false, onCloudError, onTerrainLoading, aircraftEnabled = false, aircraftRoutesEnabled = true, aircraftStates = [], selectedAircraftId = null, onAircraftSelect, earthEvents = [], earthEventsEnabled = true, eventCategories = [], onEarthEventSelect, eventViewRequest = 0, eventViewPosition = null, onMapStyleError, onMapStyleLoading, explorationActive = false, targetPosition = null, targetVelocity = null, targetName = null, onExplorationHud, onExitExplore, onOpenExploreNav, onExploreActivity, explorationCameraSensitivity = 1, explorationCameraPreset = 'FOLLOW' }: GlobeProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Viewer | null>(null)
  const pointsRef = useRef<PointPrimitiveCollection | null>(null)
  const labelsRef = useRef<LabelCollection | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const generationRef = useRef(0)
  const requestRef = useRef(0)
  const latestAppliedRequestRef = useRef(0)
  const defaultImageryRef = useRef<unknown>(null)
  const cloudLayerRef = useRef<ImageryLayer | null>(null)
  const nightLightsLayerRef = useRef<ImageryLayer | null>(null)
  const cloudShellRef = useRef<Primitive[]>([])
  const orbitEntityRef = useRef<Entity | null>(null)
  const satelliteTrailEntityRef = useRef<Entity | null>(null)
  const orbitPositionsRef = useRef<ConstantProperty | null>(null)
  const satelliteTrailPositionsRef = useRef<ConstantProperty | null>(null)
  const terrainProviderRef = useRef<TerrainProvider | null>(null)
  const aircraftVisualsRef = useRef(new Map<string, AircraftVisual>())
  const aircraftTracksRef = useRef(new Map<string, AircraftTrackPoint[]>())
  const imageryRequestRef = useRef(0)
  const explorationRef = useRef<ExplorationController | null>(null)

  const satrecs = useMemo(() => {
    const map = new Map<number, ReturnType<typeof createSatrec>>()
    const selected = objects.find((object) => object.NORAD_CAT_ID === selectedId)
    if (selected) {
      try { map.set(selected.NORAD_CAT_ID, createSatrec(selected)) } catch { /* worker reports bulk parse failures */ }
    }
    return map
  }, [objects, selectedId])

  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return

    const token = import.meta.env.VITE_CESIUM_ION_TOKEN
    if (token) Ion.defaultAccessToken = token
    let terrainCancelled = false

    const viewer = new Viewer(containerRef.current, {
      animation: false,
      timeline: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      shouldAnimate: true,
      useBrowserRecommendedResolution: false,
    })

    // Cesium's default star map is intentionally tiny. Use the display's
    // native pixel density plus a modest quality headroom so the sky and thin
    // atmospheric edge do not look like enlarged pixels on a large monitor.
    viewer.resolutionScale = Math.min(1.65, Math.max(1.15, window.devicePixelRatio || 1))
    viewer.scene.skyBox = createHighResolutionSpaceSkyBox()

    const cameraController = viewer.scene.screenSpaceCameraController
    cameraController.enableCollisionDetection = true
    cameraController.minimumZoomDistance = 250
    // Keep drag, spin and zoom continuous while imagery/terrain refine in the
    // background instead of making the camera feel like it is stepping tiles.
    cameraController.inertiaSpin = 0.88
    cameraController.inertiaTranslate = 0.9
    cameraController.inertiaZoom = 0.82
    cameraController.maximumMovementRatio = 0.08
    viewer.camera.setView({ destination: Cartesian3.fromDegrees(-18, 18, 18_000_000) })
    defaultImageryRef.current = viewer.imageryLayers.get(0)?.imageryProvider ?? null

    viewer.scene.globe.enableLighting = true
    // Keep terrain and imagery tiles refining while the camera approaches the
    // surface. The cloud field is intentionally handled separately below.
    viewer.scene.globe.maximumScreenSpaceError = 0.8
    viewer.scene.globe.tileCacheSize = 1024
    viewer.scene.globe.preloadAncestors = true
    viewer.scene.globe.preloadSiblings = true
    viewer.scene.globe.depthTestAgainstTerrain = true
    viewer.scene.globe.showGroundAtmosphere = atmosphereEnabled
    viewer.scene.globe.dynamicAtmosphereLighting = true
    viewer.scene.globe.dynamicAtmosphereLightingFromSun = true
    viewer.scene.globe.atmosphereLightIntensity = 20
    viewer.scene.globe.atmosphereBrightnessShift = 0.035
    viewer.scene.globe.atmosphereSaturationShift = 0.12
    const skyAtmosphere = viewer.scene.skyAtmosphere
    if (skyAtmosphere) {
      skyAtmosphere.show = atmosphereEnabled
      skyAtmosphere.perFragmentAtmosphere = true
      skyAtmosphere.atmosphereLightIntensity = 72
      skyAtmosphere.brightnessShift = 0.035
      skyAtmosphere.saturationShift = 0.12
    }
    // Cesium computes both bodies from the scene clock. Keep them visible and
    // slightly more legible against the deep-space background.
    const sun = viewer.scene.sun
    if (sun) {
      sun.show = true
      sun.glowFactor = 1.35
    }
    const moon = viewer.scene.moon
    if (moon) moon.show = true
    const shadowMap = viewer.shadowMap
    shadowMap.enabled = true
    shadowMap.softShadows = true
    shadowMap.normalOffset = true
    shadowMap.fadingEnabled = true
    shadowMap.darkness = 0.3
    shadowMap.size = 2048
    shadowMap.maximumDistance = 6_000_000
    viewer.scene.globe.shadows = ShadowMode.ENABLED
    viewer.scene.globe.vertexShadowDarkness = 0.42
    viewer.scene.globe.lambertDiffuseMultiplier = 1.12
    viewer.scene.backgroundColor = Color.fromCssColorString('#02040b')
    // A modest exaggeration makes mountain ranges readable from low orbit
    // while keeping the global silhouette believable.
    viewer.scene.verticalExaggeration = 1.16
    viewer.scene.verticalExaggerationRelativeHeight = 0

    const loadTerrain = async () => {
      if (token) {
        try {
      return await createWorldTerrainAsync({ requestVertexNormals: true, requestWaterMask: true })
        } catch {
          // Fall through to the public ArcGIS elevation service.
        }
      }
      return ArcGISTiledElevationTerrainProvider.fromUrl(ARC_GIS_TERRAIN_URL)
    }
    onTerrainLoading?.(true)
    loadTerrain().then((terrainProvider) => {
      if (terrainCancelled || viewer.isDestroyed()) return
      terrainProviderRef.current = terrainProvider
      if (!terrainEnabled) {
        onTerrainLoading?.(false)
        return
      }
      viewer.terrainProvider = terrainProvider
      viewer.scene.globe.enableLighting = true
      viewer.scene.requestRender()
      onTerrainLoading?.(false)
    }).catch(() => {
      // Keep the ellipsoid fallback if remote elevation is unavailable.
      onTerrainLoading?.(false)
    })

    const points = viewer.scene.primitives.add(new PointPrimitiveCollection())
    pointsRef.current = points
    labelsRef.current = viewer.scene.primitives.add(new LabelCollection())
    viewerRef.current = viewer
    explorationRef.current = new ExplorationController(viewer, {
      onHudUpdate: (snapshot) => onExplorationHud?.(snapshot),
      onExit: () => onExitExplore?.(),
      onOpenNavigation: () => onOpenExploreNav?.(),
      onControlsActivity: () => onExploreActivity?.(),
    })

    const worker = new Worker(new URL('../workers/orbit.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker

    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas)
      handler.setInputAction((movement: { position: Cartesian2 }) => {
      if (explorationRef.current?.isActive()) return
      const picked = viewer.scene.pick(movement.position)
      const earthEventId = picked?.id?.properties?.earthEventId?.getValue?.(viewer.clock.currentTime) ?? picked?.id?.earthEventId
      if (typeof earthEventId === 'string') {
        onEarthEventSelect?.(earthEventId)
        return
      }
      const aircraftId = picked?.id?.properties?.aircraftId?.getValue?.(viewer.clock.currentTime) ?? picked?.id?.aircraftId
      if (typeof aircraftId === 'string') {
        onAircraftSelect?.(aircraftId)
        onSelect(null)
        onEarthEventSelect?.(null)
        return
      }
      const id = picked?.id?.catalogId
      onSelect(typeof id === 'number' ? id : null)
    }, ScreenSpaceEventType.LEFT_CLICK)

    return () => {
      handler.destroy()
      pointsRef.current = null
      labelsRef.current = null
      worker.postMessage({ type: 'DISPOSE' } satisfies WorkerCommand)
      workerRef.current = null
      explorationRef.current?.destroy()
      explorationRef.current = null
      terrainCancelled = true
      terrainProviderRef.current = null
      cloudShellRef.current.forEach((shell) => viewer.scene.primitives.remove(shell))
      cloudShellRef.current = []
      if (nightLightsLayerRef.current && !viewer.isDestroyed()) viewer.imageryLayers.remove(nightLightsLayerRef.current, false)
      nightLightsLayerRef.current = null
      orbitEntityRef.current = null
      satelliteTrailEntityRef.current = null
      orbitPositionsRef.current = null
      satelliteTrailPositionsRef.current = null
      aircraftVisualsRef.current.forEach(({ entity, route }) => { viewer.entities.remove(entity); viewer.entities.remove(route) })
      aircraftVisualsRef.current.clear()
      aircraftTracksRef.current.clear()
      viewerRef.current = null
      viewer.destroy()
    }
  }, [onSelect, onExplorationHud, onExitExplore, onOpenExploreNav, onExploreActivity, onEarthEventSelect, onAircraftSelect])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || viewer.isDestroyed()) return
    viewer.scene.globe.showGroundAtmosphere = atmosphereEnabled
    if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = atmosphereEnabled
    if (viewer.scene.sun) viewer.scene.sun.show = atmosphereEnabled
    if (viewer.scene.moon) viewer.scene.moon.show = atmosphereEnabled
    viewer.scene.requestRender()
  }, [atmosphereEnabled])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || viewer.isDestroyed()) return
    viewer.terrainProvider = terrainEnabled && terrainProviderRef.current
      ? terrainProviderRef.current
      : new EllipsoidTerrainProvider()
    viewer.scene.globe.enableLighting = terrainEnabled
    viewer.scene.requestRender()
  }, [terrainEnabled])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || viewer.isDestroyed()) return
    viewer.clock.currentTime = JulianDate.fromDate(simulatedAt)
  }, [simulatedAt])

  useEffect(() => {
    const controller = explorationRef.current
    if (!controller) return
    if (explorationActive) controller.enter(targetPosition, targetName, targetVelocity)
    else controller.exit()
  }, [explorationActive])

  useEffect(() => { explorationRef.current?.setTarget(targetPosition, targetName, targetVelocity) }, [targetPosition, targetName, targetVelocity])
  useEffect(() => {
    explorationRef.current?.setCameraSensitivity(explorationCameraSensitivity)
  }, [explorationCameraSensitivity])
  useEffect(() => {
    explorationRef.current?.setCameraPreset(explorationCameraPreset)
  }, [explorationCameraPreset])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || homeRequest === 0) return
    viewer.camera.flyTo({ destination: Cartesian3.fromDegrees(-18, 18, 18_000_000), duration: 0.8 })
  }, [homeRequest])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || viewer.isDestroyed()) return
    const requestId = imageryRequestRef.current + 1
    imageryRequestRef.current = requestId
    const definition = discoverMapStyles().find((style) => style.id === mapStyle) ?? discoverMapStyles()[0]
    const current = viewer.imageryLayers.get(0)
    if (!current) { onMapStyleLoading?.(false); return }
    let cancelled = false
    if (!definition.create) {
      if (defaultImageryRef.current && current.imageryProvider !== defaultImageryRef.current) {
        viewer.imageryLayers.remove(current, false)
        viewer.imageryLayers.addImageryProvider(defaultImageryRef.current as Parameters<typeof viewer.imageryLayers.addImageryProvider>[0])
      }
      if (cloudLayerRef.current) viewer.imageryLayers.raiseToTop(cloudLayerRef.current)
      onMapStyleLoading?.(false)
      return () => { cancelled = true }
    }
    onMapStyleLoading?.(true)
    const startedAt = performance.now()
    let commitTimer: number | null = null
    Promise.resolve().then(() => definition.create?.()).then((provider) => {
      if (cancelled || requestId !== imageryRequestRef.current || !provider) return
      const commit = () => {
        if (cancelled || requestId !== imageryRequestRef.current) return
        viewer.imageryLayers.remove(current, false)
        if (Array.isArray(provider)) provider.forEach((item) => viewer.imageryLayers.addImageryProvider(item))
        else viewer.imageryLayers.addImageryProvider(provider)
        if (cloudLayerRef.current) viewer.imageryLayers.raiseToTop(cloudLayerRef.current)
        onMapStyleLoading?.(false)
      }
      commitTimer = window.setTimeout(commit, Math.max(0, 160 - (performance.now() - startedAt)))
    }).catch(() => { if (!cancelled && requestId === imageryRequestRef.current) { onMapStyleLoading?.(false); onMapStyleError?.() } })
    return () => { cancelled = true; if (commitTimer !== null) window.clearTimeout(commitTimer) }
  }, [mapStyle, onMapStyleError, onMapStyleLoading])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || viewer.isDestroyed() || nightLightsLayerRef.current) return
    const provider = createNasaNightLightsProvider()
    const layer = viewer.imageryLayers.addImageryProvider(provider, 1)
    // VIIRS encodes the fill as black. Convert only that fill to transparency,
    // preserving the warm radiance of the city pixels over the day texture.
    layer.colorToAlpha = Color.BLACK
    layer.colorToAlphaThreshold = 0.018
    layer.alpha = 0.78
    layer.brightness = 1.8
    layer.contrast = 1.25
    nightLightsLayerRef.current = layer
    return () => {
      if (!viewer.isDestroyed() && nightLightsLayerRef.current === layer) viewer.imageryLayers.remove(layer, false)
      if (nightLightsLayerRef.current === layer) nightLightsLayerRef.current = null
    }
  }, [])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || viewer.isDestroyed()) return
    let cancelled = false
    const removeCloudLayer = () => {
      if (!viewer.isDestroyed() && cloudLayerRef.current) viewer.imageryLayers.remove(cloudLayerRef.current, false)
      cloudLayerRef.current = null
    }
    removeCloudLayer()
    if (!cloudsEnabled) return
    const opacity = Math.max(0, Math.min(1, cloudOpacity))
    const fallbackCloudTexture = createNasaCloudTexture()
    const cloudTextureUrl = fallbackCloudTexture.toDataURL('image/png')
    // Explore gets a cinematic volume instead of a flat map overlay. The
    // map uses the continuous shell; Explore uses Earth-anchored cloud banks
    // with separate low and high strata so the terrain remains readable.
    // Both modes use the same observed NASA macro layer. Explore keeps the
    // same visual language as the normal globe and uses only the altitude
    // fade to prevent it from becoming fog when the camera gets close.
    const cloudShellAlpha = opacity * 0.46
    const cloudMaterial = Material.fromType('Image', {
      image: cloudTextureUrl,
      color: Color.WHITE.withAlpha(cloudShellAlpha),
    })
    const shadowMaterial = Material.fromType('Image', {
      image: cloudTextureUrl,
      color: Color.fromCssColorString('#0a1825').withAlpha(opacity * (explorationActive ? 0.12 : 0.07)),
    })
    const createCloudShell = (height: number, material: Material) => viewer.scene.primitives.add(new Primitive({
      geometryInstances: new GeometryInstance({
        geometry: new EllipsoidGeometry({
          radii: Cartesian3.add(Ellipsoid.WGS84.radii, new Cartesian3(height, height, height), new Cartesian3()),
          stackPartitions: 96,
          slicePartitions: 192,
          vertexFormat: MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
        }),
      }),
      // Keep the material flat-shaded so the cloud alpha remains visible on
      // both the sunlit and night-facing sides; the nested shells provide the
      // depth cue without turning the volume into a dark opaque fog.
      appearance: new MaterialAppearance({ material, faceForward: true, translucent: true, flat: true }),
      asynchronous: false,
      allowPicking: false,
      cull: false,
      show: true,
    }))
    const cloudShell = createCloudShell(9_500, cloudMaterial)
    // The low shadow shell is useful in the map view, but from the spacecraft
    // it sits directly in front of the terrain and exaggerates any source
    // pixel into square plates. Explore keeps the soft high cloud volume and
    // leaves the terrain readable; the shadow option still applies to the map.
    const shadowShell = cloudShadowsEnabled && !explorationActive ? createCloudShell(1_800, shadowMaterial) : null
    cloudShellRef.current = [cloudShell, shadowShell].filter((shell): shell is Primitive => Boolean(shell))
    const cloudMotionStartedAt = performance.now()
    // The promise is shared by all globe remounts and backed by CacheStorage,
    // so changing map mode does not restart the two large NASA downloads.
    preloadNasaCloudTexture().catch(() => fallbackCloudTexture).then((cloudTexture) => {
      if (cancelled || viewer.isDestroyed()) return
      const cloudTextureUrl = cloudTexture.toDataURL('image/png')
      cloudMaterial.uniforms.image = cloudTextureUrl
      shadowMaterial.uniforms.image = cloudTextureUrl
      return createNasaCloudProvider(NASA_GIBS_CLOUD_OBSERVATION_DATE, cloudTexture)
    }).then((provider) => {
      if (cancelled || viewer.isDestroyed() || !provider) return
      const cloudLayer = viewer.imageryLayers.addImageryProvider(provider)
      const updateCloudDetail = () => {
        if (viewer.isDestroyed()) return
        const height = viewer.camera.positionCartographic.height
        const detailFade = Math.max(0, Math.min(1, (height - 900_000) / 1_900_000))
        // Keep the imagery layer for the normal globe only; Explore uses the
        // same NASA texture on the elevated shell to avoid a flat decal.
        cloudLayer.alpha = opacity * detailFade * 0.82
        cloudLayer.show = !explorationActive && detailFade > 0.01
        // Like Google Earth, let the atmospheric cloud layer disappear as the
        // camera enters the terrain view. The fade is smooth and independent
        // of the map tile loading state, so it never pops in or out.
        const fadeStart = explorationActive ? 135_000 : 85_000
        const fadeRange = explorationActive ? 300_000 : 240_000
        const fadeAmount = Math.max(0, Math.min(1, (height - fadeStart) / fadeRange))
        const shellFade = fadeAmount * fadeAmount * (3 - 2 * fadeAmount)
        cloudMaterial.uniforms.color = Color.WHITE.withAlpha(cloudShellAlpha * shellFade)
        shadowMaterial.uniforms.color = Color.fromCssColorString('#0a1825').withAlpha(opacity * (explorationActive ? 0.08 : 0.07) * shellFade)
        if (cloudShell) cloudShell.show = shellFade > 0.01
        if (shadowShell) shadowShell.show = cloudShadowsEnabled && shellFade > 0.15
        const cloudRotation = Matrix3.fromRotationZ((performance.now() - cloudMotionStartedAt) / 1000 * CLOUD_DRIFT_RADIANS_PER_SECOND, new Matrix3())
        if (cloudShell) cloudShell.modelMatrix = Matrix4.fromRotationTranslation(cloudRotation, Cartesian3.ZERO, new Matrix4())
        if (shadowShell) {
          const shadowRotation = Matrix3.fromRotationZ((performance.now() - cloudMotionStartedAt) / 1000 * CLOUD_SHADOW_DRIFT_RADIANS_PER_SECOND, new Matrix3())
          shadowShell.modelMatrix = Matrix4.fromRotationTranslation(shadowRotation, Cartesian3.ZERO, new Matrix4())
        }
      }
      updateCloudDetail()
      viewer.scene.preRender.addEventListener(updateCloudDetail)
      cloudLayerRef.current = cloudLayer
      viewer.imageryLayers.raiseToTop(cloudLayer)
      ;(cloudLayer as ImageryLayer & { __hsaDetailListener?: () => void }).__hsaDetailListener = updateCloudDetail
    }).catch(() => { if (!cancelled) onCloudError?.() })
    return () => {
      cancelled = true
      const cloudLayer = cloudLayerRef.current as (ImageryLayer & { __hsaDetailListener?: () => void }) | null
      if (cloudLayer?.__hsaDetailListener && !viewer.isDestroyed()) viewer.scene.preRender.removeEventListener(cloudLayer.__hsaDetailListener)
      removeCloudLayer()
      cloudShellRef.current.forEach((shell) => { if (!viewer.isDestroyed()) viewer.scene.primitives.remove(shell) })
      cloudShellRef.current = []
    }
  }, [cloudsEnabled, explorationActive, cloudOpacity, cloudShadowsEnabled, onCloudError])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    const visuals = aircraftVisualsRef.current
    const tracks = aircraftTracksRef.current
    const activeIds = new Set<string>()
    const now = JulianDate.now()
    const nextTime = JulianDate.addSeconds(now, AIRCRAFT_PREDICTION_SECONDS, new JulianDate())
    const currentTimestamp = Date.now()

    if (aircraftEnabled) {
      for (const aircraft of aircraftStates) {
        const id = aircraft.icao24
        activeIds.add(id)
        const currentPosition = Cartesian3.fromDegrees(aircraft.longitudeDeg, aircraft.latitudeDeg, aircraft.altitudeMeters)
        const track = tracks.get(id) ?? []
        const lastTrackPoint = track[track.length - 1]
        if (!lastTrackPoint) track.push({ timestamp: aircraft.lastContact * 1000 - AIRCRAFT_PREDICTION_SECONDS * 1000, position: predictAircraftPosition(aircraft, -AIRCRAFT_PREDICTION_SECONDS) })
        if (!lastTrackPoint || lastTrackPoint.timestamp < aircraft.lastContact * 1000) track.push({ timestamp: aircraft.lastContact * 1000, position: currentPosition })
        const cutoff = currentTimestamp - AIRCRAFT_ROUTE_RETENTION_MS
        while (track.length > 2 && track[0].timestamp < cutoff) track.shift()
        tracks.set(id, track)

        let visual = visuals.get(id)
        if (!visual) {
          const position = new SampledPositionProperty()
          const entity = viewer.entities.add({
            id: `aircraft-${id}`,
            position,
            orientation: new VelocityOrientationProperty(position),
            properties: { aircraftId: id, callsign: aircraft.callsign ?? id },
            billboard: {
              image: AIRCRAFT_ICON,
              width: 19,
              height: 19,
              scaleByDistance: new NearFarScalar(100_000, 1.35, 25_000_000, 0.65),
              translucencyByDistance: new NearFarScalar(100_000, 1, 30_000_000, 0.35),
            },
          })
          const route = viewer.entities.add({
            id: `aircraft-route-${id}`,
            polyline: {
              positions: [],
              width: 1.25,
              material: Color.fromCssColorString('#ffcf9a').withAlpha(0.55),
              depthFailMaterial: Color.fromCssColorString('#d89b67').withAlpha(0.22),
              show: aircraftRoutesEnabled,
            },
          })
          visual = { entity, route, position }
          visuals.set(id, visual)
        }

        const position = new SampledPositionProperty()
        position.addSample(now, currentPosition)
        position.addSample(nextTime, predictAircraftPosition(aircraft, AIRCRAFT_PREDICTION_SECONDS))
        visual.position = position
        visual.entity.position = position
        visual.entity.orientation = new VelocityOrientationProperty(position)
        if (visual.route.polyline) {
          visual.route.polyline.positions = new ConstantProperty(track.map((point) => point.position))
          visual.route.polyline.show = new ConstantProperty(aircraftRoutesEnabled && selectedAircraftId === id && track.length > 1)
        }
        visual.entity.show = true
      }
    }

    for (const [id, visual] of visuals) {
      if (activeIds.has(id)) continue
      viewer.entities.remove(visual.entity)
      viewer.entities.remove(visual.route)
      visuals.delete(id)
      tracks.delete(id)
    }
  }, [aircraftEnabled, aircraftRoutesEnabled, aircraftStates, selectedAircraftId])

  useEffect(() => {
    const worker = workerRef.current
    if (!worker) return
    const generation = generationRef.current + 1
    generationRef.current = generation
    worker.postMessage({ type: 'LOAD_CATALOG', generation, objects } satisfies WorkerCommand)
  }, [objects])

  useEffect(() => {
    const points = pointsRef.current
    const labels = labelsRef.current
    if (!points) return

    points.removeAll()
    labels?.removeAll()
    for (const object of objects) {
      points.add({
        position: Cartesian3.ZERO,
        pixelSize: POINT_SIZE,
        scaleByDistance: new NearFarScalar(1_000, 1.5, 20_000_000, 0.6),
        color: object.NORAD_CAT_ID === selectedId ? Color.CYAN : Color.WHITE,
        outlineColor: Color.fromCssColorString('#0b1023'),
        outlineWidth: 1,
        id: { catalogId: object.NORAD_CAT_ID },
        show: false,
      })
      labels?.add({
        position: Cartesian3.ZERO,
        text: object.OBJECT_NAME,
        font: '11px sans-serif',
        fillColor: object.NORAD_CAT_ID === selectedId ? Color.CYAN : Color.WHITE,
        outlineColor: Color.fromCssColorString('#02040b'),
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        scaleByDistance: new NearFarScalar(1_000, 1, 4_000_000, 0.65),
        show: false,
      })
    }
  }, [objects, selectedId])

  useEffect(() => {
    const viewer = viewerRef.current
    const labels = labelsRef.current
    if (!viewer || !labels) return
    const updateLabels = () => {
      const cameraPosition = viewer.camera.positionWC
      for (let index = 0; index < labels.length; index += 1) {
        const label = labels.get(index)
        const object = objects[index]
        const point = pointsRef.current?.get(index)
        if (!object || !point || !point.show || explorationActive) {
          label.show = false
          continue
        }
        const nearCamera = Cartesian3.distance(cameraPosition, point.position) < 1_600_000
        label.position = point.position
        label.show = object.NORAD_CAT_ID === selectedId || nearCamera
      }
    }
    updateLabels()
    viewer.scene.preRender.addEventListener(updateLabels)
    return () => { if (!viewer.isDestroyed()) viewer.scene.preRender.removeEventListener(updateLabels) }
  }, [objects, selectedId, explorationActive])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    for (const entity of viewer.entities.values.filter((item) => String(item.id).startsWith('earth-event-'))) viewer.entities.remove(entity)
    if (!earthEventsEnabled) return
    const allowed = new Set(eventCategories)
    const eventVisuals: Array<{ entity: Entity; anchor: Cartesian3 }> = []
    for (const event of earthEvents) {
      if (allowed.size && !allowed.has(event.categoryId)) continue
      const color = Color.fromCssColorString(eventColor(event.categoryId))
      const id = `earth-event-${event.id}`
      if (event.geometry.type === 'Point') {
        const anchor = Cartesian3.fromDegrees(event.geometry.coordinates[0], event.geometry.coordinates[1])
        const entity = viewer.entities.add({
          id,
          position: anchor,
          properties: { earthEventId: event.id },
          point: { pixelSize: 10, color, outlineColor: Color.WHITE, outlineWidth: 1, heightReference: HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        })
        eventVisuals.push({ entity, anchor })
      } else {
        const anchorCoordinates = event.geometry.coordinates.reduce((sum, [longitude, latitude]) => [sum[0] + longitude, sum[1] + latitude], [0, 0])
        const anchor = Cartesian3.fromDegrees(anchorCoordinates[0] / event.geometry.coordinates.length, anchorCoordinates[1] / event.geometry.coordinates.length)
        const entity = viewer.entities.add({
          id,
          properties: { earthEventId: event.id },
          polygon: {
            hierarchy: new ConstantProperty(Cartesian3.fromDegreesArray(event.geometry.coordinates.flat())),
            material: new ColorMaterialProperty(color.withAlpha(0.22)),
            outline: new ConstantProperty(true),
            outlineColor: new ConstantProperty(color),
            classificationType: new ConstantProperty(ClassificationType.TERRAIN),
          },
        })
        eventVisuals.push({ entity, anchor })
      }
    }

    const cameraNormal = new Cartesian3()
    const eventNormal = new Cartesian3()
    const updateEventVisibility = () => {
      if (viewer.isDestroyed()) return
      Cartesian3.normalize(viewer.camera.positionWC, cameraNormal)
      for (const { entity, anchor } of eventVisuals) {
        Cartesian3.normalize(anchor, eventNormal)
        // EONET markers are only useful on the hemisphere facing the camera.
        // This also prevents the old always-on depth bypass from showing
        // orange points through the planet from the far side.
        entity.show = Cartesian3.dot(cameraNormal, eventNormal) > 0.08
      }
    }
    updateEventVisibility()
    viewer.scene.preRender.addEventListener(updateEventVisibility)
    return () => {
      if (!viewer.isDestroyed()) viewer.scene.preRender.removeEventListener(updateEventVisibility)
    }
  }, [earthEvents, earthEventsEnabled, eventCategories, onEarthEventSelect])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || eventViewRequest === 0 || !eventViewPosition) return
    viewer.camera.flyTo({ destination: eventViewPosition, duration: 0.8 })
  }, [eventViewRequest, eventViewPosition])

  useEffect(() => {
    if (!explorationActive || !pointsRef.current) return
    for (let index = 0; index < pointsRef.current.length; index += 1) pointsRef.current.get(index).show = false
  }, [explorationActive])

  useEffect(() => {
    const worker = workerRef.current
    const points = pointsRef.current
    if (!worker || !points || objects.length === 0) return
    const generation = generationRef.current
    const pointById = new Map(objects.map((object, index) => [object.NORAD_CAT_ID, points.get(index)]))
    const labelById = new Map(objects.map((object, index) => [object.NORAD_CAT_ID, labelsRef.current?.get(index)]))
    const transitions = new Map<number, { point: ReturnType<PointPrimitiveCollection['get']>; from: Cartesian3; to: Cartesian3; startedAt: number }>()
    const initialized = new Set<number>()
    let animationFrame = 0
    const animateTransitions = (now: number) => {
      let active = false
      for (const transition of transitions.values()) {
        const progress = Math.min(1, (now - transition.startedAt) / SATELLITE_INTERPOLATION_MS)
        Cartesian3.lerp(transition.from, transition.to, progress, transition.point.position)
        if (progress < 1) active = true
      }
      if (active) animationFrame = requestAnimationFrame(animateTransitions)
      else animationFrame = 0
    }
    const onMessage = (event: MessageEvent<WorkerResult>) => {
      const result = event.data
      if (result.type !== 'POSITIONS' || result.generation !== generation || !shouldApplyPositionResult(result.requestId, latestAppliedRequestRef.current)) return
      latestAppliedRequestRef.current = result.requestId
      const applyStarted = performance.now()
      const receivedAt = performance.now()
      for (let i = 0; i < result.ids.length; i += 1) {
        const point = pointById.get(result.ids[i])
        if (!point) continue
        const label = labelById.get(result.ids[i])
        const nextPosition = Cartesian3.fromDegrees(result.values[i * 3], result.values[i * 3 + 1], result.values[i * 3 + 2])
        if (!initialized.has(result.ids[i])) {
          point.position = nextPosition
          initialized.add(result.ids[i])
        } else {
          transitions.set(result.ids[i], { point, from: point.position.clone(), to: nextPosition, startedAt: receivedAt })
        }
        point.color = result.ids[i] === selectedId ? Color.CYAN : Color.WHITE
        point.pixelSize = result.ids[i] === selectedId ? 10 : POINT_SIZE
        if (label) {
          label.position = point.position
          label.fillColor = result.ids[i] === selectedId ? Color.CYAN : Color.WHITE
        }
        // Catalog markers stay out of Explore so they cannot be mistaken for
        // cloud particles around the spacecraft.
        point.show = !explorationActive
      }
      if (!animationFrame && transitions.size > 0) animationFrame = requestAnimationFrame(animateTransitions)
      onPerformance?.({ workerMs: result.elapsedMs, applyMs: performance.now() - applyStarted, transferBytes: result.values.byteLength, pending: Math.max(0, requestRef.current - result.requestId) })
    }
    worker.addEventListener('message', onMessage)
    return () => {
      worker.removeEventListener('message', onMessage)
      if (animationFrame) cancelAnimationFrame(animationFrame)
      transitions.clear()
    }
  }, [objects, selectedId, explorationActive, onPerformance])

  useEffect(() => {
    const worker = workerRef.current
    if (!worker || objects.length === 0) return
    const requestId = requestRef.current + 1
    requestRef.current = requestId
    worker.postMessage({ type: 'PROPAGATE', generation: generationRef.current, requestId, timeMs: simulatedAt.getTime() } satisfies WorkerCommand)
  }, [objects, simulatedAt])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return

    const orbit = orbitEntityRef.current
    const trail = satelliteTrailEntityRef.current
    if (!orbitsEnabled || selectedId === null) {
      if (orbit) orbit.show = false
      if (trail) trail.show = false
      return
    }

    const satrec = satrecs.get(selectedId)
    if (!satrec) {
      if (orbit) orbit.show = false
      if (trail) trail.show = false
      return
    }

    const positions = sampleOrbit(satrec, simulatedAt).map((state) =>
      Cartesian3.fromDegrees(state.longitudeDeg, state.latitudeDeg, toCesiumHeightMeters(state.altitudeKm)),
    )

    if (positions.length > 1) {
      const orbitPositions = orbitPositionsRef.current ?? new ConstantProperty(positions)
      const orbitEntity = orbitEntityRef.current ?? viewer.entities.add({
        id: 'selected-orbit',
        polyline: {
          positions: orbitPositions,
          width: 1.5,
          material: Color.CYAN.withAlpha(0.7),
          depthFailMaterial: Color.CYAN.withAlpha(0.2),
          show: true,
        },
      })
      orbitPositionsRef.current = orbitPositions
      orbitEntityRef.current = orbitEntity
      orbitEntity.show = true
      orbitPositions.setValue(positions)
    }
    if (satelliteTrailsEnabled) {
      const trailPositions = sampleOrbit(satrec, new Date(simulatedAt.getTime() - 90_000), 3, 10).map((state) =>
        Cartesian3.fromDegrees(state.longitudeDeg, state.latitudeDeg, toCesiumHeightMeters(state.altitudeKm)),
      )
      if (trailPositions.length > 1) {
        const trailPositionsProperty = satelliteTrailPositionsRef.current ?? new ConstantProperty(trailPositions)
        const trailEntity = satelliteTrailEntityRef.current ?? viewer.entities.add({
          id: 'selected-satellite-trail',
          polyline: {
            positions: trailPositionsProperty,
            width: 3,
            material: Color.fromCssColorString('#a9edff').withAlpha(0.38),
            depthFailMaterial: Color.fromCssColorString('#a9edff').withAlpha(0.14),
            show: true,
          },
        })
        satelliteTrailPositionsRef.current = trailPositionsProperty
        satelliteTrailEntityRef.current = trailEntity
        trailEntity.show = true
        trailPositionsProperty.setValue(trailPositions)
      } else if (satelliteTrailEntityRef.current) {
        satelliteTrailEntityRef.current.show = false
      }
    } else if (satelliteTrailEntityRef.current) {
      satelliteTrailEntityRef.current.show = false
    }
  }, [satrecs, selectedId, orbitsEnabled, satelliteTrailsEnabled])

  return <div className="globe" ref={containerRef} />
}
