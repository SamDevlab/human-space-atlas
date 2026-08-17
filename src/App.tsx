import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Cartesian3, Quaternion } from 'cesium'
import { Globe } from './components/Globe'
import { ExplorationHud } from './components/ExplorationHud'
import { ExploreNav } from './components/ExploreNav'
import { ExploreSettings } from './components/ExploreSettings'
import { AtlasSettings } from './components/AtlasSettings'
import { PerformanceOverlay } from './components/PerformanceOverlay'
import { fetchAircraftStates, fetchCatalog, fetchEarthEvents } from './lib/api'
import { createSatrec, getOrbitState, toCesiumHeightMeters } from './lib/orbit'
import { advanceSimulatedTime } from './lib/simulationClock'
import { filterCatalog, normalizeCatalog } from './lib/orbitalCatalog'
import { generateSyntheticCatalog } from './lib/syntheticCatalog'
import { discoverMapStyles } from './lib/mapStyles'
import { EARTH_EVENT_CATEGORIES, normalizeEarthEvents } from './lib/earthEvents'
import type { EarthEvent } from './lib/earthEvents'
import { AutoRenderController, resolveRenderLimit, selectRenderSet, type RenderMode, RENDER_LIMITS } from './lib/renderSet'
import type { CatalogGroup, OmmRecord } from './lib/types'
import type { ExplorationCameraPreset, ExplorationHudSnapshot } from './exploration/types'
import type { AircraftState } from './lib/airTraffic'

const GROUPS: Array<{ value: CatalogGroup; label: string }> = [
  { value: 'stations', label: 'Estações' },
  { value: 'active', label: 'Satélites ativos' },
  { value: 'starlink', label: 'Starlink' },
  { value: 'gps-ops', label: 'GPS operacional' },
]

const SPEEDS = [0, 1, 10, 100]

function App() {
  const benchmarkCount = Number(new URLSearchParams(window.location.search).get('benchmark') ?? 0)
  const benchmarkRenderLimit = Number(new URLSearchParams(window.location.search).get('renderLimit') ?? 0)
  const debugFlight = new URLSearchParams(window.location.search).get('debug') === 'flight'
  const [group, setGroup] = useState<CatalogGroup>('stations')
  const [objects, setObjects] = useState<OmmRecord[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [simulatedAt, setSimulatedAt] = useState(() => new Date())
  const [speed, setSpeed] = useState(1)
  const [objectKind, setObjectKind] = useState('ALL')
  const [objectQuery, setObjectQuery] = useState('')
  const [explorerOpen, setExplorerOpen] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [searchFocused, setSearchFocused] = useState(false)
  const [homeRequest, setHomeRequest] = useState(0)
  const mapStyles = useMemo(() => discoverMapStyles(), [])
  const [mapStyle, setMapStyle] = useState(() => { const saved = localStorage.getItem('human-space-atlas.map-style-v2'); return saved && mapStyles.some((style) => style.id === saved) ? saved : 'satellite' })
  const [mapStyleLoading, setMapStyleLoading] = useState(false)
  const [cloudsEnabled, setCloudsEnabled] = useState(() => localStorage.getItem('human-space-atlas.clouds-enabled') !== '0')
  const [cloudOpacity, setCloudOpacity] = useState(() => {
    const savedValue = localStorage.getItem('human-space-atlas.cloud-opacity-v3')
    const saved = savedValue === null ? null : Number(savedValue)
    return saved !== null && Number.isFinite(saved) ? Math.min(0.7, Math.max(0, saved)) : 0.5
  })
  const [cloudShadowsEnabled, setCloudShadowsEnabled] = useState(() => localStorage.getItem('human-space-atlas.cloud-shadows-enabled') !== '0')
  const [atmosphereEnabled, setAtmosphereEnabled] = useState(() => localStorage.getItem('human-space-atlas.atmosphere-enabled') !== '0')
  const [terrainEnabled, setTerrainEnabled] = useState(() => localStorage.getItem('human-space-atlas.terrain-enabled') !== '0')
  const [orbitsEnabled, setOrbitsEnabled] = useState(false)
  const [satelliteTrailsEnabled, setSatelliteTrailsEnabled] = useState(() => localStorage.getItem('human-space-atlas.satellite-trails-enabled') === '1')
  const [terrainLoading, setTerrainLoading] = useState(true)
  const [aircraftEnabled, setAircraftEnabled] = useState(() => localStorage.getItem('human-space-atlas.aircraft-enabled') !== '0')
  const [aircraftRoutesEnabled, setAircraftRoutesEnabled] = useState(() => localStorage.getItem('human-space-atlas.aircraft-routes-enabled') !== '0')
  const [aircraftDensity, setAircraftDensity] = useState(() => {
    const saved = Number(localStorage.getItem('human-space-atlas.aircraft-density'))
    return Number.isFinite(saved) ? Math.min(300, Math.max(25, Math.round(saved / 25) * 25)) : 125
  })
  const [aircraftStates, setAircraftStates] = useState<AircraftState[]>([])
  const [selectedAircraftId, setSelectedAircraftId] = useState<string | null>(null)
  // Earth events are opt-in in the clean visual mode. The versioned key also
  // prevents an older session that had events enabled from re-enabling them
  // on the first visit after this visual change.
  const [earthEventsEnabled, setEarthEventsEnabled] = useState(() => localStorage.getItem('human-space-atlas.earth-events-enabled-v2') === '1')
  const [eventCategories, setEventCategories] = useState<string[]>(() => EARTH_EVENT_CATEGORIES.map((category) => category.id))
  const [earthEvents, setEarthEvents] = useState<EarthEvent[]>([])
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null)
  const [eventViewRequest, setEventViewRequest] = useState(0)
  const [eventViewPosition, setEventViewPosition] = useState<Cartesian3 | null>(null)
  const [explorationActive, setExplorationActive] = useState(true)
  const [exploreUiOpen, setExploreUiOpen] = useState(false)
  const [exploreNavOpen, setExploreNavOpen] = useState(false)
  const [exploreNavQuery, setExploreNavQuery] = useState('')
  const [exploreSettingsOpen, setExploreSettingsOpen] = useState(false)
  const [exploreCameraSensitivity, setExploreCameraSensitivity] = useState(() => Number(localStorage.getItem('human-space-atlas.explore-camera-sensitivity') ?? 1))
  const [exploreCameraPreset, setExploreCameraPreset] = useState<ExplorationCameraPreset>(() => (localStorage.getItem('human-space-atlas.explore-camera-preset') as ExplorationCameraPreset | null) ?? 'FOLLOW')
  const [exploreControlsVisible, setExploreControlsVisible] = useState(false)
  const [exploreObjectMarkerEnabled, setExploreObjectMarkerEnabled] = useState(() => localStorage.getItem('human-space-atlas.explore-object-marker') !== '0')
  const [explorationHud, setExplorationHud] = useState<ExplorationHudSnapshot>({ altitudeKm: 0, speedKmS: 0, throttle: 0, cameraMode: 'THIRD_PERSON', cameraDistanceMeters: 7500, cameraOrbiting: false, flightAssist: true, boostActive: false, lowAltitude: false, targetName: null, targetDistanceKm: null, targetIndicator: null, debugFlight: { mouseDx: 0, mouseDy: 0, yawRate: 0, pitchRate: 0, rollRate: 0, throttle: 0, velocity: Cartesian3.ZERO, forward: Cartesian3.UNIT_X, orientation: Quaternion.IDENTITY, pointerLock: false } })
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [status, setStatus] = useState('Carregando catálogo…')
  const [error, setError] = useState<string | null>(null)
  const [performanceMetric, setPerformanceMetric] = useState({ workerMs: 0, applyMs: 0, transferBytes: 0, pending: 0 })
  const [renderMode, setRenderMode] = useState<RenderMode>(() => benchmarkRenderLimit > 0 ? 'CUSTOM' : (localStorage.getItem('human-space-atlas.render-mode') as RenderMode | null) ?? 'AUTO')
  const [customLimit, setCustomLimit] = useState(() => benchmarkRenderLimit > 0 ? benchmarkRenderLimit : Number(localStorage.getItem('human-space-atlas.render-limit') ?? 5000))
  const [autoLimit, setAutoLimit] = useState(5000)
  const autoControllerRef = useRef(new AutoRenderController())
  const onPerformance = useCallback((metric: typeof performanceMetric) => setPerformanceMetric(metric), [])
  const onMapStyleError = useCallback(() => { setMapStyle('satellite'); setMapStyleLoading(false) }, [])
  const onMapStyleLoading = useCallback((loading: boolean) => setMapStyleLoading(loading), [])
  const onCloudError = useCallback(() => setCloudsEnabled(false), [])
  const onTerrainLoading = useCallback((loading: boolean) => setTerrainLoading(loading), [])
  const onExplorationHud = useCallback((snapshot: ExplorationHudSnapshot) => setExplorationHud(snapshot), [])
  const onExitExplore = useCallback(() => { setExploreNavOpen(false); setExploreSettingsOpen(false); setExploreUiOpen(false); setExplorationActive(false) }, [])
  const onOpenExploreNav = useCallback(() => { setExploreUiOpen(true); setExploreSettingsOpen(false); setExploreNavOpen(true) }, [])
  const onOpenExploreSettings = useCallback(() => { setExploreUiOpen(true); setExploreNavOpen(false); setExploreSettingsOpen(true) }, [])
  const onExploreActivity = useCallback(() => {
    setExploreControlsVisible((visible) => {
      if (visible) localStorage.setItem('human-space-atlas.explore-controls-seen', '1')
      return false
    })
  }, [])
  const dismissExploreControls = useCallback(() => {
    localStorage.setItem('human-space-atlas.explore-controls-seen', '1')
    setExploreControlsVisible(false)
  }, [])

  useEffect(() => {
    const closeOverlays = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchInputRef.current?.focus(); setSettingsOpen(false); setSearchFocused(true) }
      if (event.key === 'Escape') { setSettingsOpen(false); setSearchFocused(false); setExploreNavOpen(false); setExploreSettingsOpen(false) }
    }
    const closeOnOutside = (event: MouseEvent) => {
      const target = event.target as Element
      if (!target.closest('.search-wrap')) setSearchFocused(false)
      if (!target.closest('.settings-popover, .icon-button')) setSettingsOpen(false)
    }
    document.addEventListener('keydown', closeOverlays)
    document.addEventListener('mousedown', closeOnOutside)
    return () => { document.removeEventListener('keydown', closeOverlays); document.removeEventListener('mousedown', closeOnOutside) }
  }, [])

  useEffect(() => { localStorage.setItem('human-space-atlas.render-mode', renderMode) }, [renderMode])
  useEffect(() => { localStorage.setItem('human-space-atlas.render-limit', String(customLimit)) }, [customLimit])
  useEffect(() => { localStorage.setItem('human-space-atlas.map-style-v2', mapStyle) }, [mapStyle])
  useEffect(() => { localStorage.setItem('human-space-atlas.clouds-enabled', cloudsEnabled ? '1' : '0') }, [cloudsEnabled])
  useEffect(() => { localStorage.setItem('human-space-atlas.cloud-opacity-v3', String(cloudOpacity)) }, [cloudOpacity])
  useEffect(() => { localStorage.setItem('human-space-atlas.cloud-shadows-enabled', cloudShadowsEnabled ? '1' : '0') }, [cloudShadowsEnabled])
  useEffect(() => { localStorage.setItem('human-space-atlas.atmosphere-enabled', atmosphereEnabled ? '1' : '0') }, [atmosphereEnabled])
  useEffect(() => { localStorage.setItem('human-space-atlas.terrain-enabled', terrainEnabled ? '1' : '0') }, [terrainEnabled])
  useEffect(() => { localStorage.setItem('human-space-atlas.orbits-enabled', orbitsEnabled ? '1' : '0') }, [orbitsEnabled])
  useEffect(() => { localStorage.setItem('human-space-atlas.satellite-trails-enabled', satelliteTrailsEnabled ? '1' : '0') }, [satelliteTrailsEnabled])
  useEffect(() => { localStorage.setItem('human-space-atlas.aircraft-enabled', aircraftEnabled ? '1' : '0') }, [aircraftEnabled])
  useEffect(() => { localStorage.setItem('human-space-atlas.aircraft-routes-enabled', aircraftRoutesEnabled ? '1' : '0') }, [aircraftRoutesEnabled])
  useEffect(() => { localStorage.setItem('human-space-atlas.aircraft-density', String(aircraftDensity)) }, [aircraftDensity])
  useEffect(() => { localStorage.setItem('human-space-atlas.earth-events-enabled-v2', earthEventsEnabled ? '1' : '0') }, [earthEventsEnabled])
  useEffect(() => { localStorage.setItem('human-space-atlas.explore-camera-sensitivity', String(exploreCameraSensitivity)) }, [exploreCameraSensitivity])
  useEffect(() => { localStorage.setItem('human-space-atlas.explore-camera-preset', exploreCameraPreset) }, [exploreCameraPreset])
  useEffect(() => { localStorage.setItem('human-space-atlas.explore-object-marker', exploreObjectMarkerEnabled ? '1' : '0') }, [exploreObjectMarkerEnabled])
  useEffect(() => {
    if (renderMode === 'AUTO') setAutoLimit(autoControllerRef.current.update(performanceMetric, performance.now()))
  }, [performanceMetric, renderMode])

  useEffect(() => {
    const controller = new AbortController()
    setError(null)
    setStatus('Loading orbital catalog…')
    setSelectedId(null)

    if (benchmarkCount > 0) {
      try {
        const synthetic = generateSyntheticCatalog(benchmarkCount)
        setObjects(synthetic)
        setStatus(`${synthetic.length.toLocaleString('en-US')} objects · synthetic benchmark READY`)
      } catch (err) {
        setObjects([])
        setError(err instanceof Error ? err.message : 'Benchmark inválido')
        setStatus('Benchmark unavailable')
      }
      return () => controller.abort()
    }

    fetchCatalog(group, controller.signal)
      .then((payload) => {
        setObjects(payload.objects)
        setStatus(`${payload.objects.length.toLocaleString('en-US')} objects · ${payload.cache === 'hit' ? 'cached' : 'live source'}`)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setObjects([])
        setError(err instanceof Error ? err.message : 'Erro inesperado')
        setStatus('Catalog unavailable')
      })

    return () => controller.abort()
  }, [group, benchmarkCount])

  useEffect(() => {
    const controller = new AbortController()
    fetchEarthEvents(controller.signal).then((payload) => setEarthEvents(normalizeEarthEvents(payload.events))).catch(() => setEarthEvents([]))
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!aircraftEnabled) {
      setAircraftStates([])
      return
    }
    const controller = new AbortController()
    let timer: number | null = null
    let active = true
    const refresh = () => {
      fetchAircraftStates(aircraftDensity, controller.signal)
        .then((payload) => { if (active) setAircraftStates(payload.states) })
        .catch(() => { if (active) setAircraftStates([]) })
    }
    refresh()
    timer = window.setInterval(refresh, 15_000)
    return () => {
      active = false
      controller.abort()
      if (timer !== null) window.clearInterval(timer)
    }
  }, [aircraftEnabled, aircraftDensity])

  useEffect(() => {
    const startedReal = Date.now()
    const startedSim = simulatedAt.getTime()

    const timer = window.setInterval(() => {
      if (speed === 0) return
      setSimulatedAt(new Date(advanceSimulatedTime(startedSim, Date.now() - startedReal, speed)))
    }, 500)

    return () => window.clearInterval(timer)
  }, [speed])

  const catalogEntries = useMemo(() => normalizeCatalog(objects).entries, [objects])
  useEffect(() => {
    if (!explorationActive || selectedId !== null || catalogEntries.length === 0) return
    setSelectedId(catalogEntries[0].noradNumericId)
  }, [catalogEntries, explorationActive, selectedId])
  const filteredEntries = useMemo(() => filterCatalog(catalogEntries, objectKind, objectQuery), [catalogEntries, objectKind, objectQuery])
  const exploreNavEntries = useMemo(() => filterCatalog(catalogEntries, 'ALL', exploreNavQuery).map((entry) => entry.omm), [catalogEntries, exploreNavQuery])
  const renderLimit = resolveRenderLimit(renderMode, filteredEntries.length, autoLimit, customLimit)
  const selectedEntry = selectedId === null ? null : catalogEntries.find((entry) => entry.noradNumericId === selectedId) ?? null
  const renderCandidates = useMemo(() => selectedEntry && !filteredEntries.some((entry) => entry.noradNumericId === selectedEntry.noradNumericId) ? [selectedEntry, ...filteredEntries] : filteredEntries, [filteredEntries, selectedEntry])
  const activeEntries = useMemo(() => selectRenderSet(renderCandidates, renderLimit, selectedId), [renderCandidates, renderLimit, selectedId])
  const visibleObjects = useMemo(() => activeEntries.map((entry) => entry.omm), [activeEntries])

  const selected = useMemo(
    () => catalogEntries.find((item) => item.noradNumericId === selectedId)?.omm ?? null,
    [catalogEntries, selectedId],
  )
  const selectedEvent = useMemo(() => earthEvents.find((event) => event.id === selectedEventId) ?? null, [earthEvents, selectedEventId])
  const selectedAircraft = useMemo(() => aircraftStates.find((aircraft) => aircraft.icao24 === selectedAircraftId) ?? null, [aircraftStates, selectedAircraftId])

  const selectedState = useMemo(() => {
    if (!selected) return null
    try {
      return getOrbitState(createSatrec(selected), simulatedAt)
    } catch {
      return null
    }
  }, [selected, simulatedAt])

  const targetPosition = useMemo(() => selectedState ? Cartesian3.fromDegrees(selectedState.longitudeDeg, selectedState.latitudeDeg, toCesiumHeightMeters(selectedState.altitudeKm)) : null, [selectedState])
  const targetVelocity = useMemo(() => {
    if (!selected) return null
    try {
      const satrec = createSatrec(selected)
      const before = getOrbitState(satrec, new Date(simulatedAt.getTime() - 2_000))
      const after = getOrbitState(satrec, new Date(simulatedAt.getTime() + 2_000))
      if (!before || !after) return null
      const beforePosition = Cartesian3.fromDegrees(before.longitudeDeg, before.latitudeDeg, toCesiumHeightMeters(before.altitudeKm))
      const afterPosition = Cartesian3.fromDegrees(after.longitudeDeg, after.latitudeDeg, toCesiumHeightMeters(after.altitudeKm))
      return Cartesian3.divideByScalar(Cartesian3.subtract(afterPosition, beforePosition, new Cartesian3()), 4, new Cartesian3())
    } catch {
      return null
    }
  }, [selected, simulatedAt])

  function jumpToNow() {
    setSimulatedAt(new Date())
    if (speed === 0) setSpeed(1)
  }

  function selectMapStyle(styleId: string) {
    setMapStyleLoading(styleId !== 'satellite')
    setMapStyle(styleId)
  }

  function enterExploration() {
    if (selectedId === null) {
      const defaultTarget = catalogEntries[0]?.noradNumericId
      if (defaultTarget !== undefined) setSelectedId(defaultTarget)
    }
    setSettingsOpen(false)
    setSearchFocused(false)
    setExploreNavOpen(false)
    setExploreSettingsOpen(false)
    setExploreUiOpen(false)
    setExplorationActive(true)
  }

  function selectExploreTarget(catalogId: number) {
    setSelectedId(catalogId)
    setExploreNavOpen(false)
  }

  const selectEarthEvent = useCallback((eventId: string | null) => {
    setSelectedEventId(eventId)
    if (eventId) setSelectedId(null)
    if (eventId) setSelectedAircraftId(null)
  }, [])

  const selectAircraft = useCallback((aircraftId: string | null) => {
    setSelectedAircraftId(aircraftId)
    if (aircraftId) {
      setSelectedId(null)
      setSelectedEventId(null)
    }
  }, [])

  const updateEventCategory = useCallback((categoryId: string, enabled: boolean) => {
    setEventCategories((categories) => enabled ? [...new Set([...categories, categoryId])] : categories.filter((category) => category !== categoryId))
  }, [])

  function viewSelectedEvent() {
    if (!selectedEvent) return
    const [longitude, latitude] = selectedEvent.geometry.type === 'Point' ? selectedEvent.geometry.coordinates : selectedEvent.geometry.coordinates[0]
    setEventViewPosition(Cartesian3.fromDegrees(longitude, latitude, 2_000_000))
    setEventViewRequest((request) => request + 1)
  }

  return (
    <main className={`app-shell ${settingsOpen ? 'settings-open' : ''} ${explorationActive ? 'explore-mode' : ''}`}>
      <Globe
        objects={visibleObjects}
        simulatedAt={simulatedAt}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onPerformance={onPerformance}
        homeRequest={homeRequest}
        mapStyle={mapStyle}
        cloudsEnabled={cloudsEnabled}
        cloudOpacity={cloudOpacity}
        cloudShadowsEnabled={cloudShadowsEnabled}
        atmosphereEnabled={atmosphereEnabled}
        terrainEnabled={terrainEnabled}
        orbitsEnabled={orbitsEnabled}
        satelliteTrailsEnabled={satelliteTrailsEnabled}
        onCloudError={onCloudError}
        onTerrainLoading={onTerrainLoading}
        aircraftEnabled={aircraftEnabled}
        aircraftRoutesEnabled={aircraftRoutesEnabled}
        aircraftStates={aircraftStates}
        selectedAircraftId={selectedAircraftId}
        onAircraftSelect={selectAircraft}
        earthEvents={earthEvents}
        earthEventsEnabled={earthEventsEnabled}
        eventCategories={eventCategories}
        onEarthEventSelect={selectEarthEvent}
        eventViewRequest={eventViewRequest}
        eventViewPosition={eventViewPosition}
        onMapStyleError={onMapStyleError}
        onMapStyleLoading={onMapStyleLoading}
        explorationActive={explorationActive}
        targetPosition={targetPosition}
        targetVelocity={targetVelocity}
        targetName={selected?.OBJECT_NAME ?? null}
        onExplorationHud={onExplorationHud}
        onExitExplore={onExitExplore}
        onOpenExploreNav={onOpenExploreNav}
        onExploreActivity={onExploreActivity}
        explorationCameraSensitivity={exploreCameraSensitivity}
        explorationCameraPreset={exploreCameraPreset}
      />
      {new URLSearchParams(window.location.search).get('debug') === 'perf' && <PerformanceOverlay loaded={objects.length} visible={visibleObjects.length} {...performanceMetric} />}

      <header className="topbar glass">
        <button className="brand" onClick={() => { setSelectedId(null); setObjectQuery('') }} aria-label="Human Space Atlas home"><span className="brand-mark">◉</span><span>HUMAN SPACE ATLAS</span></button>
        <button className="mode-toggle" onClick={explorationActive ? onExitExplore : enterExploration}>{explorationActive ? 'ATLAS' : 'EXPLORAR'}</button>
        <div className="search-wrap"><span className="search-icon">⌕</span><input ref={searchInputRef} aria-label="Pesquisar satélites" placeholder="Pesquisar satélites ou ID NORAD…" value={objectQuery} onFocus={() => { setSearchFocused(true); setSettingsOpen(false) }} onChange={(event) => { setObjectQuery(event.target.value); setSearchFocused(true) }} />{objectQuery && <button className="clear-search" onClick={() => { setObjectQuery(''); searchInputRef.current?.focus() }} aria-label="Limpar pesquisa">×</button>}<kbd>⌘ K</kbd>
          {searchFocused && objectQuery && <div className="search-dropdown">{filteredEntries.slice(0, 8).map((entry) => <button key={entry.id} onClick={() => { setSelectedId(entry.noradNumericId); setSearchFocused(false) }}><strong>{entry.name}</strong><span>NORAD {entry.noradId} · {entry.objectType}</span></button>)}</div>}
        </div>
        <div className="live-status">
          <span className="live-dot" />
          <div><strong>{objects.length ? 'AO VIVO' : 'CONECTANDO'}</strong><span>{objects.length.toLocaleString('pt-BR')} objetos</span></div>
        </div>
        <button className="icon-button" onClick={() => { setSettingsOpen((open) => !open); setSearchFocused(false) }} aria-label="Abrir configurações" title="Configurações">⚙</button>
      </header>

      {explorerOpen ? <aside className="filters glass">
        <button className="collapse-button" onClick={() => setExplorerOpen((open) => !open)} aria-label={explorerOpen ? 'Recolher painel de exploração' : 'Abrir painel de exploração'}>{explorerOpen ? '‹' : '☰'}</button>
        {explorerOpen && <>
        <span className="panel-title">Explorar</span>
        <div className="nav-list">
          {GROUPS.map((item) => (
            <button
              key={item.value}
              className={group === item.value ? 'active' : ''}
              onClick={() => setGroup(item.value)}
            >
              <span className="nav-icon">{item.value === 'stations' ? '◉' : item.value === 'active' ? '◌' : item.value === 'starlink' ? '✦' : '◇'}</span>{item.label}
            </button>
          ))}
        </div>
        <span className="panel-title section-label">Tipo de objeto</span>
        <div className="nav-list type-list">
          {(['ALL', 'PAYLOAD', 'ROCKET BODY', 'DEBRIS']).map((kind) => <button key={kind} className={objectKind === kind ? 'active' : ''} onClick={() => setObjectKind(kind)}><span className="nav-icon">{kind === 'ALL' ? '●' : '◇'}</span>{kind === 'ALL' ? 'Todos os objetos' : kind === 'PAYLOAD' ? 'Carga útil' : kind === 'ROCKET BODY' ? 'Corpo de foguete' : 'Detritos'}</button>)}
        </div>
        <p className="microcopy">OMM / JSON · propagação SGP4 local</p>
        <div className="atlas-status" aria-label="Status do atlas">
          <div className="status-line"><span className="live-dot" /> <strong>{filteredEntries.length.toLocaleString('pt-BR')} / {objects.length.toLocaleString('pt-BR')}</strong> objetos exibidos</div>
          <button className={earthEventsEnabled ? 'status-action active' : 'status-action'} onClick={() => setEarthEventsEnabled((enabled) => !enabled)}><span className="status-mark event-mark" /> Eventos da Terra · {earthEvents.length.toLocaleString('pt-BR')} <b>{earthEventsEnabled ? 'ATIVOS' : 'OCULTOS'}</b></button>
          <div className="status-line aircraft-status"><span className="aircraft-mark">✈</span> Aeronaves · {aircraftEnabled ? `${aircraftStates.length.toLocaleString('pt-BR')} ao vivo` : 'ocultas'}</div>
          <div className="status-line terrain-status"><span className={terrainLoading ? 'status-spinner' : 'status-mark terrain-mark'} /> {terrainLoading ? 'Elevação carregando…' : terrainEnabled ? 'Relevo 3D pronto' : 'Relevo 3D oculto'}</div>
          <div className="map-legend" aria-label="Legenda visual"><span><i className="legend-line orbit-legend" /> Órbita</span><span><i className="legend-dot event-legend" /> Evento</span><span><i className="legend-dot aircraft-legend" /> Aeronave</span></div>
        </div>
        {error && <div className="error-box">Não foi possível atualizar o catálogo orbital<br /><small>Usando dados em cache</small></div>}
        </>}
      </aside> : <button className="explorer-rail glass" onClick={() => setExplorerOpen(true)} aria-label="Abrir painel de exploração" title="Abrir painel de exploração">☰</button>}

      {settingsOpen && <AtlasSettings
        mapStyles={mapStyles}
        mapStyle={mapStyle}
        mapStyleLoading={mapStyleLoading}
        onMapStyleSelect={selectMapStyle}
        onHome={() => { setHomeRequest((request) => request + 1); setSettingsOpen(false) }}
        cloudsEnabled={cloudsEnabled}
        cloudOpacity={cloudOpacity}
        cloudShadowsEnabled={cloudShadowsEnabled}
        atmosphereEnabled={atmosphereEnabled}
        terrainEnabled={terrainEnabled}
        orbitsEnabled={orbitsEnabled}
        satelliteTrailsEnabled={satelliteTrailsEnabled}
        onCloudsChange={setCloudsEnabled}
        onCloudOpacityChange={setCloudOpacity}
        onCloudShadowsChange={setCloudShadowsEnabled}
        onAtmosphereChange={setAtmosphereEnabled}
        onTerrainChange={setTerrainEnabled}
        onOrbitsChange={setOrbitsEnabled}
        onSatelliteTrailsChange={setSatelliteTrailsEnabled}
        terrainLoading={terrainLoading}
        aircraftEnabled={aircraftEnabled}
        aircraftRoutesEnabled={aircraftRoutesEnabled}
        aircraftDensity={aircraftDensity}
        aircraftCount={aircraftStates.length}
        onAircraftChange={setAircraftEnabled}
        onAircraftRoutesChange={setAircraftRoutesEnabled}
        onAircraftDensityChange={setAircraftDensity}
        earthEventsEnabled={earthEventsEnabled}
        earthEventCount={earthEvents.length}
        eventCategories={eventCategories}
        onEarthEventsChange={setEarthEventsEnabled}
        onEventCategoryChange={updateEventCategory}
        renderMode={renderMode}
        customLimit={customLimit}
        renderLimit={renderLimit}
        objectCount={objects.length}
        visibleCount={visibleObjects.length}
        onRenderModeChange={setRenderMode}
        onCustomLimitChange={setCustomLimit}
        onClose={() => setSettingsOpen(false)}
      />}

      <section className="time-controls glass">
        <div>
          <span className="panel-title">Tempo simulado</span>
          <strong>{simulatedAt.toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' })} UTC</strong>
        </div>
        <div className="speed-row">
          {SPEEDS.map((value) => (
            <button key={value} className={speed === value ? 'active' : ''} onClick={() => setSpeed(value)}>
              {value === 0 ? '❚❚' : `${value}×`}
            </button>
          ))}
          <button onClick={jumpToNow} title="Voltar ao tempo real">AGORA</button>
        </div>
      </section>

      <aside className={`details ${selected || selectedEvent || selectedAircraft ? 'glass inspector-open' : 'empty-inspector-panel'}`}>
        {selectedEvent ? (
          <>
            <div className="inspector-heading"><p className="eyebrow">EVENTO TERRESTRE</p><button className="close-button" onClick={() => setSelectedEventId(null)} aria-label="Fechar evento">×</button></div>
            <h2>{selectedEvent.title}</h2>
            <div className="object-meta"><span className="live-dot" /> {selectedEvent.categoryTitle} <span>NASA EONET v3 · ATIVO</span></div>
            <dl>
              <div><dt>ÚLTIMA OBSERVAÇÃO</dt><dd>{selectedEvent.geometry.date?.slice(0, 10) ?? '—'}</dd></div><div><dt>MAGNITUDE</dt><dd>{selectedEvent.magnitudeValue !== null ? `${selectedEvent.magnitudeValue}${selectedEvent.magnitudeUnit ? ` ${selectedEvent.magnitudeUnit}` : ''}` : '—'}</dd></div>
              <div><dt>FONTE</dt><dd>{selectedEvent.source ?? '—'}</dd></div><div><dt>GEOMETRIA</dt><dd>{selectedEvent.geometry.type === 'Point' ? 'Ponto' : 'Área'}</dd></div>
            </dl>
            {selectedEvent.description && <p className="event-description">{selectedEvent.description}</p>}
            <button className="clear-button" onClick={viewSelectedEvent}>Ver localização</button>
          </>
        ) : selectedAircraft ? (
          <>
            <div className="inspector-heading"><p className="eyebrow">AERONAVE AO VIVO</p><button className="close-button" onClick={() => setSelectedAircraftId(null)} aria-label="Fechar aeronave">×</button></div>
            <h2>{selectedAircraft.callsign ?? selectedAircraft.icao24.toUpperCase()}</h2>
            <div className="object-meta"><span className="live-dot" /> ADS-B · {selectedAircraft.originCountry ?? 'origem desconhecida'} <span>OPENSKY · AO VIVO</span></div>
            <dl>
              <div><dt>ALTITUDE</dt><dd>{(selectedAircraft.altitudeMeters / 1000).toFixed(1)} km</dd></div><div><dt>VELOCIDADE</dt><dd>{(selectedAircraft.velocityMetersPerSecond * 3.6).toFixed(0)} km/h</dd></div>
              <div><dt>RUMO</dt><dd>{selectedAircraft.trueTrackDeg !== null ? `${selectedAircraft.trueTrackDeg.toFixed(0)}°` : '—'}</dd></div><div><dt>ICAO24</dt><dd>{selectedAircraft.icao24.toUpperCase()}</dd></div>
            </dl>
            <p className="event-description">O rastro recente desta aeronave está visível no mapa.</p>
            <button className="clear-button" onClick={() => setSelectedAircraftId(null)}>Limpar seleção</button>
          </>
        ) : selected ? (
          <>
            <div className="inspector-heading"><p className="eyebrow">INSPEÇÃO DO OBJETO</p><button className="close-button" onClick={() => setSelectedId(null)} aria-label="Fechar objeto">×</button></div>
            <h2>{selected.OBJECT_NAME}</h2>
            <div className="object-meta"><span className="live-dot" /> ATIVO · {selected.OBJECT_TYPE} <span>NORAD {selected.NORAD_CAT_ID}</span></div>
            <dl>
              <div><dt>ALTITUDE</dt><dd>{selectedState ? `${selectedState.altitudeKm.toFixed(0)} km` : '—'}</dd></div><div><dt>VELOCIDADE</dt><dd>{selectedState ? `${selectedState.speedKmS.toFixed(2)} km/s` : '—'}</dd></div>
              <div><dt>INCLINAÇÃO</dt><dd>{selected.INCLINATION.toFixed(2)}°</dd></div><div><dt>ID NORAD</dt><dd>{selected.NORAD_CAT_ID}</dd></div>
              <div><dt>ID DO OBJETO</dt><dd>{selected.OBJECT_ID ?? '—'}</dd></div><div><dt>ÉPOCA</dt><dd>{selected.EPOCH.slice(0, 10)}</dd></div>
            </dl>
            <button className="clear-button" onClick={() => setSelectedId(null)}>Limpar seleção</button>
          </>
        ) : (
          <>
            <div className="empty-inspector"><span>✦</span><p>Clique em um objeto para inspecionar</p><small>Explore o ambiente orbital da Terra</small></div>
          </>
        )}
      </aside>

      <footer className="source-note">CelesTrak · OpenSky ADS-B · OMM / JSON · propagação SGP4 · CesiumJS</footer>
      {explorationActive && !exploreUiOpen && <button className="explore-appreciation-button" onClick={() => setExploreUiOpen(true)} aria-label="Abrir opções da exploração" title="Abrir opções">☰</button>}
      {explorationActive && exploreUiOpen && <ExplorationHud snapshot={explorationHud} debugFlight={debugFlight} showTargetMarker={exploreObjectMarkerEnabled} onExit={onExitExplore} onOpenNav={onOpenExploreNav} onOpenSettings={onOpenExploreSettings} controlsHelpVisible={exploreControlsVisible} onDismissHelp={dismissExploreControls} />}
      {explorationActive && exploreNavOpen && <ExploreNav query={exploreNavQuery} entries={exploreNavEntries} onQueryChange={setExploreNavQuery} onSelect={selectExploreTarget} onClose={() => setExploreNavOpen(false)} />}
      {explorationActive && exploreSettingsOpen && <ExploreSettings cameraSensitivity={exploreCameraSensitivity} onCameraChange={setExploreCameraSensitivity} cameraPreset={exploreCameraPreset} onCameraPresetChange={setExploreCameraPreset} orbitsEnabled={orbitsEnabled} onOrbitsChange={setOrbitsEnabled} cloudsEnabled={cloudsEnabled} cloudOpacity={cloudOpacity} cloudShadowsEnabled={cloudShadowsEnabled} onCloudsChange={setCloudsEnabled} onCloudOpacityChange={setCloudOpacity} onCloudShadowsChange={setCloudShadowsEnabled} objectMarkerEnabled={exploreObjectMarkerEnabled} onObjectMarkerChange={setExploreObjectMarkerEnabled} onVisualOnly={() => { setExploreNavOpen(false); setExploreSettingsOpen(false); setExploreUiOpen(false) }} onClose={() => setExploreSettingsOpen(false)} />}
    </main>
  )
}

export default App
