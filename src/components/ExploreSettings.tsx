interface ExploreSettingsProps {
  steeringSensitivity: number
  cameraSensitivity: number
  onSteeringChange: (value: number) => void
  onCameraChange: (value: number) => void
  onClose: () => void
}

export function ExploreSettings({ steeringSensitivity, cameraSensitivity, onSteeringChange, onCameraChange, onClose }: ExploreSettingsProps) {
  return <section className="explore-settings glass">
    <div className="explore-nav-heading"><span className="panel-title">Explore settings</span><button className="close-button" onClick={onClose} aria-label="Close Explore settings">×</button></div>
    <label>Mouse steering <strong>{steeringSensitivity.toFixed(2)}×</strong><input type="range" min="0.25" max="2" step="0.05" value={steeringSensitivity} onChange={(event) => onSteeringChange(Number(event.target.value))} /></label>
    <label>Camera orbit <strong>{cameraSensitivity.toFixed(2)}×</strong><input type="range" min="0.25" max="2" step="0.05" value={cameraSensitivity} onChange={(event) => onCameraChange(Number(event.target.value))} /></label>
    <small>Flight Assist remains active · R recenters the camera</small>
  </section>
}
