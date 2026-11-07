// The own products API of stage 6 (docs/integrations.md, «Свої товари»).
//   GET    /api/own-products                             the products, each with its linked models
//   POST   /api/own-products                             { name, code? }
//   GET    /api/own-products/links?modelIds=1&modelIds=2 the links of these models, for the marks on result cards
//   PUT    /api/own-products/:ownProductId/links/:modelId { type }; a repeat of the pair sets its type
//   DELETE /api/own-products/:ownProductId/links/:modelId
// Behind the login, registered in the signed-in scope of src/app.ts. Cross-site requests come without the cookie
// (SameSite=Strict, src/auth/session.ts) and are refused by Sec-Fetch-Site (src/auth/routes.ts); the body schemas take
// no form, and PUT and DELETE need a preflight that the server, with no CORS, does not answer.
import type { FastifyInstance, FastifyReply } from "fastify";
import { OwnProductExists, OwnProductInputError, OwnProductNotFound } from "./errors.js";
import {
  type LinkBody, linkBodySchema, type LinkParams, linkParamsSchema, type ModelLinksQuery, modelLinksQuerySchema,
  type OwnProductBody, ownProductBodySchema, parseOwnProduct,
} from "./request.js";
import type { OwnProductsService } from "./store.js";

const LINK_PATH = "/api/own-products/:ownProductId/links/:modelId";

function sendFailure(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof OwnProductInputError) return reply.code(400).send({ error: error.message });
  if (error instanceof OwnProductExists) return reply.code(409).send({ error: error.message });
  if (error instanceof OwnProductNotFound) return reply.code(404).send({ error: error.message });
  throw error;
}

export function registerOwnProductRoutes(app: FastifyInstance, service: OwnProductsService): void {
  app.get("/api/own-products", () => service.list());

  app.post<{ Body: OwnProductBody }>("/api/own-products", {
    schema: { body: ownProductBodySchema },
  }, async (request, reply) => {
    try {
      return await reply.code(201).send(await service.create(parseOwnProduct(request.body)));
    } catch (error) {
      return sendFailure(reply, error);
    }
  });

  app.get<{ Querystring: ModelLinksQuery }>("/api/own-products/links", {
    schema: { querystring: modelLinksQuerySchema },
  }, async (request) => ({ links: await service.linksOfModels(request.query.modelIds) }));

  app.put<{ Params: LinkParams; Body: LinkBody }>(LINK_PATH, {
    schema: { params: linkParamsSchema, body: linkBodySchema },
  }, async (request, reply) => {
    const { ownProductId, modelId } = request.params;
    const { type } = request.body;
    try {
      await service.link(ownProductId, modelId, type);
      return { ownProductId, modelId, type };
    } catch (error) {
      return sendFailure(reply, error);
    }
  });

  app.delete<{ Params: LinkParams }>(LINK_PATH, {
    schema: { params: linkParamsSchema },
  }, async (request) => {
    const { ownProductId, modelId } = request.params;
    return { isRemoved: await service.unlink(ownProductId, modelId) };
  });
}
