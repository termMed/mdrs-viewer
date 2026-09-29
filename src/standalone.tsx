// Single-file build entry (no Next.js runtime) used to publish a shareable demo page.
// Build: npm run build:standalone  -> standalone/index.html + standalone/app.js
import { createRoot } from "react-dom/client";
import Explorer from "./components/Explorer";

createRoot(document.getElementById("mdrs-root")!).render(<Explorer />);
