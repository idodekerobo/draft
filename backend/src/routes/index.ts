import * as health from "./health";
import * as whoami from "./whoami";

export const routes = {
  "/health": { GET: health.GET },
  "/whoami": { GET: whoami.GET },
};
