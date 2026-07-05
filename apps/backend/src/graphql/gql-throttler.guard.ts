import { ExecutionContext, Injectable } from "@nestjs/common";
import { GqlExecutionContext } from "@nestjs/graphql";
import { ThrottlerGuard } from "@nestjs/throttler";

/**
 * ThrottlerGuard that also understands GraphQL execution contexts, so the
 * global rate limiter applies to both REST and GraphQL without throwing when
 * there is no HTTP request/response on the context.
 */
@Injectable()
export class GqlThrottlerGuard extends ThrottlerGuard {
  getRequestResponse(context: ExecutionContext): { req: any; res: any } {
    const http = context.switchToHttp();
    const req = http.getRequest();
    if (req) return { req, res: http.getResponse() };
    const gql = GqlExecutionContext.create(context).getContext();
    return { req: gql?.req, res: gql?.req?.res ?? gql?.res };
  }
}
