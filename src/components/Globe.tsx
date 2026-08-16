import { useEffect, useMemo, useRef } from 'react'
import {
  Cartesian3,
  Cartesian2,
  Color,
  Ion,
  PointPrimitiveCollection,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Viewer,
} from 'cesium'
import type { OmmRecord } from '../lib/types'
import { createSatrec, sampleOrbit, toCesiumHeightMeters } from '../lib/orbit'
import type { WorkerCommand, WorkerResult } from '../workers/orbitProtocol'
import { shouldApplyPositionResult } from '../workers/workerState'

interface GlobeProps {
  objects: OmmRecord[]
  simulatedAt: Date
  selectedId: number | null
  onSelect: (catalogId: number | null) => void
}

const POINT_SIZE = 5

export function Globe({ objects, simulatedAt, selectedId, onSelect }: GlobeProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Viewer | null>(null)
  const pointsRef = useRef<PointPrimitiveCollection | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const generationRef = useRef(0)
  const requestRef = useRef(0)
  const latestAppliedRequestRef = useRef(0)

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
      baseLayerPicker: true,
      geocoder: false,
      homeButton: true,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      shouldAnimate: true,
    })

    viewer.scene.globe.enableLighting = true
    viewer.scene.backgroundColor = Color.fromCssColorString('#02040b')

    const points = viewer.scene.primitives.add(new PointPrimitiveCollection())
    pointsRef.current = points
    viewerRef.current = viewer

    const worker = new Worker(new URL('../workers/orbit.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker

    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas)
    handler.setInputAction((movement: { position: Cartesian2 }) => {
      const picked = viewer.scene.pick(movement.position)
      const id = picked?.id?.catalogId
      onSelect(typeof id === 'number' ? id : null)
    }, ScreenSpaceEventType.LEFT_CLICK)

    return () => {
      handler.destroy()
      pointsRef.current = null
      worker.postMessage({ type: 'DISPOSE' } satisfies WorkerCommand)
      workerRef.current = null
      viewerRef.current = null
      viewer.destroy()
    }
  }, [onSelect])

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
      const pointById = new Map(objects.map((object, index) => [object.NORAD_CAT_ID, points.get(index)]))
      for (let i = 0; i < result.ids.length; i += 1) {
        const point = pointById.get(result.ids[i])
        if (!point) continue
        point.position = Cartesian3.fromDegrees(result.values[i * 3], result.values[i * 3 + 1], result.values[i * 3 + 2])
        point.color = result.ids[i] === selectedId ? Color.CYAN : Color.WHITE
        point.pixelSize = result.ids[i] === selectedId ? 10 : POINT_SIZE
        point.show = true
      }
    }
    worker.addEventListener('message', onMessage)
    worker.postMessage({ type: 'PROPAGATE', generation, requestId, timeMs: simulatedAt.getTime() } satisfies WorkerCommand)
    return () => worker.removeEventListener('message', onMessage)
  }, [objects, selectedId, simulatedAt])

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
