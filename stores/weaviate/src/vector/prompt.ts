export const WEAVIATE_PROMPT = `When querying Weaviate, you can ONLY use the operators listed below. Any other operators will be rejected.
Important: Don't explain how you constructed the filter, just return the filter itself.

Basic Comparison Operators:
- $eq: Exact match (default when using field: value)
  Example: { "category": "electronics" }
- $ne: Not equal
  Example: { "category": { "$ne": "electronics" } }
- $gt: Greater than
  Example: { "price": { "$gt": 100 } }
- $gte: Greater than or equal
  Example: { "price": { "$gte": 100 } }
- $lt: Less than
  Example: { "price": { "$lt": 100 } }
- $lte: Less than or equal
  Example: { "price": { "$lte": 100 } }

Array Operators:
- $in: Match any value in array
  Example: { "category": { "$in": ["electronics", "books"] } }
- $nin: Not match any value in array
  Example: { "category": { "$nin": ["electronics", "books"] } }

Text Operator:
- $like: Wildcard match, where ? matches one character and * matches many
  Example: { "title": { "$like": "weav*" } }

Element Operator:
- $exists: Check whether a property is set
  Example: { "discount": { "$exists": true } }

Logical Operators:
- $and: Logical AND (implicit when multiple fields are given)
  Example: { "$and": [{ "price": { "$gt": 100 } }, { "category": "electronics" }] }
- $or: Logical OR
  Example: { "$or": [{ "price": { "$lt": 50 } }, { "category": "books" }] }
- $not: Negates the enclosed condition
  Example: { "$not": { "category": "electronics" } }

RESTRICTIONS:
- $regex is not supported. Use $like for wildcard matching instead.
- $nor and $elemMatch are not supported.
- Metadata-only queries are not supported; a query vector is always required.
- Filters cannot be empty objects.

Example Complex Query:
{
  "$and": [
    { "category": { "$in": ["electronics", "computers"] } },
    { "price": { "$gte": 100, "$lte": 1000 } },
    { "$or": [{ "inStock": true }, { "preorder": true }] }
  ]
}`;
