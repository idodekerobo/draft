// StatusBar.tsx — empty strip at the top of the main window. It stays so the window can be dragged.

import { memo } from "react";

export const StatusBar = memo(function StatusBar() {
  return <header className="status-bar electrobun-webkit-app-region-drag" />;
});
