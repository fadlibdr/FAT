import { Controller, MessageEvent, Sse } from "@nestjs/common";
import { Observable } from "rxjs";
import { RealtimeService } from "./realtime.service";
import { Public } from "../../auth/public.decorator";

@Controller("api")
export class RealtimeController {
  constructor(private readonly realtime: RealtimeService) {}

  /**
   * Server-Sent Events stream of document changes. Public (payload is only
   * doctype + name) so the browser EventSource can connect without headers.
   */
  @Public()
  @Sse("stream")
  stream(): Observable<MessageEvent> {
    return this.realtime.stream();
  }
}
