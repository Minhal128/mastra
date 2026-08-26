# @mastra/weaviate

Vector store implementation for [Weaviate](https://weaviate.io) using the official `weaviate-client` v3 client, with collection management, MongoDB-style metadata filtering, and support for arbitrary (non-UUID) record IDs.

## Installation

```bash
npm install @mastra/weaviate
```

## Instantiation

### Local or Self-Deployments

Run Weaviate locally with Docker:

```shell
docker run -p 8080:8080 -p 50051:50051 \
  -e AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED=true \
  -e DEFAULT_VECTORIZER_MODULE=none \
  cr.weaviate.io/semitechnologies/weaviate:1.34.0
```

```typescript
import { WeaviateVector } from '@mastra/weaviate';

const vectorStore = new WeaviateVector({ id: 'weaviate' });
```

Connection details can be customised:

```typescript
const vectorStore = new WeaviateVector({
  id: 'weaviate',
  host: 'localhost',
  port: 8080,
  grpcPort: 50051,
});
```

> The gRPC port is required — `weaviate-client` v3 uses gRPC for batch writes and vector search.

### Weaviate Cloud

```typescript
const vectorStore = new WeaviateVector({
  id: 'weaviate',
  url: process.env.WEAVIATE_URL!,
  apiKey: process.env.WEAVIATE_API_KEY!,
});
```

## Usage

```typescript
// Create an index
await vectorStore.createIndex({ indexName: 'my_index', dimension: 1536, metric: 'cosine' });

// Add vectors
await vectorStore.upsert({
  indexName: 'my_index',
  vectors: embeddings,
  metadata: [{ text: 'doc1' }, { text: 'doc2' }],
  ids: ['doc-1', 'doc-2'],
});

// Query
const results = await vectorStore.query({
  indexName: 'my_index',
  queryVector: queryEmbedding,
  topK: 10,
  filter: { text: { $like: 'doc*' } },
  includeVector: false,
});

// Release the gRPC connection when you're done
await vectorStore.disconnect();
```

## Supported filter operators

| Category   | Operators                                  |
| ---------- | ------------------------------------------ |
| Comparison | `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte` |
| Array      | `$in`, `$nin`                              |
| Text       | `$like` (`?` matches one char, `*` many)   |
| Element    | `$exists`                                  |
| Logical    | `$and`, `$or`, `$not`                      |

`$regex`, `$nor`, and `$elemMatch` are not supported — Weaviate has no equivalent. Use `$like` for wildcard matching.

Multiple operators on one field, and multiple sibling fields, are combined with `AND`:

```typescript
// price > 100 AND price <= 1000 AND category == 'books'
{ price: { $gt: 100, $lte: 1000 }, category: 'books' }
```

## Weaviate-specific behaviour

Three Weaviate constraints are handled for you, but they are visible at the edges:

- **Record IDs.** Weaviate requires object IDs to be UUIDs and rejects anything else. Your ID is hashed into a deterministic UUIDv5 and the original is stored on the record, so arbitrary string IDs work and are returned unchanged by `query`. Because the hash is deterministic, re-upserting the same ID overwrites instead of duplicating.
- **Index names.** Weaviate capitalises the first letter of every collection name, so `my_index` and `My_index` are the same collection. Index names are normalised on the way in; `listIndexes()` returns Weaviate's capitalised names.
- **Dimension.** Weaviate stores no user-defined collection metadata, so `createIndex` records the dimension in the collection description and `describeIndex` reads it back.

## Methods

- `createIndex({ indexName, dimension, metric? })` — `metric` is `cosine` (default), `euclidean`, or `dotproduct`
- `upsert({ indexName, vectors, metadata?, ids? })` — returns the record IDs
- `query({ indexName, queryVector, topK?, filter?, includeVector? })`
- `describeIndex({ indexName })` — returns `{ dimension, count, metric }`
- `listIndexes()`
- `updateVector({ indexName, id, update })` — `update` takes `vector` and/or `metadata`
- `deleteVector({ indexName, id })`
- `deleteVectors({ indexName, ids | filter })`
- `deleteIndex({ indexName })`
- `disconnect()`

## Testing

The test suite runs against a real Weaviate instance, started automatically by the package's `docker-compose.yaml`:

```bash
pnpm test
```

## Related Links

- [Weaviate Documentation](https://weaviate.io/developers/weaviate)
- [weaviate-client (TypeScript)](https://github.com/weaviate/typescript-client)
