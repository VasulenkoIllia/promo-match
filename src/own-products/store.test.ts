import { describe, expect, it, vi } from "vitest";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { OwnProductExists, OwnProductNotFound } from "./errors.js";
import { assembleOwnProducts, createOwnProductsService, type LinkedModelRow, type OwnProduct } from "./store.js";

const row = (ownProductId: number, modelId: number): LinkedModelRow => ({
  ownProductId, modelId, type: "same", sourceCode: "axpol", sourceName: "Axpol", code: `V${modelId}`, name: "Mug",
  category: ["DRINKWARE", "mugs"], isActive: true, photoUrl: "https://files.axpol.com/a.jpg",
});
const product = (id: number): OwnProduct => ({ id, name: `Товар ${id}`, code: null });

function prismaError(code: string) {
  return new Prisma.PrismaClientKnownRequestError("failed", { code, clientVersion: "7.10.0" });
}

describe("assembleOwnProducts", () => {
  it("puts each link under its product, in the order read, and keeps a product with no links", () => {
    const list = assembleOwnProducts([product(2), product(1)], [row(1, 7), row(1, 9)]);
    expect(list.isComplete).toBe(true);
    expect(list.products.map((each) => each.links.map((link) => link.modelId))).toEqual([[], [7, 9]]);
    expect(list.products[1]?.links[0]).toEqual({
      modelId: 7, type: "same", source: { code: "axpol", name: "Axpol" }, code: "V7", name: "Mug",
      category: ["DRINKWARE", "mugs"], isActive: true, photoUrl: "https://files.axpol.com/a.jpg",
    });
  });

  it("shows a model with no English category with an empty path", () => {
    const list = assembleOwnProducts([product(1)], [{ ...row(1, 7), category: null }]);
    expect(list.products[0]?.links[0]?.category).toEqual([]);
  });

  it("says when the products or the links went past what the list holds", () => {
    const products = Array.from({ length: 501 }, (_item, index) => product(index + 1));
    const tooManyProducts = assembleOwnProducts(products, []);
    expect(tooManyProducts.products).toHaveLength(500);
    expect(tooManyProducts.isComplete).toBe(false);
    const links = Array.from({ length: 5001 }, (_item, index) => row(1, index + 1));
    const tooManyLinks = assembleOwnProducts([product(1)], links);
    expect(tooManyLinks.products[0]?.links).toHaveLength(5000);
    expect(tooManyLinks.isComplete).toBe(false);
  });
});

describe("the service", () => {
  const dbWith = (tables: Record<string, unknown>) => tables as unknown as PrismaClient;

  it("reads the links of the listed products only, one query however many there are", async () => {
    const queryRaw = vi.fn(() => Promise.resolve([row(1, 7)]));
    const findMany = vi.fn(() => Promise.resolve(Array.from({ length: 501 }, (_item, index) => product(501 - index))));
    const list = await createOwnProductsService(dbWith({ ownProduct: { findMany }, $queryRaw: queryRaw })).list();
    expect(queryRaw).toHaveBeenCalledOnce();
    const ids = (queryRaw.mock.calls[0] as unknown[])[1] as number[];
    expect(ids).toHaveLength(500);
    expect(ids).not.toContain(1);
    expect(list.isComplete).toBe(false);
  });

  it("answers OwnProductExists to a name or code taken, and passes other errors on", async () => {
    const taken = dbWith({ ownProduct: { create: () => Promise.reject(prismaError("P2002")) } });
    await expect(createOwnProductsService(taken).create({ name: "Кружка", code: null })).rejects.toThrow(OwnProductExists);
    const failure = new Error("connection lost");
    const broken = dbWith({ ownProduct: { create: () => Promise.reject(failure) } });
    await expect(createOwnProductsService(broken).create({ name: "Кружка", code: null })).rejects.toBe(failure);
  });

  it("writes a link by its pair, so a repeat only sets the type", async () => {
    const upsert = vi.fn(() => Promise.resolve({}));
    await createOwnProductsService(dbWith({ ownProductLink: { upsert } })).link(1, 7, "analog");
    expect(upsert).toHaveBeenCalledWith({
      where: { ownProductId_modelId: { ownProductId: 1, modelId: 7 } },
      create: { ownProductId: 1, modelId: 7, type: "analog" },
      update: { type: "analog" },
    });
  });

  it("answers OwnProductNotFound to a link whose own product or model is not there, and passes other errors on", async () => {
    const missing = dbWith({ ownProductLink: { upsert: () => Promise.reject(prismaError("P2003")) } });
    await expect(createOwnProductsService(missing).link(1, 7, "same")).rejects.toThrow(OwnProductNotFound);
    const failure = prismaError("P2024");
    const broken = dbWith({ ownProductLink: { upsert: () => Promise.reject(failure) } });
    await expect(createOwnProductsService(broken).link(1, 7, "same")).rejects.toBe(failure);
  });

  it("tells whether an unlink removed a row", async () => {
    const removed = dbWith({ ownProductLink: { deleteMany: () => Promise.resolve({ count: 1 }) } });
    await expect(createOwnProductsService(removed).unlink(1, 7)).resolves.toBe(true);
    const nothing = dbWith({ ownProductLink: { deleteMany: () => Promise.resolve({ count: 0 }) } });
    await expect(createOwnProductsService(nothing).unlink(1, 7)).resolves.toBe(false);
  });

  it("gives the links of models with the own product's name", async () => {
    const findMany = vi.fn(() => Promise.resolve([{ modelId: 7, ownProductId: 1, type: "same", ownProduct: { name: "Кружка" } }]));
    const links = await createOwnProductsService(dbWith({ ownProductLink: { findMany } })).linksOfModels([7, 9]);
    expect(links).toEqual([{ modelId: 7, ownProductId: 1, type: "same", ownProductName: "Кружка" }]);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { modelId: { in: [7, 9] } }, take: 1000 }));
  });
});
