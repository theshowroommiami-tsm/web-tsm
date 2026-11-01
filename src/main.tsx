
import { createRoot, hydrateRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.tsx'
import './index.css'
import { initCallTracking } from './utils/callTracking'
import { initAttribution } from './lib/cbAttribution'
import { initEstimateCtaTracking } from './lib/cbDataLayer'

initCallTracking();
initAttribution();
initEstimateCtaTracking();

const root = document.getElementById("root")!;
const app = (
  <BrowserRouter>
    <App />
  </BrowserRouter>
);

// Use hydration for SSR in production
if (import.meta.env.PROD) {
  hydrateRoot(root, app);
} else {
  createRoot(root).render(app);
}
