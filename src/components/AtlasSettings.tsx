import type { MapStyleDefinition } from '../lib/mapStyles'
import { NASA_GIBS_CLOUD_SOURCE } from '../lib/earthLayers'
import { EARTH_EVENT_CATEGORIES } from '../lib/earthEvents'
import type { RenderMode } from '../lib/renderSet'

interface AtlasSettingsProps {
  mapStyles: MapStyleDefinition[]
  mapStyle: string
  mapStyleLoading: boolean
  onMapStyleSelect: (styleId: string) => void
  onHome: () => void
  cloudsEnabled: boolean
  cloudOpacity: number
  cloudShadowsEnabled: boolean
  atmosphereEnabled: boolean
  terrainEnabled: boolean
  orbitsEnabled: boolean
  satelliteTrailsEnabled: boolean
  onCloudsChange: (value: boolean) => void
  onCloudOpacityChange: (value: number) => void
  onCloudShadowsChange: (value: boolean) => void
  onAtmosphereChange: (value: boolean) => void
  onTerrainChange: (value: boolean) => void
  onOrbitsChange: (value: boolean) => void
  onSatelliteTrailsChange: (value: boolean) => void
  terrainLoading: boolean
  aircraftEnabled: boolean
  aircraftRoutesEnabled: boolean
  aircraftDensity: number
  aircraftCount: number
  onAircraftChange: (value: boolean) => void
  onAircraftRoutesChange: (value: boolean) => void
  onAircraftDensityChange: (value: number) => void
  earthEventsEnabled: boolean
  earthEventCount: number
  eventCategories: string[]
  onEarthEventsChange: (value: boolean) => void
  onEventCategoryChange: (categoryId: string, value: boolean) => void
  renderMode: RenderMode
  customLimit: number
  renderLimit: number
  objectCount: number
  visibleCount: number
  onRenderModeChange: (mode: RenderMode) => void
  onCustomLimitChange: (value: number) => void
  onClose: () => void
}

const mapNames: Record<string, string> = {
  satellite: 'Satélite',
  'arcgis-world-imagery': 'Imagem mundial ArcGIS',
  'arcgis-world-hillshade': 'Relevo ArcGIS',
  'esri-world-ocean': 'Oceano mundial Esri',
  'open-street-map': 'Mapa de ruas',
  'natural-earth-ii': 'Terra natural II',
}

function toggleLabel(checked: boolean): string {
  return checked ? 'ATIVO' : 'OCULTO'
}

export function AtlasSettings(props: AtlasSettingsProps) {
  return <section className="settings-popover glass">
    <div className="popover-heading"><span className="panel-title">Configurações</span><button className="close-button" onClick={props.onClose} aria-label="Fechar configurações">×</button></div>
    <span className="panel-title section-label">Visão</span>
    <button className="home-setting" onClick={props.onHome} aria-label="Voltar para a visão geral"><span>⌂</span><div><strong>Visão geral</strong><small>Voltar para a visão da Terra</small></div></button>

    <span className="panel-title section-label">Estilo do mapa {props.mapStyleLoading && <span className="map-loading"><span /> Carregando mapa</span>}</span>
    <div className="map-style-list">{props.mapStyles.map((style) => <button key={style.id} className={props.mapStyle === style.id ? 'active' : ''} onClick={() => props.onMapStyleSelect(style.id)} title={style.tooltip}><span className={`map-preview ${style.id === 'satellite' ? 'satellite-preview' : style.id === 'openstreetmap' ? 'map-preview-osm' : 'map-preview-generic'}`} style={style.iconUrl ? { backgroundImage: `url(${style.iconUrl})` } : undefined} /><div><strong>{mapNames[style.id] ?? style.name}</strong><small>{style.isDefault ? 'PADRÃO' : props.mapStyle === style.id ? 'SELECIONADO' : style.id === 'natural-earth-ii' ? 'Mapa atlas' : 'Imagem'}</small></div>{props.mapStyle === style.id && <span className="map-check">✓</span>}</button>)}</div>

    <span className="panel-title section-label">Camadas da Terra</span>
    <label className="layer-toggle"><input type="checkbox" checked={props.atmosphereEnabled} onChange={(event) => props.onAtmosphereChange(event.target.checked)} /><span><strong>Atmosfera</strong><small>Brilho azul e transição dia/noite</small></span><b>{toggleLabel(props.atmosphereEnabled)}</b></label>
    <label className="layer-toggle"><input type="checkbox" checked={props.cloudsEnabled} onChange={(event) => props.onCloudsChange(event.target.checked)} /><span><strong>Nuvens</strong><small>{NASA_GIBS_CLOUD_SOURCE}</small></span><b>{toggleLabel(props.cloudsEnabled)}</b></label>
    <label className="small-control">Opacidade das nuvens · {Math.round(props.cloudOpacity * 100)}%<input type="range" min="0" max="1" step="0.05" value={props.cloudOpacity} onChange={(event) => props.onCloudOpacityChange(Number(event.target.value))} /></label>
    <label className="layer-toggle"><input type="checkbox" checked={props.cloudShadowsEnabled} onChange={(event) => props.onCloudShadowsChange(event.target.checked)} /><span><strong>Sombras das nuvens</strong><small>Sombras suaves sobre o relevo</small></span><b>{toggleLabel(props.cloudShadowsEnabled)}</b></label>
    <label className="layer-toggle"><input type="checkbox" checked={props.terrainEnabled} onChange={(event) => props.onTerrainChange(event.target.checked)} /><span><strong>Relevo 3D</strong><small>{props.terrainLoading ? 'Carregando elevação progressiva…' : 'Elevação mundial detalhada'}</small></span><b>{props.terrainLoading ? 'CARREGANDO' : toggleLabel(props.terrainEnabled)}</b></label>
    <label className="layer-toggle"><input type="checkbox" checked={props.orbitsEnabled} onChange={(event) => props.onOrbitsChange(event.target.checked)} /><span><strong>Órbitas</strong><small>Linhas orbitais dos objetos selecionados</small></span><b>{toggleLabel(props.orbitsEnabled)}</b></label>
    <label className="layer-toggle"><input type="checkbox" checked={props.satelliteTrailsEnabled} onChange={(event) => props.onSatelliteTrailsChange(event.target.checked)} /><span><strong>Rastro do satélite</strong><small>Traço luminoso curto do movimento</small></span><b>{toggleLabel(props.satelliteTrailsEnabled)}</b></label>
    <p className="microcopy">A luz do Sol e a Lua acompanham o relógio simulado.</p>

    <span className="panel-title section-label">Tráfego aéreo</span>
    <label className="layer-toggle"><input type="checkbox" checked={props.aircraftEnabled} onChange={(event) => props.onAircraftChange(event.target.checked)} /><span><strong>Aeronaves ao vivo</strong><small>OpenSky ADS-B · {props.aircraftCount} voando</small></span><b>{toggleLabel(props.aircraftEnabled)}</b></label>
    {props.aircraftEnabled && <><label className="layer-toggle"><input type="checkbox" checked={props.aircraftRoutesEnabled} onChange={(event) => props.onAircraftRoutesChange(event.target.checked)} /><span><strong>Rotas ao selecionar</strong><small>O rastro aparece somente ao clicar na aeronave</small></span><b>{toggleLabel(props.aircraftRoutesEnabled)}</b></label><label className="small-control">Densidade de aeronaves · {props.aircraftDensity}<input type="range" min="25" max="300" step="25" value={props.aircraftDensity} onChange={(event) => props.onAircraftDensityChange(Number(event.target.value))} /></label></>}

    <span className="panel-title section-label">Eventos da Terra</span>
    <label className="layer-toggle"><input type="checkbox" checked={props.earthEventsEnabled} onChange={(event) => props.onEarthEventsChange(event.target.checked)} /><span><strong>Eventos da Terra</strong><small>NASA EONET v3 · {props.earthEventCount} ativos</small></span><b>{toggleLabel(props.earthEventsEnabled)}</b></label>
    <div className="event-category-list">{EARTH_EVENT_CATEGORIES.map((category) => <label key={category.id}><input type="checkbox" checked={props.eventCategories.includes(category.id)} onChange={(event) => props.onEventCategoryChange(category.id, event.target.checked)} /><span>{category.label}</span></label>)}</div>

    <span className="panel-title section-label">Densidade de renderização</span>
    <div className="density-list">{(['AUTO', '1000', '2500', '5000', '10000', '25000', 'MAXIMUM'] as RenderMode[]).map((mode) => <button key={mode} className={props.renderMode === mode ? 'active' : ''} onClick={() => props.onRenderModeChange(mode)}><span>{mode === 'AUTO' ? 'Automática' : mode === 'MAXIMUM' ? 'Máxima' : Number(mode).toLocaleString('pt-BR')}</span><small>{mode === 'AUTO' ? 'Recomendada' : mode === '1000' ? 'Baixa' : mode === '5000' ? 'Equilibrada' : mode === '10000' ? 'Alta' : mode === '25000' ? 'Ultra' : ''}</small></button>)}</div>
    <label className="small-control">Personalizada · {props.customLimit.toLocaleString('pt-BR')} objetos<input type="range" min="1000" max="50000" step="500" value={props.customLimit} onChange={(event) => props.onCustomLimitChange(Number(event.target.value))} /></label>
    <p className="microcopy">Catálogo: {props.objectCount.toLocaleString('pt-BR')} · Exibidos: {props.visibleCount.toLocaleString('pt-BR')}<br />O catálogo completo continua pesquisável.</p>
    {props.renderLimit >= 25000 && <p className="warning-copy">Densidades altas podem reduzir o desempenho.</p>}
  </section>
}
