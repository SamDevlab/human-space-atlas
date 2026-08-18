import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import './styles.css'
import './stage-b.css'
import App from './App'
import { StageBWorkbench } from './components/StageBWorkbench'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <StageBWorkbench />
  </StrictMode>,
)
