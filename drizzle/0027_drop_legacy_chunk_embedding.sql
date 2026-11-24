-- Superseded by chunk_embeddings in v0.25.0 (#56) and kept for one release as a
-- rollback path. Nothing has read or written it since. The HNSW index on it
-- (chunks_embedding_idx) goes with the column.
ALTER TABLE "chunks" DROP COLUMN "embedding";
