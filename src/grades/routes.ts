// The grades API (docs/integrations.md, «Оцінки»).
//   PUT    /api/search/grades/:searchId/:modelId { grade, text?, hasPhoto, model, filters, rank, confidencePercent?, lists,
//                                                  conditionMatch?, matchedCode? }; a repeat sets the grade
//   DELETE /api/search/grades/:searchId/:modelId
// Behind the login, registered in the signed-in scope of src/app.ts, where a user reaches their own grades only. The
// body holds the text of a query and is never logged (src/app.ts, requestLine).
import type { FastifyInstance } from "fastify";
import { signedInUser } from "../auth/routes.js";
import { GradedModelNotFound } from "./errors.js";
import { type GradeBody, gradeBodySchema, type GradeParams, gradeParamsSchema } from "./request.js";
import type { GradesService } from "./store.js";

const GRADE_PATH = "/api/search/grades/:searchId/:modelId";

export function registerGradeRoutes(app: FastifyInstance, service: GradesService): void {
  app.put<{ Params: GradeParams; Body: GradeBody }>(GRADE_PATH, {
    schema: { params: gradeParamsSchema, body: gradeBodySchema },
  }, async (request, reply) => {
    try {
      await service.set(request.params, signedInUser(request).id, request.body);
      return { grade: request.body.grade };
    } catch (error) {
      if (error instanceof GradedModelNotFound) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  app.delete<{ Params: GradeParams }>(GRADE_PATH, {
    schema: { params: gradeParamsSchema },
  }, async (request) => ({ isRemoved: await service.remove(request.params, signedInUser(request).id) }));
}
