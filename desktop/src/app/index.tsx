// desktop/src/app/index.tsx — React entry point for the renderer process
//
// Initializes the RPC singleton (must happen before any bun request is made)
// then mounts the React root into #root.

import "./rpc"; // side-effect: registers all webview message handlers
import { createRoot } from "react-dom/client";
import { App } from "./App";

const container = document.getElementById("root");
if (!container) throw new Error("[draft-desktop] #root element not found in index.html");

createRoot(container).render(<App />);
