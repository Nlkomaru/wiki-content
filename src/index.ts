import { createContentApp } from "hagaki/content-worker";

// Serves the static content, refusing to serve draft articles — see
// `createContentApp` for the routing contract with `run_worker_first`.
export default createContentApp();
