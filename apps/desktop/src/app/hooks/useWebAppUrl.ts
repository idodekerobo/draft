import { useEffect, useState } from "react";
import { rpc } from "../rpc";

let cached: Promise<string> | undefined;

/** The web app origin for shared links. Undefined until the main process answers. */
export function useWebAppUrl(): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    cached ??= rpc.request.getWebAppUrl();
    let live = true;
    cached.then((value) => live && setUrl(value)).catch(() => { cached = undefined; });
    return () => { live = false; };
  }, []);
  return url;
}
