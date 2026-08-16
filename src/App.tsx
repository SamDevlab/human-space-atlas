import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Cartesian3 } from 'cesium'
import { Globe } from './components/Globe'
import { ExplorationHud } from './components/ExplorationHud'
import { ExploreNav } from './components/ExploreNav'
import { ExploreSettings } from './components/ExploreSettings'
import { PerformanceOverlay } from './components/PerformanceOverlay'
import { fetchCatalog } from './lib/api'
import { createSatrec, getOrbitState, toCesiumHeightMeters } from './lib/orbit'
import { advanceSimulatedTime } from './lib/simulationClock'
import { filterCatalog, normalizeCatalog } from './lib/orbitalCatalog'
import { generateSyntheticCatalog } from './lib/syntheticCatalog'
import { discoverMapStyles } from './lib/mapStyles'
import { AutoRenderController, resolveRenderLimit, selectRenderSet, type RenderMode, RENDER_LIMITS } from './lib/renderSet'
import type { CatalogGroup, OmmRecord } from './lib/types'
import type { ExplorationHudSnapshot } from './exploration/types'

const GROUPS: Array<{ value: CatalogGroup; label: string }> = [
  { value: 'stations', label: 'Stations' },
  { value: 'active', label: 'Active Satellites' },
  { value: 'starlink', label: 'Starlink' },
  { value: 'gps-ops', label: 'GPS' },
]

const SPEEDS = [0, 1, 10, 100]

function App() {
  const benchmarkCount = Number(new URLSearchParams(window.location.search).get('benchmark') ?? 0)
  const benchmarkRenderLimit = Number(new URLSearchParams(window.location.search).get('renderLimit') ?? 0)
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
  const [explorationActive, setExplorationActive] = useState(false)
  const [exploreNavOpen, setExploreNavOpen] = useState(false)
  const [exploreNavQuery, setExploreNavQuery] = useState('')
  const [exploreSettingsOpen, setExploreSettingsOpen] = useState(false)
  const [exploreSteeringSensitivity, setExploreSteeringSensitivity] = useState(() => Number(localStorage.getItem('human-space-atlas.explore-steering-sensitivity') ?? 1))
  const [exploreCameraSensitivity, setExploreCameraSensitivity] = useState(() => Number(localStorage.getItem('human-space-atlas.explore-camera-sensitivity') ?? 1))
  const [exploreControlsVisible, setExploreControlsVisible] = useState(() => localStorage.getItem('human-space-atlas.explore-controls-seen') !== '1')
  const [explorationHud, setExplorationHud] = useState<ExplorationHudSnapshot>({ altitudeKm: 0, speedKmS: 0, throttle: 0, cameraMode: 'THIRD_PERSON', cameraDistanceMeters: 7500, cameraOrbiting: false, flightAssist: true, boostActive: false, lowAltitude: false, targetName: null, targetDistanceKm: null, targetIndicator: null })
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
  const onExplorationHud = useCallback((snapshot: ExplorationHudSnapshot) => setExplorationHud(snapshot), [])
  const onExitExplore = useCallback(() => { setExploreNavOpen(false); setExploreSettingsOpen(false); setExplorationActive(false) }, [])
  const onOpenExploreNav = useCallback(() => { setExploreSettingsOpen(false); setExploreNavOpen(true) }, [])
  const onOpenExploreSettings = useCallback(() => { setExploreNavOpen(false); setExploreSettingsOpen(true) }, [])
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
  useEffect(() => { localStorage.setItem('human-space-atlas.explore-steering-sensitivity', String(exploreSteeringSensitivity)) }, [exploreSteeringSensitivity])
  useEffect(() => { localStorage.setItem('human-space-atlas.explore-camera-sensitivity', String(exploreCameraSensitivity)) }, [exploreCameraSensitivity])
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
    const startedReal = Date.now()
    const startedSim = simulatedAt.getTime()

    const timer = window.setInterval(() => {
      if (speed === 0) return
      setSimulatedAt(new Date(advanceSimulatedTime(startedSim, Date.now() - startedReal, speed)))
    }, 500)

    return () => window.clearInterval(timer)
  }, [speed])

  const catalogEntries = useMemo(() => normalizeCatalog(objects).entries, [objects])
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

  const selectedState = useMemo(() => {
    if (!selected) return null
    try {
      return getOrbitState(createSatrec(selected), simulatedAt)
    } catch {
      return null
    }
  }, [selected, simulatedAt])

  const targetPosition = useMemo(() => selectedState ? Cartesian3.fromDegrees(selectedState.longitudeDeg, selectedState.latitudeDeg, toCesiumHeightMeters(selectedState.altitudeKm)) : null, [selectedState])

  function jumpToNow() {
    setSimulatedAt(new Date())
    if (speed === 0) setSpeed(1)
  }

  function selectMapStyle(styleId: string) {
    setMapStyleLoading(styleId !== 'satellite')
    setMapStyle(styleId)
  }

  function enterExploration() {
    setSettingsOpen(false)
    setSearchFocused(false)
    setExploreNavOpen(false)
    setExploreSettingsOpen(false)
    setExplorationActive(true)
  }

  function selectExploreTarget(catalogId: number) {
    setSelectedId(catalogId)
    setExploreNavOpen(false)
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
        onMapStyleError={onMapStyleError}
        onMapStyleLoading={onMapStyleLoading}
        explorationActive={explorationActive}
        targetPosition={targetPosition}
        targetName={selected?.OBJECT_NAME ?? null}
        onExplorationHud={onExplorationHud}
        onExitExplore={onExitExplore}
        onOpenExploreNav={onOpenExploreNav}
        onExploreActivity={onExploreActivity}
        explorationSteeringSensitivity={exploreSteeringSensitivity}
        explorationCameraSensitivity={exploreCameraSensitivity}
      />
      {new URLSearchParams(window.location.search).get('debug') === 'perf' && <PerformanceOverlay loaded={objects.length} visible={visibleObjects.length} {...performanceMetric} />}

      <header className="topbar glass">
        <button className="brand" onClick={() => { setSelectedId(null); setObjectQuery('') }} aria-label="Human Space Atlas home"><span className="brand-mark">◉</span><span>HUMAN SPACE ATLAS</span></button>
        <button className="mode-toggle" onClick={explorationActive ? onExitExplore : enterExploration}>{explorationActive ? 'ATLAS' : 'EXPLORE'}</button>
        <div className="search-wrap"><span className="search-icon">⌕</span><input ref={searchInputRef} aria-label="Search satellites" placeholder="Search satellites or NORAD ID..." value={objectQuery} onFocus={() => { setSearchFocused(true); setSettingsOpen(false) }} onChange={(event) => { setObjectQuery(event.target.value); setSearchFocused(true) }} />{objectQuery && <button className="clear-search" onClick={() => { setObjectQuery(''); searchInputRef.current?.focus() }} aria-label="Clear search">×</button>}<kbd>⌘ K</kbd>
          {searchFocused && objectQuery && <div className="search-dropdown">{filteredEntries.slice(0, 8).map((entry) => <button key={entry.id} onClick={() => { setSelectedId(entry.noradNumericId); setSearchFocused(false) }}><strong>{entry.name}</strong><span>NORAD {entry.noradId} · {entry.objectType}</span></button>)}</div>}
        </div>
        <div className="live-status">
          <span className="live-dot" />
          <div><strong>{objects.length ? 'LIVE' : 'CONNECTING'}</strong><span>{objects.length.toLocaleString('en-US')} objects</span></div>
        </div>
        <button className="icon-button" onClick={() => { setSettingsOpen((open) => !open); setSearchFocused(false) }} aria-label="Open settings" title="Settings">⚙</button>
      </header>

      {explorerOpen ? <aside className="filters glass">
        <button className="collapse-button" onClick={() => setExplorerOpen((open) => !open)} aria-label={explorerOpen ? 'Collapse explorer' : 'Open explorer'}>{explorerOpen ? '‹' : '☰'}</button>
        {explorerOpen && <>
        <span className="panel-title">Explore</span>
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
        <span className="panel-title section-label">Object Type</span>
        <div className="nav-list type-list">
          {(['ALL', 'PAYLOAD', 'ROCKET BODY', 'DEBRIS']).map((kind) => <button key={kind} className={objectKind === kind ? 'active' : ''} onClick={() => setObjectKind(kind)}><span className="nav-icon">{kind === 'ALL' ? '●' : '◇'}</span>{kind === 'ALL' ? 'All Objects' : kind === 'ROCKET BODY' ? 'Rocket Body' : kind[0] + kind.slice(1).toLowerCase()}</button>)}
        </div>
        <p className="microcopy">OMM / JSON · local SGP4 propagation</p>
        {error && <div className="error-box">Unable to update orbital catalog<br /><small>Using cached data</small></div>}
        </>}
      </aside> : <button className="explorer-rail glass" onClick={() => setExplorerOpen(true)} aria-label="Open explorer" title="Open explorer">☰</button>}

      <div className="catalog-counts glass"><span className="live-dot" /> {filteredEntries.length.toLocaleString('en-US')} / {objects.length.toLocaleString('en-US')} objects <small>displayed</small></div>

      {settingsOpen && <section className="settings-popover glass"><div className="popover-heading"><span className="panel-title">Settings</span><button className="close-button" onClick={() => setSettingsOpen(false)}>×</button></div><span className="panel-title section-label">View</span><button className="home-setting" onClick={() => setHomeRequest((request) => request + 1)} aria-label="Home"><span>⌂</span><div><strong>Home</strong><small>Return to Earth overview</small></div></button><span className="panel-title section-label">Map style {mapStyleLoading && <span className="map-loading"><span /> Loading map</span>}</span><div className="map-style-list">{mapStyles.map((style) => <button key={style.id} className={mapStyle === style.id ? 'active' : ''} onClick={() => selectMapStyle(style.id)} title={style.tooltip}><span className={`map-preview ${style.id === 'satellite' ? 'satellite-preview' : style.id === 'openstreetmap' ? 'map-preview-osm' : 'map-preview-generic'}`} style={style.iconUrl ? { backgroundImage: `url(${style.iconUrl})` } : undefined} /><div><strong>{style.name}</strong><small>{style.isDefault ? 'DEFAULT' : mapStyle === style.id ? 'SELECTED' : style.name === 'Natural Earth II' ? 'Atlas map' : style.name === 'OpenStreetMap' ? 'Street map' : 'Imagery'}</small></div>{mapStyle === style.id && <span className="map-check">✓</span>}</button>)}</div><span className="panel-title section-label">Rendering density</span><div className="density-list">{(['AUTO', '1000', '2500', '5000', '10000', '25000', 'MAXIMUM'] as RenderMode[]).map((mode) => <button key={mode} className={renderMode === mode ? 'active' : ''} onClick={() => setRenderMode(mode)}><span>{mode === 'AUTO' ? 'Automatic' : mode === 'MAXIMUM' ? 'Maximum' : Number(mode).toLocaleString('en-US')}</span><small>{mode === 'AUTO' ? 'Recommended' : mode === '1000' ? 'Low' : mode === '5000' ? 'Balanced' : mode === '10000' ? 'High' : mode === '25000' ? 'Ultra' : ''}</small></button>)}</div><label className="small-control">Custom · {customLimit.toLocaleString('en-US')} objects<input type="range" min="1000" max="50000" step="500" value={customLimit} onChange={(event) => { setCustomLimit(Number(event.target.value)); setRenderMode('CUSTOM') }} /></label><p className="microcopy">Catalog: {objects.length.toLocaleString('en-US')} · Displayed: {visibleObjects.length.toLocaleString('en-US')}<br />The complete catalog remains searchable.</p>{renderLimit >= 25000 && <p className="warning-copy">High object densities may reduce performance.</p>}</section>}

      <section className="time-controls glass">
        <div>
          <span className="panel-title">Simulated Time</span>
          <strong>{simulatedAt.toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' })} UTC</strong>
        </div>
        <div className="speed-row">
          {SPEEDS.map((value) => (
            <button key={value} className={speed === value ? 'active' : ''} onClick={() => setSpeed(value)}>
              {value === 0 ? '❚❚' : `${value}×`}
            </button>
          ))}
          <button onClick={jumpToNow} title="Return to real time">NOW</button>
        </div>
      </section>

      <aside className={`details ${selected ? 'glass inspector-open' : 'empty-inspector-panel'}`}>
        {selected ? (
          <>
            <div className="inspector-heading"><p className="eyebrow">OBJECT INSPECTOR</p><button className="close-button" onClick={() => setSelectedId(null)}>×</button></div>
            <h2>{selected.OBJECT_NAME}</h2>
            <div className="object-meta"><span className="live-dot" /> ACTIVE · {selected.OBJECT_TYPE} <span>NORAD {selected.NORAD_CAT_ID}</span></div>
            <dl>
              <div><dt>ALTITUDE</dt><dd>{selectedState ? `${selectedState.altitudeKm.toFixed(0)} km` : '—'}</dd></div><div><dt>SPEED</dt><dd>{selectedState ? `${selectedState.speedKmS.toFixed(2)} km/s` : '—'}</dd></div>
              <div><dt>INCLINATION</dt><dd>{selected.INCLINATION.toFixed(2)}°</dd></div><div><dt>NORAD ID</dt><dd>{selected.NORAD_CAT_ID}</dd></div>
              <div><dt>OBJECT ID</dt><dd>{selected.OBJECT_ID ?? '—'}</dd></div><div><dt>EPOCH</dt><dd>{selected.EPOCH.slice(0, 10)}</dd></div>
            </dl>
            <button className="clear-button" onClick={() => setSelectedId(null)}>Clear selection</button>
          </>
        ) : (
          <>
            <div className="empty-inspector"><span>✦</span><p>Click an object to inspect</p><small>Explore Earth's orbital environment</small></div>
          </>
        )}
      </aside>

      <footer className="source-note">CelesTrak · OMM / JSON · SGP4 · CesiumJS</footer>
      {explorationActive && <ExplorationHud snapshot={explorationHud} onExit={onExitExplore} onOpenNav={onOpenExploreNav} onOpenSettings={onOpenExploreSettings} controlsHelpVisible={exploreControlsVisible} onDismissHelp={dismissExploreControls} />}
      {explorationActive && exploreNavOpen && <ExploreNav query={exploreNavQuery} entries={exploreNavEntries} onQueryChange={setExploreNavQuery} onSelect={selectExploreTarget} onClose={() => setExploreNavOpen(false)} />}
      {explorationActive && exploreSettingsOpen && <ExploreSettings steeringSensitivity={exploreSteeringSensitivity} cameraSensitivity={exploreCameraSensitivity} onSteeringChange={setExploreSteeringSensitivity} onCameraChange={setExploreCameraSensitivity} onClose={() => setExploreSettingsOpen(false)} />}
    </main>
  )
}

export default App
