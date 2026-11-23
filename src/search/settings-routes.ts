// The search settings API (docs/integrations.md, «Налаштування пошуку»):
//   GET /api/search/settings          { defaults, codeDefaults, updatedAt }: every signed-in role, the search screen's
//                                     switches start from the defaults
//   PUT /api/admin/search-settings    { settings }: every setting, the admin's alone (the admin scope of src/app.ts);
//                                     200 with the same shape as GET, 400 for a missing or unknown key or value
// A search takes some of them for itself (POST /api/search, settings), src/search/routes.ts.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { signedInUser } from "../auth/routes.js";
import { CODE_DEFAULT_SETTINGS, fullSettingsSchema, type SearchSettings } from "./settings.js";
import type { SearchDefaults, SearchSettingsService } from "./settings-store.js";

interface SaveBody {
  settings: SearchSettings;
}

// Nine short values take some 350 bytes: a body of a megabyte (Fastify's default) is never one of them
const SAVE_BODY_LIMIT_BYTES = 4_096;

const saveBodySchema = {
  type: "object", additionalProperties: false, required: ["settings"], properties: { settings: fullSettingsSchema },
} as const;

function answerOf({ defaults, updatedAt }: SearchDefaults) {
  return { defaults, codeDefaults: CODE_DEFAULT_SETTINGS, updatedAt };
}

// Saved keys this release does not know hold the code's defaults: the admin saves the settings again to clear them
function warnDropped(request: FastifyRequest, read: SearchDefaults): void {
  if (read.dropped.length) request.log.warn({ dropped: read.dropped }, "search settings: saved keys or values not known, the code's defaults hold");
}

// In the signed-in scope
export function registerSettingsRoutes(app: FastifyInstance, service: SearchSettingsService): void {
  app.get("/api/search/settings", async (request) => {
    const read = await service.read();
    warnDropped(request, read);
    return answerOf(read);
  });
}

// In the admin scope
export function registerAdminSettingsRoutes(app: FastifyInstance, service: SearchSettingsService): void {
  app.put<{ Body: SaveBody }>("/api/admin/search-settings", {
    bodyLimit: SAVE_BODY_LIMIT_BYTES, schema: { body: saveBodySchema },
  }, async (request) => {
    const admin = signedInUser(request);
    const saved = await service.save(request.body.settings, admin.id);
    request.log.info({ userId: admin.id, settings: request.body.settings }, "search settings saved");
    return answerOf(saved);
  });
}
