import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { WeaviateVector, toCollectionName } from './index';

// Matches the docker-compose.yaml shipped with this package.
const HOST = process.env.WEAVIATE_HOST ?? 'localhost';
const PORT = Number(process.env.WEAVIATE_PORT ?? 8080);
const GRPC_PORT = Number(process.env.WEAVIATE_GRPC_PORT ?? 50051);

const INDEX = 'mastra_test_index';
const DIMENSION = 3;

describe('WeaviateVector', () => {
  let vector: WeaviateVector;

  beforeAll(() => {
    vector = new WeaviateVector({ id: 'test', host: HOST, port: PORT, grpcPort: GRPC_PORT });
  });

  afterAll(async () => {
    await vector.deleteIndex({ indexName: INDEX }).catch(() => {});
    await vector.disconnect();
  });

  beforeEach(async () => {
    await vector.deleteIndex({ indexName: INDEX }).catch(() => {});
    await vector.createIndex({ indexName: INDEX, dimension: DIMENSION, metric: 'cosine' });
  });

  describe('toCollectionName', () => {
    it('capitalises the first letter, because Weaviate does', () => {
      expect(toCollectionName('my_index')).toBe('My_index');
      expect(toCollectionName('My_index')).toBe('My_index');
      expect(toCollectionName('')).toBe('');
    });
  });

  describe('createIndex', () => {
    it('rejects a non-positive dimension', async () => {
      await expect(vector.createIndex({ indexName: 'bad_dim', dimension: 0 })).rejects.toThrow(
        /Dimension must be a positive integer/,
      );
    });

    it('rejects an unknown metric', async () => {
      await expect(
        vector.createIndex({ indexName: 'bad_metric', dimension: 3, metric: 'manhattan' as any }),
      ).rejects.toThrow(/Invalid metric/);
    });

    it('is idempotent when the existing index matches', async () => {
      await expect(
        vector.createIndex({ indexName: INDEX, dimension: DIMENSION, metric: 'cosine' }),
      ).resolves.not.toThrow();
    });
  });

  describe('describeIndex', () => {
    it('round-trips dimension and metric, and counts objects', async () => {
      const empty = await vector.describeIndex({ indexName: INDEX });
      expect(empty).toMatchObject({ dimension: DIMENSION, count: 0, metric: 'cosine' });

      await vector.upsert({ indexName: INDEX, vectors: [[1, 0, 0]], ids: ['a'] });
      const filled = await vector.describeIndex({ indexName: INDEX });
      expect(filled.count).toBe(1);
    });

    it('reports euclidean when the index was created with it', async () => {
      await vector.deleteIndex({ indexName: INDEX });
      await vector.createIndex({ indexName: INDEX, dimension: DIMENSION, metric: 'euclidean' });
      const stats = await vector.describeIndex({ indexName: INDEX });
      expect(stats.metric).toBe('euclidean');
    });
  });

  describe('listIndexes', () => {
    it('includes the created index under its Weaviate name', async () => {
      await expect(vector.listIndexes()).resolves.toContain(toCollectionName(INDEX));
    });
  });

  describe('upsert', () => {
    it('accepts arbitrary non-UUID ids and returns them unchanged', async () => {
      const ids = await vector.upsert({
        indexName: INDEX,
        vectors: [
          [1, 0, 0],
          [0, 1, 0],
        ],
        metadata: [{ city: 'lahore' }, { city: 'karachi' }],
        ids: ['plain-id-1', 'plain-id-2'],
      });

      expect(ids).toEqual(['plain-id-1', 'plain-id-2']);

      const results = await vector.query({ indexName: INDEX, queryVector: [1, 0, 0], topK: 1 });
      expect(results[0]?.id).toBe('plain-id-1');
      expect(results[0]?.metadata).toEqual({ city: 'lahore' });
    });

    it('generates ids when none are supplied', async () => {
      const ids = await vector.upsert({ indexName: INDEX, vectors: [[1, 0, 0]] });
      expect(ids).toHaveLength(1);
      expect(ids[0]).toBeTruthy();
    });

    it('overwrites rather than duplicating on repeat upsert of the same id', async () => {
      await vector.upsert({ indexName: INDEX, vectors: [[1, 0, 0]], metadata: [{ v: 1 }], ids: ['dup'] });
      await vector.upsert({ indexName: INDEX, vectors: [[1, 0, 0]], metadata: [{ v: 2 }], ids: ['dup'] });

      const stats = await vector.describeIndex({ indexName: INDEX });
      expect(stats.count).toBe(1);

      const results = await vector.query({ indexName: INDEX, queryVector: [1, 0, 0], topK: 5 });
      expect(results[0]?.metadata).toEqual({ v: 2 });
    });
  });

  describe('query', () => {
    beforeEach(async () => {
      await vector.upsert({
        indexName: INDEX,
        vectors: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        metadata: [
          { city: 'lahore', pop: 13 },
          { city: 'karachi', pop: 20 },
          { city: 'multan', pop: 2 },
        ],
        ids: ['x', 'y', 'z'],
      });
    });

    it('requires a query vector', async () => {
      await expect(vector.query({ indexName: INDEX, queryVector: undefined as any })).rejects.toThrow(
        /queryVector is required/,
      );
    });

    it('ranks the nearest vector first and scores it highest', async () => {
      const results = await vector.query({ indexName: INDEX, queryVector: [1, 0, 0], topK: 3 });
      expect(results[0]?.id).toBe('x');
      expect(results[0]?.score).toBeCloseTo(1, 5);
      expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
    });

    it('honours topK', async () => {
      const results = await vector.query({ indexName: INDEX, queryVector: [1, 0, 0], topK: 2 });
      expect(results).toHaveLength(2);
    });

    it('omits the vector unless asked, and returns it when asked', async () => {
      const without = await vector.query({ indexName: INDEX, queryVector: [1, 0, 0], topK: 1 });
      expect(without[0]?.vector).toBeUndefined();

      const including = await vector.query({
        indexName: INDEX,
        queryVector: [1, 0, 0],
        topK: 1,
        includeVector: true,
      });
      expect(including[0]?.vector).toEqual([1, 0, 0]);
    });

    it('never leaks the internal id property into metadata', async () => {
      const results = await vector.query({ indexName: INDEX, queryVector: [1, 0, 0], topK: 3 });
      for (const result of results) {
        expect(result.metadata).not.toHaveProperty('_mastra_id');
      }
    });

    describe('filters', () => {
      const queryWith = (filter: any) => vector.query({ indexName: INDEX, queryVector: [1, 0, 0], topK: 10, filter });

      it('$eq via shorthand', async () => {
        const results = await queryWith({ city: 'karachi' });
        expect(results.map(r => r.id)).toEqual(['y']);
      });

      it('$ne', async () => {
        const results = await queryWith({ city: { $ne: 'karachi' } });
        expect(results.map(r => r.id).sort()).toEqual(['x', 'z']);
      });

      it('$gt / $lte', async () => {
        expect((await queryWith({ pop: { $gt: 10 } })).map(r => r.id).sort()).toEqual(['x', 'y']);
        expect((await queryWith({ pop: { $lte: 2 } })).map(r => r.id)).toEqual(['z']);
      });

      it('combines multiple operators on one field with AND', async () => {
        const results = await queryWith({ pop: { $gte: 3, $lt: 20 } });
        expect(results.map(r => r.id)).toEqual(['x']);
      });

      it('$in / $nin', async () => {
        expect((await queryWith({ city: { $in: ['lahore', 'multan'] } })).map(r => r.id).sort()).toEqual(['x', 'z']);
        expect((await queryWith({ city: { $nin: ['lahore', 'multan'] } })).map(r => r.id)).toEqual(['y']);
      });

      it('$like wildcards', async () => {
        const results = await queryWith({ city: { $like: 'lah*' } });
        expect(results.map(r => r.id)).toEqual(['x']);
      });

      it('$and', async () => {
        const results = await queryWith({ $and: [{ pop: { $gt: 10 } }, { city: 'lahore' }] });
        expect(results.map(r => r.id)).toEqual(['x']);
      });

      it('$or', async () => {
        const results = await queryWith({ $or: [{ city: 'lahore' }, { city: 'multan' }] });
        expect(results.map(r => r.id).sort()).toEqual(['x', 'z']);
      });

      it('$not', async () => {
        const results = await queryWith({ $not: { city: 'lahore' } });
        expect(results.map(r => r.id).sort()).toEqual(['y', 'z']);
      });

      it('implicit AND across sibling fields', async () => {
        const results = await queryWith({ city: 'lahore', pop: 13 });
        expect(results.map(r => r.id)).toEqual(['x']);
      });

      it('treats an empty filter as no filter', async () => {
        expect(await queryWith({})).toHaveLength(3);
      });

      it('rejects an unsupported operator', async () => {
        await expect(queryWith({ city: { $regex: 'lah' } })).rejects.toThrow();
      });
    });
  });

  describe('updateVector', () => {
    beforeEach(async () => {
      await vector.upsert({ indexName: INDEX, vectors: [[1, 0, 0]], metadata: [{ city: 'lahore' }], ids: ['u'] });
    });

    it('requires an id', async () => {
      await expect(vector.updateVector({ indexName: INDEX, id: '', update: { metadata: { a: 1 } } })).rejects.toThrow(
        /id must be provided/,
      );
    });

    it('requires something to update', async () => {
      await expect(vector.updateVector({ indexName: INDEX, id: 'u', update: {} })).rejects.toThrow(
        /No updates provided/,
      );
    });

    it('updates metadata while keeping the id addressable', async () => {
      await vector.updateVector({ indexName: INDEX, id: 'u', update: { metadata: { city: 'multan' } } });
      const results = await vector.query({ indexName: INDEX, queryVector: [1, 0, 0], topK: 1 });
      expect(results[0]?.id).toBe('u');
      expect(results[0]?.metadata).toEqual({ city: 'multan' });
    });

    it('updates the vector', async () => {
      await vector.updateVector({ indexName: INDEX, id: 'u', update: { vector: [0, 1, 0] } });
      const results = await vector.query({
        indexName: INDEX,
        queryVector: [0, 1, 0],
        topK: 1,
        includeVector: true,
      });
      expect(results[0]?.vector).toEqual([0, 1, 0]);
    });
  });

  describe('deleteVector / deleteVectors', () => {
    beforeEach(async () => {
      await vector.upsert({
        indexName: INDEX,
        vectors: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        metadata: [{ keep: false }, { keep: false }, { keep: true }],
        ids: ['d1', 'd2', 'd3'],
      });
    });

    it('deletes a single vector by id', async () => {
      await vector.deleteVector({ indexName: INDEX, id: 'd1' });
      const stats = await vector.describeIndex({ indexName: INDEX });
      expect(stats.count).toBe(2);
    });

    it('deletes many by ids', async () => {
      await vector.deleteVectors({ indexName: INDEX, ids: ['d1', 'd2'] });
      const results = await vector.query({ indexName: INDEX, queryVector: [0, 0, 1], topK: 10 });
      expect(results.map(r => r.id)).toEqual(['d3']);
    });

    it('deletes many by filter', async () => {
      await vector.deleteVectors({ indexName: INDEX, filter: { keep: false } });
      const results = await vector.query({ indexName: INDEX, queryVector: [0, 0, 1], topK: 10 });
      expect(results.map(r => r.id)).toEqual(['d3']);
    });

    it('rejects ids and filter together', async () => {
      await expect(vector.deleteVectors({ indexName: INDEX, ids: ['d1'], filter: { keep: false } })).rejects.toThrow(
        /mutually exclusive/,
      );
    });

    it('rejects neither ids nor filter', async () => {
      await expect(vector.deleteVectors({ indexName: INDEX })).rejects.toThrow(/Either filter or ids/);
    });

    it('rejects an empty ids array', async () => {
      await expect(vector.deleteVectors({ indexName: INDEX, ids: [] })).rejects.toThrow(/empty ids array/);
    });

    it('rejects an empty filter object', async () => {
      await expect(vector.deleteVectors({ indexName: INDEX, filter: {} })).rejects.toThrow(/empty filter object/);
    });
  });

  describe('deleteIndex', () => {
    it('removes the index from listIndexes', async () => {
      await vector.deleteIndex({ indexName: INDEX });
      await expect(vector.listIndexes()).resolves.not.toContain(toCollectionName(INDEX));
    });
  });

  describe('disconnect', () => {
    it('is safe to call when never connected', async () => {
      const unused = new WeaviateVector({ id: 'unused', host: HOST, port: PORT, grpcPort: GRPC_PORT });
      await expect(unused.disconnect()).resolves.toBeUndefined();
    });
  });
});
