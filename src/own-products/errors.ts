// The own products' errors, each answered with a status of its own (src/own-products/routes.ts). Kept apart from the
// module that reads the database, so the routes do not load it.

// A request that cannot be taken, with a message safe to show the client
export class OwnProductInputError extends Error {
  override name = "OwnProductInputError";
}

// Another own product has this name or code
export class OwnProductExists extends Error {
  override name = "OwnProductExists";
}

// The own product or the model of a link is not in the database
export class OwnProductNotFound extends Error {
  override name = "OwnProductNotFound";
}
