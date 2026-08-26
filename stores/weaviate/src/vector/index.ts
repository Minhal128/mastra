import { MastraError, ErrorDomain, ErrorCategory } from '@mastra/core/error';
import { createVectorErrorId } from '@mastra/core/storage';
import { MastraVector, validateUpsert, validateTopK } from '@mastra/core/vector';
import type {
  QueryResult,
  IndexStats,
  CreateIndexParams,
  UpsertVectorParams,
  QueryVectorParams,
  DescribeIndexParams,
  DeleteIndexParams,
  DeleteVectorParams,
  UpdateVectorParams,
  DeleteVectorsParams,
} from '@mastra/core/vector';
import weaviate, { generateUuid5 } from 'weaviate-client';
import type { Collection, WeaviateClient } from 'weaviate-client';
import type { WeaviateVectorFilter } from './filter';
import { WeaviateFilterTranslator, toWeaviateFilter } from './filter';

/**
 * Weaviate object IDs must be UUIDs, so the caller's ID is hashed into a
 * deterministic UUIDv5 and the original is kept in this property. Hashing is
 * deterministic, which is what makes `upsert` overwrite instead of duplicate.
 */
const MASTRA_ID_PROPERTY = '_mastra_id';

/** Weaviate has no user-defined collection metadata, so the dimension rides along in the description. */
const DIMENSION_PREFIX = 'mastra:dimension=';

type MastraMetric = 'cosine' | 'euclidean' | 'dotproduct';

const METRIC_TO_DISTANCE = {
  cosine: 'cosine',
  euclidean: 'l2-squared',
  dotproduct: 'dot',
} as const satisfies Record<MastraMetric, string>;

const DISTANCE_TO_METRIC: Record<string, MastraMetric> = {
  cosine: 'cosine',
  'l2-squared': 'euclidean',
  dot: 'dotproduct',
};

export type WeaviateVectorArgs = {
  id: string;
  /** Weaviate Cloud URL. When omitted, connects to a local instance. */
  url?: string;
  /** API key for Weaviate Cloud or an auth-enabled instance. */
  apiKey?: string;
  /** Host for a local instance. Defaults to `localhost`. */
  host?: string;
  /** REST port for a local instance. Defaults to `8080`. */
  port?: number;
  /** gRPC port for a local instance. Defaults to `50051`. */
  grpcPort?: number;
  /** Extra headers passed to Weaviate, e.g. third-party module keys. */
  headers?: Record<string, string>;
};

/**
 * Weaviate capitalises the first letter of every collection name, so
 * `my_index` and `My_index` address the same collection. Normalising up front
 * keeps `createIndex`/`describeIndex`/`deleteIndex` pointed at one collection.
 */
export function toCollectionName(indexName: string): string {
  if (!indexName) return indexName;
  return indexName.charAt(0).toUpperCase() + indexName.slice(1);
}

function readDimension(description?: string): number {
  if (!description?.startsWith(DIMENSION_PREFIX)) return 0;
  const dimension = Number.parseInt(description.slice(DIMENSION_PREFIX.length), 10);
  return Number.isFinite(dimension) ? dimension : 0;
}

function distanceToScore(distance: number, metric: MastraMetric): number {
  switch (metric) {
    case 'euclidean':
      // Weaviate reports squared L2, so undo the square before normalising.
      return 1 / (1 + Math.sqrt(distance));
    case 'dotproduct':
      // Weaviate negates the dot product so that "smaller is closer" holds.
      return -distance;
    case 'cosine':
    default:
      return 1 - distance;
  }
}

export class WeaviateVector extends MastraVector<WeaviateVectorFilter> {
  private clientPromise: Promise<WeaviateClient> | null = null;
  private readonly args: WeaviateVectorArgs;

  constructor(args: WeaviateVectorArgs) {
    super({ id: args.id });
    this.args = args;
  }

  /**
   * Weaviate's connect helpers are async and open a gRPC channel, so the
   * connection is created on first use and shared afterwards.
   */
  private getClient(): Promise<WeaviateClient> {
    if (!this.clientPromise) {
      const { url, apiKey, host, port, grpcPort, headers } = this.args;
      const auth = apiKey ? { authCredentials: new weaviate.ApiKey(apiKey) } : {};

      const connect = url
        ? weaviate.connectToWeaviateCloud(url, { ...auth, ...(headers ? { headers } : {}) })
        : weaviate.connectToLocal({
            host: host ?? 'localhost',
            port: port ?? 8080,
            grpcPort: grpcPort ?? 50051,
            ...auth,
            ...(headers ? { headers } : {}),
          });

      this.clientPromise = connect.catch((error: unknown) => {
        // Don't cache a failed connection, so the next call can retry.
        this.clientPromise = null;
        throw error;
      });
    }
    return this.clientPromise;
  }

  private async getCollection(indexName: string): Promise<Collection<any, any>> {
    const client = await this.getClient();
    return client.collections.use(toCollectionName(indexName));
  }

  /** Releases the gRPC connection. Safe to call when never connected. */
  async disconnect(): Promise<void> {
    if (!this.clientPromise) return;
    const client = await this.clientPromise.catch(() => null);
    this.clientPromise = null;
    await client?.close();
  }

  async createIndex({ indexName, dimension, metric = 'cosine' }: CreateIndexParams): Promise<void> {
    if (!Number.isInteger(dimension) || dimension <= 0) {
      throw new MastraError({
        id: createVectorErrorId('WEAVIATE', 'CREATE_INDEX', 'INVALID_DIMENSION'),
        text: 'Dimension must be a positive integer',
        domain: ErrorDomain.MASTRA_VECTOR,
        category: ErrorCategory.USER,
        details: { dimension },
      });
    }

    const distance = METRIC_TO_DISTANCE[metric as MastraMetric];
    if (!distance) {
      throw new MastraError({
        id: createVectorErrorId('WEAVIATE', 'CREATE_INDEX', 'INVALID_METRIC'),
        text: `Invalid metric: "${metric}". Must be one of: cosine, euclidean, dotproduct`,
        domain: ErrorDomain.MASTRA_VECTOR,
        category: ErrorCategory.USER,
        details: { metric },
      });
    }

    try {
      const client = await this.getClient();
      const collectionName = toCollectionName(indexName);

      if (await client.collections.exists(collectionName)) {
        await this.validateExistingIndex(indexName, dimension, metric);
        return;
      }

      await client.collections.create({
        name: collectionName,
        description: `${DIMENSION_PREFIX}${dimension}`,
        vectorizers: weaviate.configure.vectors.selfProvided({
          vectorIndexConfig: weaviate.configure.vectorIndex.hnsw({ distanceMetric: distance }),
        }),
      });
    } catch (error: any) {
      if (error instanceof MastraError) throw error;
      throw new MastraError(
        {
          id: createVectorErrorId('WEAVIATE', 'CREATE_INDEX', 'FAILED'),
          domain: ErrorDomain.MASTRA_VECTOR,
          category: ErrorCategory.THIRD_PARTY,
          details: { indexName },
        },
        error,
      );
    }
  }

  async upsert({ indexName, vectors, metadata, ids }: UpsertVectorParams): Promise<string[]> {
    validateUpsert('WEAVIATE', vectors, metadata, ids, true);

    try {
      const collection = await this.getCollection(indexName);
      const recordIds = ids ?? vectors.map(() => crypto.randomUUID());

      const result = await collection.data.insertMany(
        vectors.map((vector, index) => ({
          id: generateUuid5(recordIds[index]!),
          properties: {
            ...(metadata?.[index] ?? {}),
            [MASTRA_ID_PROPERTY]: recordIds[index]!,
          },
          vectors: vector,
        })),
      );

      if (result.hasErrors) {
        throw new Error(
          Object.values(result.errors)
            .map(e => e.message)
            .join('; '),
        );
      }

      return recordIds;
    } catch (error: any) {
      if (error instanceof MastraError) throw error;
      throw new MastraError(
        {
          id: createVectorErrorId('WEAVIATE', 'UPSERT', 'FAILED'),
          domain: ErrorDomain.MASTRA_VECTOR,
          category: ErrorCategory.THIRD_PARTY,
          details: { indexName },
        },
        error,
      );
    }
  }

  transformFilter(filter?: WeaviateVectorFilter): WeaviateVectorFilter {
    return new WeaviateFilterTranslator().translate(filter);
  }

  async query({
    indexName,
    queryVector,
    topK = 10,
    filter,
    includeVector = false,
  }: QueryVectorParams<WeaviateVectorFilter>): Promise<QueryResult[]> {
    if (!queryVector) {
      throw new MastraError({
        id: createVectorErrorId('WEAVIATE', 'QUERY', 'MISSING_VECTOR'),
        text: 'queryVector is required for Weaviate queries. Metadata-only queries are not supported by this vector store.',
        domain: ErrorDomain.MASTRA_VECTOR,
        category: ErrorCategory.USER,
        details: { indexName },
      });
    }

    validateTopK('WEAVIATE', topK);

    try {
      const collection = await this.getCollection(indexName);
      const { metric } = await this.describeIndex({ indexName });

      const results = await collection.query.nearVector(queryVector, {
        limit: topK,
        returnMetadata: ['distance'],
        includeVector,
        filters: toWeaviateFilter(collection, this.transformFilter(filter)),
      });

      return results.objects.map(object => {
        const { [MASTRA_ID_PROPERTY]: originalId, ...rest } = object.properties as Record<string, unknown>;
        const distance = object.metadata?.distance;
        return {
          id: (originalId as string) ?? object.uuid,
          score: distance == null ? 0 : distanceToScore(distance, metric ?? 'cosine'),
          metadata: rest,
          ...(includeVector && { vector: (object.vectors?.default as number[]) ?? [] }),
        };
      });
    } catch (error: any) {
      if (error instanceof MastraError) throw error;
      throw new MastraError(
        {
          id: createVectorErrorId('WEAVIATE', 'QUERY', 'FAILED'),
          domain: ErrorDomain.MASTRA_VECTOR,
          category: ErrorCategory.THIRD_PARTY,
          details: { indexName },
        },
        error,
      );
    }
  }

  async listIndexes(): Promise<string[]> {
    try {
      const client = await this.getClient();
      const collections = await client.collections.listAll();
      return collections.map(collection => collection.name);
    } catch (error: any) {
      throw new MastraError(
        {
          id: createVectorErrorId('WEAVIATE', 'LIST_INDEXES', 'FAILED'),
          domain: ErrorDomain.MASTRA_VECTOR,
          category: ErrorCategory.THIRD_PARTY,
        },
        error,
      );
    }
  }

  /**
   * Retrieves statistics about a vector index.
   *
   * @param {string} indexName - The name of the index to describe
   * @returns A promise that resolves to the index statistics including dimension, count and metric
   */
  async describeIndex({ indexName }: DescribeIndexParams): Promise<IndexStats> {
    try {
      const collection = await this.getCollection(indexName);
      const config = await collection.config.get();
      const { totalCount } = await collection.aggregate.overAll();

      const vectorConfig = config.vectorizers?.default ?? Object.values(config.vectorizers ?? {})[0];
      const distance = (vectorConfig?.indexConfig as { distance?: string } | undefined)?.distance;

      return {
        dimension: readDimension(config.description),
        count: totalCount,
        metric: distance ? DISTANCE_TO_METRIC[distance] : undefined,
      };
    } catch (error: any) {
      if (error instanceof MastraError) throw error;
      throw new MastraError(
        {
          id: createVectorErrorId('WEAVIATE', 'DESCRIBE_INDEX', 'FAILED'),
          domain: ErrorDomain.MASTRA_VECTOR,
          category: ErrorCategory.THIRD_PARTY,
          details: { indexName },
        },
        error,
      );
    }
  }

  async deleteIndex({ indexName }: DeleteIndexParams): Promise<void> {
    try {
      const client = await this.getClient();
      await client.collections.delete(toCollectionName(indexName));
    } catch (error: any) {
      throw new MastraError(
        {
          id: createVectorErrorId('WEAVIATE', 'DELETE_INDEX', 'FAILED'),
          domain: ErrorDomain.MASTRA_VECTOR,
          category: ErrorCategory.THIRD_PARTY,
          details: { indexName },
        },
        error,
      );
    }
  }

  /**
   * Updates a vector by its ID.
   * @param indexName - The name of the index containing the vector.
   * @param id - The ID of the vector to update.
   * @param update - An object containing the vector and/or metadata to update.
   * @returns A promise that resolves when the update is complete.
   */
  async updateVector({ indexName, id, update }: UpdateVectorParams<WeaviateVectorFilter>): Promise<void> {
    if (!id) {
      throw new MastraError({
        id: createVectorErrorId('WEAVIATE', 'UPDATE_VECTOR', 'NO_TARGET'),
        text: 'id must be provided',
        domain: ErrorDomain.MASTRA_VECTOR,
        category: ErrorCategory.USER,
        details: { indexName },
      });
    }

    if (!update.vector && !update.metadata) {
      throw new MastraError({
        id: createVectorErrorId('WEAVIATE', 'UPDATE_VECTOR', 'NO_PAYLOAD'),
        text: 'No updates provided',
        domain: ErrorDomain.MASTRA_VECTOR,
        category: ErrorCategory.USER,
        details: { indexName, id },
      });
    }

    try {
      const collection = await this.getCollection(indexName);
      await collection.data.update({
        id: generateUuid5(id),
        // Weaviate merges properties, so re-sending the ID keeps it intact.
        ...(update.metadata && { properties: { ...update.metadata, [MASTRA_ID_PROPERTY]: id } }),
        ...(update.vector && { vectors: update.vector }),
      });
    } catch (error: any) {
      if (error instanceof MastraError) throw error;
      throw new MastraError(
        {
          id: createVectorErrorId('WEAVIATE', 'UPDATE_VECTOR', 'FAILED'),
          domain: ErrorDomain.MASTRA_VECTOR,
          category: ErrorCategory.THIRD_PARTY,
          details: { indexName, id },
        },
        error,
      );
    }
  }

  async deleteVector({ indexName, id }: DeleteVectorParams): Promise<void> {
    try {
      const collection = await this.getCollection(indexName);
      await collection.data.deleteById(generateUuid5(id));
    } catch (error: any) {
      if (error instanceof MastraError) throw error;
      throw new MastraError(
        {
          id: createVectorErrorId('WEAVIATE', 'DELETE_VECTOR', 'FAILED'),
          domain: ErrorDomain.MASTRA_VECTOR,
          category: ErrorCategory.THIRD_PARTY,
          details: { indexName, id },
        },
        error,
      );
    }
  }

  /**
   * Deletes multiple vectors by IDs or filter.
   * @param indexName - The name of the index containing the vectors.
   * @param ids - Array of vector IDs to delete (mutually exclusive with filter).
   * @param filter - Filter to match vectors to delete (mutually exclusive with ids).
   * @returns A promise that resolves when the deletion is complete.
   */
  async deleteVectors({ indexName, filter, ids }: DeleteVectorsParams<WeaviateVectorFilter>): Promise<void> {
    if (ids && filter) {
      throw new MastraError({
        id: createVectorErrorId('WEAVIATE', 'DELETE_VECTORS', 'MUTUALLY_EXCLUSIVE'),
        text: 'Cannot specify both ids and filter - they are mutually exclusive',
        domain: ErrorDomain.MASTRA_VECTOR,
        category: ErrorCategory.USER,
        details: { indexName },
      });
    }

    if (!ids && !filter) {
      throw new MastraError({
        id: createVectorErrorId('WEAVIATE', 'DELETE_VECTORS', 'NO_TARGET'),
        text: 'Either filter or ids must be provided',
        domain: ErrorDomain.MASTRA_VECTOR,
        category: ErrorCategory.USER,
        details: { indexName },
      });
    }

    if (ids && ids.length === 0) {
      throw new MastraError({
        id: createVectorErrorId('WEAVIATE', 'DELETE_VECTORS', 'EMPTY_IDS'),
        text: 'Cannot delete with empty ids array',
        domain: ErrorDomain.MASTRA_VECTOR,
        category: ErrorCategory.USER,
        details: { indexName },
      });
    }

    if (filter && Object.keys(filter).length === 0) {
      throw new MastraError({
        id: createVectorErrorId('WEAVIATE', 'DELETE_VECTORS', 'EMPTY_FILTER'),
        text: 'Cannot delete with empty filter object',
        domain: ErrorDomain.MASTRA_VECTOR,
        category: ErrorCategory.USER,
        details: { indexName },
      });
    }

    try {
      const collection = await this.getCollection(indexName);

      if (ids) {
        await collection.data.deleteMany(collection.filter.byId().containsAny(ids.map(id => generateUuid5(id))));
        return;
      }

      const translated = toWeaviateFilter(collection, this.transformFilter(filter));
      if (translated) await collection.data.deleteMany(translated);
    } catch (error: any) {
      if (error instanceof MastraError) throw error;
      throw new MastraError(
        {
          id: createVectorErrorId('WEAVIATE', 'DELETE_VECTORS', 'FAILED'),
          domain: ErrorDomain.MASTRA_VECTOR,
          category: ErrorCategory.THIRD_PARTY,
          details: {
            indexName,
            ...(filter && { filter: JSON.stringify(filter) }),
            ...(ids && { idsCount: ids.length }),
          },
        },
        error,
      );
    }
  }
}
