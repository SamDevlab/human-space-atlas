import { useEffect, useMemo, useRef } from 'react'
import {
  Cartesian3,
  Cartesian2,
  Color,
  Ellipsoid,
  EllipsoidGeometry,
  GeometryInstance,
  ImageryLayer,
  Ion,
  Material,
  MaterialAppearance,
  PointPrimitiveCollection,
  Primitive,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  VertexFormat,
  Viewer,
} from 'cesium'
import { discoverMapStyles } from '../lib/mapStyles'
import { createNasaCloudProvider } from '../lib/earthLayers'
import { eventColor } from '../lib/earthEvents'
import type { EarthEvent } from '../lib/earthEvents'
import type { OmmRecord } from '../lib/types'
import { createSatrec, sampleOrbit, toCesiumHeightMeters } from '../lib/orbit'
import type { WorkerCommand, WorkerResult } from '../workers/orbitProtocol'
import { shouldApplyPositionResult } from '../workers/workerState'
import { ExplorationController } from '../exploration/ExplorationController'
import type { ExplorationHudSnapshot } from '../exploration/types'

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
  onCloudError?: () => void
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
  autopilotAction?: 'ENGAGE' | 'CANCEL' | null
  autopilotRequest?: number
  onExplorationHud?: (snapshot: ExplorationHudSnapshot) => void
  onExitExplore?: () => void
  onOpenExploreNav?: () => void
  onExploreActivity?: () => void
  explorationSteeringSensitivity?: number
  explorationCameraSensitivity?: number
}

const POINT_SIZE = 5

export function Globe({ objects, simulatedAt, selectedId, onSelect, onPerformance, homeRequest = 0, mapStyle = 'satellite', cloudsEnabled = true, cloudOpacity = 0.55, onCloudError, earthEvents = [], earthEventsEnabled = true, eventCategories = [], onEarthEventSelect, eventViewRequest = 0, eventViewPosition = null, onMapStyleError, onMapStyleLoading, explorationActive = false, targetPosition = null, targetVelocity = null, targetName = null, autopilotAction = null, autopilotRequest = 0, onExplorationHud, onExitExplore, onOpenExploreNav, onExploreActivity, explorationSteeringSensitivity = 1, explorationCameraSensitivity = 1 }: GlobeProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Viewer | null>(null)
  const pointsRef = useRef<PointPrimitiveCollection | null>(null)
  const atmospherePrimitiveRef = useRef<Primitive | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const generationRef = useRef(0)
  const requestRef = useRef(0)
  const latestAppliedRequestRef = useRef(0)
  const defaultImageryRef = useRef<unknown>(null)
  const cloudLayerRef = useRef<ImageryLayer | null>(null)
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
    })

    viewer.camera.setView({ destination: Cartesian3.fromDegrees(-18, 18, 18_000_000) })
    defaultImageryRef.current = viewer.imageryLayers.get(0)?.imageryProvider ?? null

    viewer.scene.globe.enableLighting = true
    viewer.scene.globe.showGroundAtmosphere = true
    viewer.scene.globe.dynamicAtmosphereLighting = true
    viewer.scene.globe.dynamicAtmosphereLightingFromSun = true
    viewer.scene.globe.atmosphereLightIntensity = 18
    viewer.scene.globe.atmosphereBrightnessShift = 0.02
    viewer.scene.globe.atmosphereSaturationShift = 0.18
    const skyAtmosphere = viewer.scene.skyAtmosphere
    if (skyAtmosphere) {
      skyAtmosphere.show = true
      skyAtmosphere.perFragmentAtmosphere = true
      skyAtmosphere.atmosphereLightIntensity = 72
      skyAtmosphere.brightnessShift = 0.02
      skyAtmosphere.saturationShift = 0.16
    }
    viewer.scene.backgroundColor = Color.fromCssColorString('#02040b')

    const atmosphereRadii = Cartesian3.multiplyByScalar(Ellipsoid.WGS84.radii, 1.014, new Cartesian3())
    const atmospherePrimitive = viewer.scene.primitives.add(new Primitive({
      geometryInstances: new GeometryInstance({
        geometry: new EllipsoidGeometry({
          radii: atmosphereRadii,
          stackPartitions: 48,
          slicePartitions: 64,
          vertexFormat: VertexFormat.POSITION_AND_NORMAL,
        }),
      }),
      appearance: new MaterialAppearance({
        material: Material.fromType('RimLighting', {
          color: Color.WHITE.withAlpha(0),
          rimColor: Color.fromCssColorString('#56bfff').withAlpha(0.26),
          width: 0.42,
        }),
        faceForward: true,
        translucent: true,
        closed: false,
        materialSupport: MaterialAppearance.MaterialSupport.BASIC,
      }),
      allowPicking: false,
      asynchronous: false,
      cull: false,
    }))
    atmospherePrimitiveRef.current = atmospherePrimitive

    const points = viewer.scene.primitives.add(new PointPrimitiveCollection())
    pointsRef.current = points
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
      const id = picked?.id?.catalogId
      onSelect(typeof id === 'number' ? id : null)
    }, ScreenSpaceEventType.LEFT_CLICK)

    return () => {
      handler.destroy()
      pointsRef.current = null
      atmospherePrimitiveRef.current = null
      worker.postMessage({ type: 'DISPOSE' } satisfies WorkerCommand)
      workerRef.current = null
      explorationRef.current?.destroy()
      explorationRef.current = null
      viewerRef.current = null
      viewer.destroy()
    }
  }, [onSelect, onExplorationHud, onExitExplore, onOpenExploreNav, onExploreActivity])

  useEffect(() => {
    const controller = explorationRef.current
    if (!controller) return
    if (explorationActive) controller.enter(targetPosition, targetName, targetVelocity)
    else controller.exit()
  }, [explorationActive])

  useEffect(() => { explorationRef.current?.setTarget(targetPosition, targetName, targetVelocity) }, [targetPosition, targetName, targetVelocity])
  useEffect(() => {
    const controller = explorationRef.current
    if (!controller || !autopilotAction || autopilotRequest === 0) return
    if (autopilotAction === 'ENGAGE') controller.engageAutopilot()
    else controller.cancelAutopilot()
  }, [autopilotAction, autopilotRequest])
  useEffect(() => {
    explorationRef.current?.setSteeringSensitivity(explorationSteeringSensitivity)
    explorationRef.current?.setCameraSensitivity(explorationCameraSensitivity)
  }, [explorationSteeringSensitivity, explorationCameraSensitivity])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || homeRequest === 0) return
    viewer.camera.flyTo({ destination: Cartesian3.fromDegrees(-18, 18, 18_000_000), duration: 0.8 })
  }, [homeRequest])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    const requestId = imageryRequestRef.current + 1
    imageryRequestRef.current = requestId
    const definition = discoverMapStyles().find((style) => style.id === mapStyle) ?? discoverMapStyles()[0]
    const current = viewer.imageryLayers.get(0)
    if (!current) { onMapStyleLoading?.(false); return }
    let cancelled = false
    if (definition.isDefault) {
      if (defaultImageryRef.current && current.imageryProvider !== defaultImageryRef.current) {
        viewer.imageryLayers.remove(current, false)
        viewer.imageryLayers.addImageryProvider(defaultImageryRef.current as Parameters<typeof viewer.imageryLayers.addImageryProvider>[0])
        if (cloudLayerRef.current) viewer.imageryLayers.raiseToTop(cloudLayerRef.current)
      }
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
    if (!viewer) return
    let cancelled = false
    if (!viewer.isDestroyed() && cloudLayerRef.current) {
      viewer.imageryLayers.remove(cloudLayerRef.current, false)
      cloudLayerRef.current = null
    }
    if (!cloudsEnabled) return
    createNasaCloudProvider().then((provider) => {
      if (cancelled || viewer.isDestroyed()) return
      const layer = viewer.imageryLayers.addImageryProvider(provider)
      layer.alpha = cloudOpacity
      cloudLayerRef.current = layer
      viewer.imageryLayers.raiseToTop(layer)
    }).catch(() => { if (!cancelled) onCloudError?.() })
    return () => {
      cancelled = true
      if (!viewer.isDestroyed() && cloudLayerRef.current) {
        viewer.imageryLayers.remove(cloudLayerRef.current, false)
        cloudLayerRef.current = null
      }
    }
  }, [cloudsEnabled, onCloudError])

  useEffect(() => {
    if (cloudLayerRef.current) cloudLayerRef.current.alpha = Math.max(0, Math.min(1, cloudOpacity))
  }, [cloudOpacity])

  useEffect(() => {
    const worker = workerRef.current
    if (!worker) return
    const generation = generationRef.current + 1
    generationRef.current = generation
    worker.postMessage({ type: 'LOAD_CATALOG', generation, objects } satisfies WorkerCommand)
  }, [objects])

  useEffect(() => {
    const points = pointsRef.current
    if (!points) return

    points.removeAll()
    for (const object of objects) {
      points.add({
        position: Cartesian3.ZERO,
        pixelSize: POINT_SIZE,
        color: object.NORAD_CAT_ID === selectedId ? Color.CYAN : Color.WHITE,
        outlineColor: Color.fromCssColorString('#0b1023'),
        outlineWidth: 1,
        id: { catalogId: object.NORAD_CAT_ID },
        show: false,
      })
    }
  }, [objects, selectedId])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    for (const entity of viewer.entities.values.filter((item) => String(item.id).startsWith('earth-event-'))) viewer.entities.remove(entity)
    if (!earthEventsEnabled) return
    const allowed = new Set(eventCategories)
    for (const event of earthEvents) {
      if (allowed.size && !allowed.has(event.categoryId)) continue
      const color = Color.fromCssColorString(eventColor(event.categoryId))
      const id = `earth-event-${event.id}`
      if (event.geometry.type === 'Point') {
        viewer.entities.add({
          id,
          position: Cartesian3.fromDegrees(event.geometry.coordinates[0], event.geometry.coordinates[1]),
          properties: { earthEventId: event.id },
          point: { pixelSize: 9, color, outlineColor: Color.WHITE, outlineWidth: 1, heightReference: 0 },
        })
      } else {
        viewer.entities.add({
          id,
          properties: { earthEventId: event.id },
          polygon: { hierarchy: Cartesian3.fromDegreesArray(event.geometry.coordinates.flat()), material: color.withAlpha(0.25), outline: true, outlineColor: color, height: 2_000 },
        })
      }
    }
  }, [earthEvents, earthEventsEnabled, eventCategories, onEarthEventSelect])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || eventViewRequest === 0 || !eventViewPosition) return
    viewer.camera.flyTo({ destination: eventViewPosition, duration: 0.8 })
  }, [eventViewRequest, eventViewPosition])

  useEffect(() => {
    const worker = workerRef.current
    const points = pointsRef.current
    if (!worker || !points || objects.length === 0) return
    const requestId = requestRef.current + 1
    requestRef.current = requestId
    const generation = generationRef.current
    const onMessage = (event: MessageEvent<WorkerResult>) => {
      const result = event.data
      if (result.type !== 'POSITIONS' || result.generation !== generation || !shouldApplyPositionResult(result.requestId, latestAppliedRequestRef.current)) return
      latestAppliedRequestRef.current = result.requestId
      const applyStarted = performance.now()
      const pointById = new Map(objects.map((object, index) => [object.NORAD_CAT_ID, points.get(index)]))
      for (let i = 0; i < result.ids.length; i += 1) {
        const point = pointById.get(result.ids[i])
        if (!point) continue
        point.position = Cartesian3.fromDegrees(result.values[i * 3], result.values[i * 3 + 1], result.values[i * 3 + 2])
        point.color = result.ids[i] === selectedId ? Color.CYAN : Color.WHITE
        point.pixelSize = result.ids[i] === selectedId ? 10 : POINT_SIZE
        point.show = true
      }
      onPerformance?.({ workerMs: result.elapsedMs, applyMs: performance.now() - applyStarted, transferBytes: result.values.byteLength, pending: Math.max(0, requestRef.current - result.requestId) })
    }
    worker.addEventListener('message', onMessage)
    worker.postMessage({ type: 'PROPAGATE', generation, requestId, timeMs: simulatedAt.getTime() } satisfies WorkerCommand)
    return () => worker.removeEventListener('message', onMessage)
  }, [objects, selectedId, simulatedAt, onPerformance])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return

    const entityId = 'selected-orbit'
    viewer.entities.removeById(entityId)
    if (selectedId === null) return

    const satrec = satrecs.get(selectedId)
    if (!satrec) return

    const positions = sampleOrbit(satrec, simulatedAt).map((state) =>
      Cartesian3.fromDegrees(state.longitudeDeg, state.latitudeDeg, toCesiumHeightMeters(state.altitudeKm)),
    )

    if (positions.length > 1) {
      viewer.entities.add({
        id: entityId,
        polyline: {
          positions,
          width: 1.5,
          material: Color.CYAN.withAlpha(0.7),
        },
      })
    }
  }, [satrecs, selectedId])

  return <div className="globe" ref={containerRef} />
}
