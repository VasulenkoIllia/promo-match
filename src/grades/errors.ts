// Kept apart from the module that reads the database, so the routes do not load it.

// The model of a grade is not in the database
export class GradedModelNotFound extends Error {
  override name = "GradedModelNotFound";
}
