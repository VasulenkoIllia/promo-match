// The grades of found models (docs/integrations.md, «Оцінки»). The text of a query is kept here and nowhere else, and it
// goes with the last grade of its search.
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { prismaCode } from "../own-products/store.js";
import { GradedModelNotFound } from "./errors.js";
import type { GradeBody, GradeParams } from "./request.js";

const FOREIGN_KEY_VIOLATION = "P2003";

export interface GradesService {
  // A repeat for the same search and model sets its grade: there is one row per user
  set(key: GradeParams, userId: number, body: GradeBody): Promise<void>;
  // false: this user had not graded the model in this search
  remove(key: GradeParams, userId: number): Promise<boolean>;
}

export function createGradesService(db: PrismaClient): GradesService {
  return {
    async set({ searchId, modelId }, userId, body) {
      const { grade } = body;
      try {
        await db.resultGrade.upsert({
          where: { searchId_modelId_userId: { searchId, modelId, userId } },
          create: {
            searchId, modelId, userId, grade,
            queryText: body.text ?? null,
            hasPhoto: body.hasPhoto,
            embeddingModel: body.model,
            filters: body.filters as Prisma.InputJsonObject,
            rank: body.rank,
            confidencePercent: body.confidencePercent ?? null,
            lists: body.lists,
            conditionMatch: (body.conditionMatch as Prisma.InputJsonObject | null | undefined) ?? Prisma.DbNull,
            matchedCode: body.matchedCode ?? null,
          },
          update: { grade, gradedAt: new Date() },
        });
      } catch (error) {
        if (prismaCode(error) === FOREIGN_KEY_VIOLATION) throw new GradedModelNotFound("no such model");
        throw error;
      }
    },

    async remove({ searchId, modelId }, userId) {
      const { count } = await db.resultGrade.deleteMany({ where: { searchId, modelId, userId } });
      return count > 0;
    },
  };
}
