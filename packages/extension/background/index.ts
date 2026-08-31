// Background service worker (Chrome) / background script (Firefox).
// Thin entry point: wires the real platform and engine factory into the
// orchestration in service.ts, which is where the logic (and its tests) live.

import { platform } from "@platform";
import { createEngineClient } from "./engines";
import { startBackground } from "./service";

startBackground({ platform, createEngine: createEngineClient });
