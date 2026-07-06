import { ExecutionContext } from "@nestjs/common";
import { GqlExecutionContext } from "@nestjs/graphql";

/**
 * Resolve the underlying HTTP request whether the call arrived over REST or
 * GraphQL, so the global JWT guard and CurrentUser decorator work for both.
 */
export function requestFrom(context: ExecutionContext): any {
  const httpReq = context.switchToHttp().getRequest();
  if (httpReq) return httpReq;
  const gql = GqlExecutionContext.create(context);
  return gql.getContext()?.req;
}
