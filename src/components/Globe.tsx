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
import { createSatrec, getOrbitState, sampleOrbit } from '../lib/orbit'

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

  const satrecs = useMemo(() => {
    const map = new Map<number, ReturnType<typeof createSatrec>>()
    for (const object of objects) {
      try {
        map.set(object.NORAD_CAT_ID, createSatrec(object))
      } catch {
        // Ignore malformed public records rather than breaking the whole scene.
      }
    }
    return map
  }, [objects])

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

    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas)
    handler.setInputAction((movement: { position: Cartesian2 }) => {
      const picked = viewer.scene.pick(movement.position)
      const id = picked?.id?.catalogId
      onSelect(typeof id === 'number' ? id : null)
    }, ScreenSpaceEventType.LEFT_CLICK)

    return () => {
      handler.destroy()
      pointsRef.current = null
      viewerRef.current = null
      viewer.destroy()
    }
  }, [onSelect])

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
    const points = pointsRef.current
    if (!points) return

    for (let i = 0; i < objects.length; i += 1) {
      const object = objects[i]
      const point = points.get(i)
      const satrec = satrecs.get(object.NORAD_CAT_ID)
      if (!point || !satrec) continue

      const state = getOrbitState(satrec, simulatedAt)
      if (!state) {
        point.show = false
        continue
      }

      point.position = Cartesian3.fromDegrees(
        state.longitudeDeg,
        state.latitudeDeg,
        state.altitudeKm * 1000,
      )
      point.color = object.NORAD_CAT_ID === selectedId ? Color.CYAN : Color.WHITE
      point.pixelSize = object.NORAD_CAT_ID === selectedId ? 10 : POINT_SIZE
      point.show = true
    }
  }, [objects, satrecs, selectedId, simulatedAt])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return

    const entityId = 'selected-orbit'
    viewer.entities.removeById(entityId)
    if (selectedId === null) return

    const satrec = satrecs.get(selectedId)
    if (!satrec) return

    const positions = sampleOrbit(satrec, simulatedAt).map((state) =>
      Cartesian3.fromDegrees(state.longitudeDeg, state.latitudeDeg, state.altitudeKm * 1000),
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
