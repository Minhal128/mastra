import { BaseFilterTranslator } from '@mastra/core/vector/filter';
import type {
  VectorFilter,
  OperatorSupport,
  OperatorValueMap,
  LogicalOperatorValueMap,
  BlacklistedRootOperators,
} from '@mastra/core/vector/filter';
import { Filters } from 'weaviate-client';
import type { Collection, FilterValue } from 'weaviate-client';

type WeaviateOperatorValueMap = Omit<OperatorValueMap, '$elemMatch' | '$options'>;

type WeaviateLogicalOperatorValueMap = Omit<LogicalOperatorValueMap, '$nor'>;

type WeaviateBlacklisted = BlacklistedRootOperators | '$nor';

export type WeaviateVectorFilter = VectorFilter<
  keyof WeaviateOperatorValueMap,
  WeaviateOperatorValueMap,
  WeaviateLogicalOperatorValueMap,
  WeaviateBlacklisted
>;

/**
 * Translator for Weaviate filter queries.
 *
 * Weaviate has no JSON filter syntax — filters are built with a fluent builder
 * bound to a collection (`collection.filter.byProperty(...)`). So this class
 * only validates and normalizes the MongoDB-style input; `toWeaviateFilter`
 * turns the normalized tree into a `FilterValue`.
 */
export class WeaviateFilterTranslator extends BaseFilterTranslator<WeaviateVectorFilter> {
  protected override getSupportedOperators(): OperatorSupport {
    return {
      ...BaseFilterTranslator.DEFAULT_OPERATORS,
      logical: ['$and', '$or', '$not'],
      array: ['$in', '$nin'],
      element: ['$exists'],
      // Weaviate has no regex operator; `$like` is its wildcard equivalent.
      regex: [],
      custom: ['$like'],
    };
  }

  translate(filter?: WeaviateVectorFilter): WeaviateVectorFilter {
    if (this.isEmpty(filter)) return filter;
    this.validateFilter(filter);
    return filter;
  }
}

/** Weaviate rejects `$regex`; `$like` maps onto its wildcard `like` operator. */
const COMPARISON_BUILDERS = {
  $eq: (p: any, v: any) => p.equal(v),
  $ne: (p: any, v: any) => p.notEqual(v),
  $gt: (p: any, v: any) => p.greaterThan(v),
  $gte: (p: any, v: any) => p.greaterOrEqual(v),
  $lt: (p: any, v: any) => p.lessThan(v),
  $lte: (p: any, v: any) => p.lessOrEqual(v),
  $in: (p: any, v: any) => p.containsAny(Array.isArray(v) ? v : [v]),
  $nin: (p: any, v: any) => p.containsNone(Array.isArray(v) ? v : [v]),
  $like: (p: any, v: any) => p.like(v),
  $exists: (p: any, v: any) => p.isNull(!v),
} as const;

const isOperatorKey = (key: string): key is keyof typeof COMPARISON_BUILDERS => key in COMPARISON_BUILDERS;

function combine(operator: '$and' | '$or', parts: FilterValue[]): FilterValue | undefined {
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return operator === '$and' ? Filters.and(...parts) : Filters.or(...parts);
}

function buildField(collection: Collection<any, any>, field: string, condition: unknown): FilterValue | undefined {
  const property = collection.filter.byProperty(field);

  // `{ field: 'value' }` is shorthand for `{ field: { $eq: 'value' } }`.
  if (condition === null || typeof condition !== 'object' || Array.isArray(condition)) {
    return property.equal(condition as any);
  }

  const parts: FilterValue[] = [];
  for (const [operator, value] of Object.entries(condition as Record<string, unknown>)) {
    if (!isOperatorKey(operator)) {
      throw new Error(`Unsupported Weaviate filter operator: ${operator}`);
    }
    parts.push(COMPARISON_BUILDERS[operator](property, value));
  }
  return combine('$and', parts);
}

/**
 * Converts a validated MongoDB-style filter into a Weaviate `FilterValue`.
 * Returns `undefined` for empty filters so callers can omit the argument.
 */
export function toWeaviateFilter(
  collection: Collection<any, any>,
  filter?: WeaviateVectorFilter,
): FilterValue | undefined {
  if (!filter || typeof filter !== 'object' || Object.keys(filter).length === 0) return undefined;

  const parts: FilterValue[] = [];

  for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
    if (key === '$and' || key === '$or') {
      const branches = (value as WeaviateVectorFilter[])
        .map(branch => toWeaviateFilter(collection, branch))
        .filter((branch): branch is FilterValue => branch !== undefined);
      const combined = combine(key, branches);
      if (combined) parts.push(combined);
      continue;
    }

    if (key === '$not') {
      const inner = toWeaviateFilter(collection, value as WeaviateVectorFilter);
      if (inner) parts.push(Filters.not(inner));
      continue;
    }

    const built = buildField(collection, key, value);
    if (built) parts.push(built);
  }

  return combine('$and', parts);
}
