// The own products of stage 6 and their links to the models of sources (docs/integrations.md, «Свої товари»). No
// purchase prices here: a linked model is shown by its name and photo.
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import type { OwnProductLinkType } from "../generated/prisma/enums.js";
import { categoryOf } from "../search/results.js";
import { OwnProductExists, OwnProductNotFound } from "./errors.js";
import type { NewOwnProduct } from "./request.js";

// The list is read whole, with no pages: past these bounds the oldest products and links are left out, and it says it
// is not complete
const MAX_LISTED_PRODUCTS = 500;
const MAX_LISTED_LINKS = 5_000;
// The marks on result cards: a search shows up to 100 models, each linked to a few own products
const MAX_MODEL_LINKS = 1_000;
const UNIQUE_VIOLATION = "P2002";
const FOREIGN_KEY_VIOLATION = "P2003";

export interface OwnProduct {
  id: number;
  name: string;
  code: string | null;
}

export interface LinkedModel {
  modelId: number;
  type: OwnProductLinkType;
  source: { code: string; name: string };
  code: string;
  name: string | null;
  category: string[];
  // false: the last import no longer found the model
  isActive: boolean;
  photoUrl: string | null;
}

export interface OwnProductEntry extends OwnProduct {
  links: LinkedModel[];
}

export interface OwnProductList {
  products: OwnProductEntry[];
  // false: more products or links than the list holds
  isComplete: boolean;
}

// A link as a result card shows it
export interface ModelLink {
  modelId: number;
  ownProductId: number;
  ownProductName: string;
  type: OwnProductLinkType;
}

export interface OwnProductsService {
  list(): Promise<OwnProductList>;
  create(input: NewOwnProduct): Promise<OwnProduct>;
  linksOfModels(modelIds: number[]): Promise<ModelLink[]>;
  // A repeat of the pair sets its type: there is one row per pair
  link(ownProductId: number, modelId: number, type: OwnProductLinkType): Promise<void>;
  // false: the pair was not linked
  unlink(ownProductId: number, modelId: number): Promise<boolean>;
}

export interface LinkedModelRow {
  ownProductId: number;
  modelId: number;
  type: OwnProductLinkType;
  sourceCode: string;
  sourceName: string;
  code: string;
  name: string | null;
  category: unknown;
  isActive: boolean;
  photoUrl: string | null;
}

export function prismaCode(error: unknown): string | undefined {
  return error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined;
}

// The photos of a deactivated model stay in their table, so it keeps its picture; its active ones come first otherwise
function readLinkedModels(db: PrismaClient, ownProductIds: number[]): Promise<LinkedModelRow[]> {
  return db.$queryRaw<LinkedModelRow[]>`
    SELECT l.own_product_id AS "ownProductId", l.model_id AS "modelId", l.type::text AS type,
      s.code AS "sourceCode", s.name AS "sourceName", m.code, m.name->>'en' AS name, m.category->'en' AS category,
      m.is_active AS "isActive",
      (SELECT p.url FROM photo p WHERE p.model_id = m.id ORDER BY p.is_active DESC, p.position, p.id LIMIT 1)
        AS "photoUrl"
    FROM own_product_link l
    JOIN product_model m ON m.id = l.model_id
    JOIN source s ON s.id = m.source_id
    WHERE l.own_product_id = ANY(${ownProductIds}::integer[])
    ORDER BY l.created_at DESC, l.model_id DESC
    LIMIT ${MAX_LISTED_LINKS + 1}`;
}

function linkedModelOf(row: LinkedModelRow): LinkedModel {
  return {
    modelId: row.modelId,
    type: row.type,
    source: { code: row.sourceCode, name: row.sourceName },
    code: row.code,
    name: row.name,
    category: categoryOf(row.category),
    isActive: row.isActive,
    photoUrl: row.photoUrl,
  };
}

export function assembleOwnProducts(products: OwnProduct[], links: LinkedModelRow[]): OwnProductList {
  const linksByProduct = new Map<number, LinkedModel[]>();
  for (const row of links.slice(0, MAX_LISTED_LINKS)) {
    const list = linksByProduct.get(row.ownProductId) ?? [];
    list.push(linkedModelOf(row));
    linksByProduct.set(row.ownProductId, list);
  }
  return {
    products: products.slice(0, MAX_LISTED_PRODUCTS)
      .map((product) => ({ ...product, links: linksByProduct.get(product.id) ?? [] })),
    isComplete: products.length <= MAX_LISTED_PRODUCTS && links.length <= MAX_LISTED_LINKS,
  };
}

export function createOwnProductsService(db: PrismaClient): OwnProductsService {
  return {
    async list() {
      // The newest first: while models are linked to a product just made, the form offers it at the top
      const products = await db.ownProduct.findMany({
        select: { id: true, name: true, code: true }, orderBy: { id: "desc" }, take: MAX_LISTED_PRODUCTS + 1,
      });
      const listed = products.slice(0, MAX_LISTED_PRODUCTS).map((product) => product.id);
      return assembleOwnProducts(products, await readLinkedModels(db, listed));
    },

    async create(input) {
      try {
        return await db.ownProduct.create({ data: input, select: { id: true, name: true, code: true } });
      } catch (error) {
        if (prismaCode(error) === UNIQUE_VIOLATION) {
          throw new OwnProductExists("another own product has this name or code");
        }
        throw error;
      }
    },

    async linksOfModels(modelIds) {
      const rows = await db.ownProductLink.findMany({
        where: { modelId: { in: modelIds } },
        select: { modelId: true, ownProductId: true, type: true, ownProduct: { select: { name: true } } },
        orderBy: [{ createdAt: "asc" }, { ownProductId: "asc" }],
        take: MAX_MODEL_LINKS,
      });
      return rows.map(({ ownProduct, ...link }) => ({ ...link, ownProductName: ownProduct.name }));
    },

    async link(ownProductId, modelId, type) {
      try {
        // Prisma sends this as one INSERT ... ON CONFLICT (query log, 2026-10-30): a new pair linked twice at once does
        // not collide
        await db.ownProductLink.upsert({
          where: { ownProductId_modelId: { ownProductId, modelId } },
          create: { ownProductId, modelId, type },
          update: { type },
        });
      } catch (error) {
        if (prismaCode(error) === FOREIGN_KEY_VIOLATION) throw new OwnProductNotFound("no such own product or model");
        throw error;
      }
    },

    async unlink(ownProductId, modelId) {
      const { count } = await db.ownProductLink.deleteMany({ where: { ownProductId, modelId } });
      return count > 0;
    },
  };
}
