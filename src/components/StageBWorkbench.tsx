import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchCatalog } from '../lib/api'
import type { OmmRecord } from '../lib/types'
import { GROUND_STATIONS } from '../lib/groundStations'
import { predictPasses, type ObserverLocation, type PredictedPass } from '../lib/passPrediction'
import { screenConjunctions, type ConjunctionScreeningResult } from '../lib/conjunctions'
import { assessReentry } from '../lib/reentry'
import {
  ASTRONOMICAL_UNIT_KM,
  DEEP_SPACE_TARGETS,
  EARTH_HORIZONS_TARGET,
  SOLAR_ORBIT_RADII_AU,
  distanceBetweenVectorsKm,
  fetchHorizonsVector,
  type HorizonsVector,
} from '../lib/deepSpace'

type WorkbenchTab = 'passes' | 'conjunctions' | 'reentry' | 'deep-space'

function formatUtc(date: Date) {
  return date.toLocaleString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' UTC'
}

function DeepSpaceMap({ vector, earth }: { vector: HorizonsVector | null; earth: HorizonsVector | null }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const draw = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(rect.height * dpr))
      const context = canvas.getContext('2d')
      if (!context) return
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      const width = rect.width
      const height = rect.height
      context.clearRect(0, 0, width, height)
      const cx = width * 0.5
      const cy = height * 0.5
      const missionAu = vector ? vector.distanceFromSunKm / ASTRONOMICAL_UNIT_KM : 1
      const maxAu = Math.max(35, missionAu * 1.12)
      const maxRadius = Math.min(width, height) * 0.44
      const radiusForAu = (au: number) => maxRadius * Math.log10(1 + Math.max(0, au)) / Math.log10(1 + maxAu)

      context.strokeStyle = 'rgba(138, 190, 225, .16)'
      context.fillStyle = 'rgba(174, 210, 234, .56)'
      context.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
      for (const orbit of SOLAR_ORBIT_RADII_AU) {
        const radius = radiusForAu(orbit.au)
        context.beginPath()
        context.arc(cx, cy, radius, 0, Math.PI * 2)
        context.stroke()
        if (orbit.name === 'Terra' || orbit.name === 'Júpiter' || orbit.name === 'Netuno') context.fillText(orbit.name, cx + radius + 4, cy - 3)
      }

      context.fillStyle = '#ffd98d'
      context.beginPath()
      context.arc(cx, cy, 5, 0, Math.PI * 2)
      context.fill()
      context.fillStyle = 'rgba(255, 228, 170, .72)'
      context.fillText('SOL', cx + 9, cy - 7)

      const drawVector = (item: HorizonsVector, label: string, fill: string, radius = 4) => {
        const xAu = item.positionKm[0] / ASTRONOMICAL_UNIT_KM
        const yAu = item.positionKm[1] / ASTRONOMICAL_UNIT_KM
        const length = Math.hypot(xAu, yAu)
        const plottedRadius = radiusForAu(length)
        const angle = Math.atan2(yAu, xAu)
        const x = cx + Math.cos(angle) * plottedRadius
        const y = cy + Math.sin(angle) * plottedRadius
        context.strokeStyle = fill
        context.globalAlpha = 0.28
        context.beginPath()
        context.moveTo(cx, cy)
        context.lineTo(x, y)
        context.stroke()
        context.globalAlpha = 1
        context.fillStyle = fill
        context.beginPath()
        context.arc(x, y, radius, 0, Math.PI * 2)
        context.fill()
        context.fillStyle = 'rgba(230, 244, 255, .9)'
        context.fillText(label, x + 8, y - 7)
      }

      if (earth) drawVector(earth, 'Terra', '#74cfff', 3.5)
      if (vector) drawVector(vector, vector.target.name, '#8dffcc', 5)

      context.fillStyle = 'rgba(150, 186, 211, .62)'
      context.fillText('PROJEÇÃO HELIOCÊNTRICA J2000 · ESCALA RADIAL LOGARÍTMICA', 14, height - 14)
    }

    draw()
    window.addEventListener('resize', draw)
    return () => window.removeEventListener('resize', draw)
  }, [vector, earth])

  return <canvas ref={ref} className="stage-b-deep-map" aria-label="Mapa heliocêntrico do Sistema Solar" />
}

export function StageBWorkbench() {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<WorkbenchTab>('passes')
  const [catalog, setCatalog] = useState<OmmRecord[]>([])
  const [catalogStatus, setCatalogStatus] = useState('Catálogo ainda não carregado')
  const [query, setQuery] = useState('ISS')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [observer, setObserver] = useState<ObserverLocation>({ latitudeDeg: -12.9714, longitudeDeg: -38.5014, altitudeMeters: 8, name: 'Salvador' })
  const [passes, setPasses] = useState<PredictedPass[]>([])
  const [conjunctions, setConjunctions] = useState<ConjunctionScreeningResult[]>([])
  const [analysisBusy, setAnalysisBusy] = useState(false)
  const [analysisError, setAnalysisError] = useState<string | null>(null)
  const [deepTargetId, setDeepTargetId] = useState(DEEP_SPACE_TARGETS[0].id)
  const [deepVector, setDeepVector] = useState<HorizonsVector | null>(null)
  const [earthVector, setEarthVector] = useState<HorizonsVector | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && open) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  useEffect(() => {
    if (!open || catalog.length > 0) return
    const controller = new AbortController()
    setCatalogStatus('Carregando catálogo ativo…')
    fetchCatalog('active', controller.signal)
      .then((payload) => {
        setCatalog(payload.objects)
        setCatalogStatus(`${payload.objects.length.toLocaleString('pt-BR')} objetos · ${payload.cache === 'hit' ? 'cache' : 'fonte pública'}`)
        const iss = payload.objects.find((item) => item.OBJECT_NAME.toUpperCase().includes('ISS'))
        setSelectedId((current) => current ?? iss?.NORAD_CAT_ID ?? payload.objects[0]?.NORAD_CAT_ID ?? null)
      })
      .catch((error: unknown) => setCatalogStatus(error instanceof Error ? error.message : 'Catálogo indisponível'))
    return () => controller.abort()
  }, [open, catalog.length])

  const selected = useMemo(() => catalog.find((item) => item.NORAD_CAT_ID === selectedId) ?? null, [catalog, selectedId])
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return catalog.slice(0, 12)
    return catalog.filter((item) => item.OBJECT_NAME.toLowerCase().includes(needle) || String(item.NORAD_CAT_ID).includes(needle)).slice(0, 12)
  }, [catalog, query])
  const reentry = selected ? assessReentry(selected) : null

  const runPasses = () => {
    if (!selected) return
    setAnalysisError(null)
    setAnalysisBusy(true)
    window.setTimeout(() => {
      try { setPasses(predictPasses(selected, observer, new Date(), 24, 10, 8)) }
      catch (error) { setAnalysisError(error instanceof Error ? error.message : String(error)) }
      finally { setAnalysisBusy(false) }
    }, 0)
  }

  const runConjunctions = () => {
    if (!selected) return
    setAnalysisError(null)
    setAnalysisBusy(true)
    window.setTimeout(() => {
      try { setConjunctions(screenConjunctions(selected, catalog, new Date(), 90, 8)) }
      catch (error) { setAnalysisError(error instanceof Error ? error.message : String(error)) }
      finally { setAnalysisBusy(false) }
    }, 0)
  }

  const useMyLocation = () => {
    if (!navigator.geolocation) return setAnalysisError('Geolocalização não disponível neste navegador.')
    navigator.geolocation.getCurrentPosition(
      (position) => setObserver({ latitudeDeg: position.coords.latitude, longitudeDeg: position.coords.longitude, altitudeMeters: position.coords.altitude ?? 0, name: 'Minha localização' }),
      (error) => setAnalysisError(`Não foi possível usar sua localização: ${error.message}`),
      { enableHighAccuracy: false, timeout: 8_000, maximumAge: 300_000 },
    )
  }

  const loadDeepSpace = async () => {
    const target = DEEP_SPACE_TARGETS.find((item) => item.id === deepTargetId)
    if (!target) return
    setAnalysisBusy(true)
    setAnalysisError(null)
    const controller = new AbortController()
    try {
      const [mission, earth] = await Promise.all([
        fetchHorizonsVector(target, new Date(), controller.signal),
        fetchHorizonsVector(EARTH_HORIZONS_TARGET, new Date(), controller.signal),
      ])
      setDeepVector(mission)
      setEarthVector(earth)
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : String(error))
    } finally {
      setAnalysisBusy(false)
    }
  }

  const selectCatalogObject = (record: OmmRecord) => {
    setSelectedId(record.NORAD_CAT_ID)
    setQuery(record.OBJECT_NAME)
    setPasses([])
    setConjunctions([])
    setAnalysisError(null)
  }

  return (
    <>
      <button className="stage-b-launcher" onClick={() => setOpen(true)} aria-label="Abrir inteligência orbital">INTEL</button>
      {open && <section className="stage-b-backdrop" role="dialog" aria-modal="true" aria-label="Inteligência orbital e espaço profundo">
        <div className="stage-b-workbench">
          <header className="stage-b-header">
            <div><span className="stage-b-kicker">HUMAN SPACE ATLAS</span><h2>ORBITAL INTELLIGENCE</h2><p>Passagens · estações · conjunction screening · reentrada · JPL Horizons</p></div>
            <button onClick={() => setOpen(false)} aria-label="Fechar inteligência orbital">×</button>
          </header>

          <nav className="stage-b-tabs">
            <button className={tab === 'passes' ? 'active' : ''} onClick={() => setTab('passes')}>PASSAGENS</button>
            <button className={tab === 'conjunctions' ? 'active' : ''} onClick={() => setTab('conjunctions')}>CONJUNÇÕES</button>
            <button className={tab === 'reentry' ? 'active' : ''} onClick={() => setTab('reentry')}>REENTRADA</button>
            <button className={tab === 'deep-space' ? 'active' : ''} onClick={() => setTab('deep-space')}>DEEP SPACE</button>
          </nav>

          {tab !== 'deep-space' && <div className="stage-b-object-picker">
            <label>OBJETO ORBITAL<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Nome ou NORAD" /></label>
            <div className="stage-b-search-results">
              {filtered.map((record) => <button key={record.NORAD_CAT_ID} className={record.NORAD_CAT_ID === selectedId ? 'active' : ''} onClick={() => selectCatalogObject(record)}><strong>{record.OBJECT_NAME}</strong><span>NORAD {record.NORAD_CAT_ID} · {record.OBJECT_TYPE ?? 'OBJECT'}</span></button>)}
            </div>
            <small>{catalogStatus}</small>
          </div>}

          <div className="stage-b-content">
            {tab === 'passes' && <>
              <div className="stage-b-panel stage-b-observer">
                <span className="stage-b-kicker">OBSERVADOR</span>
                <div className="stage-b-station-grid">
                  {GROUND_STATIONS.map((station) => <button key={station.id} onClick={() => setObserver({ latitudeDeg: station.latitudeDeg, longitudeDeg: station.longitudeDeg, altitudeMeters: station.altitudeMeters, name: `${station.network} · ${station.name}` })}><strong>{station.name}</strong><span>{station.network}</span></button>)}
                </div>
                <div className="stage-b-coordinates">
                  <label>LAT<input type="number" step="0.0001" value={observer.latitudeDeg} onChange={(event) => setObserver((value) => ({ ...value, latitudeDeg: Number(event.target.value) }))} /></label>
                  <label>LON<input type="number" step="0.0001" value={observer.longitudeDeg} onChange={(event) => setObserver((value) => ({ ...value, longitudeDeg: Number(event.target.value) }))} /></label>
                  <button onClick={useMyLocation}>USAR MINHA LOCALIZAÇÃO</button>
                </div>
                <p className="stage-b-note">{observer.name ?? 'Coordenadas manuais'} · máscara de elevação 10°. Previsão SGP4 baseada no OMM público atual.</p>
                <button className="stage-b-primary" disabled={!selected || analysisBusy} onClick={runPasses}>{analysisBusy ? 'CALCULANDO…' : 'CALCULAR PRÓXIMAS 24H'}</button>
              </div>
              <div className="stage-b-panel">
                <span className="stage-b-kicker">PRÓXIMAS PASSAGENS</span>
                {passes.length === 0 ? <div className="stage-b-empty">Calcule as passagens para o objeto e observador selecionados.</div> : <div className="stage-b-list">{passes.map((pass, index) => <article key={`${pass.riseAt.toISOString()}-${index}`}><strong>{formatUtc(pass.peakAt)}</strong><span>máx. {pass.maxElevationDeg.toFixed(1)}° · {(pass.durationSeconds / 60).toFixed(1)} min</span><small>nasce {formatUtc(pass.riseAt)} · põe {formatUtc(pass.setAt)}</small></article>)}</div>}
              </div>
            </>}

            {tab === 'conjunctions' && <>
              <div className="stage-b-panel">
                <span className="stage-b-kicker">SCREENING ±90 MIN</span>
                <h3>{selected?.OBJECT_NAME ?? 'Selecione um objeto'}</h3>
                <p className="stage-b-note">Triagem geométrica contra até 900 objetos do catálogo público carregado. Não usa covariância, CDM nem calcula probabilidade de colisão.</p>
                <button className="stage-b-primary" disabled={!selected || analysisBusy} onClick={runConjunctions}>{analysisBusy ? 'ANALISANDO…' : 'PROCURAR APROXIMAÇÕES'}</button>
              </div>
              <div className="stage-b-panel">
                <span className="stage-b-kicker">MENORES DISTÂNCIAS ENCONTRADAS</span>
                {conjunctions.length === 0 ? <div className="stage-b-empty">Nenhum screening executado.</div> : <div className="stage-b-list">{conjunctions.map((item) => <article key={item.catalogId}><strong>{item.name}</strong><span>{item.missDistanceKm.toFixed(item.missDistanceKm < 100 ? 1 : 0)} km · {formatUtc(item.closestAt)}</span><small>{item.relativeSpeedKmS === null ? 'velocidade relativa indisponível' : `vel. relativa ${item.relativeSpeedKmS.toFixed(2)} km/s`} · NORAD {item.catalogId}</small></article>)}</div>}
              </div>
            </>}

            {tab === 'reentry' && <>
              <div className="stage-b-panel stage-b-reentry-card">
                <span className="stage-b-kicker">DECAY WATCH</span>
                <h3>{selected?.OBJECT_NAME ?? 'Selecione um objeto'}</h3>
                {reentry && <><strong className={`stage-b-risk ${reentry.status}`}>{reentry.label}</strong><p>{reentry.reason}</p><dl><div><dt>PERIGEU DERIVADO</dt><dd>{reentry.perigeeKm === null ? '—' : `${reentry.perigeeKm.toFixed(1)} km`}</dd></div><div><dt>APOGEU DERIVADO</dt><dd>{reentry.apogeeKm === null ? '—' : `${reentry.apogeeKm.toFixed(1)} km`}</dd></div><div><dt>BSTAR</dt><dd>{reentry.bstar.toExponential(3)}</dd></div><div><dt>MEAN MOTION DOT</dt><dd>{reentry.meanMotionDot.toExponential(3)}</dd></div></dl></>}
              </div>
              <div className="stage-b-panel"><span className="stage-b-kicker">INTERPRETAÇÃO</span><p className="stage-b-note">O Atlas não fabrica uma data de reentrada. Quando o catálogo informa DECAY_DATE, ela é exibida. Fora disso, mostramos somente o estado orbital derivável do OMM e sinais de arrasto.</p></div>
            </>}

            {tab === 'deep-space' && <>
              <div className="stage-b-panel stage-b-deep-controls">
                <span className="stage-b-kicker">JPL HORIZONS · HELIOCÊNTRICO</span>
                <label>MISSÃO<select value={deepTargetId} onChange={(event) => { setDeepTargetId(event.target.value); setDeepVector(null) }}>{DEEP_SPACE_TARGETS.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}</select></label>
                <button className="stage-b-primary" disabled={analysisBusy} onClick={loadDeepSpace}>{analysisBusy ? 'CONSULTANDO JPL…' : 'ATUALIZAR VETOR'}</button>
                {deepVector && <dl><div><dt>DISTÂNCIA DO SOL</dt><dd>{(deepVector.distanceFromSunKm / ASTRONOMICAL_UNIT_KM).toFixed(3)} AU</dd></div><div><dt>VELOCIDADE HELIOCÊNTRICA</dt><dd>{deepVector.speedKmS.toFixed(2)} km/s</dd></div><div><dt>DISTÂNCIA DA TERRA</dt><dd>{earthVector ? `${(distanceBetweenVectorsKm(deepVector, earthVector) / ASTRONOMICAL_UNIT_KM).toFixed(3)} AU` : '—'}</dd></div><div><dt>ÉPOCA</dt><dd>{deepVector.epochLabel ?? '—'}</dd></div></dl>}
                <p className="stage-b-note">Vetores servidos pelo backend do Atlas a partir do NASA/JPL Horizons. O mapa usa projeção 2D J2000 e escala radial logarítmica para caber de 0,3 AU a dezenas de AU na mesma cena.</p>
              </div>
              <div className="stage-b-panel stage-b-deep-panel"><DeepSpaceMap vector={deepVector} earth={earthVector} /></div>
            </>}
          </div>
          {analysisError && <div className="stage-b-error">{analysisError}</div>}
        </div>
      </section>}
    </>
  )
}
