// The photos of Makito's catalogue through the server (src/photos/proxy.ts), and those of Macma and Easy Gifts out of
// their ZIP archives (src/photos/archive.ts).
//   GET /api/photos/makito/<path under /catalog/assets/>   the picture, typed by its bytes; 404, 503 with Retry-After, 502
//   GET /api/photos/promotray/<archive path>/<entry>        the same, from data.promotray.de
// Behind the login, registered in the signed-in scope of src/app.ts. Only a path comes in: the host is fixed in Makito's
// client, so the route cannot be pointed at another server, and the token never leaves it.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SupplierPhotos } from "./proxy.js";

export const MAKITO_PHOTO_PATH = "/api/photos/makito/";
export const ARCHIVE_PHOTO_PATH = "/api/photos/promotray/";
// A catalogue photo holds no price: the browser may keep it for a day, for this user only. Set after the scope's own
// no-store, which the hook of the route follows.
const PHOTO_CACHE = "private, max-age=86400";

function keepInBrowser(_request: FastifyRequest, reply: FastifyReply, payload: unknown, done: (error: null, value: unknown) => void): void {
  if (reply.statusCode === 200) void reply.header("cache-control", PHOTO_CACHE);
  done(null, payload);
}

export function registerPhotoRoutes(app: FastifyInstance, photos: SupplierPhotos, prefix = MAKITO_PHOTO_PATH, supplier = "makito"): void {
  app.get<{ Params: { "*": string } }>(`${prefix}*`, { onSend: keepInBrowser }, async (request, reply) => {
    const answer = await photos.read(request.params["*"]);
    switch (answer.kind) {
      case "ok":
        return reply.header("content-type", answer.mimeType).header("x-content-type-options", "nosniff").send(answer.bytes);
      case "missing":
        return reply.code(404).send({ error: "Not Found" });
      case "busy":
        request.log.warn({ supplier, retryAfterSeconds: answer.retryAfterSeconds }, "photo refused: request limit");
        return reply.code(503).header("retry-after", answer.retryAfterSeconds).send({ error: "the supplier is busy" });
      case "failed":
        request.log.warn({ supplier, reason: answer.reason }, "photo not read");
        return reply.code(502).send({ error: "the supplier did not give the photo" });
    }
  });
}
