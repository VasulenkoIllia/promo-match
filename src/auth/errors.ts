// The users API's errors, each answered with a status of its own (src/auth/admin-routes.ts). Kept apart from the module
// that reads the database, so the routes do not load it.

// Used, past its end, of another kind, or not there: the page cannot tell which, and needs not
export class LinkNotUsable extends Error {
  override name = "LinkNotUsable";
}

// Another user signs in with this login
export class LoginTaken extends Error {
  override name = "LoginTaken";
}

export class UserNotFound extends Error {
  override name = "UserNotFound";
}

// An admin disabling themselves would leave nobody to enable them but the users job
export class OwnAccountChange extends Error {
  override name = "OwnAccountChange";
}
