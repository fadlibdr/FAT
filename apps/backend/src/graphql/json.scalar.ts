import { GraphQLScalarType, Kind, ValueNode } from "graphql";

function parseLiteral(ast: ValueNode): unknown {
  switch (ast.kind) {
    case Kind.STRING:
    case Kind.BOOLEAN:
      return ast.value;
    case Kind.INT:
    case Kind.FLOAT:
      return Number(ast.value);
    case Kind.NULL:
      return null;
    case Kind.LIST:
      return ast.values.map((v) => parseLiteral(v));
    case Kind.OBJECT: {
      const obj: Record<string, unknown> = {};
      for (const f of ast.fields) obj[f.name.value] = parseLiteral(f.value);
      return obj;
    }
    default:
      return null;
  }
}

/**
 * A permissive JSON scalar so the generic GraphQL API can carry arbitrary
 * metadata-driven document shapes without a static type per DocType.
 */
export const GraphQLJSON = new GraphQLScalarType({
  name: "JSON",
  description: "Arbitrary JSON value",
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral,
});
