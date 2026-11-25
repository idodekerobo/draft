"use client";

import { NeedsYouPanel, type NeedsYouPanelProps } from "./NeedsYouPanel";

/** Home: what needs the person, above a welcome. The agent thread replaces the welcome in a later slice. */
export function HomeView(props: NeedsYouPanelProps) {
  return (
    <>
      <h1 className="ui-page__title">Home</h1>
      <NeedsYouPanel {...props} />
      <section className="ui-home-welcome" aria-labelledby="home-welcome-title">
        <h2 id="home-welcome-title" className="ui-home-welcome__title">Welcome</h2>
        <p className="ui-home-welcome__text">Draft watches your connected tools and tells you what needs you. Done and Not mine teach it who things belong to.</p>
      </section>
    </>
  );
}
