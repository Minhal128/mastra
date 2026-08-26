---
'@mastra/weaviate': minor
---

Add `@mastra/weaviate`, a Weaviate vector store built on the official `weaviate-client` v3 client.

Supports the full `MastraVector` surface (create/describe/list/delete index, upsert, query, update, delete vectors) with MongoDB-style filters translated to Weaviate's filter builder, including `$like` for wildcard matching. Arbitrary string record IDs are supported by hashing them into deterministic UUIDv5 object IDs, so re-upserting an ID overwrites rather than duplicating.
