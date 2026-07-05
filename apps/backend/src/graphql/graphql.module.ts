import { Module } from "@nestjs/common";
import { GraphQLModule } from "@nestjs/graphql";
import { ApolloDriver, ApolloDriverConfig } from "@nestjs/apollo";
import { join } from "path";
import { CoreModule } from "../core/core.module";
import { DocumentResolver } from "./document.resolver";

/**
 * GraphQL API alongside REST — one generic schema over the DocType engine.
 * Auth flows through the same global JWT guard (GraphQL-aware) and the request
 * is placed on the Apollo context so guards/decorators can read it.
 */
@Module({
  imports: [
    CoreModule,
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: join(process.cwd(), "src/graphql/schema.gql"),
      sortSchema: true,
      playground: true,
      context: ({ req, res }: { req: unknown; res: unknown }) => ({ req, res }),
    }),
  ],
  providers: [DocumentResolver],
})
export class FatGraphQLModule {}
