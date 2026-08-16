import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Globe } from './components/Globe'
import { PerformanceOverlay } from './components/PerformanceOverlay'
import { fetchCatalog } from './lib/api'
import { createSatrec, getOrbitState } from './lib/orbit'
import { advanceSimulatedTime } from './lib/simulationClock'
import { filterCatalog, normalizeCatalog } from './lib/orbitalCatalog'
import { generateSyntheticCatalog } from './lib/syntheticCatalog'
import { AutoRenderController, resolveRenderLimit, selectRenderSet, type RenderMode, RENDER_LIMITS } from './lib/renderSet'
import type { CatalogGroup, OmmRecord } from './lib/types'

const GROUPS: Array<{ value: CatalogGroup; label: string }> = [
  { value: 'stations', label: 'Estações' },
  { value: 'active', label: 'Ativos' },
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
  const [status, setStatus] = useState('Carregando catálogo…')
  const [error, setError] = useState<string | null>(null)
  const [performanceMetric, setPerformanceMetric] = useState({ workerMs: 0, applyMs: 0, transferBytes: 0, pending: 0 })
  const [renderMode, setRenderMode] = useState<RenderMode>(() => benchmarkRenderLimit > 0 ? 'CUSTOM' : (localStorage.getItem('human-space-atlas.render-mode') as RenderMode | null) ?? 'AUTO')
  const [customLimit, setCustomLimit] = useState(() => benchmarkRenderLimit > 0 ? benchmarkRenderLimit : Number(localStorage.getItem('human-space-atlas.render-limit') ?? 5000))
  const [autoLimit, setAutoLimit] = useState(5000)
  const autoControllerRef = useRef(new AutoRenderController())
  const onPerformance = useCallback((metric: typeof performanceMetric) => setPerformanceMetric(metric), [])

  useEffect(() => { localStorage.setItem('human-space-atlas.render-mode', renderMode) }, [renderMode])
  useEffect(() => { localStorage.setItem('human-space-atlas.render-limit', String(customLimit)) }, [customLimit])
  useEffect(() => {
    if (renderMode === 'AUTO') setAutoLimit(autoControllerRef.current.update(performanceMetric, performance.now()))
  }, [performanceMetric, renderMode])

  useEffect(() => {
    const controller = new AbortController()
    setError(null)
    setStatus('Carregando catálogo…')
    setSelectedId(null)

    if (benchmarkCount > 0) {
      try {
        const synthetic = generateSyntheticCatalog(benchmarkCount)
        setObjects(synthetic)
        setStatus(`${synthetic.length.toLocaleString('pt-BR')} objetos · benchmark sintético READY`)
      } catch (err) {
        setObjects([])
        setError(err instanceof Error ? err.message : 'Benchmark inválido')
        setStatus('Benchmark indisponível')
      }
      return () => controller.abort()
    }

    fetchCatalog(group, controller.signal)
      .then((payload) => {
        setObjects(payload.objects)
        setStatus(`${payload.objects.length.toLocaleString('pt-BR')} objetos · ${payload.cache === 'hit' ? 'cache' : 'fonte atualizada'}`)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setObjects([])
        setError(err instanceof Error ? err.message : 'Erro inesperado')
        setStatus('Catálogo indisponível')
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

  function jumpToNow() {
    setSimulatedAt(new Date())
    if (speed === 0) setSpeed(1)
  }

  return (
    <main className="app-shell">
      <Globe
        objects={visibleObjects}
        simulatedAt={simulatedAt}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onPerformance={onPerformance}
      />
      {new URLSearchParams(window.location.search).get('debug') === 'perf' && <PerformanceOverlay loaded={objects.length} visible={visibleObjects.length} {...performanceMetric} />}

      <header className="topbar glass">
        <div>
          <p className="eyebrow">HUMAN SPACE ATLAS</p>
          <h1>Presença humana no espaço, em uma só visão.</h1>
        </div>
        <div className="segmented">
          {['ALL', 'PAYLOAD', 'ROCKET BODY', 'DEBRIS'].map((kind) => (
            <button key={kind} className={objectKind === kind ? 'active' : ''} onClick={() => setObjectKind(kind)}>
              {kind === 'ALL' ? 'Todos' : kind}
            </button>
          ))}
        </div>
        <input aria-label="Buscar objeto" placeholder="Buscar nome ou NORAD" value={objectQuery} onChange={(event) => setObjectQuery(event.target.value)} />
        <div className="live-status">
          <span className="live-dot" />
          <span>{status}</span>
        </div>
      </header>

      <aside className="filters glass">
        <span className="panel-title">Órbita terrestre</span>
        <div className="segmented">
          {GROUPS.map((item) => (
            <button
              key={item.value}
              className={group === item.value ? 'active' : ''}
              onClick={() => setGroup(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <p className="microcopy">
          Dados orbitais via OMM/JSON. A posição é propagada localmente com SGP4.
        </p>
        <span className="panel-title">Performance de renderização</span>
        <div className="segmented render-modes">
          {(['AUTO', '1000', '2500', '5000', '10000', '25000', 'MAXIMUM'] as RenderMode[]).map((mode) => <button key={mode} className={renderMode === mode ? 'active' : ''} onClick={() => setRenderMode(mode)}>{mode === 'AUTO' ? 'Automático' : mode === 'MAXIMUM' ? 'Máximo' : Number(mode).toLocaleString('pt-BR')}</button>)}
        </div>
        <label className="small-control">Personalizado
          <input type="number" min="1000" max="50000" step="500" value={customLimit} onChange={(event) => { setCustomLimit(Math.max(1000, Math.min(50000, Number(event.target.value) || 1000))); setRenderMode('CUSTOM') }} />
        </label>
        <p className="microcopy">{renderMode === 'AUTO' ? `Auto · ${autoLimit.toLocaleString('pt-BR')} objetos` : `Renderizando até ${renderLimit.toLocaleString('pt-BR')} objetos`}. O catálogo completo continua pesquisável.</p>
        {renderLimit >= 25000 && <p className="warning-copy">Valores altos podem reduzir o desempenho em alguns dispositivos.</p>}
        {error && <div className="error-box">{error}</div>}
      </aside>

      <div className="catalog-counts glass">Catálogo: {objects.length.toLocaleString('pt-BR')} · Filtrado: {filteredEntries.length.toLocaleString('pt-BR')} · Renderizado: {visibleObjects.length.toLocaleString('pt-BR')}{filteredEntries.length > visibleObjects.length && ` · Exibindo ${visibleObjects.length.toLocaleString('pt-BR')} de ${filteredEntries.length.toLocaleString('pt-BR')}`}</div>

      <section className="time-controls glass">
        <div>
          <span className="panel-title">Tempo simulado</span>
          <strong>{simulatedAt.toLocaleString('pt-BR', { timeZone: 'UTC' })} UTC</strong>
        </div>
        <div className="speed-row">
          {SPEEDS.map((value) => (
            <button key={value} className={speed === value ? 'active' : ''} onClick={() => setSpeed(value)}>
              {value === 0 ? 'Pausa' : `${value}×`}
            </button>
          ))}
          <button onClick={jumpToNow}>Agora</button>
        </div>
      </section>

      <aside className="details glass">
        {selected ? (
          <>
            <p className="eyebrow">OBJETO SELECIONADO</p>
            <h2>{selected.OBJECT_NAME}</h2>
            <dl>
              <div><dt>NORAD</dt><dd>{selected.NORAD_CAT_ID}</dd></div>
              <div><dt>Designador</dt><dd>{selected.OBJECT_ID ?? '—'}</dd></div>
              <div><dt>Epoch</dt><dd>{selected.EPOCH}</dd></div>
              <div><dt>Inclinação</dt><dd>{selected.INCLINATION.toFixed(2)}°</dd></div>
              <div><dt>Altitude</dt><dd>{selectedState ? `${selectedState.altitudeKm.toFixed(0)} km` : '—'}</dd></div>
              <div><dt>Velocidade</dt><dd>{selectedState ? `${selectedState.speedKmS.toFixed(2)} km/s` : '—'}</dd></div>
            </dl>
            <button className="clear-button" onClick={() => setSelectedId(null)}>Limpar seleção</button>
          </>
        ) : (
          <>
            <p className="eyebrow">EXPLORAR</p>
            <h2>Selecione um ponto no globo</h2>
            <p>O MVP mostra estações, ativos, Starlink e GPS. Deep-space já tem endpoint preparado no backend.</p>
            {objectQuery && <div className="search-results"><p className="microcopy">Resultados no catálogo completo:</p>{filteredEntries.slice(0, 5).map((entry) => <button key={entry.id} onClick={() => setSelectedId(entry.noradNumericId)}>{entry.name} · NORAD {entry.noradId}</button>)}</div>}
          </>
        )}
      </aside>

      <footer className="source-note">CelesTrak → OMM/JSON → SGP4 → CesiumJS</footer>
    </main>
  )
}

export default App
