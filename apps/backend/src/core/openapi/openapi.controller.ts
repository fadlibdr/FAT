import { Controller, Get, Header } from "@nestjs/common";
import { Public } from "../../auth/public.decorator";

const SPEC = {
  openapi: "3.0.3",
  info: {
    title: "FAT ERP API",
    version: "0.1.0",
    description:
      "Metadata-driven ERP. Every DocType is served by the generic resource, meta and report endpoints. Authenticate with a JWT bearer token or `Authorization: token <api_key>:<api_secret>`.",
  },
  servers: [{ url: "/" }],
  components: {
    securitySchemes: {
      bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      apiKey: { type: "apiKey", in: "header", name: "Authorization" },
    },
  },
  security: [{ bearer: [] }, { apiKey: [] }],
  paths: {
    "/api/auth/login": {
      post: { summary: "Login, returns JWT tokens", security: [] },
    },
    "/api/auth/api-key": { post: { summary: "Generate an API key/secret" } },
    "/api/meta": { get: { summary: "List DocTypes the user can read" } },
    "/api/meta/{doctype}": { get: { summary: "Get a DocType's metadata" } },
    "/api/resource/{doctype}": {
      get: { summary: "List documents (filters, limit, offset, order_by)" },
      post: { summary: "Create a document" },
    },
    "/api/resource/{doctype}/{name}": {
      get: { summary: "Get one document" },
      put: { summary: "Update a document" },
      delete: { summary: "Delete a document" },
    },
    "/api/resource/{doctype}/{name}/submit": { post: { summary: "Submit" } },
    "/api/resource/{doctype}/{name}/cancel": { post: { summary: "Cancel" } },
    "/api/report/{doctype}": { get: { summary: "Group-by aggregation report" } },
    "/api/query-report/{name}": { get: { summary: "Named report (trial-balance, stock-balance)" } },
    "/api/workflow/{doctype}/{name}/actions": { get: { summary: "Available workflow actions" } },
    "/api/workflow/{doctype}/{name}/action": { post: { summary: "Apply a workflow action" } },
    "/api/search": { get: { summary: "Global search across DocTypes" } },
    "/api/upload": { post: { summary: "Upload a file (multipart)" } },
    "/api/admin/doctype": { post: { summary: "Create a DocType (System Manager)" } },
  },
};

@Controller("api")
export class OpenApiController {
  @Public()
  @Get("openapi.json")
  spec() {
    return SPEC;
  }

  @Public()
  @Get("docs")
  @Header("Content-Type", "text/html")
  docs(): string {
    const rows = Object.entries(SPEC.paths)
      .flatMap(([path, methods]) =>
        Object.entries(methods as Record<string, { summary: string }>).map(
          ([method, def]) =>
            `<tr><td><code>${method.toUpperCase()}</code></td><td><code>${path}</code></td><td>${def.summary}</td></tr>`,
        ),
      )
      .join("");
    return `<!doctype html><html><head><meta charset="utf-8"><title>FAT ERP API</title>
<style>body{font-family:system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#1e293b}
h1{color:#4f46e5}table{border-collapse:collapse;width:100%}td{border-bottom:1px solid #e2e8f0;padding:.5rem}
code{background:#f1f5f9;padding:.1rem .3rem;border-radius:4px}</style></head>
<body><h1>FAT ERP API</h1><p>${SPEC.info.description}</p>
<p>Machine-readable spec: <a href="/api/openapi.json">/api/openapi.json</a></p>
<table><thead><tr><th>Method</th><th>Path</th><th>Summary</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;
  }
}
