// The shape of a shared category code and name, apart from the list itself: the search checks and returns them without
// loading the list and the configuration (src/search/request.ts, src/search/store.ts)
const SLUG = "[a-z][a-z0-9-]*";
// "drinkware" for a group, "drinkware.mugs" for one of its categories
export const CATEGORY_CODE_PATTERN = `^${SLUG}(\\.${SLUG})?$`;
// A group's code, and the part of a category's code after its group's
export const CODE_SEGMENT = new RegExp(`^${SLUG}$`);

export interface CategoryName {
  uk: string;
  en: string;
}
