import type { ExplorationHudSnapshot } from '../exploration/types'

interface ExplorationHudProps {
  snapshot: ExplorationHudSnapshot
  onExit: () => void
  onToggleCamera: () => void
}

function speedLabel(speedKmS: number): string {
  if (speedKmS < 1) return `${(speedKmS * 1000).toFixed(0)} m/s`
  return `${speedKmS.toFixed(1)} km/s`
}

export function ExplorationHud({ snapshot, onExit, onToggleCamera }: ExplorationHudProps) {
  return <div className="exploration-hud">
    <div className="explore-brand"><span className="brand-mark">◉</span> HUMAN SPACE ATLAS <span className="explore-divider">/</span> EXPLORE</div>
    <button className="explore-exit" onClick={onExit}>EXIT EXPLORATION</button>
    <div className="explore-target">{snapshot.targetName ? <><strong>◇ {snapshot.targetName}</strong><span>{snapshot.targetDistanceKm === null ? '—' : `${snapshot.targetDistanceKm.toFixed(1)} km`}</span></> : <span>TARGET · NONE</span>}</div>
    <div className="explore-reticle" aria-hidden="true"><i /><b>+</b><i /></div>
    <div className="explore-readouts"><div><small>ALT</small><strong>{snapshot.altitudeKm.toFixed(0)} km</strong></div><div><small>SPD</small><strong>{speedLabel(snapshot.speedKmS)}</strong></div></div>
    <div className="explore-bottom"><span>FLIGHT ASSIST <b>● ON</b></span><button onClick={onToggleCamera}>{snapshot.cameraMode} <small>· C to switch</small></button></div>
  </div>
}
