interface ExploreSettingsProps {
  cameraSensitivity: number
  onCameraChange: (value: number) => void
  cameraPreset: 'ASTRONAUT' | 'ORBIT' | 'FOLLOW'
  onCameraPresetChange: (value: 'ASTRONAUT' | 'ORBIT' | 'FOLLOW') => void
  orbitsEnabled: boolean
  onOrbitsChange: (enabled: boolean) => void
  cloudsEnabled: boolean
  cloudOpacity: number
  cloudShadowsEnabled: boolean
  onCloudsChange: (enabled: boolean) => void
  onCloudOpacityChange: (opacity: number) => void
  onCloudShadowsChange: (enabled: boolean) => void
  objectMarkerEnabled: boolean
  onObjectMarkerChange: (enabled: boolean) => void
  onVisualOnly: () => void
  onClose: () => void
}

export function ExploreSettings({ cameraSensitivity, onCameraChange, cameraPreset, onCameraPresetChange, orbitsEnabled, onOrbitsChange, cloudsEnabled, cloudOpacity, cloudShadowsEnabled, onCloudsChange, onCloudOpacityChange, onCloudShadowsChange, objectMarkerEnabled, onObjectMarkerChange, onVisualOnly, onClose }: ExploreSettingsProps) {
  return <section className="explore-settings glass">
    <div className="explore-nav-heading"><span className="panel-title">Configurações da exploração</span><button className="close-button" onClick={onClose} aria-label="Fechar configurações da exploração">×</button></div>
    <span className="panel-title section-label">Predefinição da câmera</span>
    <div className="camera-presets">
      {([['ASTRONAUT', 'Visão astronauta'], ['ORBIT', 'Órbita externa'], ['FOLLOW', 'Acompanhamento']] as const).map(([value, label]) => <button key={value} className={cameraPreset === value ? 'active' : ''} onClick={() => onCameraPresetChange(value)}>{label}</button>)}
    </div>
    <label>Sensibilidade da órbita <strong>{cameraSensitivity.toFixed(2)}×</strong><input type="range" min="0.25" max="2" step="0.05" value={cameraSensitivity} onChange={(event) => onCameraChange(Number(event.target.value))} /></label>
    <span className="panel-title section-label">Elementos da cena</span>
    <label className="explore-toggle"><span><strong>Traçado da órbita</strong><small>Linha do objeto selecionado</small></span><input type="checkbox" checked={orbitsEnabled} onChange={(event) => onOrbitsChange(event.target.checked)} /></label>
    <label className="explore-toggle"><span><strong>Nuvens</strong><small>Campo de nuvens da Terra</small></span><input type="checkbox" checked={cloudsEnabled} onChange={(event) => onCloudsChange(event.target.checked)} /></label>
    <label>Opacidade das nuvens <strong>{Math.round(cloudOpacity * 100)}%</strong><input type="range" min="0" max="1" step="0.05" value={cloudOpacity} onChange={(event) => onCloudOpacityChange(Number(event.target.value))} /></label>
    <label className="explore-toggle"><span><strong>Sombras das nuvens</strong><small>Sombras suaves no modo mapa</small></span><input type="checkbox" checked={cloudShadowsEnabled} onChange={(event) => onCloudShadowsChange(event.target.checked)} /></label>
    <label className="explore-toggle"><span><strong>Ponto e nome do objeto</strong><small>Marcador da estação acompanhada</small></span><input type="checkbox" checked={objectMarkerEnabled} onChange={(event) => onObjectMarkerChange(event.target.checked)} /></label>
    <button className="visual-only-button" onClick={onVisualOnly}>APENAS VISUALIZAÇÃO · OCULTAR HUD</button>
    <small>Acompanhamento orbital · arraste para orbitar a câmera · R recentraliza</small>
  </section>
}
