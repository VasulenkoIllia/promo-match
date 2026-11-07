import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError, createOwnProduct, fetchModelLinks, fetchOwnProducts, linkModel, type LinkType, type ModelLink, type NewOwnProduct,
  type OwnProduct, type OwnProductList, unlinkModel,
} from "./api";
import { linksByModel } from "./format";
import { type ErrorText, ownProductErrorText, text } from "./text";

export type OwnListState = { kind: "loading" } | ({ kind: "ok" } & OwnProductList) | { kind: "error"; error: ErrorText };

export interface OwnProducts {
  list: OwnListState;
  // The links of the models on screen, for the marks on their cards
  linksOfModels: Map<number, ModelLink[]>;
  hasMarksFailed: boolean;
  retryList: () => void;
  // The models a new search shows
  showModels: (modelIds: number[]) => void;
  // These three throw an ApiError: the form that called shows it (ownProductErrorOf)
  create: (input: NewOwnProduct) => Promise<OwnProduct>;
  link: (ownProductId: number, modelId: number, type: LinkType) => Promise<void>;
  unlink: (ownProductId: number, modelId: number) => Promise<void>;
}

export function ownProductErrorOf(error: unknown): ErrorText {
  if (error instanceof ApiError) return ownProductErrorText(error.failure);
  console.error(error);
  return { message: text.search.failed, detail: null };
}

interface Marks {
  byModel: Map<number, ModelLink[]>;
  hasFailed: boolean;
}

// The list and the marks are read again after every change, so the tab and the cards cannot disagree. A read that a
// newer one replaced is aborted, so its late answer does not overwrite the newer one.
export function useOwnProducts(): OwnProducts {
  const [list, setList] = useState<OwnListState>({ kind: "loading" });
  const [marks, setMarks] = useState<Marks>({ byModel: new Map(), hasFailed: false });
  const shownModels = useRef<number[]>([]);
  const listRead = useRef<AbortController | null>(null);
  const marksRead = useRef<AbortController | null>(null);

  const readList = useCallback(() => {
    listRead.current?.abort();
    const controller = new AbortController();
    listRead.current = controller;
    return fetchOwnProducts(controller.signal).then(
      (next) => setList({ kind: "ok", ...next }),
      (error: unknown) => {
        if (!controller.signal.aborted) setList({ kind: "error", error: ownProductErrorOf(error) });
      },
    );
  }, []);

  const readMarks = useCallback(async () => {
    marksRead.current?.abort();
    const controller = new AbortController();
    marksRead.current = controller;
    const modelIds = shownModels.current;
    try {
      const links = modelIds.length ? await fetchModelLinks(modelIds, controller.signal) : [];
      setMarks({ byModel: linksByModel(links), hasFailed: false });
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error(error);
      setMarks((current) => ({ ...current, hasFailed: true }));
    }
  }, []);

  useEffect(() => {
    void readList();
    return () => listRead.current?.abort();
  }, [readList]);

  const retryList = useCallback(() => {
    setList({ kind: "loading" });
    void readList();
  }, [readList]);

  const showModels = useCallback((modelIds: number[]) => {
    shownModels.current = modelIds;
    void readMarks();
  }, [readMarks]);

  const create = useCallback(async (input: NewOwnProduct) => {
    const product = await createOwnProduct(input);
    await readList();
    return product;
  }, [readList]);

  const link = useCallback(async (ownProductId: number, modelId: number, type: LinkType) => {
    await linkModel(ownProductId, modelId, type);
    await Promise.all([readList(), readMarks()]);
  }, [readList, readMarks]);

  const unlink = useCallback(async (ownProductId: number, modelId: number) => {
    await unlinkModel(ownProductId, modelId);
    await Promise.all([readList(), readMarks()]);
  }, [readList, readMarks]);

  // The same object until something changes: the result cards are memoized on it
  return useMemo(() => ({
    list, linksOfModels: marks.byModel, hasMarksFailed: marks.hasFailed, retryList, showModels, create, link, unlink,
  }), [list, marks, retryList, showModels, create, link, unlink]);
}
