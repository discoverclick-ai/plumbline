import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from index.html')

// Vite proxies /api to the API server, so the browser stays on one origin and
// there is no CORS layer to configure.
createRoot(container).render(
  <StrictMode>
    <App baseUrl="/api" />
  </StrictMode>,
)
