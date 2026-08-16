import { useEffect, useMemo, useState } from 'react'
import { Globe } from './components/Globe'
import { fetchCatalog } from './lib/api'
import { createSatrec, getOrbitState } from './lib/orbit'
import { advanceSimulatedTime } from './lib/simulationClock'
import type { CatalogGroup, OmmRecord } from './lib/types'

const GROUPS: Array<{ value: CatalogGroup; label: string }> = [
  { value: 'stations', label: 'Estações' },
  { value: 'active', label: 'Ativos' },
  { value: 'starlink', label: 'Starlink' },
  { value: 'gps-ops', label: 'GPS' },
]

const SPEEDS = [0, 1, 10, 100]

function App() {
  const [group, setGroup] = useState<CatalogGroup>('stations')
  const [objects, setObjects] = useState<OmmRecord[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [simulatedAt, setSimulatedAt] = useState(() => new Date())
  const [speed, setSpeed] = useState(1)
  const [status, setStatus] = useState('Carregando catálogo…')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setError(null)
    setStatus('Carregando catálogo…')
    setSelectedId(null)

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
  }, [group])

  useEffect(() => {
    const startedReal = Date.now()
    const startedSim = simulatedAt.getTime()

    const timer = window.setInterval(() => {
      if (speed === 0) return
      setSimulatedAt(new Date(advanceSimulatedTime(startedSim, Date.now() - startedReal, speed)))
    }, 500)

    return () => window.clearInterval(timer)
  }, [speed])

  const selected = useMemo(
    () => objects.find((item) => item.NORAD_CAT_ID === selectedId) ?? null,
    [objects, selectedId],
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
        objects={objects}
        simulatedAt={simulatedAt}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />

      <header className="topbar glass">
        <div>
          <p className="eyebrow">HUMAN SPACE ATLAS</p>
          <h1>Presença humana no espaço, em uma só visão.</h1>
        </div>
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
        {error && <div className="error-box">{error}</div>}
      </aside>

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
          </>
        )}
      </aside>

      <footer className="source-note">CelesTrak → OMM/JSON → SGP4 → CesiumJS</footer>
    </main>
  )
}

export default App
