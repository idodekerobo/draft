"use client";

import { NeedsYouPanel, type NeedsYouPanelProps } from "./NeedsYouPanel";

/** Home: what needs the person. The agent thread goes below it in a later slice. */
export function HomeView(props: NeedsYouPanelProps) {
  return (
    <>
      <h1 className="ui-page__title">Home</h1>
      <NeedsYouPanel {...props} />
    </>
  );
}
