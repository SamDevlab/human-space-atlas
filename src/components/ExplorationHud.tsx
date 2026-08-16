import type { CSSProperties } from 'react'
import type { ExplorationHudSnapshot } from '../exploration/types'

interface ExplorationHudProps {
  snapshot: ExplorationHudSnapshot
  debugFlight: boolean
  onExit: () => void
  onOpenNav: () => void
  onOpenSettings: () => void
  controlsHelpVisible: boolean
  onDismissHelp: () => void
}

function speedLabel(speedKmS: number): string {
  if (speedKmS < 1) return `${(speedKmS * 1000).toFixed(0)} m/s`
  return `${speedKmS.toFixed(2)} km/s`
}

function throttleLabel(throttle: number): string {
  const percent = Math.round(Math.abs(throttle) * 100)
  if (percent === 0) return '0%'
  return `${throttle < 0 ? 'REV ' : '+'}${percent}%`
}

function vectorLabel(vector: { x: number; y: number; z: number }): string {
  return `${vector.x.toFixed(2)}  ${vector.y.toFixed(2)}  ${vector.z.toFixed(2)}`
}

export function ExplorationHud({ snapshot, debugFlight, onExit, onOpenNav, onOpenSettings, controlsHelpVisible, onDismissHelp }: ExplorationHudProps) {
  const marker = snapshot.targetIndicator
  const markerStyle = marker ? { left: `${marker.x}px`, top: `${marker.y}px` } : undefined
  const arrowStyle = marker?.edge ? { transform: `rotate(${marker.angle}rad)` } : undefined
  const throttleWidth = `${Math.min(100, Math.abs(snapshot.throttle) * 100)}%`

  const speedFeedback = snapshot.boostActive || snapshot.speedKmS > 8
  return <div className={`exploration-hud ${speedFeedback ? 'speed-feedback' : ''}`}>
    <div className="explore-speed-vignette" aria-hidden="true" />
    <div className="explore-brand"><span className="brand-mark">◉</span> HUMAN SPACE ATLAS <span className="explore-divider">/</span> EXPLORE</div>
    <div className="explore-actions">
      <button className="explore-nav-button" onClick={onOpenNav}>NAV <small>F</small></button>
      <button className="explore-nav-button" onClick={onOpenSettings}>SETTINGS</button>
      <button className="explore-exit" onClick={onExit}>EXIT</button>
    </div>

    {snapshot.targetName && marker && <div className={`explore-target-marker ${marker.edge ? 'edge' : ''}`} style={markerStyle as CSSProperties}>
      <span className="target-arrow" style={arrowStyle}>{marker.edge ? '➜' : '◇'}</span>
      <div><strong>{snapshot.targetName}</strong><small>{snapshot.targetDistanceKm === null ? '—' : snapshot.targetDistanceKm < 1 ? `${(snapshot.targetDistanceKm * 1000).toFixed(0)} m` : `${snapshot.targetDistanceKm.toFixed(snapshot.targetDistanceKm < 10 ? 1 : 0)} km`}</small></div>
    </div>}

    <div className="explore-reticle" aria-hidden="true"><i /><b>+</b><i /></div>
    <div className="explore-altitude"><small>ALTITUDE</small><strong>{snapshot.altitudeKm.toFixed(0)} <em>km</em></strong>{snapshot.lowAltitude && <span>⚠ LOW ALTITUDE</span>}</div>
    <div className="explore-speed"><small>SPEED</small><strong>{speedLabel(snapshot.speedKmS)}</strong></div>
    <div className="explore-throttle"><small>THROTTLE <b>{throttleLabel(snapshot.throttle)}</b></small><div className="throttle-track"><span style={{ width: throttleWidth }} /></div><em>{snapshot.throttle < 0 ? 'REVERSE' : snapshot.throttle > 0 ? 'FORWARD' : 'IDLE'}</em></div>
    <div className="explore-status"><span className="assist-status">● FLIGHT ASSIST <b>{snapshot.flightAssist ? 'ON' : 'OFF'}</b></span>{snapshot.boostActive && <span className="boost-status">BOOST</span>}<span className="camera-hint">THIRD PERSON · MMB ORBIT · WHEEL ZOOM · R RECENTER</span></div>

    {controlsHelpVisible && <div className="explore-help">
      <div className="explore-help-heading"><strong>HSA EXPLORER</strong><span>THIRD-PERSON FLIGHT</span></div>
      <div className="explore-help-grid"><span><b>W / S</b> throttle</span><span><b>Mouse</b> steer</span><span><b>MMB</b> orbit camera</span><span><b>Wheel</b> zoom</span><span><b>A / D</b> strafe</span><span><b>Space / Ctrl</b> vertical</span><span><b>Q / E</b> roll</span><span><b>Shift</b> boost</span><span><b>X</b> brake</span><span><b>R</b> recenter</span></div>
      <button onClick={onDismissHelp}>GOT IT</button>
    </div>}
    {debugFlight && <div className="flight-debug">
      <strong>FLIGHT DEBUG</strong>
      <span>Mouse DX / DY <b>{snapshot.debugFlight.mouseDx.toFixed(1)} / {snapshot.debugFlight.mouseDy.toFixed(1)}</b></span>
      <span>Yaw / Pitch / Roll <b>{snapshot.debugFlight.yawRate.toFixed(2)} / {snapshot.debugFlight.pitchRate.toFixed(2)} / {snapshot.debugFlight.rollRate.toFixed(2)}</b></span>
      <span>Throttle <b>{snapshot.debugFlight.throttle.toFixed(3)}</b></span>
      <span>Velocity <b>{vectorLabel(snapshot.debugFlight.velocity)}</b></span>
      <span>Forward <b>{vectorLabel(snapshot.debugFlight.forward)}</b></span>
      <span>Quaternion <b>{snapshot.debugFlight.orientation.x.toFixed(3)} {snapshot.debugFlight.orientation.y.toFixed(3)} {snapshot.debugFlight.orientation.z.toFixed(3)} {snapshot.debugFlight.orientation.w.toFixed(3)}</b></span>
      <span>Pointer Lock <b>{snapshot.debugFlight.pointerLock ? 'ON' : 'OFF'}</b></span>
    </div>}
  </div>
}
