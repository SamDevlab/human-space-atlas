import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import './styles.css'
import './stage-b.css'
import App from './App'
import { StageBWorkbench } from './components/StageBWorkbench'

// Start every Atlas session with clouds disabled, regardless of the previous
// session. The user can still enable them normally from the UI; this reset only
// defines the clean initial presentation on a fresh page load.
localStorage.setItem('human-space-atlas.clouds-enabled', '0')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <StageBWorkbench />
  </StrictMode>,
)
