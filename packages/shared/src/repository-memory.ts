/**
 * Length of `repository_memory.embedding` (`extensions.vector(1536)`) and of the query vector
 * `match_repository_memory` accepts. Fixed by the schema, so it is never read from env; changing it
 * requires a migration.
 */
export const REPOSITORY_MEMORY_EMBEDDING_DIMENSIONS = 1536;
