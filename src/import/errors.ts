// An import stopped on purpose (a stop signal, a lease held by another import, a guard): its message says it all,
// a stack trace would only bury it
export class ImportStopped extends Error {}
